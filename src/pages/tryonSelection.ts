export interface TryOnProductSelection {
  productId: number;
  photoIndex: number;
}

export interface TryOnBatchPlan {
  version: 1;
  userId: number;
  rootPublicId: string;
  second: TryOnProductSelection;
  idempotencyKey: string;
  paused: boolean;
}

export type TryOnSelectionResult =
  | { ok: true; selections: TryOnProductSelection[] }
  | { ok: false; selections: TryOnProductSelection[]; reason: string };

/** 由呼叫方提供目前選擇嘅部位，避免將商品清單或 React 狀態綁入純邏輯。 */
export function addTryOnProductSelection(args: {
  selections: TryOnProductSelection[];
  products: Array<{ id: number; tryOnKind: string }>;
  product: { id: number; tryOnKind: string };
  kindLabel: string;
  maxSelections: number;
}): TryOnSelectionResult {
  const { selections, products, product, kindLabel, maxSelections } = args;
  if (selections.some((item) => item.productId === product.id)) {
    return { ok: true, selections: selections.filter((item) => item.productId !== product.id) };
  }
  if (selections.length >= maxSelections) {
    return {
      ok: false,
      selections,
      reason: maxSelections === 2 ? "第一次生成前最多即場揀兩件；可先移除其中一件再揀" : "呢一步只確認追加一件",
    };
  }
  const selectedKinds = new Set(
    selections
      .map((item) => products.find((product) => product.id === item.productId)?.tryOnKind)
      .filter((kind): kind is string => Boolean(kind)),
  );
  if (selectedKinds.has(product.tryOnKind)) {
    return { ok: false, selections, reason: `已揀${kindLabel}；兩件商品必須係不同穿著部位` };
  }
  return { ok: true, selections: [...selections, { productId: product.id, photoIndex: 0 }] };
}

export function moveTryOnProductSelection(
  selections: TryOnProductSelection[],
  index: number,
  direction: -1 | 1,
): TryOnProductSelection[] {
  const target = index + direction;
  if (index < 0 || target < 0 || index >= selections.length || target >= selections.length) return selections;
  const next = [...selections];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function parseTryOnBatchPlan(raw: string | null, userId: number): TryOnBatchPlan | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<TryOnBatchPlan>;
    if (
      value.version !== 1 ||
      value.userId !== userId ||
      typeof value.rootPublicId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.rootPublicId) ||
      !value.second ||
      !Number.isInteger(value.second.productId) ||
      value.second.productId <= 0 ||
      !Number.isInteger(value.second.photoIndex) ||
      value.second.photoIndex < 0 ||
      value.second.photoIndex > 50 ||
      typeof value.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(value.idempotencyKey) ||
      typeof value.paused !== "boolean"
    ) {
      return null;
    }
    return value as TryOnBatchPlan;
  } catch {
    return null;
  }
}
