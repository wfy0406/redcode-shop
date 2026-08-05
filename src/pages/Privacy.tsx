import { Link } from 'react-router';

/**
 * 私隱政策 /privacy（2026-08-05 Glo 要求：全站頁底連結）
 * 內容＝2026-08-04 經 Glo 批核嘅 17 節政策原文（RedCode_私隱政策.md）。
 * 排版跟 About 頁嘅安靜奢華語言：花體 kicker＋serif 標題＋髮絲線分節。
 * 2026-08-06：聯絡途徑加入 Facebook Messenger（m.me/redcodexhk）；
 * 直接促銷拒收方法補返會員中心「優惠資訊」自助開關。
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

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pt-2">
      <h3 className="text-[15px] font-bold text-txt-1">{title}</h3>
      <div className="mt-2 space-y-3">{children}</div>
    </div>
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

export default function Privacy() {
  return (
    <div className="mx-auto max-w-[860px] px-5 pb-24 pt-12 md:px-8 md:pt-16">
      {/* 頁頭 */}
      <header className="pb-10 text-center">
        <p className="script text-3xl">privacy comes first ✦</p>
        <h1 className="mt-3 font-serif-tc text-3xl font-bold leading-[1.25] text-starlight md:text-[40px]">
          私隱政策
        </h1>
        <p className="mt-3 font-mono text-[13px] tracking-[0.08em] text-txt-3">
          RedCode Fashion Design · 最近更新：2026 年 8 月 6 日
        </p>
      </header>

      <div className="space-y-10">
        <Section num="01" title="引言">
          <p>
            RedCode Fashion Design（「RedCode」或「我哋」）經營 redcode.red
            官方購物網站（「本網站」），透過 Facebook 直播及本網站出售女裝、鞋襪及配飾。我哋重視你嘅個人資料私隱，並按照香港法例第
            486 章《個人資料（私隱）條例》（「條例」）收集、使用、儲存及轉移你嘅個人資料。
          </p>
          <p>
            本政策說明我哋收集邊啲資料、點樣使用、可能交畀邊類人士、點樣保障，以及你嘅權利。使用本網站或向我哋提供個人資料，即表示你已閱讀並明白本政策嘅內容。
          </p>
        </Section>

        <Section num="02" title="我哋收集嘅個人資料">
          <Sub title="2.1 你主動提供嘅資料">
            <UL
              items={[
                <>
                  <b className="text-txt-1">會員註冊</b>
                  ：姓名（稱呼）、電話號碼（用作登入帳號）、電郵地址、密碼（只以加密雜湊形式儲存，我哋睇唔到你嘅原密碼）
                </>,
                <>
                  <b className="text-txt-1">選填會員資料</b>
                  ：收貨地址、年齡、生日月份——填唔填都開到戶，填咗可以幫我哋揀更啱你嘅款同記住你嘅大日子
                </>,
                <>
                  <b className="text-txt-1">落單資料</b>
                  ：訂購嘅商品、尺碼、數量、取貨方式及相關資料（送貨地址、順豐站或智能櫃取貨點）、訂單備註、使用嘅優惠碼
                </>,
                <>
                  <b className="text-txt-1">付款證明</b>
                  ：你上傳嘅付款截圖或單據（截圖可能顯示你嘅銀行或支付帳戶資料，只會用於核對該筆付款）
                </>,
                <>
                  <b className="text-txt-1">客戶服務</b>
                  ：你經 WhatsApp（5483 5368）、電郵（service.support@ows.redcode.red）或 Facebook
                  Messenger（m.me/redcodexhk）聯絡我哋嘅對話及來往紀錄
                </>,
                <>
                  <b className="text-txt-1">Google 登入／連結</b>
                  ：如你選擇用 Google
                  一掣開戶、登入或連結帳號，我哋會收到你 Google 帳號嘅電郵地址、顯示名稱及 Google
                  識別碼
                </>,
              ]}
            />
          </Sub>
          <Sub title="2.2 自動收集嘅技術資料">
            <UL
              items={[
                <>
                  <b className="text-txt-1">登入狀態</b>
                  ：瀏覽器本地儲存（localStorage）嘅登入憑證，用途係保持你登入，唔會用嚟追蹤你喺其他網站嘅活動
                </>,
                <>
                  <b className="text-txt-1">第三方插件 cookies</b>：本網站載有 Facebook 專頁插件及
                  Google 登入按鈕，呢啲第三方可能喺你嘅瀏覽器放置 cookies（詳見第 8 節）
                </>,
                <>
                  <b className="text-txt-1">伺服器紀錄</b>：IP
                  地址、瀏覽器類型、瀏覽時間等基本技術紀錄（網站託管服務商嘅標準日誌）
                </>,
              ]}
            />
          </Sub>
          <Sub title="2.3 我哋唔會收集嘅資料">
            <UL
              items={[
                <>
                  <b className="text-txt-1">信用卡或銀行卡號碼</b>
                  ：本網站不設網上刷卡。你經銀行轉帳或電子支付付款後上傳截圖，整個過程卡資料唔會經過我哋嘅系統。
                </>,
              ]}
            />
          </Sub>
        </Section>

        <Section num="03" title="我哋幾時收集你嘅資料">
          <UL
            items={[
              '註冊會員帳號時',
              '使用 Google 開戶、登入或連結帳號時',
              '落單及結帳時',
              '上傳付款證明時',
              '聯絡我哋客戶服務時',
              '瀏覽本網站時（只限第 2.2 節嘅技術資料）',
            ]}
          />
        </Section>

        <Section num="04" title="資料用途">
          <Sub title="4.1 核心用途（提供服務必需）">
            <UL
              items={[
                '建立及管理你嘅會員帳號、處理登入驗證',
                '處理你嘅訂單：核對付款、審批訂單、安排出貨、發出訂單單據',
                '發送交易相關電郵：訂單待付款通知、訂單確認（附訂單單據）、重設密碼驗證碼',
                '提供客戶服務及售後跟進',
                '內部營運管理：訂單及庫存管理、營運及操作日誌、防止欺詐及濫用',
                '記住你嘅生日月份，用於會員生日相關安排（如有）',
              ]}
            />
          </Sub>
          <Sub title="4.2 推廣用途（須經你同意，可隨時拒絕）">
            <UL
              items={[
                '發送迎新優惠碼、優惠活動、直播預告及新品資訊——詳情請睇第 7 節「直接促銷」',
              ]}
            />
          </Sub>
        </Section>

        <Section num="05" title="提供資料係必須定自願">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-[14px]">
              <thead>
                <tr
                  className="border-b text-left text-[12px] tracking-[0.08em] text-txt-3"
                  style={{ borderColor: 'var(--text-1)' }}
                >
                  <th className="py-2.5 pr-4 font-bold">資料</th>
                  <th className="py-2.5 pr-4 font-bold">必須／自願</th>
                  <th className="py-2.5 font-bold">唔提供嘅後果</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['姓名、電話號碼、電郵地址、密碼', '必須（註冊）', '無法開立會員帳號'],
                  ['取貨資料（送貨地址或取貨點）', '必須（落單）', '無法處理及交付訂單'],
                  ['付款證明', '必須（確認訂單）', '訂單無法確認及出貨'],
                  ['收貨地址（會員資料）、年齡、生日月份', '自願', '唔影響註冊同購物'],
                  ['接收推廣資訊嘅同意', '自願', '只會收到交易必需嘅電郵，冇推廣訊息'],
                ].map(([a, b, c]) => (
                  <tr key={a} className="border-b" style={{ borderColor: 'var(--space-line)' }}>
                    <td className="py-2.5 pr-4 text-txt-1">{a}</td>
                    <td className="py-2.5 pr-4">{b}</td>
                    <td className="py-2.5 text-txt-3">{c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section num="06" title="資料披露及轉移對象">
          <p>
            我哋只會喺有需要時，將你嘅個人資料轉移畀以下
            <b className="text-txt-1">類別</b>嘅人士（不論其身處香港或香港以外地方）：
          </p>
          <UL
            items={[
              <>
                <b className="text-txt-1">速遞及物流公司</b>
                （例如順豐速運）：收件人姓名、電話、送貨地址或取貨點——用於派遞及相關聯絡
              </>,
              <>
                <b className="text-txt-1">雲端託管及系統服務商</b>：Render（網站及資料庫託管）、Resend（交易電郵寄出服務）——用於營運本網站及發送電郵
              </>,
              <>
                <b className="text-txt-1">Google</b>：你選擇 Google 登入或連結帳號時，用作身份驗證
              </>,
              <>
                <b className="text-txt-1">Meta／Facebook</b>：你瀏覽載有 Facebook
                插件嘅頁面時，Facebook 會按其私隱政策收集資料
              </>,
              <>
                <b className="text-txt-1">執法機關、監管機構或法院</b>：如我哋有法律責任披露
              </>,
              <>
                <b className="text-txt-1">專業顧問</b>：會計師、法律顧問等（如有實際需要）
              </>,
            ]}
          />
          <KeyBox>
            <p className="font-bold text-txt-1">我哋唔會出售你嘅個人資料畀任何人。</p>
          </KeyBox>
        </Section>

        <Section num="07" title="直接促銷">
          <p>
            我哋希望喺取得你同意嘅情況下，使用你嘅
            <b className="text-txt-1">姓名、電郵地址及電話號碼</b>，經
            <b className="text-txt-1">電郵或 WhatsApp</b>
            向你發送以下類別嘅資訊：
          </p>
          <UL
            items={[
              'RedCode 自家出售嘅女裝、衫褲、鞋、襪、小飾物等商品資訊',
              'Facebook 直播預告及重溫資訊',
              '優惠碼、折扣及其他推廣活動',
            ]}
          />
          <p>請留意：</p>
          <UL
            items={[
              <>
                <b className="text-txt-1">未經你同意，我哋唔會咁樣使用你嘅個人資料。</b>
                註冊或落單時會有獨立嘅同意選項，唔會預先剔選。
              </>,
              '我哋第一次向你發送推廣訊息時，會話你知你有權要求停止使用你嘅資料作直接促銷。',
              <>
                <b className="text-txt-1">你可以隨時免費拒絕接收推廣訊息</b>：喺會員中心「優惠資訊」自行關閉、WhatsApp
                5483 5368、電郵
                service.support@ows.redcode.red 或 Facebook Messenger（m.me/redcodexhk），或按推廣電郵內嘅指示辦理。我哋收到要求後會免費停止，並將你喺推廣名單中剔除，期間唔會影響你接收訂單相關嘅交易電郵。
              </>,
            ]}
          />
        </Section>

        <Section num="08" title="Cookies 及網上追蹤">
          <UL
            items={[
              <>
                <b className="text-txt-1">我哋自己</b>
                ：使用瀏覽器本地儲存保存登入憑證，令你不使次次重新登入；唔會用嚟追蹤你喺其他網站嘅瀏覽活動。
              </>,
              <>
                <b className="text-txt-1">第三方</b>：Facebook 專頁插件（用於顯示我哋嘅專頁及直播）及
                Google 登入按鈕，可能喺你嘅瀏覽器放置 cookies。如果你已登入 Facebook 或
                Google，佢哋可能得悉你瀏覽過本網站——呢啲收集由 Facebook 及 Google
                按佢哋各自嘅私隱政策處理，唔受本政策管限。
              </>,
              <>
                <b className="text-txt-1">停用方法</b>：你可以喺瀏覽器設定拒絕或清除
                cookies。停用第三方 cookies 唔影響你落單購物，但 Facebook 插件嘅內容同 Google
                一掣登入功能可能無法使用。
              </>,
            ]}
          />
        </Section>

        <Section num="09" title="第三方服務及連結">
          <p>
            本網站載有前往 Facebook、WhatsApp、Google
            等第三方平台嘅連結或插件。你離開本網站後向第三方提供嘅任何資料，一概受該第三方嘅私隱政策管限，本政策並不適用，請你細閱佢哋嘅政策。
          </p>
        </Section>

        <Section num="10" title="資料保安">
          <p>我哋採取切實可行嘅步驟保障你嘅個人資料，包括：</p>
          <UL
            items={[
              '全站 HTTPS 加密傳輸',
              '密碼只以加密雜湊形式儲存',
              '付款截圖及訂單資料儲存於設有存取控制嘅伺服器',
              '後台管理系統只限授權員工使用，所有敏感操作留有日誌',
              '以合約或服務條款規範代我哋處理資料嘅服務商',
            ]}
          />
          <p>
            不過互聯網上嘅資料傳輸唔可能保證百分百安全，請你都妥善保管自己嘅帳號密碼。如不幸發生個人資料事故，我哋會按照個人資料私隱專員公署嘅指引評估及跟進，有需要時通知受影響嘅客戶。
          </p>
        </Section>

        <Section num="11" title="資料保留">
          <UL
            items={[
              '你嘅會員資料會喺帳號有效期間保留；訂單及付款紀錄會按會計及稅務需要保留（一般不超過 7 年）。',
              '除此之外，我哋只會將個人資料保留至達到收集目的（或直接相關目的）實際所需嘅時間，之後刪除或作匿名化處理。',
              '如你想刪除會員帳號，可以聯絡客戶服務（第 17 節），我哋核實身份後會處理。',
            ]}
          />
        </Section>

        <Section num="12" title="香港以外地方嘅轉移">
          <p>
            本網站嘅雲端託管及電郵服務商嘅伺服器可能位於香港以外地方（例如美國或新加坡），即你嘅個人資料可能被轉移及處理於香港境外。進行有關轉移時，我哋會採取合理步驟，確保接收資料嘅服務商以合約或相若嘅保障標準處理你嘅資料，有關轉移亦會遵照條例之規定。
          </p>
        </Section>

        <Section num="13" title="你嘅權利">
          <p>根據條例，你有權：</p>
          <UL
            items={[
              <>
                <b className="text-txt-1">查閱</b>：要求我哋提供你所持有關於你嘅個人資料副本
              </>,
              <>
                <b className="text-txt-1">改正</b>：要求改正唔準確嘅個人資料（大部分會員資料你可以喺「會員中心」自行更新）
              </>,
              <>
                <b className="text-txt-1">拒絕促銷</b>：隨時免費要求停止使用你嘅資料作直接促銷（第
                7 節）
              </>,
            ]}
          />
          <KeyBox>
            <p>
              <b className="text-txt-1">提出方法</b>：電郵
              service.support@ows.redcode.red、WhatsApp 5483
              5368 或 Facebook Messenger（m.me/redcodexhk），註明「私隱查閱／改正要求」，並提供足夠資料俾我哋核實你嘅身份。我哋會喺條例規定嘅
              <b className="text-txt-1">40 日內</b>回覆。查閱要求我哋可能收取合理費用（不會超過直接成本），收費前會預先話你知。
            </p>
          </KeyBox>
        </Section>

        <Section num="14" title="未成年人">
          <p>
            本網站以成年人為主要服務對象。18
            歲以下人士請喺家長或監護人同意及陪同下，先至註冊帳號、提供個人資料或購物。
          </p>
        </Section>

        <Section num="15" title="提供他人嘅個人資料">
          <p>
            如果你代其他人落單或提供他人嘅收件資料（例如姓名、電話、送貨地址），你聲明已獲該人士同意提供其資料，並會將本政策轉達畀佢知悉。
          </p>
        </Section>

        <Section num="16" title="政策更新">
          <p>
            我哋可能不時更新本政策。更新後會喺本頁公布，並註明最近更新日期；如有重大改變，會經電郵或網站公告通知。你喺政策更新後繼續使用本網站，即表示接受更新後嘅政策。
          </p>
        </Section>

        <Section num="17" title="聯絡我哋">
          <p>如對本政策或你嘅個人資料有任何疑問、要求或投訴，歡迎聯絡：</p>
          <p className="text-txt-1">
            <b>RedCode Fashion Design</b>
            <br />
            E-Mail：service.support@ows.redcode.red
            <br />
            WhatsApp：5483 5368
            <br />
            Facebook Messenger：m.me/redcodexhk（RedCode 專頁私訊）
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
        <p>本政策以中文版本為準。</p>
        <p className="mt-2">
          另請參閱{' '}
          <Link to="/terms" className="text-pink-soft underline underline-offset-4 hover:opacity-80">
            服務條款（Terms of Service）
          </Link>
        </p>
      </footer>
    </div>
  );
}
