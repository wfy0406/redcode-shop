/**
 * 結帳（Checkout）— scaffold placeholder
 * TODO(page-agent): 三步進度：資料 → 付款（FPS/PayMe/AlipayHK + 付款截圖上傳）→ 完成（§P7）
 */
export default function Checkout() {
  return (
    <section className="mx-auto max-w-[1280px] px-5 py-24 md:px-8 xl:px-12">
      <p className="script text-3xl">Checkout</p>
      <h1 className="mt-2 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">
        結帳
      </h1>
      <p className="mt-4 max-w-lg text-[15px] text-txt-2">三步進度：資料 → 付款（FPS/PayMe/AlipayHK + 付款截圖上傳）→ 完成（§P7）</p>
    </section>
  );
}
