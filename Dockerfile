# RedCode Fashion Design 官方購物網站 — 全棧（Vite build + Hono/tRPC server）
FROM node:20

WORKDIR /app

# v2.2.0：VIP 晉升恭賀信用 sharp 即場畫 SVG→JPG，容器要有中文字型
# （fonts-noto-cjk 提供 Noto Serif/Sans CJK TC）；冇字型中文會變豆腐格
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk \
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

ENV NODE_ENV=production
EXPOSE 3000

# server 讀 process.env.PORT || 3000；DATABASE_URL / JWT_SECRET 等由平台注入
CMD ["node", "dist/boot.js"]
