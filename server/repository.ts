import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Database } from "./database.js";
import { HttpError } from "./errors.js";
import type { AuditEvent, DashboardData, ExportBatch, InvoiceDetail, InvoiceSummary, PageResult } from "../src/domain/api.js";
import type { DeliveryRecord, Invoice, InvoiceStatus, PurchaseOrder, ReviewAction, ReviewHistory, Supplier, User } from "../src/domain/types.js";
import { invoiceTotal } from "../src/domain/money.js";
import { invoiceStatuses, type invoiceQuerySchema, type referenceQuerySchema } from "../src/domain/validation.js";
import { getInvoiceExceptions, normalizedInvoiceNumber } from "../src/services/invoiceChecks.js";

type InvoiceRow = Omit<Invoice, "sourceFile" | "deliveryRecordId" | "exportBatchId"> & {
  sourceFile: Invoice["sourceFile"] | null;
  deliveryRecordId: string | null;
  exportBatchId: string | null;
};
export const invoiceColumns = `i.id, i.version, i.invoice_number AS "invoiceNumber", coalesce(i.supplier_id, '') AS "supplierId",
  coalesce(i.issue_date::text, '') AS date, coalesce(i.due_date::text, '') AS "dueDate",
  coalesce(i.purchase_order_id, '') AS "purchaseOrderId", i.delivery_record_id AS "deliveryRecordId",
  i.currency, i.line_items AS "lineItems", (i.tax_cents::numeric / 100)::float8 AS tax, i.status,
  i.extracted_fields AS "extractedFields", i.export_batch_id AS "exportBatchId",
  CASE WHEN i.source_name IS NULL THEN NULL ELSE json_build_object('name', i.source_name, 'type', i.source_type, 'size', octet_length(i.document)) END AS "sourceFile"`;
const poColumns = `id, po_number AS "poNumber", supplier_id AS "supplierId", ordered_date::text AS "orderedDate", line_items AS "lineItems"`;
const deliveryColumns = `id, delivery_number AS "deliveryNumber", purchase_order_id AS "purchaseOrderId", received_date::text AS "receivedDate", line_items AS "lineItems"`;

function mapInvoice(row: InvoiceRow): Invoice {
  const { sourceFile, deliveryRecordId, exportBatchId, ...invoice } = row;
  return { ...invoice, ...(sourceFile ? { sourceFile } : {}), ...(deliveryRecordId ? { deliveryRecordId } : {}), ...(exportBatchId ? { exportBatchId } : {}) };
}

export async function findInvoice(db: Database, id: string): Promise<Invoice> {
  const { rows } = await db.query<InvoiceRow>(`SELECT ${invoiceColumns} FROM invoices i WHERE i.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "NOT_FOUND", "Invoice not found.");
  return mapInvoice(rows[0]);
}

export interface InvoiceContext {
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  deliveryRecords: DeliveryRecord[];
  relatedInvoices: Invoice[];
}
export async function invoiceContext(db: Database, invoices: Invoice[]): Promise<InvoiceContext> {
  const suppliers = [...new Set(invoices.map((invoice) => invoice.supplierId).filter(Boolean))];
  const orders = [...new Set(invoices.map((invoice) => invoice.purchaseOrderId).filter(Boolean))];
  const receipts = [...new Set(invoices.flatMap((invoice) => invoice.deliveryRecordId ? [invoice.deliveryRecordId] : []))];
  const numbers = [...new Set(invoices.map((invoice) => normalizedInvoiceNumber(invoice.invoiceNumber)).filter(Boolean))];
  // This connection may be a transaction client; pg does not support concurrent queries on one client.
  const supplierRows = await db.query<Supplier>("SELECT id, name, code, location FROM suppliers WHERE id = ANY($1::text[])", [suppliers]);
  const orderRows = await db.query<PurchaseOrder>(`SELECT ${poColumns} FROM purchase_orders WHERE id = ANY($1::text[])`, [orders]);
  const receiptRows = await db.query<DeliveryRecord>(`SELECT ${deliveryColumns} FROM delivery_records WHERE id = ANY($1::text[])`, [receipts]);
  const relatedRows = await db.query<InvoiceRow>(`SELECT ${invoiceColumns} FROM invoices i WHERE i.status <> 'voided' AND (
      (i.supplier_id = ANY($1::text[]) AND i.invoice_key = ANY($2::text[])) OR
      (i.status IN ('ready_to_export', 'exported') AND (i.purchase_order_id = ANY($3::text[]) OR i.delivery_record_id = ANY($4::text[]))))`,
    [suppliers, numbers, orders, receipts]);
  return { suppliers: supplierRows.rows, purchaseOrders: orderRows.rows, deliveryRecords: receiptRows.rows, relatedInvoices: relatedRows.rows.map(mapInvoice) };
}

export function exceptionsFor(invoice: Invoice, context: InvoiceContext) {
  return getInvoiceExceptions(invoice, context.relatedInvoices,
    context.purchaseOrders.find((order) => order.id === invoice.purchaseOrderId),
    context.deliveryRecords.find((receipt) => receipt.id === invoice.deliveryRecordId));
}

function summarize(invoice: Invoice, context: InvoiceContext): InvoiceSummary {
  const supplier = context.suppliers.find((item) => item.id === invoice.supplierId);
  const order = context.purchaseOrders.find((item) => item.id === invoice.purchaseOrderId);
  const exceptions = exceptionsFor(invoice, context);
  return {
    id: invoice.id, version: invoice.version, invoiceNumber: invoice.invoiceNumber, date: invoice.date, dueDate: invoice.dueDate,
    status: invoice.status, supplierName: supplier?.name ?? "Not assigned", supplierCode: supplier?.code ?? "",
    purchaseOrderNumber: order?.poNumber ?? "Not linked", total: invoiceTotal(invoice.lineItems, invoice.tax),
    exceptionCount: exceptions.length, exceptionReason: exceptions[0]?.title ?? "",
  };
}
function like(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function listInvoices(db: Database, query: z.infer<typeof invoiceQuerySchema>, priority = false): Promise<PageResult<InvoiceSummary>> {
  const parameters: unknown[] = [like(query.search)];
  const where = [`(i.invoice_number ILIKE $1 OR s.name ILIKE $1 OR p.po_number ILIKE $1)`];
  if (query.status !== "all") {
    parameters.push(query.status);
    where.push(`i.status = $${parameters.length}`);
  }
  if (priority) where.push("i.status IN ('needs_review', 'possible_duplicate', 'escalated', 'correction_requested')");
  const from = `FROM invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN purchase_orders p ON p.id = i.purchase_order_id WHERE ${where.join(" AND ")}`;
  const sort = {
    date_desc: "i.issue_date DESC NULLS LAST", date_asc: "i.issue_date ASC NULLS LAST",
    amount_desc: "i.total_cents DESC", supplier: "s.name ASC NULLS LAST",
  }[query.sort];
  const [count, result] = await Promise.all([
    db.query<{ total: number }>(`SELECT count(*)::int AS total ${from}`, parameters),
    db.query<InvoiceRow>(`SELECT ${invoiceColumns} ${from} ORDER BY ${sort}, i.id LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`, [...parameters, query.limit, (query.page - 1) * query.limit]),
  ]);
  const invoices = result.rows.map(mapInvoice);
  const context = await invoiceContext(db, invoices);
  return { items: invoices.map((invoice) => summarize(invoice, context)), total: count.rows[0].total, page: query.page, limit: query.limit };
}

export async function invoiceHistory(db: Database, invoiceId: string | undefined, page = 1, limit = 25): Promise<PageResult<ReviewHistory>> {
  const where = invoiceId ? "WHERE h.invoice_id = $1" : "";
  const values = invoiceId ? [invoiceId] : [];
  const [count, result] = await Promise.all([
    db.query<{ total: number }>(`SELECT count(*)::int AS total FROM invoice_history h ${where}`, values),
    db.query<ReviewHistory>(`SELECT h.id, h.invoice_id AS "invoiceId", i.invoice_number AS "invoiceNumber", h.version, h.action,
      h.actor_name AS "user", h.detail, to_char(h.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp
      ${invoiceId ? ", h.snapshot" : ""} FROM invoice_history h JOIN invoices i ON i.id = h.invoice_id ${where}
      ORDER BY h.timestamp DESC, h.version DESC, h.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, limit, (page - 1) * limit]),
  ]);
  return { items: result.rows, total: count.rows[0].total, page, limit };
}

export async function invoiceDetail(db: Database, id: string): Promise<InvoiceDetail> {
  const invoice = await findInvoice(db, id);
  const [context, history] = await Promise.all([invoiceContext(db, [invoice]), invoiceHistory(db, id)]);
  return {
    invoice, supplier: context.suppliers.find((item) => item.id === invoice.supplierId),
    purchaseOrder: context.purchaseOrders.find((item) => item.id === invoice.purchaseOrderId),
    delivery: context.deliveryRecords.find((item) => item.id === invoice.deliveryRecordId),
    exceptions: exceptionsFor(invoice, context), history,
  };
}

export async function dashboard(db: Database): Promise<DashboardData> {
  const [statuses, priority, history] = await Promise.all([
    db.query<{ status: InvoiceStatus; count: number }>("SELECT status, count(*)::int AS count FROM invoices GROUP BY status"),
    listInvoices(db, { page: 1, limit: 4, search: "", sort: "date_asc", status: "all" }, true),
    invoiceHistory(db, undefined, 1, 5),
  ]);
  const counts = Object.fromEntries(invoiceStatuses.map((status) => [status, 0])) as Record<InvoiceStatus, number>;
  for (const row of statuses.rows) counts[row.status] = row.count;
  return { counts, priority: priority.items, history: history.items };
}

export type ReferenceKind = "suppliers" | "purchase-orders" | "deliveries";
interface ReferenceTypes { suppliers: Supplier; "purchase-orders": PurchaseOrder; deliveries: DeliveryRecord }
const references = {
  suppliers: { table: "suppliers", columns: "id, name, code, location", search: "(name ILIKE $1 OR code ILIKE $1)", sort: "name, id" },
  "purchase-orders": { table: "purchase_orders", columns: poColumns, search: "po_number ILIKE $1", sort: "ordered_date DESC, id" },
  deliveries: { table: "delivery_records", columns: deliveryColumns, search: "delivery_number ILIKE $1", sort: "received_date DESC, id" },
} satisfies Record<ReferenceKind, { table: string; columns: string; search: string; sort: string }>;

export async function referencePage<K extends ReferenceKind>(db: Database, kind: K, query: z.infer<typeof referenceQuerySchema>): Promise<PageResult<ReferenceTypes[K]>> {
  const definition = references[kind];
  const parameters: unknown[] = [like(query.search)];
  const where = [definition.search];
  if (query.supplierId) {
    if (kind !== "purchase-orders") throw new HttpError(400, "INVALID_FILTER", "This list cannot be filtered by supplier.");
    parameters.push(query.supplierId);
    where.push(`supplier_id = $${parameters.length}`);
  }
  if (query.purchaseOrderId) {
    if (kind !== "deliveries") throw new HttpError(400, "INVALID_FILTER", "This list cannot be filtered by purchase order.");
    parameters.push(query.purchaseOrderId);
    where.push(`purchase_order_id = $${parameters.length}`);
  }
  const from = `FROM ${definition.table} WHERE ${where.join(" AND ")}`;
  const [count, result] = await Promise.all([
    db.query<{ total: number }>(`SELECT count(*)::int AS total ${from}`, parameters),
    db.query<ReferenceTypes[K]>(`SELECT ${definition.columns} ${from} ORDER BY ${definition.sort} LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`, [...parameters, query.limit, (query.page - 1) * query.limit]),
  ]);
  return { items: result.rows, total: count.rows[0].total, page: query.page, limit: query.limit };
}
export async function referenceById<K extends ReferenceKind>(db: Database, kind: K, id: string): Promise<ReferenceTypes[K]> {
  const definition = references[kind];
  const { rows } = await db.query<ReferenceTypes[K]>(`SELECT ${definition.columns} FROM ${definition.table} WHERE id = $1`, [id]);
  if (!rows[0]) throw new HttpError(422, "INVALID_REFERENCE", `The selected ${kind} record does not exist.`);
  return rows[0];
}

export async function appendHistory(db: Database, invoice: Invoice, actor: User, action: ReviewAction, detail: string): Promise<void> {
  await db.query("INSERT INTO invoice_history(id, invoice_id, version, action, actor_id, actor_name, detail, snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [randomUUID(), invoice.id, invoice.version, action, actor.id, actor.name, detail, JSON.stringify(invoice)]);
}
export async function appendAudit(db: Database, actor: { id: string | null; name: string }, action: string, entityId: string, detail: string): Promise<void> {
  await db.query("INSERT INTO audit_events(id, action, entity_id, actor_id, actor_name, detail) VALUES ($1,$2,$3,$4,$5,$6)", [randomUUID(), action, entityId, actor.id, actor.name, detail]);
}
export async function auditPage(db: Database, page: number, limit: number): Promise<PageResult<AuditEvent>> {
  const [count, result] = await Promise.all([
    db.query<{ total: number }>("SELECT count(*)::int AS total FROM audit_events"),
    db.query<AuditEvent>(`SELECT id, action, entity_id AS "entityId", actor_name AS "user", detail,
      to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp
      FROM audit_events ORDER BY timestamp DESC, id LIMIT $1 OFFSET $2`, [limit, (page - 1) * limit]),
  ]);
  return { items: result.rows, total: count.rows[0].total, page, limit };
}
export async function exportPage(db: Database, page: number, limit: number): Promise<PageResult<ExportBatch>> {
  const [count, result] = await Promise.all([
    db.query<{ total: number }>("SELECT count(*)::int AS total FROM export_batches"),
    db.query<ExportBatch>(`SELECT b.id, to_char(b.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
      u.name AS "createdBy", jsonb_array_length(b.invoice_ids) AS "invoiceCount" FROM export_batches b JOIN users u ON u.id = b.created_by
      ORDER BY b.created_at DESC, b.id LIMIT $1 OFFSET $2`, [limit, (page - 1) * limit]),
  ]);
  return { items: result.rows, total: count.rows[0].total, page, limit };
}
