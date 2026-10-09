import { describe, expect, it } from "vitest";
import {
  computeWalletSplit,
  splitRefundChannels,
  generateTopupNo,
  isTopupNo,
} from "./wallet";

describe("computeWalletSplit（落單購物金抵銷）", () => {
  it("唔用購物金 → 全額現金", () => {
    expect(computeWalletSplit(500, 1000, false)).toEqual({ walletApplied: 0, cashDue: 500 });
  });
  it("餘額夠 → 全單購物金，現金 0", () => {
    expect(computeWalletSplit(500, 1000, true)).toEqual({ walletApplied: 500, cashDue: 0 });
  });
  it("餘額唔夠 → 用盡餘額，尾數現金", () => {
    expect(computeWalletSplit(500, 200, true)).toEqual({ walletApplied: 200, cashDue: 300 });
  });
  it("餘額 0 → 唔扣得到", () => {
    expect(computeWalletSplit(500, 0, true)).toEqual({ walletApplied: 0, cashDue: 500 });
  });
  it("零蚊單 → 唔扣", () => {
    expect(computeWalletSplit(0, 500, true)).toEqual({ walletApplied: 0, cashDue: 0 });
  });
});

describe("splitRefundChannels（退款拆賬）", () => {
  // total 500、購物金 200（現金收 300）
  it("退款 ≤ 現金部分 → 全部退現金", () => {
    expect(splitRefundChannels(500, 200, 300)).toEqual({ cashRefund: 300, walletReturn: 0 });
  });
  it("全單退 → 現金部分退現金，購物金部分返還購物金", () => {
    expect(splitRefundChannels(500, 200, 500)).toEqual({ cashRefund: 300, walletReturn: 200 });
  });
  it("冇用購物金 → 全部現金", () => {
    expect(splitRefundChannels(500, 0, 500)).toEqual({ cashRefund: 500, walletReturn: 0 });
  });
  it("全購物金單 → 全部返還購物金（唔經 Airwallex）", () => {
    expect(splitRefundChannels(500, 500, 500)).toEqual({ cashRefund: 0, walletReturn: 500 });
  });
  it("部分退款中途額 → 先冚現金", () => {
    expect(splitRefundChannels(500, 200, 350)).toEqual({ cashRefund: 300, walletReturn: 50 });
  });
});

describe("充值單號", () => {
  it("WT 前綴＋日期＋4 位數", () => {
    const no = generateTopupNo();
    expect(no).toMatch(/^WT\d{12}$/);
    expect(isTopupNo(no)).toBe(true);
  });
  it("RC 訂單號唔會誤認做充值單", () => {
    expect(isTopupNo("RC202610094821")).toBe(false);
  });
});
