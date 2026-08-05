// 相容 re-export：部分後台元件用 "../../trpc" 相對路徑 import，
// 實際 client 喺 ./providers/trpc（repo 統一入口）。
export { trpc } from "./providers/trpc";
