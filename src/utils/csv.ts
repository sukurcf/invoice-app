import type { AppData } from "../domain/types.js";
import { invoiceTotal } from "../domain/money.js";

function escapeCsv(value: string | number): string {
  const raw = String(value);
  const text = /^[\s\u0000-\u001f]*[=+\-@]/u.test(raw) || /^[\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function readyToExportCsv(data: Pick<AppData, "invoices" | "suppliers" | "purchaseOrders">): string {
  const rows = data.invoices
    .filter((invoice) => invoice.status === "ready_to_export")
    .map((invoice) => {
      const supplier = data.suppliers.find((item) => item.id === invoice.supplierId);
      const po = data.purchaseOrders.find((item) => item.id === invoice.purchaseOrderId);
      if (!supplier || !po) throw new Error(`Cannot export invoice ${invoice.id} without valid references.`);
      return [
        invoice.invoiceNumber,
        supplier.name,
        invoice.date,
        invoice.currency,
        invoiceTotal(invoice.lineItems, invoice.tax).toFixed(2),
        po.poNumber,
        "Ready to export",
      ].map(escapeCsv).join(",");
    });

  return [
    "Invoice number,Supplier,Invoice date,Currency,Total,Purchase order,Status",
    ...rows,
  ].join("\r\n");
}
