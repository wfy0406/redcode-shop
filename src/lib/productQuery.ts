/** tRPC 商品查詢錯誤分類：明確 404 唔可以跌入示範商品 fallback。 */
export function isProductNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const data = (error as { data?: { code?: unknown; httpStatus?: unknown } }).data;
  return data?.code === 'NOT_FOUND' || data?.httpStatus === 404;
}
