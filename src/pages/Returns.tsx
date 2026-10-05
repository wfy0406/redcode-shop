import { Link } from 'react-router';

/**
 * 退換貨政策 /returns（2026-10-06 老闆要求）
 * 內容按老闆口述規則度身訂造：
 * ① 收貨起計 7 天內退換；② 每件貨寄出前會拍照紀錄，破損經核實可退可換；
 * ③ 尺寸不合聯絡客服，有相同貨品原則上可換；④ 如非貨品損壞，恕不接受退款；
 * ⑤ 切勿人為損壞。
 * 配合 Google Merchant Center 免費刊登：Google 規定網站要有公開退貨政策頁。
 * 版面跟 Terms.tsx／Privacy.tsx 同一套（Section／UL／KeyBox＋頁頭頁尾格式）。
 * 條款層面嘅法律效力以 /terms 第 10 節為準，呢頁係俾客人睇嘅操作版。
 */

function Section({
  num,
  title,
  children,
}: {
  num: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t pt-8" style={{ borderColor: 'var(--space-line)' }}>
      <h2 className="font-serif-tc text-xl font-semibold leading-[1.35] text-txt-1 md:text-2xl">
        <span className="mr-3 font-mono text-base text-purple-text md:text-lg">{num}</span>
        {title}
      </h2>
      <div className="mt-4 space-y-3 text-[15px] leading-[1.85] text-txt-2">{children}</div>
    </section>
  );
}

function UL({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-txt-3">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

/** 重點提示盒（粉紅左線＋淺底） */
function KeyBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-r-xl border border-l-2 px-5 py-4"
      style={{
        borderColor: 'var(--space-line)',
        borderLeftColor: 'var(--pink-soft)',
        background: 'var(--space-2)',
      }}
    >
      {children}
    </div>
  );
}

const WHATSAPP_URL = 'https://wa.me/85254835368';
const MESSENGER_URL = 'https://m.me/redcodexhk';
const SUPPORT_EMAIL = 'service.support@ows.redcode.red';

export default function Returns() {
  return (
    <div className="mx-auto max-w-[860px] px-5 pb-24 pt-12 md:px-8 md:pt-16">
      {/* 頁頭 */}
      <header className="pb-10 text-center">
        <p className="script text-3xl">shop with peace of mind ✦</p>
        <h1 className="mt-3 font-serif-tc text-3xl font-bold leading-[1.25] text-starlight md:text-[40px]">
          退換貨政策
        </h1>
        <p className="mt-2 font-mono text-[13px] tracking-[0.14em] text-txt-3">
          RETURN &amp; EXCHANGE POLICY
        </p>
        <p className="mt-3 font-mono text-[13px] tracking-[0.08em] text-txt-3">
          RedCode Fashion Design · 最近更新：2026 年 10 月
        </p>
      </header>

      {/* 懶人包 */}
      <KeyBox>
        <div className="space-y-2 text-[15px] leading-[1.85] text-txt-2">
          <p>
            <b className="text-txt-1">一句講晒：</b>
            收到貨 7 天內，貨品有破損／寄錯貨，我哋包換包退；尺寸不合，原則上都可以換。
            每件貨寄出前我哋都會拍照紀錄，大家都有保障。
          </p>
          <p className="text-txt-3">詳細安排請睇下面各節。</p>
        </div>
      </KeyBox>

      <div className="mt-10 space-y-10">
        <Section num="01" title="退換期限">
          <p>
            1.1 所有退換申請，請喺<b className="text-txt-1">收到貨品當日起計 7 天內</b>
            提出（以順豐簽收紀錄為準）。超過 7 天嘅申請，恕未能受理。
          </p>
          <p>
            1.2 退換貨品必須<b className="text-txt-1">未經穿著或使用、吊牌未剪、原包裝完整</b>
            ，唔影響二次銷售。
          </p>
        </Section>

        <Section num="02" title="貨品破損／品質問題">
          <KeyBox>
            <p>
              <b className="text-txt-1">寄出前拍照紀錄</b>
              ：每件貨品寄出之前，我哋都會<b className="text-txt-1">拍攝貨品照片作紀錄</b>
              ，確認寄出時狀態良好，保障你同我哋雙方。
            </p>
          </KeyBox>
          <p>
            2.1 如你收到嘅貨品有破損、缺陷或品質問題（並非人為造成），或者寄錯貨、數量唔啱，請喺
            7 天內經 WhatsApp、Facebook Messenger 或電郵聯絡客服，
            <b className="text-txt-1">附上訂單編號同貨品相片</b>。
          </p>
          <p>
            2.2 經同事核實後，我哋會安排<b className="text-txt-1">更換同款貨品或退款</b>
            ；如同款缺貨，會全額退款。退款會經原付款方式退回（網上付款嘅訂單經 Airwallex
            原路退回），核實後 7 個工作天內處理。
          </p>
          <p>
            2.3 因貨品破損或我哋嘅錯失而產生嘅退換，
            <b className="text-txt-1">來回運費由我哋承擔</b>。
          </p>
        </Section>

        <Section num="03" title="尺寸不合">
          <p>
            3.1 衫褲尺寸人手量度，1–3 厘米誤差屬合理範圍；但如果收到貨真係唔啱著，唔使擔心——
            請喺 7 天內聯絡客服，話我哋知你嘅訂單編號同想換嘅尺寸。
          </p>
          <p>
            3.2 同事會即時幫你檢查同款貨品仲有冇存貨：
            <b className="text-txt-1">有貨嘅話，原則上可以安排更換</b>合適尺寸（以實際存貨為準）；
            冇貨可換嘅，我哋會同你商量其他安排。
          </p>
          <p>3.3 尺寸更換嘅來回運費由客人承擔（順豐到付）。</p>
        </Section>

        <Section num="04" title="退款說明（重要）">
          <KeyBox>
            <p>
              <b className="text-txt-1">如非貨品損壞，恕不接受退款。</b>
              合理情況下（例如尺寸不合、同想像有出入），我哋原則上可以安排
              <b className="text-txt-1">換貨</b>，但唔會退款。直播優惠貨品嘅退換安排亦以此為準。
            </p>
          </KeyBox>
          <p>
            4.1 所有換貨屬酌情安排，RedCode 保留最終決定權；你根據香港《貨品售賣條例》（第 26
            章）享有嘅法定權利，唔會受本政策影響。
          </p>
        </Section>

        <Section num="05" title="以下情況恕不接受退換">
          <UL
            items={[
              <>
                貨品經<b className="text-txt-1">人為損壞</b>
                ——請愛惜貨品，切勿人為損壞（寄出前嘅拍照紀錄會用作核實）；
              </>,
              '貨品已穿著、洗滌、剪走吊牌，或任何影響二次銷售嘅情況；',
              <>
                基於衛生理由，<b className="text-txt-1">貼身衣物及襪類</b>
                一經售出恕不接受退換（第 2 節嘅破損／品質問題除外）；
              </>,
              '超過 7 天退換期限。',
            ]}
          />
        </Section>

        <Section num="06" title="退換流程">
          <p>6.1 想退或者換，跟呢四步：</p>
          <UL
            items={[
              <>
                <b className="text-txt-1">聯絡客服</b>
                ：WhatsApp 5483 5368／Facebook Messenger 私訊 RedCode 專頁／電郵
                service.support@ows.redcode.red，附上訂單編號同貨品相片；
              </>,
              <>
                <b className="text-txt-1">同事核實</b>
                ：同事會對返寄出前嘅拍照紀錄同存貨，盡快回覆你安排；
              </>,
              <>
                <b className="text-txt-1">寄回貨品</b>
                ：按同事指示經順豐寄回（請保留寄件單據）；
              </>,
              <>
                <b className="text-txt-1">完成退換</b>
                ：收到並檢查貨品後，安排寄出換貨或退款。
              </>,
            ]}
          />
          <p>
            6.2 未經聯絡自行寄回嘅貨品，我哋未必可以處理；請務必先聯絡客服確認。
          </p>
        </Section>

        <Section num="07" title="聯絡我哋">
          <p>7.1 對退換貨有任何疑問，歡迎隨時搵我哋：</p>
          <p className="text-txt-1">
            <b>RedCode Fashion Design</b>
            <br />
            WhatsApp：
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-pink-soft underline underline-offset-4 hover:opacity-80"
            >
              5483 5368
            </a>
            <br />
            Facebook Messenger：
            <a
              href={MESSENGER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-pink-soft underline underline-offset-4 hover:opacity-80"
            >
              m.me/redcodexhk
            </a>
            <br />
            E-Mail：
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="text-pink-soft underline underline-offset-4 hover:opacity-80"
            >
              {SUPPORT_EMAIL}
            </a>
            <br />
            網站：https://redcode.red
          </p>
        </Section>
      </div>

      {/* 頁尾 */}
      <footer
        className="mt-14 border-t pt-6 text-center text-[13px] text-txt-3"
        style={{ borderColor: 'var(--space-line)' }}
      >
        <p>本政策之法律效力以服務條款第 10 節為準。</p>
        <p className="mt-2">
          另請參閱{' '}
          <Link to="/terms" className="text-pink-soft underline underline-offset-4 hover:opacity-80">
            服務條款（Terms of Service）
          </Link>
          {' '}及{' '}
          <Link to="/privacy" className="text-pink-soft underline underline-offset-4 hover:opacity-80">
            私隱政策（Privacy Policy）
          </Link>
        </p>
      </footer>
    </div>
  );
}
