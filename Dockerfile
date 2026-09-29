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
COPY package.json package-lock.json ./
# lockfile 生成時寫咗沙盒內部/中國 mirror 嘅 resolved URL，公網 build 要轉返 npmjs 官方 registry
RUN sed -i -e 's#https://npm\.mirrors\.msh\.team#https://registry.npmjs.org#g' \
           -e 's#https://registry\.npmmirror\.com#https://registry.npmjs.org#g' \
           package-lock.json \
  && npm install --no-audit --no-fund  # F5: 用 install 唔係 ci——lockfile 暫未含 html2canvas/jspdf，build 時自動補齊同步

# 拷貝源碼、還原圖片/影片（assets-b64 → public/），然後 build
COPY . .
RUN node scripts/decode-assets.mjs
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# server 讀 process.env.PORT || 3000；DATABASE_URL / JWT_SECRET 等由平台注入
CMD ["node", "dist/boot.js"]
