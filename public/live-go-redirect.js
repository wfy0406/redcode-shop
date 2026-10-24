// 舊跳板頁（live-go.html／live-go-v2…v5.html）共用：即刻過骨去新版 live-go-v6.html（保留 ?u= 參數同 hash）。
// 2026-10-24（H2 安全覆核修復）：inline script 原樣外置——全域 CSP script-src 冇 unsafe-inline，
// inline 會被擋；外置同域 .js 行 script-src 'self' 就過到。
window.location.replace('/live-go-v6.html' + window.location.search + window.location.hash);
