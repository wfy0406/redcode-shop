#!/bin/sh
# R14（2026-11-19 安全修復）：非 root 運行 entrypoint。
# Render Persistent Disk 掛載喺 /app/uploads，mount 後 owner 可能係 root——
# 開機先修補擁有權（失敗只警告，唔阻開機），然後用 gosu 落返 node 用戶跑 server。
# 主 process 以非 root 行；runtime 寫入路徑（UPLOADS_DIR 及其子目錄、
# TRYON_PRIVATE_DIR）都喺度修補，node 用戶有權寫。
# 注意：UPLOADS_DIR／TRYON_PRIVATE_DIR 如係相對路徑，會以 WORKDIR（/app）為根解析。
set -e

fix_owner() {
  dir="$1"
  mkdir -p "$dir" 2>/dev/null || true
  if ! chown -R node:node "$dir" 2>/dev/null; then
    echo "[entrypoint] 警告：chown $dir 失敗（可能係唯讀掛載），上傳功能或受影響" >&2
  fi
}

fix_owner "${UPLOADS_DIR:-/app/uploads}"
# 私人試穿圖目錄（預設喺 UPLOADS_DIR/tryon-private，已隨上步覆蓋；自訂路徑先需要獨立修補）
if [ -n "$TRYON_PRIVATE_DIR" ]; then
  fix_owner "$TRYON_PRIVATE_DIR"
fi

exec gosu node "$@"
