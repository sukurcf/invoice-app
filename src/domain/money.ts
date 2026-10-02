export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function lineTotal(quantity: number, unitPrice: number): number {
  return (quantity * Math.round(unitPrice * 100)) / 100;
}

export function invoiceSubtotal(lineItems: Array<{ quantity: number; unitPrice: number }>): number {
  return lineItems.reduce((total, item) => total + item.quantity * Math.round(item.unitPrice * 100), 0) / 100;
}

export function invoiceTotal(
  lineItems: Array<{ quantity: number; unitPrice: number }>,
  tax: number,
): number {
  return (Math.round(invoiceSubtotal(lineItems) * 100) + Math.round(tax * 100)) / 100;
}

export function formatCurrency(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(value);
}
