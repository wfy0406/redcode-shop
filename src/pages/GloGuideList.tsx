/**
 * /glo-guide —— Glo Glo 精選配搭指南總覽（editorial 雜誌風 v2）。
 *
 * 資料：凍結合同 trpc.gloGuide.list.useQuery({ limit })，server 只回 published。
 * 排版：12-column 非對稱 grid、split display heading（拉丁斜體＋中文襯線錯位）、
 * hairline／bracket motif、暖金 × 深紫黑品牌色。樣式全部喺 GloGuideList.css（ggx- 前綴）。
 *
 * 真動態（唔係裝飾）：
 * - 有文章：thumbnail index（button＋aria-pressed），click／hover／focus 切換
 *   頭版 synopsis 同封面；預設第一篇；Arrow/Home/End 鍵盤可用；全部文章喺
 *   「今期目錄」有真 Link route。
 * - 空態：完整雜誌首頁——授權 Glo Glo 圖（/gloglo-3.jpg）、欄目用途、
 *   去商品／直播 CTA、原位 tabs（role=tablist＋aria-selected）解釋點用。
 * LCP：當前頭版封面／空態主圖 eager＋fetchPriority=high；其餘全部 lazy。
 * 公開措辭：文章係「Glo Glo 撰寫」，圖只叫「配搭圖」；唔提內部流程。
 */

import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { trpc } from '@/providers/trpc';
import { useGloGuideListSeo } from '@/components/glo-guide/seo';
import {
  formatGuideDateHK,
  guideDateTimeAttr,
  guidePath,
} from '@/components/glo-guide/guideUtils';
import type { GuideListItem } from '@/components/glo-guide/types';
import './GloGuideList.css';

const LIST_LIMIT = 24;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 報頭：eyebrow＋split display heading＋欄目簡介（所有狀態共用） */
function Masthead() {
  return (
    <header className="ggx-masthead">
      <p className="ggx-eyebrow ggx-masthead-eyebrow">RedCode Editorial</p>
      <h1 className="ggx-title">
        <span className="ggx-title-a">Glo&nbsp;Glo</span>
        <span className="ggx-title-b">
          精選<span className="ggx-bracket">配搭指南</span>
        </span>
      </h1>
      <div className="ggx-masthead-side">
        <hr className="ggx-rule" aria-hidden="true" />
        <p className="ggx-intro">
          每篇指南由 Glo Glo 撰寫：按香港天氣同生活場景揀選直播單品，附主題配搭文同配搭圖；商品外觀以商品頁原圖為準。
        </p>
      </div>
    </header>
  );
}

function GuideDate({ iso }: { iso: string }) {
  return (
    <time dateTime={guideDateTimeAttr(iso) || undefined}>{formatGuideDateHK(iso)}</time>
  );
}

/**
 * 頭版舞台：左封面（bracket 錯位相框）＋右 synopsis。
 * 下面 thumbnail index 係真 selector——click／hover／focus 即時切換舞台內容。
 */
function ArticleStage({ items }: { items: GuideListItem[] }) {
  const [active, setActive] = useState(0);
  const index = Math.min(active, items.length - 1);
  const item = items[index];

  const onIndexKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll('button'));
    const current = buttons.indexOf(e.target as HTMLButtonElement);
    if (current === -1) return;
    e.preventDefault();
    let next = current;
    if (e.key === 'ArrowRight') next = (current + 1) % buttons.length;
    if (e.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = buttons.length - 1;
    buttons[next].focus(); // onFocus 會同步切換舞台
  };

  return (
    <section className="ggx-stage" aria-label="文章頭版">
      <div className="ggx-stage-grid">
        <figure className="ggx-stage-figure">
          {item.coverImage ? (
            <Link
              to={guidePath(item.slug)}
              className="ggx-stage-frame"
              tabIndex={-1}
              aria-hidden="true"
            >
              <img
                key={item.id}
                src={item.coverImage.path}
                alt=""
                width={item.coverImage.width}
                height={item.coverImage.height}
                loading="eager"
                fetchPriority="high"
                decoding="async"
                className="ggx-stage-img"
              />
            </Link>
          ) : (
            <div className="ggx-stage-frame ggx-stage-frame--empty" aria-hidden="true">
              <span className="ggx-bracket">{item.theme}</span>
            </div>
          )}
          <figcaption className="ggx-figure-cap">
            配搭圖｜商品外觀以商品頁原圖為準
          </figcaption>
        </figure>

        <div className="ggx-stage-synopsis">
          <p
            className="ggx-stage-count"
            aria-label={`第 ${index + 1} 篇，共 ${items.length} 篇`}
          >
            {pad2(index + 1)}
            <span className="ggx-stage-total" aria-hidden="true">
              ／{pad2(items.length)}
            </span>
          </p>
          <p className="ggx-eyebrow">{item.theme}</p>
          <h2 className="ggx-stage-title">
            <Link to={guidePath(item.slug)}>{item.title}</Link>
          </h2>
          <p className="ggx-stage-excerpt">{item.excerpt}</p>
          <p className="ggx-meta">
            <GuideDate iso={item.publishedAt} />
            <span aria-hidden="true">　·　</span>
            {item.products.length} 件文中單品
          </p>
          <p className="ggx-byline">Glo Glo 撰寫</p>
          <Link to={guidePath(item.slug)} className="ggx-read">
            閱讀全文<span aria-hidden="true">　→</span>
          </Link>
        </div>
      </div>

      <ol className="ggx-index" aria-label="選擇頭版文章" onKeyDown={onIndexKeyDown}>
        {items.map((it, i) => (
          <li key={it.id} className="ggx-index-item">
            <button
              type="button"
              className={
                i === index ? 'ggx-index-btn is-active' : 'ggx-index-btn'
              }
              aria-pressed={i === index}
              aria-label={`顯示第 ${i + 1} 篇：${it.title}`}
              onClick={() => setActive(i)}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
            >
              <span className="ggx-index-num" aria-hidden="true">
                {pad2(i + 1)}
              </span>
              {it.coverImage && (
                <img
                  src={it.coverImage.path}
                  alt=""
                  width={it.coverImage.width}
                  height={it.coverImage.height}
                  loading="lazy"
                  decoding="async"
                  className="ggx-index-img"
                />
              )}
              <span className="ggx-index-title">{it.title}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 今期目錄：全部已刊登文章嘅真 Link 列表（selector 只係預覽，路由靠呢度） */
function Contents({ items }: { items: GuideListItem[] }) {
  return (
    <section className="ggx-contents" aria-labelledby="ggx-contents-h">
      <div className="ggx-contents-head">
        <h2 id="ggx-contents-h" className="ggx-contents-title">
          今期目錄
        </h2>
        <p className="ggx-contents-count">{items.length} 篇</p>
        <hr className="ggx-rule" aria-hidden="true" />
      </div>
      <ol className="ggx-contents-list">
        {items.map((it, i) => (
          <li key={it.id} className="ggx-contents-row">
            <span className="ggx-contents-num" aria-hidden="true">
              {pad2(i + 1)}
            </span>
            <div className="ggx-contents-main">
              <p className="ggx-eyebrow ggx-contents-theme">{it.theme}</p>
              <h3 className="ggx-contents-name">
                <Link to={guidePath(it.slug)}>{it.title}</Link>
              </h3>
            </div>
            <p className="ggx-meta ggx-contents-date">
              <GuideDate iso={it.publishedAt} />
            </p>
            <Link
              to={guidePath(it.slug)}
              className="ggx-contents-go"
              aria-label={`閱讀《${it.title}》`}
            >
              閱讀<span aria-hidden="true">　→</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 空態原位 tabs：解釋欄目點用（真 tablist＋aria-selected／tabpanel，箭咀鍵可切） */
const EMPTY_TABS = [
  {
    id: 'read',
    label: '指南讀咩',
    body: '每篇指南圍繞一個生活主題——例如轉季返工、週末出遊——由 Glo Glo 撰寫，示範點樣將直播單品襯進香港日常，睇完可以直接套用自己衣櫥。',
  },
  {
    id: 'buy',
    label: '點樣買單品',
    body: '文中會標示對應單品，撳商品名即去商品頁睇原圖、尺碼同價錢；商品外觀以商品頁原圖為準。',
  },
  {
    id: 'image',
    label: '配搭圖點睇',
    body: '每篇附配搭圖幫你預想上身感覺同配色方向；實際顏色、布感同細節以商品頁原圖為準。',
  },
] as const;

function EmptyTabs() {
  const [tab, setTab] = useState(0);

  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    const tabs = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const current = tabs.indexOf(e.target as HTMLButtonElement);
    if (current === -1) return;
    e.preventDefault();
    let next = current;
    if (e.key === 'ArrowRight') next = (current + 1) % tabs.length;
    if (e.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = tabs.length - 1;
    setTab(next);
    tabs[next].focus();
  };

  return (
    <div className="ggx-tabs">
      <div
        role="tablist"
        aria-label="欄目點用"
        className="ggx-tablist"
        onKeyDown={onTabKeyDown}
      >
        {EMPTY_TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`ggx-tab-${t.id}`}
            aria-selected={i === tab}
            aria-controls={`ggx-panel-${t.id}`}
            tabIndex={i === tab ? 0 : -1}
            className="ggx-tab"
            onClick={() => setTab(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {EMPTY_TABS.map((t, i) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`ggx-panel-${t.id}`}
          aria-labelledby={`ggx-tab-${t.id}`}
          hidden={i !== tab}
          className="ggx-tabpanel"
        >
          <p>{t.body}</p>
        </div>
      ))}
    </div>
  );
}

/** 空態：完整雜誌首頁——授權 Glo Glo 圖、欄目用途、商品／直播 CTA、用法 tabs */
function EmptyIssue() {
  return (
    <section className="ggx-empty" aria-label="欄目介紹">
      <figure className="ggx-empty-hero">
        <img
          src="/gloglo-3.jpg"
          alt="Glo Glo 直播選品造型"
          width={1126}
          height={2000}
          loading="eager"
          fetchPriority="high"
          decoding="async"
          className="ggx-empty-img"
        />
        <figcaption className="ggx-figure-cap">
          配搭圖｜Glo Glo 直播選品造型
        </figcaption>
      </figure>

      <div className="ggx-empty-lead">
        <p className="ggx-eyebrow">欄目介紹</p>
        <h2 className="ggx-empty-title">暫時未有已發布指南</h2>
        <p className="ggx-empty-body">
          《Glo Glo 精選配搭指南》刊登由 Glo Glo
          撰寫嘅主題配搭文：每篇圍繞一個香港生活場景，示範直播單品嘅實用襯法，並附配搭圖。新文章刊登後會即時出現喺呢度，等你隨時重溫。
        </p>
        <div className="ggx-empty-cta">
          <Link to="/products" className="ggx-cta">
            去全部貨品
          </Link>
          <Link to="/live" className="ggx-cta ggx-cta--ghost">
            睇直播重溫
          </Link>
        </div>
      </div>

      <EmptyTabs />
    </section>
  );
}

export default function GloGuideList() {
  useGloGuideListSeo();
  const query = trpc.gloGuide.list.useQuery({ limit: LIST_LIMIT }, { staleTime: 300_000 });
  const items = query.isSuccess ? query.data.items : [];

  return (
    <main className="ggx-page">
      <Masthead />

      {query.isPending && (
        <div className="ggx-state" role="status" aria-label="指南載入中">
          <p className="ggx-state-title">Glo Glo 整理緊最新配搭…</p>
          <hr className="ggx-rule" aria-hidden="true" />
          <p>最新一期即刻送到，請稍候。</p>
        </div>
      )}

      {query.isError && (
        <div className="ggx-state" role="alert">
          <p className="ggx-state-title">指南暫時載入唔到</p>
          <p>請檢查網絡連線，然後再試一次。</p>
          <button
            type="button"
            className="ggx-retry"
            onClick={() => void query.refetch()}
          >
            重新載入
          </button>
        </div>
      )}

      {query.isSuccess && items.length === 0 && <EmptyIssue />}

      {items.length > 0 && (
        <>
          <ArticleStage items={items} />
          <Contents items={items} />
        </>
      )}
    </main>
  );
}
