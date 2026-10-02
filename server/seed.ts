import type pg from "pg";
import { initialData } from "../src/data/demoData.js";
import { invoiceTotal } from "../src/domain/money.js";
import type { User } from "../src/domain/types.js";
import { tokenHash } from "./auth.js";
import { workflow } from "./database.js";
import { appendAudit, appendHistory } from "./repository.js";
import { HttpError } from "./errors.js";
import { normalizedInvoiceNumber } from "../src/services/invoiceChecks.js";

export async function seedDemo(pool: pg.Pool, actor: User): Promise<void> {
  await workflow(pool, actor, async (db) => {
    const existing = await db.query<{ present: boolean }>("SELECT EXISTS(SELECT 1 FROM suppliers) OR EXISTS(SELECT 1 FROM invoices) AS present");
    if (existing.rows[0].present) throw new HttpError(409, "NOT_EMPTY", "Demo seeding requires an empty invoice and reference-data database.");
    for (const supplier of initialData.suppliers) await db.query("INSERT INTO suppliers(id,name,code,location) VALUES ($1,$2,$3,$4)", [supplier.id, supplier.name, supplier.code, supplier.location]);
    for (const order of initialData.purchaseOrders) await db.query("INSERT INTO purchase_orders(id,po_number,supplier_id,ordered_date,line_items) VALUES ($1,$2,$3,$4,$5::jsonb)", [order.id, order.poNumber, order.supplierId, order.orderedDate, JSON.stringify(order.lineItems)]);
    for (const receipt of initialData.deliveryRecords) await db.query("INSERT INTO delivery_records(id,delivery_number,purchase_order_id,received_date,line_items) VALUES ($1,$2,$3,$4,$5::jsonb)", [receipt.id, receipt.deliveryNumber, receipt.purchaseOrderId, receipt.receivedDate, JSON.stringify(receipt.lineItems)]);
    for (const invoice of initialData.invoices) {
      await db.query(`INSERT INTO invoices(id, invoice_number, supplier_id, issue_date, due_date, purchase_order_id, delivery_record_id, line_items, tax_cents, total_cents, status, extracted_fields, created_by, request_fingerprint, invoice_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
      [invoice.id, invoice.invoiceNumber, invoice.supplierId, invoice.date, invoice.dueDate, invoice.purchaseOrderId, invoice.deliveryRecordId, JSON.stringify(invoice.lineItems),
        Math.round(invoice.tax * 100), Math.round(invoiceTotal(invoice.lineItems, invoice.tax) * 100), invoice.status, JSON.stringify(invoice.extractedFields), actor.id, tokenHash(`synthetic:${invoice.id}`), normalizedInvoiceNumber(invoice.invoiceNumber)]);
      await appendHistory(db, invoice, actor, invoice.status === "ready_to_export" ? "approved" : "created", "Synthetic example loaded by the explicit development seed command.");
    }
    await appendAudit(db, actor, "demo_seeded", "workspace", "Loaded synthetic example data into an empty development workspace.");
  }, true);
}
