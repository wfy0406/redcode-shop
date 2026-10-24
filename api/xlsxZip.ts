import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * 手寫 ZIP 讀寫（零 dependency，專為 xlsx 模板手術而設）
 * 讀：由尾搵 EOCD → 行 central directory → 逐 entry 按 local header 定位 data，
 *     deflate（method 8）用 zlib.inflateRawSync 解，store（method 0）直接切。
 * 寫：全部 entries 用 deflate（method 8，同 Excel 原生一致）+ CRC32，
 *     重寫 local headers + central directory + EOCD。
 *     用 deflate 唔單止慳位（677KB → ~80KB，慢線下載唔易截斷），
 *     產出嘅 zip 形狀亦同 Excel 自己儲存嘅一樣，相容性最好。
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

// ── CRC32（IEEE，table 喺首次使用時建） ─────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── 讀 ─────────────────────────────────────────────────────────
// 防 deflate bomb／畸形 zip 嘅硬上限（fail-closed，超出即刻 throw，唔會回傳截斷數據）：
// 預設值俾「讀信任模板」（exportDaily）用；上傳入口（luckyDrawXlsx）會傳更緊嘅限。
export const ZIP_MAX_ENTRY_BYTES = 32 * 1024 * 1024; // 每個 entry 解壓後上限 32MB
export const ZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 全部解壓 entry 合計上限 64MB

export type ReadZipOptions = {
  /** 每個 entry 解壓後上限（bytes）；超出即 throw「解壓後超過每檔上限」 */
  maxEntryBytes?: number;
  /** 所有被解壓 entry 合計上限（bytes）；超出即 throw「總解壓大小超過上限」 */
  maxTotalBytes?: number;
  /** 只解壓呢啲 entry 名；其他 entry 淨係掃 central directory metadata，完全唔解壓
   *  （無關嘅巨大 entry 唔會食記憶體）。唔傳＝全部解壓（舊行為）。 */
  only?: ReadonlySet<string>;
};

/** entry 名 fail-closed 檢查：path traversal／絕對路徑／Windows drive 一律拒絕 */
function assertSafeEntryName(name: string): void {
  if (
    name.length === 0 ||
    name.startsWith("/") ||
    name.startsWith("\\") ||
    /^[A-Za-z]:/.test(name) ||
    name.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`invalid zip: unsafe entry path "${name}"`);
  }
}

export function readZipEntries(buf: Buffer, opts: ReadZipOptions = {}): Map<string, Buffer> {
  const maxEntry = opts.maxEntryBytes ?? ZIP_MAX_ENTRY_BYTES;
  const maxTotal = opts.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES;
  const only = opts.only;

  if (buf.length < 22) throw new Error("invalid zip: file too small");
  // EOCD 固定 22 bytes，最多跟 65535 bytes comment —— 由尾向前掃 signature
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("invalid zip: end of central directory not found");

  // fail-closed：多分碟 zip 唔支援（本系統淨係處理單檔 xlsx）
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw new Error("invalid zip: multi-disk archives not supported");
  }
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdStart = buf.readUInt32LE(eocd + 16);
  if (cdStart > eocd || cdStart + cdSize > buf.length) {
    throw new Error("invalid zip: central directory out of bounds");
  }
  let off = cdStart;
  const out = new Map<string, Buffer>();
  let totalBytes = 0;

  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN_SIG) {
      throw new Error("invalid zip: corrupt central directory");
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    if (off + 46 + nameLen + extraLen + commentLen > buf.length) {
      throw new Error("invalid zip: central directory entry out of bounds");
    }
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    assertSafeEntryName(name);

    // 唔需要嘅 entry：skip——metadata 都唔再深入驗，絕對唔解壓（防無關巨大 entry 拖垮記憶體）
    if (only && !only.has(name)) {
      off += 46 + nameLen + extraLen + commentLen;
      continue;
    }
    if (out.has(name)) {
      throw new Error(`invalid zip: duplicate entry "${name}"`);
    }

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOC_SIG) {
      throw new Error(`invalid zip: bad local header for ${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) {
      throw new Error(`invalid zip: data out of bounds for ${name}`);
    }
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      // store：未壓縮，大小已知——直接檢查上限
      if (compSize > maxEntry) {
        throw new Error(`xlsx entry "${name}" 解壓後超過每檔上限 ${maxEntry} bytes（實際 ${compSize}）`);
      }
      data = Buffer.from(comp);
    } else if (method === 8) {
      // deflate：唔信 header 聲稱嘅 uncompSize，用 maxOutputLength 硬性截停——
      // 一超上限 zlib 即刻 throw ERR_BUFFER_TOO_LARGE，唔會先解出成個 bomb。
      try {
        data = inflateRawSync(comp, { maxOutputLength: maxEntry + 1 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          throw new Error(`xlsx entry "${name}" 解壓後超過每檔上限 ${maxEntry} bytes`);
        }
        throw new Error(`invalid zip: cannot inflate entry "${name}" (${(e as Error).message})`);
      }
      if (data.length > maxEntry) {
        throw new Error(`xlsx entry "${name}" 解壓後超過每檔上限 ${maxEntry} bytes（實際 ${data.length}）`);
      }
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }

    // 大小聲明核實：central header 嘅 uncompSize 同實際解出嚟唔一致＝malformed，fail-closed
    if (uncompSize !== data.length) {
      throw new Error(
        `invalid zip: entry "${name}" 聲稱解壓大小 ${uncompSize} 同實際 ${data.length} 唔符`,
      );
    }
    totalBytes += data.length;
    if (totalBytes > maxTotal) {
      throw new Error(`xlsx 總解壓大小超過上限 ${maxTotal} bytes`);
    }
    out.set(name, data);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── 寫（deflate method 8，保持 entry 順序） ─────────────────────
export function writeZipDeflate(entries: Map<string, Buffer>): Buffer {
  const chunks: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const comp = deflateRawSync(data, { level: 9 });

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method 8 = deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date = 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, nameBuf, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0, 8); // flags
    cen.writeUInt16LE(8, 10); // method 8 = deflate
    cen.writeUInt16LE(0, 12); // mod time
    cen.writeUInt16LE(0x21, 14); // mod date
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30); // extra len
    cen.writeUInt16LE(0, 32); // comment len
    cen.writeUInt16LE(0, 34); // disk number
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(offset, 42); // local header offset
    centrals.push(cen, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }

  const cdStart = offset;
  const cdSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(entries.size, 8); // entries on this disk
  eocd.writeUInt16LE(entries.size, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...chunks, ...centrals, eocd]);
}
