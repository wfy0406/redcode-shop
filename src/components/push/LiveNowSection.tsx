import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ExternalLink, Play } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { isPushSupported } from '@/lib/pushClient';
import { openFacebookLive, isSamsungInternet, isAppleMobile } from '@/lib/openLive';
import PushPermissionGuide from '@/components/push/PushPermissionGuide';
import FbPlayerOverlay from '@/components/push/FbPlayerOverlay';
import BackupThumb, { pickLiveBackup } from '@/components/push/BackupThumb';

/**
 * 直播進行中展示區（v2.2.2 高度美化版，2026-09-30 老闆指令：要生動、要動感）
 *
 * trpc.push.currentLive（publicQuery，60 秒 refetch）——後端回最新一筆
 * status='sent'、sentAt 喺 90 分鐘內、未被「落畫」（endedAt IS NULL）嘅直播；
 * 冇直播 → 成個 section 唔 render。
 * id="live-now"：首頁頂部 LiveTopBanner 撳咗會 smooth scroll 落嚟呢度。
 *
 * 動感設計（全部淨 opacity／transform，合老闆鐵律；reduced-motion 全停）：
 * - 外框：雙層 radial 紅金光暈呼吸（opacity）＋ shimmer 掃光（translateX）
 * - LIVE pill：紅點呼吸＋EQ 聲波條（scaleY 跳動，似緊直播聲浪）
 * - 右側海報卡：慢浮（translateY）＋播放掣 ping 環（scale＋opacity 擴散）
 * - 右側海報卡：v2.2.8 起後端 resolveFbEmbedUrl 認到影片 ID（短鏈都解）
 *   → 撳 ▶ 原位載入 FB 播放器，唔離開官網都睇到直播；
 *   認唔到 → 成張卡撳得，openFacebookLive 經 /live-go-v6.html 跳板去條片（推播成功路線：iPhone 網頁版條片＋金掣試 app、Android https-intent 直開 app）。
 */
export default function LiveNowSection() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [showGuide, setShowGuide] = useState(false);
  // v2.2.27（老闆實測：Samsung 瀏覽器撳唔郁、iPhone 淨係放大先播到、Chrome 唔自動播）：
  // FB 嵌入播放器喺手機一定要「用戶手勢」入面新鮮載入先穩陣（所以放大睇度度都 work），
  // 且有聲 autoplay 三大手機瀏覽器全部封晒。改做「真・縮圖海報 → 一撳即播（有聲）」：
  // 撳嗰下先 mount iframe，等於將放大睇嘅成功路線搬埋落原位播放器。
  const [playing, setPlaying] = useState(false);
  const [full, setFull] = useState(false);
  // v2.2.28（老闆回報「縮圖壞咗」）：thumbUrl 係後端代摷 FB 圖，FB 對 server IP 時好時壞；
  // 載入失敗即刻落後備縮圖，永遠唔出 broken icon；換場直播自動重試新縮圖
  const [thumbBroken, setThumbBroken] = useState(false);
  // v2.2.30（老闆指令「哈利波特式會郁嘅後備縮圖」）：直播後備 10 條隨機一條，
  // mount 嗰刻揀定，成個 session 唔變
  const [liveBackupIdx] = useState(pickLiveBackup);

  const liveQuery = trpc.push.currentLive.useQuery(undefined, {
    refetchInterval: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  // 已登入先查訂閱狀態（決定顯唔顯示「通知我開播」副掣）
  const statusQuery = trpc.push.myPushStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const live = liveQuery.data?.live ?? null;
  // 換咗另一場直播（url 變）→ 縮圖狀態重設，新縮圖照試載
  const liveUrl = live?.url ?? null;
  useEffect(() => {
    setThumbBroken(false);
  }, [liveUrl]);
  if (!live) return null;

  // v2.2.30（老闆實測：佢部 Samsung 機撲咗 iframe 都無反應，人哋部 Samsung 睇到）：
  // Samsung Internet「智能防追蹤」個別機會擋死 FB 嵌入播放器 → 呢類機全部
  // 行 v6 跳板直開 FB（app／網頁版），唔再喺官網入面塞 iframe
  const samsung = isSamsungInternet();
  // v2.2.32（老闆指令「iphone 淨係直播唔係站內播，用 live go 果頁轉去 facebook」）：
  // iPhone／iPad 睇直播一撳就行 v6 跳板去 FB（4 秒自動網頁版條片＋金掣試 app），
  // 唔再開站內全屏 overlay；直播重溫嗰邊維持 overlay 唔郁
  const apple = isAppleMobile();

  const subscribed = !!statusQuery.data?.optIn && (statusQuery.data?.activeDevices ?? 0) > 0;

  const handleNotifyMe = () => {
    if (!user) {
      navigate('/login');
      return;
    }
    setShowGuide(true);
  };

  return (
    <section
      id="live-now"
      className="mx-auto max-w-[1280px] scroll-mt-6 px-5 pt-10 md:px-8 md:pt-14 xl:px-12"
      aria-label="直播進行中"
    >
      <div
        className="livenow-card relative overflow-hidden border px-6 py-10 md:px-12 md:py-14"
        style={{
          borderColor: 'rgba(255, 0, 84, 0.45)',
          background:
            'linear-gradient(180deg, var(--space-2) 0%, var(--space-1) 100%)',
        }}
      >
        {/* 動感光暈層 ①：左紅右金雙 radial，opacity 呼吸錯相位 */}
        <div
          aria-hidden="true"
          className="livenow-glow-a pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(560px 340px at 12% 0%, rgba(255, 0, 84, 0.22) 0%, transparent 70%)',
          }}
        />
        <div
          aria-hidden="true"
          className="livenow-glow-b pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(620px 380px at 95% 100%, rgba(245, 197, 24, 0.14) 0%, transparent 70%)',
          }}
        />
        {/* 動感層 ②：斜向 shimmer 掃光（transform translateX，極低透明度） */}
        <div
          aria-hidden="true"
          className="livenow-shimmer pointer-events-none absolute inset-y-0 w-1/3"
          style={{
            background:
              'linear-gradient(105deg, transparent 0%, rgba(255, 247, 232, 0.05) 45%, rgba(255, 247, 232, 0.09) 50%, rgba(255, 247, 232, 0.05) 55%, transparent 100%)',
          }}
        />

        <div className="relative grid items-center gap-8 lg:grid-cols-2">
          {/* 左：LIVE pill＋serif 大標＋CTA */}
          <div>
            <p
              className="inline-flex items-center gap-2.5 rounded-full border px-4 py-1.5 font-mono text-[12px] font-medium tracking-[0.25em]"
              style={{ borderColor: 'rgba(255, 0, 84, 0.5)', color: 'var(--pink-tint)' }}
              aria-live="off"
            >
              {/* 🔴 紅點 opacity 呼吸（淨 opacity，合鐵律） */}
              <span
                className="livenow-dot inline-block h-2 w-2 rounded-full"
                style={{ background: 'var(--pink)' }}
                aria-hidden="true"
              />
              LIVE 直播進行中
              {/* EQ 聲波條（scaleY transform 跳動） */}
              <span className="ml-1 inline-flex items-end gap-[3px]" aria-hidden="true">
                <span className="livenow-eq inline-block h-[10px] w-[3px] rounded-sm" style={{ background: 'var(--pink-tint)', animationDelay: '0s' }} />
                <span className="livenow-eq inline-block h-[10px] w-[3px] rounded-sm" style={{ background: 'var(--pink-tint)', animationDelay: '0.25s' }} />
                <span className="livenow-eq inline-block h-[10px] w-[3px] rounded-sm" style={{ background: 'var(--pink-tint)', animationDelay: '0.5s' }} />
              </span>
            </p>
            <h2 className="mt-5 font-serif-tc text-3xl font-bold leading-[1.25] text-starlight md:text-[40px]">
              Glo Glo 開咗台啦！
            </h2>
            <p className="mt-3 font-serif-tc text-lg leading-[1.5] text-gold-soft md:text-xl">
              {live.liveDate}・{live.liveSession}
            </p>
            <p className="mt-4 max-w-md text-[14px] leading-[1.8] text-txt-2">
              即場著身、即場開賣、留言落單。快閃價手快有手慢冇，快啲入嚟一齊睇！
            </p>

            <div className="mt-7 flex flex-col gap-4 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => openFacebookLive(live.url)}
                className="livenow-cta inline-flex w-fit items-center gap-2 rounded-full px-7 py-3 font-serif-tc text-base font-semibold"
                style={{ background: 'var(--gold)', color: 'var(--space-1)' }}
              >
                立即入直播
                <ExternalLink size={16} aria-hidden="true" />
              </button>
              {/* 副掣：已訂閱顯示狀態；未訂閱「通知我開播」；未登入一樣顯示（撳咗去登入） */}
              {subscribed ? (
                <span className="inline-flex w-fit items-center gap-2 text-[14px] text-txt-3">
                  已開啟開播通知 ✓
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleNotifyMe}
                  className="inline-flex w-fit items-center gap-2 border-b pb-1 text-[14px] font-medium text-gold-soft transition-opacity hover:opacity-70"
                  style={{ borderColor: 'var(--gold)' }}
                >
                  🔔 通知我開播
                </button>
              )}
            </div>

            {!isPushSupported() && !subscribed && (
              <p className="mt-3 max-w-md text-[12px] leading-[1.7] text-txt-3">
                iPhone 用戶：Apple 規定要先将 RedCode「加至主畫面」先收得通知——
                撳上面「🔔 通知我開播」有齊圖文教學，30 秒搞掂，一勞永逸。
              </p>
            )}
          </div>

          {/*
            右：海報卡（v2.2.8）
            後端認到影片 ID → 撳 ▶ 原位變 FB 播放器（官網直接睇直播）；
            認唔到 → 成張卡撳得，openFacebookLive 經 v6 跳板去 FB 條片（推播成功路線）。
            動感：成卡慢浮（translateY）、播放掣 ping 環擴散（scale＋opacity）。
          */}
          {playing && !samsung && live.embedUrl ? (
            // v2.2.11（老闆指令「反正直播一定係打直」）：直度 9:16 播放器置中，
            // 入官網即自動播；背底先放真・縮圖（載入緊嗰秒唔会黑屏）；
            // 「放大睇」開官網內全屏直度播放器，唔再彈去 FB
            <div
              className="relative mx-auto w-full max-w-[340px] overflow-hidden rounded-2xl border"
              style={{ borderColor: 'rgba(255, 0, 84, 0.4)', background: 'var(--space-1)' }}
            >
              <div className="relative aspect-[9/16] w-full">
                {live.thumbUrl && !thumbBroken ? (
                  <img
                    src={live.thumbUrl}
                    alt=""
                    aria-hidden="true"
                    className="absolute inset-0 h-full w-full object-cover"
                    onError={() => setThumbBroken(true)}
                  />
                ) : (
                  // v2.2.30：真縮圖摷唔到 → 後備靜態海報墊底（iframe 載入嗰秒唔會黑屏）
                  <img
                    src={`/live-backup/live-${String(liveBackupIdx).padStart(2, '0')}.jpg`}
                    alt=""
                    aria-hidden="true"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                )}
                {/* v2.2.27：iframe 只會喺客人撳 ▶ 嗰下先 mount（手勢載入） */}
                <iframe
                  src={live.embedUrl}
                  className="absolute inset-0 h-full w-full border-0"
                  allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                  allowFullScreen
                  title="Facebook 直播"
                />
              </div>
              {/* Samsung 機唔會入到呢個分支（上面已擋），呢粒掣照埋喺非 Samsung 先顯示 */}
              {!samsung && (
              <button
                type="button"
                onClick={() => setFull(true)}
                className="absolute right-3 top-3 z-10 inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-[11px] font-medium text-gold-soft"
                style={{ borderColor: 'rgba(245,197,24,0.4)', background: 'rgba(10,6,20,0.72)' }}
                aria-label="放大睇直播（官網全屏）"
              >
                放大睇 ⛶
              </button>
              )}
              {/* v2.2.12（老闆指令）：播放器底下都有「去 Facebook 睇」——
                  有寶寶想返 FB app 睇／留言 */}
              <div className="flex justify-center border-t px-4 py-2.5" style={{ borderColor: 'rgba(255,0,84,0.25)' }}>
                <button
                  type="button"
                  onClick={() => openFacebookLive(live.url)}
                  className="inline-flex items-center gap-1.5 text-[12px] font-medium text-pink-soft transition-opacity hover:opacity-75"
                  aria-label="去 Facebook 睇直播（有裝 app 會開 app）"
                >
                  去 Facebook 睇
                  <ExternalLink size={12} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : live.embedUrl ? (
          // v2.2.27（老闆實測：Samsung 撳唔郁／iPhone 黑屏／Chrome 唔自動播）：
          // 真・縮圖直度海報（同播放器一樣 9:16，撳完唔跳 layout），一撳即播有聲——
          // 手機瀏覽器政策下唯一穩陣路線；畫面係真直播縮圖，唔係黑屏
          <div
            className="relative mx-auto w-full max-w-[340px] overflow-hidden rounded-2xl border"
            style={{ borderColor: 'rgba(255, 0, 84, 0.4)', background: 'var(--space-1)' }}
          >
            <button
              type="button"
              onClick={() => {
                // Samsung 機防追蹤會擋死 FB iframe → 直接行跳板去 FB，保證睇到
                // iPhone（v2.2.32 老闆指令）：直播唔站內播，一樣行 v6 跳板去 FB
                if (samsung || apple) {
                  openFacebookLive(live.url);
                  return;
                }
                setPlaying(true);
              }}
              className="livenow-poster group relative block w-full text-left"
              aria-label={samsung || apple ? '去 Facebook 睇直播' : '一撳即播直播'}
            >
              <div className="relative aspect-[9/16] w-full">
                {live.thumbUrl && !thumbBroken ? (
                  <img
                    src={live.thumbUrl}
                    alt="直播現場縮圖"
                    className="absolute inset-0 h-full w-full object-cover"
                    onError={() => setThumbBroken(true)}
                  />
                ) : (
                  // v2.2.30：摷唔到真縮圖 → 會郁嘅後備海報（Glo Glo 動態＋logo）
                  <BackupThumb kind="live" index={liveBackupIdx} logoPos="tr" />
                )}
                {/* 頂部 LIVE pill（同播放器嘅「直播」badge 呼應） */}
                <span
                  className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[11px] font-medium tracking-[0.2em]"
                  style={{ background: 'rgba(10,6,20,0.72)', color: 'var(--pink-tint)', border: '1px solid rgba(255,0,84,0.5)' }}
                >
                  <span className="livenow-dot inline-block h-1.5 w-1.5 rounded-full" style={{ background: 'var(--pink)' }} aria-hidden="true" />
                  LIVE
                </span>
                {/* 中央播放掣＋ping 環（兩環錯相位擴散） */}
                <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                  <span className="relative flex h-20 w-20 items-center justify-center">
                    <span
                      className="livenow-ping absolute inset-0 rounded-full"
                      style={{ border: '2px solid rgba(245, 197, 24, 0.55)' }}
                    />
                    <span
                      className="livenow-ping absolute inset-0 rounded-full"
                      style={{ border: '2px solid rgba(255, 0, 84, 0.45)', animationDelay: '0.9s' }}
                    />
                    <span
                      className="relative flex h-16 w-16 items-center justify-center rounded-full transition-transform duration-200 group-hover:scale-110"
                      style={{ background: 'var(--gold)', color: 'var(--space-1)' }}
                    >
                      <Play size={26} fill="currentColor" />
                    </span>
                  </span>
                </span>
                {/* 底部提示條（漸變壓底，字唔會被縮圖食咗） */}
                <span
                  className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-0.5 px-4 pb-4 pt-10 text-center"
                  style={{ background: 'linear-gradient(180deg, transparent 0%, rgba(10,6,20,0.85) 100%)' }}
                >
                  {/* v2.2.30（老闆實測「寫住有聲按左都係無聲」）：手機瀏覽器硬規定，
                      iframe 載入嗰下手勢窗口已過，聲音一定被封，要喺播放器入面
                      再撳一下開聲——唔再承諾「有聲」，改教開聲 */}
                  {samsung || apple ? (
                    <>
                      <span className="font-serif-tc text-base font-semibold text-starlight">一撳去 Facebook 睇直播</span>
                      <span className="text-[11px] text-txt-3">
                        {samsung
                          ? '你部 Samsung 機會擋嵌入播放器，直接開 FB 最穩'
                          : '自動開 FB 網頁版，想用 FB App 撳金色掣就得'}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="font-serif-tc text-base font-semibold text-starlight">一撳即播直播</span>
                      <span className="text-[11px] text-txt-3">
                        無聲嘅話喺播放器入面撳一下開聲 🔊
                      </span>
                    </>
                  )}
                </span>
              </div>
            </button>
            <div className="flex justify-center border-t px-4 py-2.5" style={{ borderColor: 'rgba(255,0,84,0.25)' }}>
              <button
                type="button"
                onClick={() => openFacebookLive(live.url)}
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-pink-soft transition-opacity hover:opacity-75"
                aria-label="去 Facebook 睇直播（有裝 app 會開 app）"
              >
                去 Facebook 睇
                <ExternalLink size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
          ) : (
          <button
            type="button"
            onClick={() => openFacebookLive(live.url)}
            className="livenow-poster group relative block w-full overflow-hidden rounded-2xl border text-left"
            style={{ borderColor: 'rgba(255, 0, 84, 0.4)', background: 'var(--space-1)' }}
            aria-label="入 Facebook 睇直播"
          >
            <div className="relative flex aspect-video flex-col items-center justify-center gap-4 px-6">
              {/* 背景紅光暈（radial）＋浮動光斑 */}
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    'radial-gradient(420px 260px at 50% 45%, rgba(255, 0, 84, 0.22) 0%, transparent 70%)',
                }}
                aria-hidden="true"
              />
              <div
                className="livenow-spark pointer-events-none absolute left-[18%] top-[22%] h-1.5 w-1.5 rounded-full"
                style={{ background: 'var(--gold-soft)', animationDelay: '0.6s' }}
                aria-hidden="true"
              />
              <div
                className="livenow-spark pointer-events-none absolute right-[16%] top-[30%] h-1 w-1 rounded-full"
                style={{ background: 'var(--pink-tint)', animationDelay: '1.4s' }}
                aria-hidden="true"
              />
              <div
                className="livenow-spark pointer-events-none absolute bottom-[24%] left-[28%] h-1 w-1 rounded-full"
                style={{ background: 'var(--starlight)', animationDelay: '2.1s' }}
                aria-hidden="true"
              />
              <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.3em] text-pink-tint">
                <span
                  className="livenow-dot inline-block h-2 w-2 rounded-full"
                  style={{ background: 'var(--pink)' }}
                  aria-hidden="true"
                />
                LIVE ON FACEBOOK
              </span>
              {/* 播放掣＋ping 環（兩環錯相位擴散） */}
              <span className="relative flex h-20 w-20 items-center justify-center" aria-hidden="true">
                <span
                  className="livenow-ping absolute inset-0 rounded-full"
                  style={{ border: '2px solid rgba(245, 197, 24, 0.55)' }}
                />
                <span
                  className="livenow-ping absolute inset-0 rounded-full"
                  style={{ border: '2px solid rgba(255, 0, 84, 0.45)', animationDelay: '0.9s' }}
                />
                <span
                  className="relative flex h-16 w-16 items-center justify-center rounded-full transition-transform duration-200 group-hover:scale-110"
                  style={{ background: 'var(--gold)', color: 'var(--space-1)' }}
                >
                  <Play size={26} fill="currentColor" />
                </span>
              </span>
              <span className="font-serif-tc text-lg font-semibold text-starlight">
                入 Facebook 睇直播
              </span>
              <span className="text-[12px] text-txt-3">
                有裝 Facebook 會直接開 app；冇裝就開網頁版
              </span>
            </div>
          </button>
          )}
        </div>
      </div>

      {/* 全屏直度播放器（官網內，唔彈 FB） */}
      {full && live.embedUrl && (
        <FbPlayerOverlay src={live.embedUrl} fbUrl={live.url} title="Facebook 直播" onClose={() => setFull(false)} />
      )}

      {/* 權限講解 modal（訂閱成功會 invalidate 狀態，副掣即轉「已開啟 ✓」） */}
      <PushPermissionGuide
        open={showGuide}
        onClose={(ok) => {
          setShowGuide(false);
          if (ok) {
            void utils.push.myPushStatus.invalidate();
            void utils.auth.me.invalidate();
          }
        }}
      />

      {/*
        動畫定義：全部淨 opacity／transform（老闆鐵律）；
        prefers-reduced-motion 全部停晒，靜態都一樣睇得。
      */}
      <style>{`
        .livenow-dot { animation: livenow-breathe 1.6s ease-in-out infinite; }
        @keyframes livenow-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

        .livenow-eq { transform-origin: bottom; animation: livenow-eq-jump 1.1s ease-in-out infinite; }
        @keyframes livenow-eq-jump {
          0%, 100% { transform: scaleY(0.35); }
          50% { transform: scaleY(1); }
        }

        .livenow-glow-a { animation: livenow-glow-a 3.2s ease-in-out infinite; }
        @keyframes livenow-glow-a { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
        .livenow-glow-b { animation: livenow-glow-b 3.2s ease-in-out infinite 1.6s; }
        @keyframes livenow-glow-b { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }

        .livenow-shimmer { animation: livenow-sweep 4.8s ease-in-out infinite; }
        @keyframes livenow-sweep {
          0% { transform: translateX(-120%) skewX(-8deg); opacity: 0; }
          18% { opacity: 1; }
          55% { transform: translateX(320%) skewX(-8deg); opacity: 1; }
          70%, 100% { transform: translateX(320%) skewX(-8deg); opacity: 0; }
        }

        .livenow-cta { transition: opacity 200ms ease, transform 200ms ease; }
        .livenow-cta:hover { opacity: 0.9; transform: translateY(-1px); }
        .livenow-cta:active { transform: translateY(0) scale(0.98); }

        .livenow-poster { transition: opacity 200ms ease, transform 200ms ease; animation: livenow-float 5.2s ease-in-out infinite; }
        .livenow-poster:hover { opacity: 0.95; }
        .livenow-poster:active { transform: scale(0.99); }
        @keyframes livenow-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-6px); }
        }

        .livenow-ping { animation: livenow-ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite; }
        @keyframes livenow-ping {
          0% { transform: scale(1); opacity: 0.9; }
          80%, 100% { transform: scale(1.55); opacity: 0; }
        }

        .livenow-spark { animation: livenow-spark 2.6s ease-in-out infinite; }
        @keyframes livenow-spark {
          0%, 100% { opacity: 0.15; transform: translateY(0) scale(1); }
          50% { opacity: 0.9; transform: translateY(-4px) scale(1.3); }
        }

        @media (prefers-reduced-motion: reduce) {
          .livenow-dot, .livenow-eq, .livenow-glow-a, .livenow-glow-b,
          .livenow-shimmer, .livenow-poster, .livenow-ping, .livenow-spark {
            animation: none;
          }
          .livenow-shimmer { opacity: 0; }
        }
      `}</style>
    </section>
  );
}
