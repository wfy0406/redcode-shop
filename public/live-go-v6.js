// live-go-v6.html 主邏輯（2026-10-24 H2 安全覆核修復：inline 原樣外置，CSP script-src 'self' 先過到）
(function () {
  var manual = document.getElementById('manual');
  var weblink = document.getElementById('weblink');
  var sub = document.getElementById('sub');

  // ① 攞 ?u= 目標連結，只准 FB 系域名（擋 open-redirect 濫用）
  var u = '';
  try {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get('u') || '';
    if (raw) {
      var parsed = new URL(raw);
      var host = parsed.hostname.toLowerCase();
      var ok = parsed.protocol === 'https:' &&
        (host === 'facebook.com' || host.endsWith('.facebook.com') ||
         host === 'fb.watch' || host === 'fb.me' || host.endsWith('.fb.me'));
      if (ok) u = raw;
    }
  } catch (e) { u = ''; }

  if (!u) { window.location.replace('/'); return; }

  var ua = navigator.userAgent || '';
  var isAndroid = /Android/i.test(ua);
  var isIOS = /iPhone|iPad|iPod/i.test(ua);

  // 桌面機：唔使玩深鏈，直接去 FB 網頁版
  if (!isAndroid && !isIOS) {
    weblink.href = u;
    manual.href = u;
    window.location.replace(u);
    return;
  }

  var fellBack = false;   // 已經落咗網頁版
  var prompted = false;   // blur 過＝系統窗／app 彈過出嚟
  var timers = [];
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function clearAll() { for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]); }

  // 一有失焦（系統「開啟 app」窗、app 選擇器、入咗 app）→ 殺晒 timer；
  // 頁面隱藏（入咗 app／開咗 in-app browser）→ 一樣殺
  window.addEventListener('blur', function () { prompted = true; clearAll(); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearAll();
  });
  window.addEventListener('pagehide', clearAll);

  // 所有延遲動作嘅共同守衛：彈過窗／入咗 app／已落網頁版就乜都唔做
  function guard() { return !prompted && !document.hidden && !fellBack; }

  function toWeb() {
    if (fellBack) return;
    fellBack = true;
    window.location.href = u;
  }

  // 用戶喺系統窗撳「取消」返嚟 → 開條 8s 長 timer，最終落到網頁版唔會卡住
  window.addEventListener('focus', function () {
    if (prompted && !fellBack && !document.hidden) {
      clearAll();
      later(function () { if (!document.hidden && !fellBack) toWeb(); }, 8000);
    }
  });

  weblink.href = u;

  // ───────────────────────────── iOS（v6 老闆拍板）─────────────────────────────
  // 自動：乜都唔試開 App，4 秒直接落網頁版條片——客人實落到條片。
  // 金掣：「用 Facebook App 睇直播」真 https 連結（universal link，iOS 唯一
  // 有可能入 App 條片嘅機制，要親手撳）；入唔入到條片睇 FB App 版本，
  // 最差情況都係網頁版條片，撳唔撳由客決定。
  if (isIOS) {
    sub.innerHTML = '幾秒後自動開網頁版直播；<br>想用 Facebook App 睇，撳下面個金掣';
    manual.textContent = '用 Facebook App 睇直播';
    manual.href = u;
    manual.target = '_blank';   // 關閉 in-app browser 返嚟 PWA 唔會 reload
    manual.rel = 'noopener';
    later(function () { if (guard()) toWeb(); }, 4000);
    return;
  }

  // ───────────────────── Android（同 v5 一字唔改，老闆指令）─────────────────────
  // 一槍 https-intent：scheme=https＋package 指實 FB，行 App Links 原生路線直達條片。
  // 唔用 S.browser_fallback_url：Chrome 擋 gestureless 嗰陣會即刻扯去 fallback，
  // 金掣冇機會畀人撳；自己嘅 guarded timer 先係可控嘅後備。
  var intentUrl = '';
  try {
    var up = new URL(u);
    intentUrl = 'intent://' + up.host + up.pathname + up.search +
      '#Intent;scheme=https;package=com.facebook.katana;end';
  } catch (e) { intentUrl = ''; }

  var isSamsung = /SamsungBrowser/i.test(ua);

  function fireIntent() {
    if (!intentUrl) return;
    try { window.location.href = intentUrl; } catch (e) { /* 靜音 */ }
  }

  // 金掣＝intent 連結（手勢下 Chrome 實彈「開啟應用程式」）
  if (intentUrl) manual.href = intentUrl;
  else manual.href = u;

  // 自動一槍：Chrome 會 silent 擋（頁面留喺度等金掣）；Samsung 會彈系統窗。
  // 全頁只有呢一槍——唔好連發（連發會踩走 Samsung 個窗）。
  fireIntent();

  // 後備 timer：Chrome 6 秒（自動槍被擋，等用戶撳金掣）；Samsung 12 秒
  // （系統窗可能彈緊而我哋偵測唔到——畀足時間用戶撳「開啟」先落網頁版）
  later(function () { if (guard()) toWeb(); }, isSamsung ? 12000 : 6000);

  // 金掣撳完 2.5 秒仲喺度（罕見：手勢都被擋／冇裝 app 冇 fallback）→ 自己落網頁版
  manual.addEventListener('click', function () {
    later(function () { if (guard()) toWeb(); }, 2500);
  });

  // 成版任何位撳一下都當金掣使（細字網頁版連結同金掣本身除外——佢哋有自己嘅路）
  document.addEventListener('pointerdown', function (ev) {
    if (fellBack) return;
    if (ev.target === weblink || ev.target === manual) return;
    fireIntent();
  });
})();
