/**
 * v2.2.59：AnimatedLogo crossfade 根因修正嘅純邏輯層。
 *
 * 病根（修正前）：三層疊圖入面淨係 poster 有 opacity transition，
 * video／anim 冇 transition 之餘仲要「按 mode 條件 unmount」——
 * 切層嗰刻新層即時全不透明显現、舊層直接消失，所謂 crossfade 其實係硬切，
 * Safari probe 失敗轉 anim 嗰下仲會閃一帧黑／白。
 *
 * 修正契約：三層常駐（reduced-motion 除外），可見性全部由呢個函數話事，
 * 任何時刻「邏輯上」只有一層可見；transition 期間新舊層半透明疊加＝真 crossfade。
 * component 層喺 src/components/AnimatedLogo.tsx。
 */

export type LogoMode = 'poster' | 'video' | 'anim';

export interface LogoLayerVisibility {
  poster: boolean;
  video: boolean;
  anim: boolean;
}

/**
 * 三層可見性：reduced-motion 永遠淨顯示靜態 poster；
 * 否則跟 mode 三揀一。component 即時切換（唔准 opacity transition），
 * 所以「目標態只有一層可見」＝「任何時刻只有一層可見」，重影無可能出現。
 */
export function logoLayerVisibility(mode: LogoMode, reduced: boolean): LogoLayerVisibility {
  if (reduced) return { poster: true, video: false, anim: false };
  return {
    poster: mode === 'poster',
    video: mode === 'video',
    anim: mode === 'anim',
  };
}
