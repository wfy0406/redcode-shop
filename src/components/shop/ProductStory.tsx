import { Link } from 'react-router';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatLiveDateLabel, liveSharePath, normalizeLiveShare } from '@/lib/liveShare';
import { normalizeAiTags } from './shop-utils';
import './product-story.css';

/**
 * ProductStory —— 商品詳情頁「商品小筆記」（editorial 描述區）
 *
 * 2026-11-12 改版：舊暖紙卡同全站黑底桃紅唔夾，改用深色細框卡
 * （space-2 底 + glass-border + 桃紅點綴），同售價帶同一視覺語言；
 * 非對稱小標（mono kicker + serif 標題）、清楚段落、重點 tags pill。
 * 描述只用 React text render（whitespace pre-line 分段），唔用 dangerouslySetInnerHTML。
 *
 * U02：商品有真 liveDate（真實日曆日期）→ 卡底出直播場次 metadata row
 * （mono 日期／場次＋hairline 分隔），成 row 係真 Link 去
 * /products?liveDate=…〔&liveSession=…〕；無資料唔虛構、唔出空徽章。
 * 原 note（描述／重點標籤）一字唔郁；冇描述冇標籤但有真場次都會出卡。
 */

export interface ProductStoryProps {
  /** 商品描述（手動填嘅純文字；空行分段、單行換行保留） */
  description?: string | null;
  /** 已批准嘅 重點標籤 */
  aiTags?: string[];
  /** 直播場次事實（products 表真欄位）：liveDate＝YYYYMMDD，liveSession＝'1','2'… */
  liveDate?: string | null;
  liveSession?: string | null;
  className?: string;
}

/** 描述分段：空行（≥2 個換行）分成獨立段落；段內單行換行靠 pre-line 保留 */
export function splitStoryParagraphs(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 內文有冇提到配搭（有先顯示「配搭建議只作造型參考」免責句） */
export function hasStylingAdvice(text: string | null | undefined): boolean {
  if (!text) return false;
  return /配搭|穿搭/.test(text);
}

export default function ProductStory({ description, aiTags, liveDate, liveSession, className }: ProductStoryProps) {
  const paragraphs = splitStoryParagraphs(description);
  const tags = normalizeAiTags(aiTags);
  // U02：真 liveDate（真實日曆日期）先算；壞資料 → null → 唔出場次 row
  const liveTarget = liveDate ? normalizeLiveShare(liveDate, liveSession ?? null) : null;
  // 描述／標籤／真場次三樣都冇就唔出（同舊版「冇描述唔出格」一致，唔出空卡）
  if (paragraphs.length === 0 && tags.length === 0 && !liveTarget) return null;

  return (
    <section className={cn('ps-story', className)} aria-label="商品小筆記">
      <p className="ps-kicker">Stylist Note</p>
      <h2 className="ps-title">商品小筆記</h2>

      {tags.length > 0 && (
        <div className="ps-tags-block">
          <p className="ps-tags-label">重點標籤</p>
          <ul className="ps-tags">
            {tags.map((tag) => (
              <li key={tag} className="ps-tag">
                {tag}
              </li>
            ))}
          </ul>
        </div>
      )}

      {paragraphs.length > 0 && (
        <div className="ps-body">
          {paragraphs.map((para, i) => (
            <p key={`${i}-${para.slice(0, 12)}`} className="ps-para">
              {para}
            </p>
          ))}
        </div>
      )}

      {hasStylingAdvice(description) && (
        <p className="ps-disclaimer">配搭建議只作造型參考</p>
      )}

      {/* U02 直播場次 row：editorial metadata（mono 日期＋hairline），成 row 係真 Link */}
      {liveTarget && (
        <p className="ps-live">
          <Link
            to={liveSharePath(liveTarget)}
            className="ps-live-link"
            aria-label={`睇返 ${formatLiveDateLabel(liveTarget.liveDate)}${
              liveTarget.liveSession ? ` 第 ${liveTarget.liveSession} 場` : ''
            } 直播商品`}
          >
            <span className="ps-live-kicker" aria-hidden="true">
              LIVE
            </span>
            <span className="ps-live-label">直播場次</span>
            <span className="ps-live-date">{formatLiveDateLabel(liveTarget.liveDate)}</span>
            {liveTarget.liveSession && (
              <span className="ps-live-session">第 {liveTarget.liveSession} 場</span>
            )}
            <ArrowUpRight size={13} aria-hidden="true" className="ps-live-arrow" />
          </Link>
        </p>
      )}
    </section>
  );
}
