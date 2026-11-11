/** 抽獎獎品庫存：後端 quantity／takenCount 係唯一事實來源。 */
export type Prize = {
  id: number;
  name: string | null;
  sku: string;
  price: number;
  imagePath: string | null;
  session: string;
  active: boolean;
  quantity: number;
  takenCount: number;
  drawCount: number;
  takenBy: { name: string; status: string; drawDate: string } | null;
};

/** 舊 server 未回 quantity／takenCount 時，沿用舊一件制口径。 */
export const remainingOf = (p: Prize): number =>
  (p.quantity ?? 1) - (p.takenCount ?? (p.takenBy ? 1 : 0));

export const displayRemainingOf = (p: Prize): number => Math.max(0, remainingOf(p));
