# RedCode Fashion Design 官方購物網站 — 全棧（Vite build + Hono/tRPC server）
FROM node:20

WORKDIR /app

# 先裝依賴（利用 docker layer cache）
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 拷貝源碼、還原圖片/影片（assets-b64 → public/），然後 build
COPY . .
RUN node scripts/decode-assets.mjs
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# server 讀 process.env.PORT || 3000；DATABASE_URL / JWT_SECRET 等由平台注入
CMD ["node", "dist/boot.js"]
