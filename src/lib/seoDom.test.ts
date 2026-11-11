import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCanonicalPath } from './seo';

type FakeElement = {
  attrs: Record<string, string>;
  removed: boolean;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | undefined;
  remove: () => void;
};

function fakeElement(): FakeElement {
  const element: FakeElement = {
    attrs: {},
    removed: false,
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    getAttribute(name) {
      return this.attrs[name];
    },
    remove() {
      this.removed = true;
    },
  };
  return element;
}

describe('SPA canonical DOM 管理（輕量 DOM stub，唔加 jsdom 依賴）', () => {
  let canonical: FakeElement | null;
  let ogUrl: FakeElement | null;

  beforeEach(() => {
    canonical = fakeElement();
    canonical.setAttribute('rel', 'canonical');
    canonical.setAttribute('href', 'https://redcode.red/');
    ogUrl = fakeElement();
    ogUrl.setAttribute('content', 'https://redcode.red/');
    vi.stubGlobal('document', {
      head: {
        appendChild(element: FakeElement) {
          if (element.attrs.rel === 'canonical') canonical = element;
          if (element.attrs.property === 'og:url') ogUrl = element;
          return element;
        },
      },
      createElement: () => fakeElement(),
      querySelector(selector: string) {
        if (selector === 'link[rel="canonical"]') return canonical && !canonical.removed ? canonical : null;
        if (selector === 'meta[property="og:url"]') return ogUrl && !ogUrl.removed ? ogUrl : null;
        return null;
      },
      querySelectorAll(selector: string) {
        if (selector === 'link[rel="canonical"]') return canonical && !canonical.removed ? [canonical] : [];
        return [];
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('公開頁寫 HTTPS apex self canonical，唔沿用目前 www host', () => {
    setCanonicalPath('/products/251');
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      'https://redcode.red/products/251',
    );
    expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(
      'https://redcode.red/products/251',
    );
    expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
  });

  it('404／私人頁移除首頁 canonical；之後公開頁可重建一條', () => {
    setCanonicalPath(null);
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelector('meta[property="og:url"]')).toBeNull();
    setCanonicalPath('/products');
    expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(
      'https://redcode.red/products',
    );
  });
});
