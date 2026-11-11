import { cn } from '@/lib/utils';
import { normalizeAiTags } from './shop-utils';
import './product-story.css';

/**
 * ProductStory —— 商品詳情頁「商品小筆記」（editorial 描述區）
 *
 * 取代舊 border-top 描述格：暖紙底 + 深啡字 + burnt-orange 點綴，
 * 非對稱小標（kicker + serif 標題）、清楚段落、重點 tags chip。
 * 描述只用 React text render（whitespace pre-line 分段），唔用 dangerouslySetInnerHTML。
 * 冇描述但有 tags 都會出（淨係顯示重點）；兩樣都冇就回 null。
 */

export interface ProductStoryProps {
  /** 商品描述（手動填嘅純文字；空行分段、單行換行保留） */
  description?: string | null;
  /** 已批准嘅 AI 重點標籤 */
  aiTags?: string[];
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

export default function ProductStory({ description, aiTags, className }: ProductStoryProps) {
  const paragraphs = splitStoryParagraphs(description);
  const tags = normalizeAiTags(aiTags);
  // 兩樣都冇就唔出（同舊版「冇描述唔出格」一致）
  if (paragraphs.length === 0 && tags.length === 0) return null;

  return (
    <section className={cn('ps-story', className)} aria-label="商品小筆記">
      <p className="ps-kicker">Stylist Note</p>
      <h2 className="ps-title">商品小筆記</h2>

      {tags.length > 0 && (
        <div className="ps-tags-block">
          <p className="ps-tags-label">重點</p>
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
    </section>
  );
}
