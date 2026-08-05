import { Link } from 'react-router';

/**
 * 服務條款 /terms（2026-08-05 Glo 要求：全站頁底連結）
 * 內容＝RedCode_服務條款.md（研究 HKTVmall／Zara HK／友和條款＋《貨品售賣條例》後度身訂造）。
 * 核心保障（Glo 指定）：第 4 節寫明「發出訂單確認電郵時，買賣合約先正式成立」＋
 * 第 6.3 條標錯價可取消訂單全額退款——避免標錯價被逼履約。
 * 2026-08-06：聯絡途徑加入 Facebook Messenger（m.me/redcodexhk）。
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

export default function Terms() {
  return (
    <div className="mx-auto max-w-[860px] px-5 pb-24 pt-12 md:px-8 md:pt-16">
      {/* 頁頭 */}
      <header className="pb-10 text-center">
        <p className="script text-3xl">house rules ✦</p>
        <h1 className="mt-3 font-serif-tc text-3xl font-bold leading-[1.25] text-starlight md:text-[40px]">
          服務條款
        </h1>
        <p className="mt-2 font-mono text-[13px] tracking-[0.14em] text-txt-3">
          TERMS OF SERVICE
        </p>
        <p className="mt-3 font-mono text-[13px] tracking-[0.08em] text-txt-3">
          RedCode Fashion Design · 最近更新：2026 年 8 月 6 日
        </p>
      </header>

      <div className="space-y-10">
        <Section num="01" title="總則與條款接納">
          <p>
            1.1 本條款由 RedCode Fashion Design（RedCode HK Limited
            旗下品牌，「RedCode」或「我哋」）訂立，適用於你使用 redcode.red
            官方購物網站（「本網站」），以及經本網站或本網站之 Facebook
            直播下單購買貨品之一切安排。
          </p>
          <p>
            1.2
            你使用本網站、註冊會員帳號或提交訂單，即表示你已閱讀、明白並同意受本條款及我哋嘅
            <Link to="/privacy" className="text-pink-soft underline underline-offset-4 hover:opacity-80">
              《私隱政策》
            </Link>
            約束。如你唔同意本條款任何部分，請唔好使用本網站或落單。
          </p>
          <p>
            1.3 本條款同《私隱政策》一齊構成你同我哋之間嘅完整協議。《私隱政策》講我哋點樣處理你嘅個人資料；本條款講買賣同網站使用嘅規則。兩者如有唔一致，涉及個人資料處理嘅事項以《私隱政策》為準。
          </p>
        </Section>

        <Section num="02" title="定義">
          <p>喺本條款入面：</p>
          <UL
            items={[
              <>
                <b className="text-txt-1">「訂單」</b>
                ：你經本網站提交嘅購買要求，附有訂單編號。
              </>,
              <>
                <b className="text-txt-1">「訂單確認」</b>
                ：我哋核實你嘅付款並審批完成後，經電郵向你發出嘅「訂單已確認」通知（附訂單單據）。
              </>,
              <>
                <b className="text-txt-1">「付款截圖」</b>
                ：你就某張訂單付款後，上傳到本網站嘅銀行轉帳或電子支付截圖／單據。
              </>,
              <>
                <b className="text-txt-1">「工作天」</b>：香港星期一至五（公眾假期除外）。
              </>,
              <>
                <b className="text-txt-1">「貨品」</b>
                ：本網站出售嘅女裝、衫褲、鞋、襪、小飾物及其他商品。
              </>,
            ]}
          />
        </Section>

        <Section num="03" title="帳戶與會員註冊">
          <p>
            3.1 你必須年滿 18 歲先可以註冊帳號同落單。18
            歲以下人士請喺家長或監護人同意及陪同下使用本網站（同《私隱政策》第 14 節一致）。
          </p>
          <p>
            3.2
            註冊時你必須提供真實、準確嘅資料（姓名、電話號碼、電郵地址等）。如資料唔實，我哋可以暫停或終止你嘅帳號。
          </p>
          <p>
            3.3
            你有責任保管好自己嘅帳號密碼。你帳號下嘅所有活動（包括落單）會當係你本人操作。如發現帳號被盜用，請即刻聯絡我哋（第
            14.7 條）。
          </p>
          <p>
            3.4 你可以選擇用 Google
            帳號開戶、登入或連結帳號，相關安排同一般帳號一樣受本條款約束。
          </p>
        </Section>

        <Section num="04" title="訂單流程與合約成立（重要）">
          <p>
            4.1 <b className="text-txt-1">網站及直播展示只係邀請，唔係要約。</b>
            本網站及 Facebook
            直播展示嘅貨品、價格及優惠，僅構成要約邀請（invitation to
            treat），唔構成我哋出售貨品嘅要約。
          </p>
          <p>
            4.2 <b className="text-txt-1">你提交訂單＝你向我哋發出購買要約。</b>
            系統自動發出嘅「訂單待付款」通知，只係確認我哋<b className="text-txt-1">收到</b>
            你嘅要約，<b className="text-txt-1">唔代表我哋接受你嘅訂單</b>
            ；你付款同上傳付款截圖，亦<b className="text-txt-1">唔代表</b>我哋接受你嘅訂單。
          </p>
          <KeyBox>
            <p>
              <b className="text-txt-1">4.3 合約成立時刻</b>
              ：當我哋核實你嘅付款、完成訂單審批，並向你發出「訂單確認」電郵之時，先係我哋接受你嘅訂單——
              <b className="text-txt-1">買賣合約喺嗰一刻先正式成立</b>
              。喺發出訂單確認之前，你同我哋之間唔存在任何具約束力嘅買賣合約。
            </p>
          </KeyBox>
          <p>
            4.4
            合約只涵蓋訂單確認電郵所列嘅貨品。如部分貨品缺貨，我哋可以只確認訂單嘅一部分，未獲確認嘅部分會按第
            7.3 條退款。
          </p>
        </Section>

        <Section num="05" title="付款">
          <p>
            5.1 本網站<b className="text-txt-1">不設網上刷卡</b>
            。落單後，請用本網站公布嘅付款方式付款；可用嘅付款方式及收款資料，以本網站「付款方式」頁及結帳頁不時公布為準。
          </p>
          <p>
            5.2 <b className="text-txt-1">付款期限</b>：落單後{' '}
            <b className="text-txt-1">48 小時（2 天）</b>
            內完成付款並上傳付款截圖。逾期未上傳截圖嘅訂單會被系統
            <b className="text-txt-1">自動取消</b>，貨品會放返出嚟發售，恕不另行通知。
          </p>
          <p>
            5.3
            付款截圖須清晰顯示付款金額、日期及交易參考資料。截圖模糊、金額不符或無法核實嘅，我哋可以要求你補交證明，或按第
            7.2 條拒絕訂單。
          </p>
          <p>
            5.4
            付款金額以訂單所示嘅應付總額為準。少付嘅訂單唔會獲確認；多付嘅金額會喺核實後退還。
          </p>
          <p>
            5.5 <b className="text-txt-1">防偽冒聲明</b>：我哋嘅收款戶口及識別碼
            <b className="text-txt-1">只會</b>喺本網站公布。我哋絕對唔會經 WhatsApp
            私訊、Facebook
            留言或 Messenger 私訊等其他渠道提供其他收款戶口。如有懷疑，請先經第 14.7 條嘅方法同我哋核實。
          </p>
          <p>
            5.6
            貨品所有權喺我哋收妥全數款項後轉移畀你。因銀行、FPS
            或支付平台處理延誤或故障導致嘅核實延遲，我哋概不負責。
          </p>
        </Section>

        <Section num="06" title="價格、存貨與標價錯誤">
          <p>
            6.1
            貨品價格以結帳時本網站顯示為準。直播間口頭報價或限時優惠，一切以本網站結帳頁顯示及訂單確認為準。
          </p>
          <p>
            6.2
            網站及直播顯示嘅存貨數量只屬參考。直播期間如同一貨品超出存貨，會按付款核實嘅先後順序分配；未能分配嘅訂單部分會全額退款。
          </p>
          <KeyBox>
            <p>
              <b className="text-txt-1">6.3 標價錯誤</b>
              ：如貨品價格因人為、電腦或系統錯誤而出錯（例如標價明顯低於合理價格），我哋保留權利喺發出訂單確認之前，拒絕或取消受影響嘅訂單（包括已付款嘅訂單）；已收取嘅款項會按第
              7.3
              條全額退還，你唔可以就呢類取消追討其他賠償。即使喺發出訂單確認之後，如發現價格存在明顯錯誤，我哋亦保留取消訂單並全額退款嘅權利。
            </p>
          </KeyBox>
          <p>
            6.4 貨品價格可能不時調整；已確認嘅訂單唔受影響，其後嘅價格調整或推廣優惠唔可以追溯。
          </p>
        </Section>

        <Section num="07" title="訂單取消與審批">
          <p>
            7.1 <b className="text-txt-1">你嘅取消權</b>
            ：喺我哋發出訂單確認之前，你可以經 WhatsApp、
            電郵或 Facebook Messenger 取消訂單；已付款嘅，我哋會按第 7.3
            條退款。訂單確認發出之後，你唔可以單方面取消訂單。
          </p>
          <p>
            7.2
            <b className="text-txt-1">我哋嘅審批權</b>
            ：我哋可以基於合理理由，拒絕或取消未確認嘅訂單，包括（但不限於）：
          </p>
          <UL
            items={[
              '付款截圖未能核實、模糊不清或金額不符；',
              '貨品存貨不足；',
              '價格錯誤（第 6.3 條）；',
              '同一客人短時間內重複異常落單，或懷疑欺詐、炒賣、盜用他人付款資料；',
              '未能安排送貨到你提供嘅地址或取貨點。',
            ]}
          />
          <p>
            7.3 <b className="text-txt-1">退款</b>
            ：凡我哋拒絕、取消或未能確認嘅訂單（或其部分），已收取嘅款項會喺{' '}
            <b className="text-txt-1">7 個工作天內</b>
            經原付款方式全額退還。除退款外，我哋毋須就拒絕或取消訂單承擔其他責任。
          </p>
          <p>
            7.4
            我哋收到付款截圖後會盡快審批。審批需時，請耐心等候；如超過 3
            個工作天仍未收到回覆，歡迎聯絡我哋查詢。
          </p>
        </Section>

        <Section num="08" title="送貨">
          <p>
            8.1 所有訂單經<b className="text-txt-1">順豐速運</b>
            派送，你可以揀：送貨上門、順豐站自取或順豐智能櫃自取。
          </p>
          <p>
            8.2 <b className="text-txt-1">運費一律順豐到付</b>
            ，由收件人喺收貨時直接畀順豐；貨品售價唔包運費。順豐運費以其官方收費為準。
          </p>
          <p>
            8.3 訂單確認後，貨品喺一般情況下會於{' '}
            <b className="text-txt-1">7–10 個工作天內</b>
            寄出；惟呢個只屬預計時間，
            <b className="text-txt-1">如超過上述時限，我哋概不負責</b>
            。所有送貨及寄出時間只屬估計，我哋會盡力而為，但唔保證完全準確；因順豐或不可抗力（第
            13.5 條）導致嘅延誤，我哋亦概不負責。
          </p>
          <p>
            8.4
            貨品交予順豐派送、或送達你指定嘅地址／順豐站／智能櫃後，遺失或損毀嘅風險即轉移畀你。請收件時即場檢查貨品。
          </p>
          <p>
            8.5
            你必須提供準確嘅收件資料。因地址、電話或取貨點資料錯誤導致嘅額外運費、退回或延誤，由你承擔。無人收件或逾期未取件嘅安排，以順豐速運嘅政策為準。
          </p>
        </Section>

        <Section num="09" title="退貨與換貨">
          <p>
            9.1 香港法例<b className="text-txt-1">冇</b>
            規定網購必須提供冷靜期。除本條款訂明嘅情況外，已出售嘅貨品恕
            <b className="text-txt-1">不設無理由退貨或退款</b>
            （例如唔啱心水、同想像唔同）。
          </p>
          <p>
            9.2 <b className="text-txt-1">你嘅法定權利不受影響</b>
            ：如貨品有缺陷或損壞（並非你造成）、同本網站描述唔相符、寄錯貨或數量唔啱，你可以喺
            <b className="text-txt-1">收貨後 7 天內</b>
            經 WhatsApp、電郵或 Facebook
            Messenger（m.me/redcodexhk）聯絡我哋（附上貨品相片及訂單編號）。經核實後，我哋會安排換貨；無貨可換嘅，全額退款。本條款嘅任何內容，均唔會排除或限制你根據香港《貨品售賣條例》（第
            26 章）享有嘅法定權利。
          </p>
          <p>
            9.3 退換貨品必須未經穿著或使用、吊牌未剪、原包裝完整。基於衛生理由，
            <b className="text-txt-1">貼身衣物及襪類</b>
            一經售出恕不接受退換（第 9.2 條嘅瑕疵情況除外）。
          </p>
          <p>
            9.4 因第 9.2
            條（我哋嘅錯失或貨品問題）產生嘅退換，來回運費由我哋承擔；其他經我哋同意嘅退換，運費由你承擔。
          </p>
          <p>9.5 退款會經原付款方式喺核實後 7 個工作天內退還。</p>
        </Section>

        <Section num="10" title="優惠碼與會員優惠">
          <p>
            10.1
            優惠碼唔可以兌換現金，每張訂單只可以使用一個，並受其本身嘅使用條件（最低消費、限期、限用次數）約束。
          </p>
          <p>10.2 訂單如被取消（不論你定我哋取消），已使用嘅優惠碼恕唔退還或恢復。</p>
          <p>
            10.3
            各項優惠、推廣及會員福利（包括迎新優惠碼、生日優惠）可以隨時修改或終止，恕不另行通知；濫用優惠（例如開多個帳號重複使用限用優惠碼）嘅，我哋可以取消相關訂單或帳號。
          </p>
        </Section>

        <Section num="11" title="用戶行為規範">
          <p>11.1 你同意唔會：</p>
          <UL
            items={[
              '提供虛假資料、偽造付款截圖或盜用他人付款方式；',
              '以任何方式攻擊、干擾或破壞本網站；',
              '利用本網站嘅錯誤或漏洞謀取不當利益；',
              '大量購買以轉售圖利（炒賣），或從事任何違法活動。',
            ]}
          />
          <p>11.2 違反本條嘅，我哋可以取消相關訂單、暫停或終止帳號，並保留追究權利。</p>
        </Section>

        <Section num="12" title="知識產權">
          <p>
            12.1
            本網站及直播嘅所有內容（包括文字、圖片、相片、影片、直播片段、標誌及商標），均屬
            RedCode
            或其許可人所有。未經我哋書面同意，你唔可以複製、轉載、截圖轉發作商業用途或以任何方式使用。
          </p>
          <p>
            12.2
            你喺本網站或直播留言、評價或上傳嘅內容，你授予我哋非獨家、免費嘅使用許可，用作營運及推廣本網站。
          </p>
        </Section>

        <Section num="13" title="免責聲明與責任限制">
          <p>
            13.1
            本網站按「現狀」提供。我哋唔保證網站唔會中斷、無錯誤或完全安全；貨品相片嘅顏色可能因屏幕顯示同實物有差異，尺寸由人手量度，1–3
            厘米誤差屬合理範圍。
          </p>
          <p>
            13.2
            本網站載有第三方連結（例如 Facebook、順豐速運網站），其內容及服務由第三方負責，我哋概不負責。
          </p>
          <p>
            13.3
            喺法例許可嘅最大範圍內，我哋唔會就任何間接或相應而生嘅損失（例如利潤或商譽損失）承擔責任；我哋就每張訂單嘅總責任，以該訂單嘅應付總額為上限。
          </p>
          <p>
            13.4 本條款嘅任何內容，均<b className="text-txt-1">唔會</b>
            排除或限制：(a) 因我哋疏忽引致人身傷亡嘅責任；(b)
            你根據《貨品售賣條例》（第 26 章）享有、依法唔可以被排除嘅權利；(c)
            欺詐嘅責任；或 (d) 任何依法唔可以被排除嘅其他責任。
          </p>
          <p>
            13.5 <b className="text-txt-1">不可抗力</b>
            ：因天災、惡劣天氣（包括八號或以上風球、黑色暴雨）、疫情、罷工、速遞停運或其他我哋無法合理控制嘅事件，導致延遲或未能履行訂單嘅，我哋唔承擔責任，但會通知你，並按第
            7.3 條安排退款（如適用）。
          </p>
        </Section>

        <Section num="14" title="一般條款">
          <p>
            14.1 <b className="text-txt-1">私隱</b>
            ：我哋高度重視你嘅私隱。你提供嘅個人資料之收集、使用、儲存及披露，一概受我哋嘅
            <Link to="/privacy" className="text-pink-soft underline underline-offset-4 hover:opacity-80">
              《私隱政策》
            </Link>
            規管；使用本網站即表示你同意按該政策處理有關資料。
          </p>
          <p>
            14.2 <b className="text-txt-1">條款修訂</b>
            ：我哋可以不時修訂本條款，修訂後會喺本頁公布並註明更新日期，公布即時生效。你喺修訂後繼續使用本網站，即接受修訂後嘅條款；但你落單時已存在嘅訂單，仍按你落單當時嘅條款版本處理。
          </p>
          <p>
            14.3 <b className="text-txt-1">可分割性</b>
            ：本條款任何部分如被裁定無效或不可執行，其餘部分繼續有效。
          </p>
          <p>
            14.4 <b className="text-txt-1">完整協議</b>
            ：本條款連同《私隱政策》，構成你同我哋之間就本網站購物嘅完整協議。
          </p>
          <p>14.5 本條款以中文版本為準。</p>
          <p>
            14.6 <b className="text-txt-1">管轄法律及法院</b>
            ：本條款受香港特別行政區法律管轄，並按其詮釋。你同我哋同意接受香港法院嘅專有管轄權。
          </p>
          <p>14.7 <b className="text-txt-1">聯絡我哋</b>：如對本條款或訂單有任何疑問，歡迎聯絡：</p>
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
        <p>本條款以中文版本為準。</p>
        <p className="mt-2">
          另請參閱{' '}
          <Link to="/privacy" className="text-pink-soft underline underline-offset-4 hover:opacity-80">
            私隱政策（Privacy Policy）
          </Link>
        </p>
      </footer>
    </div>
  );
}
