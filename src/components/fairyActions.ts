export const FAIRY_ACTION_ORDER = ['wave', 'dance', 'shy', 'play'] as const;

export type FairyIdleAction = (typeof FAIRY_ACTION_ORDER)[number];

/** point＝真指引目標時指住；scared＝拖曳時怕怕。只由狀態觸發，唔入平常隨機循環。 */
export const FAIRY_GUIDE_ACTIONS = ['point', 'scared'] as const;

export type FairyAction = FairyIdleAction | (typeof FAIRY_GUIDE_ACTIONS)[number];

/** 播放器要預載及準備 poster 嘅全部動作（閒置循環＋指引／拖曳）。 */
export const FAIRY_ALL_ACTIONS: readonly FairyAction[] = [...FAIRY_ACTION_ORDER, ...FAIRY_GUIDE_ACTIONS];

export interface FairyActionSpec {
  animation: string;
  poster: string;
  frames: number;
  frameDurationMs: number;
  cycleMs: number;
  holdMs: number;
}

/**
 * 每套動作都係 60 個唯一透明動畫 WebP 幀，40ms／帧、2400ms 完整循環；
 * holdMs 係完整循環嘅整數倍（閒置動作 7200ms＝3 個完整循環），切動作時唔會專登截斷半個揮手／舞步。
 * point／scared 由指引／拖曳狀態即時切入切出，hold 只係保底一個完整循環。
 * 數值同 public/fairy/actions 實際 ANMF 一致。
 */
export const FAIRY_ACTIONS: Record<FairyAction, FairyActionSpec> = {
  wave: {
    animation: '/fairy/actions/wave.webp',
    poster: '/fairy/actions/wave-poster.webp',
    frames: 60,
    frameDurationMs: 40,
    cycleMs: 2400,
    holdMs: 7200,
  },
  dance: {
    animation: '/fairy/actions/dance.webp',
    poster: '/fairy/actions/dance-poster.webp',
    frames: 60,
    frameDurationMs: 40,
    cycleMs: 2400,
    holdMs: 7200,
  },
  shy: {
    animation: '/fairy/actions/shy.webp',
    poster: '/fairy/actions/shy-poster.webp',
    frames: 60,
    frameDurationMs: 40,
    cycleMs: 2400,
    holdMs: 7200,
  },
  play: {
    animation: '/fairy/actions/play.webp',
    poster: '/fairy/actions/play-poster.webp',
    frames: 60,
    frameDurationMs: 40,
    cycleMs: 2400,
    holdMs: 7200,
  },
  point: {
    animation: '/fairy/actions/point.webp',
    poster: '/fairy/actions/point-poster.webp',
    frames: 60,
    frameDurationMs: 40,
    cycleMs: 2400,
    holdMs: 2400,
  },
  scared: {
    animation: '/fairy/actions/scared.webp',
    poster: '/fairy/actions/scared-poster.webp',
    frames: 60,
    frameDurationMs: 40,
    cycleMs: 2400,
    holdMs: 2400,
  },
};

export function isFairyIdleAction(action: FairyAction): action is FairyIdleAction {
  return (FAIRY_ACTION_ORDER as readonly FairyAction[]).includes(action);
}

export function nextFairyAction(current: FairyAction): FairyIdleAction {
  const index = (FAIRY_ACTION_ORDER as readonly FairyAction[]).indexOf(current);
  return FAIRY_ACTION_ORDER[(index + 1) % FAIRY_ACTION_ORDER.length];
}
