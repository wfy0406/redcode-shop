# RedCode Fashion Design 官方購物網站 — 全棧（Vite build + Hono/tRPC server）
FROM node:20

WORKDIR /app

# v2.2.0：VIP 晉升恭賀信用 sharp 即場畫 SVG→JPG，容器要有中文字型
# （fonts-noto-cjk 提供 Noto Serif/Sans CJK TC）；冇字型中文會變豆腐格
# R14（2026-11-19）：gosu 畀 entrypoint 修補 mounted disk 擁有權後落返非 root 用戶
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk gosu \
  && rm -rf /var/lib/apt/lists/*

# node:20 自帶 npm 10.8 有「Exit handler never called」bug，先升級 npm
RUN npm install -g npm@11 --no-audit --no-fund

# 先裝依賴（利用 docker layer cache）
COPY package.json package-lock.json .npmrc ./
# P2-5（2026-10 安全修復）：npm install → npm ci——依賴全部由 lockfile 鎖定，
# build 唔再即場拉「最新相容版」（供應鏈風險）；audit 報告照跑。
# lockfile 嘅 mirror resolved URL 由 .npmrc 嘅 replace-registry-host=always 處理，
# 唔再 sed 改寫 lockfile。（lockfile 補齊 html2canvas/jspdf 由主 agent 跟進）
RUN npm ci --audit --no-fund

# 拷貝源碼、還原圖片/影片（assets-b64 → public/），然後 build
COPY . .
RUN node scripts/decode-assets.mjs
RUN npm run build

# R18（2026-11-19）：build 完即剔走 devDependencies——vite／eslint／typescript 等
# 唔入 runtime attack surface；dist/boot.js 係 esbuild self-contained bundle
# （sharp 係 production dependency 並以 --external 載入），npm start 唔需要 dev 依賴。
RUN npm prune --omit=dev

# R14（2026-11-19）：uploads 目錄預設交畀 node 用戶（image 內建路徑；
# Render Persistent Disk mount 會覆蓋 owner，entrypoint 開機會再 chown 一次）
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000

# R14：healthcheck 用 render.yaml 同一條 healthCheckPath（/api/trpc/ping，公開 tRPC query）。
# Render 平台層面嘅健康檢查照舊由 render.yaml 負責；呢個 HEALTHCHECK 畀 docker
# 原生／其他編排平台用，兩者語意一致。
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/trpc/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# server 讀 process.env.PORT || 3000；DATABASE_URL / JWT_SECRET 等由平台注入
# R14：entrypoint 以 root 起步只為修補掛載碟擁有權，即刻 gosu 落 node 用戶先起 server
# （主 process 非 root；docker exec 入去 id 仍然係 root——要完全 non-root 容器，
#  需平台層面唔再依賴 root 修補 mount owner，屬 staging 驗證後嘅後續項）
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/boot.js"]
