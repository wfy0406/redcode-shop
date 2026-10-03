/**
 * v2.2.34 老闆指令：真・透明背景影片。
 * VP9 alpha WebM 喺 Chrome／Firefox／Edge／Android（包括老闆部機嘅 FB WebView）原生解到；
 * Safari 連最新版都唔解 VP9 alpha（會播咗佢但當不透明 → 黑盒），iOS 亦焗唔到 HEVC alpha
 * （HEVC alpha 只有 macOS VideoToolbox 先焗到），所以 Safari／任何「播到但冇 alpha」嘅
 * 瀏覽器就改用真 alpha 動畫 WebP（<img> 直出，iOS 14+ 得）。
 *
 * 呢個 probe 就係判官：影片一播，抽一格落 canvas 讀 alpha——
 * 有半透明像素 → 瀏覽器真係解到 alpha，用 WebM；
 * 全部 255 → 解碼冇 alpha（Safari），叫 caller 轉動畫 WebP。
 * 同源影片，canvas 唔會 taint。
 *
 * v2.2.57（老闆實測：iPhone Instagram in-app 公仔黑盒）：WKWebView 喺 onPlaying
 * 嗰刻可能仲未上到第一格色，drawImage 讀返全空白（alpha 全 0）→ 舊邏輯見到
 * <250 就誤判「有 alpha」→ 留喺冇 alpha 嘅影片 → 黑盒跟足成場。
 * 修法：要同時見到「透明像素」同「不透明像素」先算真 alpha——
 * 空白幀（全 0）同不透明片（全 255）一齊判 false，兩個方向都唔會誤判。
 */
export function videoHasRealAlpha(video: HTMLVideoElement): boolean {
  try {
    const c = document.createElement('canvas');
    const w = 64;
    const h = Math.max(1, Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * w)) || 64;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let sawClear = false;
    let sawSolid = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) sawClear = true;
      else sawSolid = true;
      if (sawClear && sawSolid) return true;
    }
    return false;
  } catch {
    return false;
  }
}
