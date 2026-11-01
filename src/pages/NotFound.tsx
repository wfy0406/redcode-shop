import { Link } from 'react-router';

/** 未知網址嘅人類用戶頁；HTTP 404 同 noindex 由 server fallback 負責。 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-[760px] flex-col items-center justify-center px-5 py-20 text-center md:px-8">
      <p className="script text-4xl">Lost among the stars ✦</p>
      <h1 className="mt-4 font-serif-tc text-3xl font-bold leading-tight text-starlight md:text-[40px]">
        搵唔到呢頁
      </h1>
      <p className="mt-4 max-w-[520px] text-[15px] leading-[1.85] text-txt-2">
        呢個網址可能已經搬走或者從未存在。你可以返回首頁，或者去全部貨品睇最新直播精選。
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link to="/" className="btn btn-secondary">返回首頁</Link>
        <Link to="/products" className="btn btn-primary">全部貨品</Link>
      </div>
    </main>
  );
}
