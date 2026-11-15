/**
 * /glo-guide —— Glo Glo 精選指南總覽（潮牌雜誌風 v3，SPEC 凍結口徑）。
 *
 * 資料：凍結合同 trpc.gloGuide.list.useQuery({ limit })，server 只回 published。
 * 主視覺：固定公開 asset /glo-guide/glo-glo-editorial-hero.webp（3:2 橫向，
 * 人物偏右、左邊負空間畀 masthead card）；圖載入失敗即場收起因圖、落有設計嘅
 * 純色期刊舞台，任何情況唔會 blank／broken。hero 係 LCP：eager＋
 * fetchPriority=high＋固定 width/height/aspect-ratio，永遠唔 lazy。
 *
 * 期刊式結構：masthead（期號 metadata 喺舞台同目錄）→ 全寬主視覺 →
 * 非對稱 editorial lead（左大標／右呢期單品欄）→ 全寬主配搭圖 →
 * thumbnail 文章 selector → 今期目錄（全部真 Link route）。
 * 期號＝刊登序（最新一期數字最大），全部嚟自真 published 列表，唔係虛構。
 *
 * 真動態（唔係裝飾）：thumbnail index（button＋aria-pressed）click／hover／
 * focus 切換頭版文章，synopsis 同「呢期單品」欄同步更新——切換文章即刻見到
 * 對應商品資訊；Arrow/Home/End 鍵盤可用。空態保留完整欄目介紹、
 * 商品／直播 CTA 同原位 tabs（role=tablist＋aria-selected）。
 * 公開措辭：文章係「Glo Glo 撰寫」，圖只叫「配搭圖」；唔提內部流程。
 */

import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { trpc } from '@/providers/trpc';
import { formatPrice } from '@/data/products';
import { useGloGuideListSeo } from '@/components/glo-guide/seo';
import {
  formatGuideDateHK,
  guideDateTimeAttr,
  guideEffectivePrice,
  guideHasDiscount,
  guidePath,
  guideProductPath,
} from '@/components/glo-guide/guideUtils';
import type { GuideListItem } from '@/components/glo-guide/types';
import './GloGuideList.css';

const LIST_LIMIT = 24;

/** SPEC 凍結主視覺路徑；主線已放入真圖（3:2，人物偏右，左邊負空間） */
export const GLO_GUIDE_HERO_SRC = '/glo-guide/glo-glo-editorial-hero.webp';
const GLO_GUIDE_HERO_WIDTH = 1536;
const GLO_GUIDE_HERO_HEIGHT = 1024;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 報頭＋全寬主視覺（所有狀態共用，LCP 穩定）。
 * Masthead card 用實色深底，坐落主視覺左邊負空間；手機改直排喺圖下面，
 * 任何圖片內容都唔影響文字對比。
 * 主視覺載入失敗：收起因圖，落有設計嘅純色期刊舞台（唔准 blank/broken icon）。
 */
function MastheadHero({ issueCount }: { issueCount: number | null }) {
  const [heroFailed, setHeroFailed] = useState(false);
  return (
    <header className="ggx-masthead">
      <figure className="ggx-hero">
        {heroFailed ? (
          <div
            className="ggx-hero-fallback"
            role="img"
            aria-label="Glo Glo 精選指南主視覺"
          >
            <span className="ggx-hero-fallback-frame" aria-hidden="true" />
            <span className="ggx-hero-fallback-kicker" aria-hidden="true">
              RedCode Editorial
            </span>
            <span className="ggx-hero-fallback-title" aria-hidden="true">
              Glo Glo
            </span>
            <span className="ggx-hero-fallback-sub" aria-hidden="true">
              精選配搭指南
            </span>
          </div>
        ) : (
          <img
            src={GLO_GUIDE_HERO_SRC}
            onError={() => setHeroFailed(true)}
            alt="Glo Glo 身穿米白立領短外套配灰色闊腳褲，示範今期直播單品配搭"
            width={GLO_GUIDE_HERO_WIDTH}
            height={GLO_GUIDE_HERO_HEIGHT}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            className="ggx-hero-img"
          />
        )}
        <div className="ggx-masthead-card">
          <p className="ggx-eyebrow ggx-masthead-eyebrow">RedCode Editorial · Hong Kong</p>
          <h1 className="ggx-title">
            <span className="ggx-title-a">Glo&nbsp;Glo</span>
            <span className="ggx-title-b">精選配搭指南</span>
          </h1>
          <p className="ggx-masthead-meta">
            Glo Glo 撰寫
            {issueCount !== null && issueCount > 0
              ? `｜已刊登 ${issueCount} 期`
              : ''}
          </p>
        </div>
        <figcaption className="ggx-figure-cap ggx-hero-cap">
          配搭圖｜商品外觀以商品頁原圖為準
        </figcaption>
      </figure>
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
 * 頭版舞台：非對稱 editorial lead（左：期號＋主題＋大標＋節錄；右：呢期單品欄）
 * ＋全寬主配搭圖。下面 thumbnail index 係真 selector——click／hover／focus
 * 即時切換 lead 同單品欄（真文章 selector，資訊同步）。
 */
function ArticleStage({ items }: { items: GuideListItem[] }) {
  const [active, setActive] = useState(0);
  const index = Math.min(active, items.length - 1);
  const item = items[index];
  // 期刊期號：刊登序由舊到新，最新一期數字最大（真列表推導，唔係虛構編號）
  const issueNo = items.length - index;

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
      <div className="ggx-stage-lead">
        <div className="ggx-stage-synopsis">
          <p
            className="ggx-issue"
            aria-label={`第 ${issueNo} 期，共 ${items.length} 期`}
          >
            <span className="ggx-issue-no">{`No.${pad2(issueNo)}`}</span>
            <span className="ggx-issue-total" aria-hidden="true">
              {`／${pad2(items.length)}`}
            </span>
          </p>
          <p className="ggx-eyebrow">{item.theme}</p>
          <h2 className="ggx-stage-title">
            <Link to={guidePath(item.slug)}>{item.title}</Link>
          </h2>
          <p className="ggx-stage-excerpt">{item.excerpt}</p>
          <p className="ggx-meta">
            香港時間 <GuideDate iso={item.publishedAt} />
            <span aria-hidden="true">　·　</span>
            {item.products.length} 件文中單品
          </p>
          <p className="ggx-byline">Glo Glo 撰寫</p>
          <Link to={guidePath(item.slug)} className="ggx-read">
            閱讀全文<span aria-hidden="true">　→</span>
          </Link>
        </div>

        {item.products.length > 0 && (
          <aside className="ggx-stage-products" aria-label="呢期文中單品">
            <p className="ggx-stage-products-head">呢期單品</p>
            <ol className="ggx-stage-products-list">
              {item.products.map((product) => (
                <li key={product.id} className="ggx-stage-product">
                  <Link to={guideProductPath(product.id)}>{product.name}</Link>
                  <span className="ggx-stage-product-price">
                    {formatPrice(guideEffectivePrice(product))}
                    {guideHasDiscount(product) && (
                      <s>{formatPrice(product.price)}</s>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>

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
              decoding="async"
              className="ggx-stage-img"
            />
          </Link>
        ) : (
          <div className="ggx-stage-frame ggx-stage-frame--empty" aria-hidden="true">
            <span>{item.theme}</span>
          </div>
        )}
        <figcaption className="ggx-figure-cap">
          配搭圖｜商品外觀以商品頁原圖為準
        </figcaption>
      </figure>

      <ol className="ggx-index" aria-label="選擇頭版文章" onKeyDown={onIndexKeyDown}>
        {items.map((it, i) => (
          <li key={it.id} className="ggx-index-item">
            <button
              type="button"
              className={
                i === index ? 'ggx-index-btn is-active' : 'ggx-index-btn'
              }
              aria-pressed={i === index}
              aria-label={`顯示第 ${items.length - i} 期：${it.title}`}
              onClick={() => setActive(i)}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
            >
              <span className="ggx-index-num" aria-hidden="true">
                {`No.${pad2(items.length - i)}`}
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
        <p className="ggx-contents-count">共 {items.length} 期</p>
        <hr className="ggx-rule" aria-hidden="true" />
      </div>
      <ol className="ggx-contents-list">
        {items.map((it, i) => (
          <li key={it.id} className="ggx-contents-row">
            <span className="ggx-contents-num" aria-hidden="true">
              {`No.${pad2(items.length - i)}`}
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

/** 空態：完整欄目介紹（主視覺喺頁首 masthead）＋商品／直播 CTA＋用法 tabs */
function EmptyIssue() {
  return (
    <section className="ggx-empty" aria-label="欄目介紹">
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
      {/* 站內已載入 Noto Serif TC / Noto Sans TC，淨補 Marcellus（拉丁 display 用） */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Marcellus&display=swap"
      />
      <MastheadHero issueCount={query.isSuccess ? items.length : null} />

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
