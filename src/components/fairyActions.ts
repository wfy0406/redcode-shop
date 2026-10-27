export const FAIRY_ACTION_ORDER = ['wave', 'dance', 'shy', 'play'] as const;

export type FairyAction = (typeof FAIRY_ACTION_ORDER)[number];

export interface FairyActionSpec {
  animation: string;
  poster: string;
  frames: number;
  frameDurationMs: number;
  cycleMs: number;
  holdMs: number;
}

/**
 * 每套動作都係 30 幀透明動畫 WebP，以 25fps 播放並補上尾接頭循環；
 * holdMs 係完整循環嘅整數倍，切動作時唔會專登截斷半個揮手／舞步。
 * 數值同 public/fairy/actions 實際 ANMF 一致。
 */
export const FAIRY_ACTIONS: Record<FairyAction, FairyActionSpec> = {
  wave: {
    animation: '/fairy/actions/wave.webp',
    poster: '/fairy/actions/wave-poster.webp',
    frames: 30,
    frameDurationMs: 40,
    cycleMs: 1200,
    holdMs: 3600,
  },
  dance: {
    animation: '/fairy/actions/dance.webp',
    poster: '/fairy/actions/dance-poster.webp',
    frames: 30,
    frameDurationMs: 40,
    cycleMs: 1200,
    holdMs: 3600,
  },
  shy: {
    animation: '/fairy/actions/shy.webp',
    poster: '/fairy/actions/shy-poster.webp',
    frames: 30,
    frameDurationMs: 40,
    cycleMs: 1200,
    holdMs: 2400,
  },
  play: {
    animation: '/fairy/actions/play.webp',
    poster: '/fairy/actions/play-poster.webp',
    frames: 30,
    frameDurationMs: 40,
    cycleMs: 1200,
    holdMs: 3600,
  },
};

export function nextFairyAction(current: FairyAction): FairyAction {
  const index = FAIRY_ACTION_ORDER.indexOf(current);
  return FAIRY_ACTION_ORDER[(index + 1) % FAIRY_ACTION_ORDER.length];
}
