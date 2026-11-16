import { useState } from 'react';
import { Check, Download, MoreVertical, Share } from 'lucide-react';
import {
  CHROME_ANDROID_INSTALL_INTENT,
  isAndroid,
  isChromeAndroid,
  isIos,
  promptPwaInstall,
  usePwaInstall,
} from '@/lib/pwaInstall';

type InstallTab = 'iphone' | 'android';

/** FAQ 專用 PWA 安裝區：原生提示可用就真正安裝，否則提供對應瀏覽器步驟。 */
export default function AppInstallGuide() {
  const { canInstall, installed } = usePwaInstall();
  const [tab, setTab] = useState<InstallTab>(() => (isIos() ? 'iphone' : 'android'));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const needsChrome = isAndroid() && !isChromeAndroid();

  const install = async () => {
    if (needsChrome) {
      setTab('android');
      setStatus('Android 必須使用最新版 Chrome 安裝。請撳「用 Chrome 開啟並安裝」，再到 Chrome 確認安裝。');
      return;
    }
    if (installed) {
      setStatus('呢個裝置已經安裝咗 RedCode APP，可以由主畫面直接開啟。');
      return;
    }
    setBusy(true);
    setStatus('正在準備安裝…系統生成 App 可能要幾分鐘，請耐心等候，唔好重複安裝。');
    const outcome = await promptPwaInstall();
    if (outcome === 'accepted') {
      setStatus('已確認安裝，系統正在背景準備；可能要幾分鐘，請唔好重複安裝。');
    } else if (outcome === 'dismissed') {
      setTab('android');
      setStatus('你取消咗系統安裝；如果想再裝，可以跟下面 Android 瀏覽器步驟。');
    } else if (outcome === 'error') {
      setStatus('系統安裝提示未能開啟，請跟下面瀏覽器步驟安裝。');
    } else {
      const apple = isIos();
      setTab(apple ? 'iphone' : 'android');
      setStatus(
        apple
          ? 'iPhone 唔支援網頁直接彈出安裝窗，請用 Safari 跟下面三步加入主畫面。'
          : '而家瀏覽器未提供一撳安裝提示，請用 Chrome 開 RedCode，再跟下面步驟由選單安裝。',
      );
    }
    setBusy(false);
  };

  return (
    <div className="faq-install-guide">
      <div className="faq-install-intro">
        <img src="/pwa-icon-192.png" alt="" aria-hidden="true" />
        <div>
          <h3>RedCode APP</h3>
          <p>唔使經 App Store／Google Play；安裝後由主畫面一撳入店，更就手接收開播通知。</p>
        </div>
      </div>

      {needsChrome ? (
        <a
          href={CHROME_ANDROID_INSTALL_INTENT}
          className="faq-install-button inline-flex items-center justify-center gap-2 no-underline"
        >
          <Download size={19} aria-hidden="true" />
          用 Chrome 開啟並安裝
        </a>
      ) : (
        <button
          type="button"
          className="faq-install-button"
          onClick={() => void install()}
          disabled={busy || installed}
        >
          {installed ? <Check size={19} aria-hidden="true" /> : <Download size={19} aria-hidden="true" />}
          {installed ? '已安裝 RedCode APP' : busy ? '系統準備中，可能要幾分鐘…' : canInstall ? '立即安裝 RedCode APP' : '安裝 RedCode APP'}
        </button>
      )}
      {needsChrome && (
        <p className="faq-install-hint">
          如果按鈕冇反應，請複製 <strong>redcode.red/faq</strong>，再喺最新版 Chrome 開啟。
        </p>
      )}
      <p className="faq-install-hint">Android 必須使用最新版 Chrome 安裝；系統生成 App 可能要幾分鐘。iPhone 會話你知 Safari 安裝步驟。</p>
      {status && <p className="faq-install-status" role="status">{status}</p>}

      <div className="faq-tabs faq-install-tabs" role="tablist" aria-label="揀返你嘅手機系統">
        {(['iphone', 'android'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`app-install-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`app-install-panel-${key}`}
            className="faq-tab"
            data-active={tab === key}
            onClick={() => setTab(key)}
          >
            {key === 'iphone' ? 'iPhone' : 'Android'}
          </button>
        ))}
      </div>

      {tab === 'iphone' ? (
        <ol
          id="app-install-panel-iphone"
          role="tabpanel"
          aria-labelledby="app-install-tab-iphone"
          className="faq-install-steps"
        >
          <li><b>1</b><span>用 <strong>Safari</strong> 開 RedCode 網站；如果而家喺其他 APP 入面，先揀「用 Safari 開啟」。</span></li>
          <li><b>2</b><span>撳 Safari 底部嘅 <strong>分享</strong> <Share size={18} aria-label="分享" /> 掣。</span></li>
          <li><b>3</b><span>向下滑揀 <strong>「加入主畫面」</strong>，再撳右上角「新增」，即完成安裝。</span></li>
        </ol>
      ) : (
        <ol
          id="app-install-panel-android"
          role="tabpanel"
          aria-labelledby="app-install-tab-android"
          className="faq-install-steps"
        >
          <li><b>1</b><span><strong>Android 必須使用最新版 Chrome 安裝。</strong>如果你而家用緊 Samsung Internet／其他瀏覽器，先撳上面「用 Chrome 開啟並安裝」。</span></li>
          <li><b>2</b><span>喺 Chrome 撳上面「立即安裝」；如果未見系統提示，撳右上角 <strong>選單</strong> <MoreVertical size={18} aria-label="選單" />，再揀「安裝應用程式」。</span></li>
          <li><b>3</b><span>確認後耐心等候系統生成 App，<strong>可能要幾分鐘</strong>；期間唔好重複安裝。完成後會出現 RedCode 主畫面圖示。</span></li>
        </ol>
      )}
    </div>
  );
}
