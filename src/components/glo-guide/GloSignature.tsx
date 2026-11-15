/**
 * Glo Glo 簽名署名（文章結尾）。
 * 重用 /email/gloria-sign.png（binary 一字節唔改）；原圖係深啡字透明底，
 * 深色版面上用 CSS filter 提亮做金色——只係顯示層，檔案本身冇郁過。
 */
export default function GloSignature() {
  return (
    <div className="gg-sign-block">
      <p className="gg-sign-byline">Glo Glo 撰寫</p>
      <img
        src="/email/gloria-sign.png"
        alt="Glo Glo 簽名"
        width={640}
        height={290}
        className="gg-sign-img"
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}
