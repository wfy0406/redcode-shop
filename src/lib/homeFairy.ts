/**
 * v2.2.60（老闆指令）：首頁品牌故事條「雙真人」互動嘅純邏輯層。
 *
 * 架構（2026-10-26 整合）：小精靈得返全站一隻，係 Layout 嘅 GlobalFairyGuide；
 * Home 唔再 render 局部 FairyFly／fairy-orbit 實例。雙真人（左 glo-poke／右 glo-heart）
 * 互動全部保留喺 Home，經 `redcode:home-fairy` CustomEvent 同全域小精靈聯動：
 * 首頁只 dispatch（合約見 src/components/globalFairyGuide.ts，佢兼容 celebrate/shy
 * 同呢度嘅 tap/shy-start/shy-end 兩種詞彙），唔直接 import 全域組件。
 *
 * 互動契約：
 * - pointer hover／keyboard focus → 被撩嗰個「怕羞」（trio-shy-left/right transform）
 * - tap（pointerdown）／Enter／Space → 人物 glo-delight 開心跳＋點按位煙花；
 *   idle timeline（glo-look）暫停（.trio-tap）
 * - 離屏／背景分頁 → .trio-paused 暫停 idle
 * - 每次互動 dispatch `redcode:home-fairy`，detail 帶 viewport 座標 x/y——
 *   全域小精靈收到 celebrate 會飛埋互動位打招呼，shy 會怕醜閃開。
 *
 * 呢個檔齋純函數（唔掂 DOM canvas），component 層喺 src/pages/Home.tsx；
 * 動畫 keyframes 喺 src/index.css（老闆鐵律：齋 transform/opacity）。
 */

/** 全站聯動事件名（Home dispatch；GlobalFairyGuide listen） */
export const HOME_FAIRY_EVENT = 'redcode:home-fairy';

/** 雙真人＋（歷史相容）小精靈成員標記 */
export type TrioMember = 'left' | 'right' | 'fairy';

/** 互動動作：怕羞開始／怕羞完結／點按慶祝 */
export type HomeFairyAction = 'shy-start' | 'shy-end' | 'tap';

export interface HomeFairyDetail {
  action: HomeFairyAction;
  /** 邊個成員觸發 */
  source: TrioMember;
  /** 觸發時間（Date.now()） */
  at: number;
  /** 可選：互動發生嘅 viewport 座標（全域小精靈飛行落腳點用） */
  x?: number;
  y?: number;
}

/** 點按慶祝 one-shot 長度（glo-delight 0.9s＋50ms 緩衝） */
export const TRIO_TAP_MS = 950;

/** 鍵盤互動：Enter／Space 當點按（同原生 button 一致） */
export function isTapKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

/** runtime 驗證 event detail（任何 listener 用，唔好信陌生人） */
export function isHomeFairyDetail(v: unknown): v is HomeFairyDetail {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  const actionOk =
    d.action === 'shy-start' || d.action === 'shy-end' || d.action === 'tap';
  const sourceOk = d.source === 'left' || d.source === 'right' || d.source === 'fairy';
  const atOk = typeof d.at === 'number';
  const xyOk =
    (d.x === undefined || (typeof d.x === 'number' && Number.isFinite(d.x))) &&
    (d.y === undefined || (typeof d.y === 'number' && Number.isFinite(d.y)));
  return actionOk && sourceOk && atOk && xyOk;
}

/**
 * dispatch 全站聯動事件。SSR／測試環境冇 window 就靜默唔派（回傳 false）。
 * 聯動係單向：Home 只派唔收——收嘅話會收到自己派嘅事件變相 double-fire。
 */
export function emitHomeFairy(detail: Omit<HomeFairyDetail, 'at'>): boolean {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;
  const full: HomeFairyDetail = { ...detail, at: Date.now() };
  return window.dispatchEvent(new CustomEvent<HomeFairyDetail>(HOME_FAIRY_EVENT, { detail: full }));
}

/** trio 容器 class 合成：基準 trio＋怕羞／點按／暫停修飾（對應 index.css 選擇器） */
export function trioContainerClass(opts: {
  shy: TrioMember | null;
  tapping: boolean;
  paused: boolean;
}): string {
  const cls = ['trio'];
  if (opts.shy) cls.push(`trio-shy-${opts.shy}`);
  if (opts.tapping) cls.push('trio-tap');
  if (opts.paused) cls.push('trio-paused');
  return cls.join(' ');
}
