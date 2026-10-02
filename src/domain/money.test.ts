import { describe, expect, it } from "vitest";
import { formatCurrency, invoiceSubtotal, invoiceTotal, lineTotal, roundMoney } from "./money";

describe("money in cents", () => {
  it("calculates decimal prices and taxes without accumulated floating-point drift", () => {
    expect(lineTotal(3, 0.1)).toBe(0.3);
    expect(invoiceSubtotal([{ quantity: 3, unitPrice: 0.1 }, { quantity: 7, unitPrice: 0.1 }])).toBe(1);
    expect(invoiceTotal([{ quantity: 3, unitPrice: 0.1 }], 0.2)).toBe(0.5);
  });
  it("supports zero and the documented maximum", () => {
    expect(invoiceSubtotal([])).toBe(0);
    expect(invoiceTotal([{ quantity: 1_000_000, unitPrice: 100 }], 0)).toBe(100_000_000);
    expect(lineTotal(4, 0)).toBe(0);
  });
  it("formats USD and rounds display percentages", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
    expect(roundMoney(1.005)).toBe(1.01);
  });
});
