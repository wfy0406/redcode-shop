import { Fragment, type ReactNode } from 'react';
import { gloGuideHeadingText, parseGloGuideRichText } from '@contracts/gloGuideRichText';

function Inline({ paragraph }: { paragraph: string }) {
  const parsed = parseGloGuideRichText(paragraph);
  // 未通過結構閘嘅內容唔應公開；真遇舊資料異常時只當純文字，由 React 自動 escape。
  if (parsed.error) return <>{paragraph}</>;
  return (
    <>
      {parsed.segments.map((segment, index) => {
        let node: ReactNode = segment.text;
        if (segment.bold) node = <strong>{node}</strong>;
        if (segment.color) node = <span className={`gg-text-${segment.color}`}>{node}</span>;
        if (segment.tag) node = <mark className="gg-key-tag">{node}</mark>;
        return <Fragment key={`${index}-${segment.text.slice(0, 12)}`}>{node}</Fragment>;
      })}
    </>
  );
}

export function splitGloGuideBody(body: string): string[] {
  return body
    .split(/\n{2,}|\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export default function GloGuideRichText({ body, className = '' }: { body: string; className?: string }) {
  return (
    <div className={`gg-body ${className}`.trim()} id="guide-body" data-fairy-target="guide-body">
      {splitGloGuideBody(body).map((paragraph, index) => {
        const heading = gloGuideHeadingText(paragraph);
        return heading !== null ? (
          <h2 key={index} className="gg-body-heading">{heading}</h2>
        ) : (
          <p key={index}>
            <Inline paragraph={paragraph} />
          </p>
        );
      })}
    </div>
  );
}
