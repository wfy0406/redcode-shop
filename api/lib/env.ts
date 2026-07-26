import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // 唔好令 server 成個 crash（會變白畫面）；降級，DB 查詢先至報錯
    console.warn(`[env] Missing environment variable: ${name}`);
  }
  return value ?? "";
}

export const env = {
  appId: required("APP_ID"),
  appSecret: required("APP_SECRET"),
  isProduction: process.env.NODE_ENV === "production",
  databaseUrl: required("DATABASE_URL"),
};
