import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const component = readFileSync(new URL('./WalletMascot.tsx', import.meta.url), 'utf8');
const wallet = readFileSync(new URL('../../pages/WalletTopup.tsx', import.meta.url), 'utf8');

describe('Wallet 單層公仔顯示契約', () => {
  it('兩個 Wallet 位置都用專用元件，唔再行 GloCutout 多媒體層或人形陰影', () => {
    expect(wallet.match(/<WalletMascot\b/g)).toHaveLength(2);
    expect(wallet).not.toContain('import GloCutout');
    expect(wallet).not.toContain('<GloCutout');
    expect(wallet).not.toContain('drop-shadow(0 16px 36px');
  });

  it('img／video 互斥單層顯示，WebM 用內建 poster，冇雙層 opacity crossfade', () => {
    expect(component.match(/<img\s/g)).toHaveLength(1);
    expect(component.match(/<video\s/g)).toHaveLength(1);
    expect(component).toContain("mode === 'video' ? (");
    expect(component).toContain('poster={poster}');
    expect(component).toContain("src={mode === 'anim' && animSrc ? animSrc : poster}");
    expect(component).not.toContain('opacity-0');
    expect(component).not.toContain('opacity-100');
  });

  it('兩隻公仔都用乾淨 WebM；抱金幣唔再用裁切帧 WebP，豬仔先用安全全帧後備', () => {
    expect(wallet).toContain('videoSrc="/wallet/glo-wallet-alpha.webm"');
    expect(wallet).toContain('videoSrc="/wallet/glo-piggy-alpha.webm"');
    expect(wallet).toContain('animSrc="/wallet/glo-piggy-anim.webp"');
    expect(wallet).not.toContain('/wallet/glo-wallet-anim.webp');
  });

  it('WebM 通過真 alpha probe 先顯示；WebKit／失敗只載入明確指定嘅安全 WebP', () => {
    expect(component).toContain("document.createElement('video')");
    expect(component).toContain('videoHasRealAlpha(probe)');
    expect(component).toContain('if (webkit || videoBlocked)');
    expect(component).toContain('if (!animSrc) return');
    expect(component).toContain('const preload = new Image()');
    expect(component).toContain('probe.removeAttribute(\'src\')');
  });

  it('保留 lazy、reduced-motion、頁面隱藏暫停及 observer 清理', () => {
    expect(component).toContain("rootMargin: '240px'");
    expect(component).toContain('prefers-reduced-motion: reduce');
    expect(component).toContain('usePageVisible()');
    expect(component).toContain('video.pause()');
    expect(component).toContain('observer.disconnect()');
    expect(component).toContain('preload.onload = null');
  });

  it('快速 pause 造成嘅 AbortError 唔會誤判影片永久失敗', () => {
    expect(component).toContain("?.name !== 'AbortError'");
    expect(component).toContain('blockVideo();');
  });
});
