import { getDb } from "../api/queries/connection";
import { products } from "./schema";
import { ensureInitialAdmin } from "../api/initialAdmin";

async function seed() {
  const db = getDb();
  console.log("Seeding database...");

  // P0-1（2026-10 安全修復）：admin 帳號唔再寫死密碼——同 boot-migrate 共用 ensureInitialAdmin
  // （冇 admin 先建；密碼用 ADMIN_INITIAL_PASSWORD env，未設就一次性隨機打印落 log）
  await ensureInitialAdmin();

  // Products
  const existingProducts = await db.query.products.findMany();
  if (existingProducts.length === 0) {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    await db.insert(products).values([
      {
        sku: "RC-KNIT-001",
        name: "粉色針織開衫外套",
        description: "柔軟針織面料，百搭開衫剪裁，春秋必備單品。",
        image: "/product-1.jpg",
        price: 268,
        discountPrice: 228,
        sizes: "S,M,L",
        category: "top",
        listedDate: new Date(now - 1 * day),
        stock: 30,
      },
      {
        sku: "RC-TOP-002",
        name: "白色雪紡荷葉邊恤衫",
        description: "輕盈雪紡配荷葉邊細節，斯文又顯氣質。",
        image: "/product-2.jpg",
        price: 198,
        sizes: "S,M,L",
        category: "top",
        listedDate: new Date(now - 2 * day),
        stock: 25,
      },
      {
        sku: "RC-DRESS-003",
        name: "黑色顯瘦連身裙",
        description: "修身剪裁黑色連身裙，顯瘦百搭，返工出街都得。",
        image: "/product-3.jpg",
        price: 328,
        discountPrice: 288,
        sizes: "S,M,L,XL",
        category: "dress",
        listedDate: new Date(now - 3 * day),
        stock: 18,
      },
      {
        sku: "RC-JEANS-004",
        name: "高腰直筒牛仔褲",
        description: "高腰直筒版型，拉長腿部線條，四季皆宜。",
        image: "/product-4.jpg",
        price: 258,
        sizes: "26,27,28,29,30",
        category: "pants",
        listedDate: new Date(now - 5 * day),
        stock: 40,
      },
      {
        sku: "RC-SKIRT-005",
        name: "紫色碎花半身裙",
        description: "浪漫紫色碎花，A字裙擺，夏日小清新之選。",
        image: "/product-5.jpg",
        price: 188,
        sizes: "S,M,L",
        category: "dress",
        listedDate: new Date(now - 7 * day),
        stock: 22,
      },
      {
        sku: "RC-SWEAT-006",
        name: "奶油白 oversize 衛衣",
        description: "奶油白寬鬆版型衛衣，舒適保暖，慵懶風必備。",
        image: "/product-6.jpg",
        price: 228,
        category: "top",
        listedDate: new Date(now - 10 * day),
        stock: 35,
      },
    ]);
    console.log("Created 6 products");
  } else {
    console.log("Products already exist, skipped");
  }

  console.log("Done.");
  process.exit(0); // close Postgres connection pool
}

seed();
