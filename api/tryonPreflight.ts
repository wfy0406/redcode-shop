import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { TryOnMediaError } from "./tryonMedia";

/*
 * Offline preflight for customer-supplied try-on photos.
 *
 * Face detector adapted from pico.js (MIT), copyright Nenad Markus:
 * https://github.com/nenadmarkus/picojs
 * The bundled facefinder cascade comes from the official pico repository at
 * commit c2e81f9d23cc11d1a612fd21e4f9de0921a5d0d9. See
 * tryonPreflight.LICENSE.txt. No photo is sent anywhere for this check.
 */

type Detection = [row: number, column: number, scale: number, score: number];
type ClassifyRegion = (
  row: number,
  column: number,
  scale: number,
  pixels: Uint8Array,
  ldim: number,
) => number;

interface GrayImage {
  pixels: Uint8Array;
  nrows: number;
  ncols: number;
  ldim: number;
}

export interface TryOnPreflightResult {
  width: number;
  height: number;
  meanLuma: number;
  faceLuma: number;
  faceCount: number;
}

const CASCADE_SHA256 = "d8014993e7298c7b1865d1f8b855d6dbf4ec5c808bf879e2091ab6837abf90cd";
// Keep this as a cost-saving safety net, not a beauty / studio-lighting gate.
// The lower score and darkness limits accept ordinary indoor photos; the two
// fallback angles below improve recall for slightly tilted full-body portraits.
const FACE_SCORE_THRESHOLD = 4;
const DARK_IMAGE_MEAN = 18;
const DARK_FACE_MEAN = 24;
const FALLBACK_ANGLES = [-18, 18] as const;
let cascadePromise: Promise<ClassifyRegion> | null = null;

function unpackCascade(bytes: Uint8Array): ClassifyRegion {
  if (bytes.length < 16) throw new Error("face cascade is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8; // Skip cascade version and training metadata.
  const treeDepth = view.getInt32(p, true);
  p += 4;
  const treeCount = view.getInt32(p, true);
  p += 4;
  if (treeDepth < 1 || treeDepth > 8 || treeCount < 1 || treeCount > 10_000) {
    throw new Error("face cascade header is invalid");
  }

  const codeList: number[] = [];
  const predictionList: number[] = [];
  const thresholds: number[] = [];
  const leaves = 2 ** treeDepth;
  for (let tree = 0; tree < treeCount; tree += 1) {
    codeList.push(0, 0, 0, 0);
    const codeBytes = 4 * leaves - 4;
    if (p + codeBytes + 4 * leaves + 4 > bytes.length) throw new Error("face cascade is truncated");
    for (let i = 0; i < codeBytes; i += 1) codeList.push(view.getInt8(p + i));
    p += codeBytes;
    for (let i = 0; i < leaves; i += 1) {
      predictionList.push(view.getFloat32(p, true));
      p += 4;
    }
    thresholds.push(view.getFloat32(p, true));
    p += 4;
  }
  if (p !== bytes.length) throw new Error("face cascade length is invalid");

  const codes = new Int8Array(codeList);
  const predictions = new Float32Array(predictionList);
  const threshold = new Float32Array(thresholds);
  return (row, column, scale, pixels, ldim) => {
    const r = 256 * row;
    const c = 256 * column;
    let root = 0;
    let output = 0;
    for (let tree = 0; tree < treeCount; tree += 1) {
      let index = 1;
      for (let depth = 0; depth < treeDepth; depth += 1) {
        const offset = root + 4 * index;
        const left = pixels[
          ((r + codes[offset] * scale) >> 8) * ldim + ((c + codes[offset + 1] * scale) >> 8)
        ];
        const right = pixels[
          ((r + codes[offset + 2] * scale) >> 8) * ldim + ((c + codes[offset + 3] * scale) >> 8)
        ];
        index = 2 * index + (left <= right ? 1 : 0);
      }
      output += predictions[leaves * tree + index - leaves];
      if (output <= threshold[tree]) return -1;
      root += 4 * leaves;
    }
    return output - threshold[treeCount - 1];
  };
}

function runCascade(image: GrayImage, classify: ClassifyRegion): Detection[] {
  const detections: Detection[] = [];
  const minSize = Math.max(16, Math.min(20, Math.floor(Math.min(image.nrows, image.ncols) / 12)));
  const maxSize = Math.min(image.nrows, image.ncols);
  for (let scale = minSize; scale <= maxSize; scale *= 1.1) {
    const step = Math.max(1, Math.floor(0.1 * scale));
    const offset = Math.floor(scale / 2 + 1);
    for (let row = offset; row <= image.nrows - offset; row += step) {
      for (let column = offset; column <= image.ncols - offset; column += step) {
        const score = classify(row, column, scale, image.pixels, image.ldim);
        if (score > 0) detections.push([row, column, scale, score]);
      }
    }
  }
  return detections;
}

function clusterDetections(detections: Detection[], iouThreshold = 0.2): Detection[] {
  const sorted = [...detections].sort((a, b) => b[3] - a[3]);
  const assigned = new Array<boolean>(sorted.length).fill(false);
  const clusters: Detection[] = [];
  const iou = (a: Detection, b: Detection) => {
    const overlapRows = Math.max(
      0,
      Math.min(a[0] + a[2] / 2, b[0] + b[2] / 2) - Math.max(a[0] - a[2] / 2, b[0] - b[2] / 2),
    );
    const overlapColumns = Math.max(
      0,
      Math.min(a[1] + a[2] / 2, b[1] + b[2] / 2) - Math.max(a[1] - a[2] / 2, b[1] - b[2] / 2),
    );
    const intersection = overlapRows * overlapColumns;
    return intersection / (a[2] * a[2] + b[2] * b[2] - intersection);
  };

  for (let i = 0; i < sorted.length; i += 1) {
    if (assigned[i]) continue;
    let row = 0;
    let column = 0;
    let scale = 0;
    let score = 0;
    let count = 0;
    for (let j = i; j < sorted.length; j += 1) {
      if (!assigned[j] && iou(sorted[i], sorted[j]) > iouThreshold) {
        assigned[j] = true;
        row += sorted[j][0];
        column += sorted[j][1];
        scale += sorted[j][2];
        score += sorted[j][3];
        count += 1;
      }
    }
    if (count) clusters.push([row / count, column / count, scale / count, score]);
  }
  return clusters;
}

async function loadCascade(): Promise<ClassifyRegion> {
  const candidates = [
    path.resolve(process.cwd(), "dist/public/tryon/facefinder.bin"),
    path.resolve(process.cwd(), "public/tryon/facefinder.bin"),
    path.resolve(import.meta.dirname, "../dist/public/tryon/facefinder.bin"),
    path.resolve(import.meta.dirname, "../../dist/public/tryon/facefinder.bin"),
    path.resolve(import.meta.dirname, "../public/tryon/facefinder.bin"),
  ];
  let bytes: Buffer | null = null;
  for (const candidate of candidates) {
    try {
      bytes = await readFile(candidate);
      break;
    } catch {
      // Try the next development/production layout.
    }
  }
  if (!bytes) throw new Error("offline face cascade is unavailable");
  if (createHash("sha256").update(bytes).digest("hex") !== CASCADE_SHA256) {
    throw new Error("offline face cascade failed its integrity check");
  }
  return unpackCascade(bytes);
}

async function getCascade(): Promise<ClassifyRegion> {
  if (!cascadePromise) {
    cascadePromise = loadCascade().catch((error) => {
      cascadePromise = null;
      throw error;
    });
  }
  return cascadePromise;
}

function meanLuma(pixels: Uint8Array): number {
  if (!pixels.length) return 0;
  let total = 0;
  for (const value of pixels) total += value;
  return total / pixels.length;
}

function regionMeanLuma(image: GrayImage, face: Detection): number {
  const radius = face[2] * 0.34; // Central facial area; avoids most hair/background.
  const startRow = Math.max(0, Math.floor(face[0] - radius));
  const endRow = Math.min(image.nrows - 1, Math.ceil(face[0] + radius));
  const startColumn = Math.max(0, Math.floor(face[1] - radius));
  const endColumn = Math.min(image.ncols - 1, Math.ceil(face[1] + radius));
  let total = 0;
  let count = 0;
  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startColumn; column <= endColumn; column += 1) {
      total += image.pixels[row * image.ldim + column];
      count += 1;
    }
  }
  return count ? total / count : 0;
}

function findFaces(image: GrayImage, classify: ClassifyRegion): Detection[] {
  return clusterDetections(runCascade(image, classify))
    .filter((face) => face[3] > FACE_SCORE_THRESHOLD)
    .sort((a, b) => b[3] - a[3]);
}

/** Local, tolerant safety check: accept ordinary dim / slightly tilted portraits, block only clear failures. */
export async function inspectTryOnModelImage(input: Buffer): Promise<TryOnPreflightResult> {
  const sharp = (await import("sharp")).default;
  const decodeGray = async (angle = 0): Promise<GrayImage> => {
    let pipeline = sharp(input, { limitInputPixels: 25_000_000 }).rotate();
    if (angle) pipeline = pipeline.rotate(angle, { background: "#808080" });
    const { data, info } = await pipeline
      .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { pixels: data, nrows: info.height, ncols: info.width, ldim: info.width };
  };

  const image = await decodeGray();
  const brightness = meanLuma(image.pixels);
  if (brightness < DARK_IMAGE_MEAN) {
    throw new TryOnMediaError(
      "IMAGE_TOO_DARK",
      "相片真係太暗；請換一張光線平均嘅本人全身相，前鏡、後鏡或相簿相片都得。今次未送 AI 生成，亦未預留或扣除 credits。",
    );
  }

  const classify = await getCascade();
  let faceImage = image;
  let faces = findFaces(image, classify);
  // A phone portrait is often slightly tilted. Retry only when the first pass
  // finds nobody, bounding extra CPU while avoiding an unnecessary retake.
  for (const angle of FALLBACK_ANGLES) {
    if (faces.length) break;
    const candidate = await decodeGray(angle);
    const candidateFaces = findFaces(candidate, classify);
    if (candidateFaces.length) {
      faceImage = candidate;
      faces = candidateFaces;
    }
  }
  if (!faces.length) {
    throw new TryOnMediaError(
      "NO_HUMAN_FACE",
      "呢張相暫時睇唔清楚人像；請換一張本人正面全身相，前鏡、後鏡或相簿相片都得。今次未送 AI 生成，亦未預留或扣除 credits。",
    );
  }
  const faceBrightness = regionMeanLuma(faceImage, faces[0]);
  if (faceBrightness < DARK_FACE_MEAN) {
    throw new TryOnMediaError(
      "IMAGE_TOO_DARK",
      "人像位置真係太暗；請換一張面向光源嘅相片，唔使專業打燈。今次未送 AI 生成，亦未預留或扣除 credits。",
    );
  }
  return {
    width: image.ncols,
    height: image.nrows,
    meanLuma: brightness,
    faceLuma: faceBrightness,
    faceCount: faces.length,
  };
}
