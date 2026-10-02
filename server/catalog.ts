import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { z } from "zod";
import { workflow } from "./database.js";
import { HttpError } from "./errors.js";
import { appendAudit, referenceById } from "./repository.js";
import type { DeliveryRecord, PurchaseOrder, Supplier, User } from "../src/domain/types.js";
import type { deliverySchema, purchaseOrderSchema, supplierSchema } from "../src/domain/validation.js";

export async function createSupplier(pool: pg.Pool, actor: User, input: z.infer<typeof supplierSchema>): Promise<Supplier> {
  return workflow(pool, actor, async (db) => {
    const supplier = { ...input, id: randomUUID() };
    await db.query("INSERT INTO suppliers(id, name, code, location) VALUES ($1,$2,$3,$4)", [supplier.id, supplier.name, supplier.code, supplier.location]);
    await appendAudit(db, actor, "supplier_created", supplier.id, `Created supplier ${supplier.code}. Reference records are immutable.`);
    return supplier;
  }, true);
}
export async function createPurchaseOrder(pool: pg.Pool, actor: User, input: z.infer<typeof purchaseOrderSchema>): Promise<PurchaseOrder> {
  return workflow(pool, actor, async (db) => {
    await referenceById(db, "suppliers", input.supplierId);
    const order = { ...input, id: randomUUID(), lineItems: input.lineItems.map((line) => ({ ...line, id: randomUUID() })) };
    await db.query("INSERT INTO purchase_orders(id, po_number, supplier_id, ordered_date, line_items) VALUES ($1,$2,$3,$4,$5::jsonb)", [order.id, order.poNumber, order.supplierId, order.orderedDate, JSON.stringify(order.lineItems)]);
    await appendAudit(db, actor, "purchase_order_created", order.id, `Created immutable purchase order ${order.poNumber}.`);
    return order;
  }, true);
}
export async function createDelivery(pool: pg.Pool, actor: User, input: z.infer<typeof deliverySchema>): Promise<DeliveryRecord> {
  return workflow(pool, actor, async (db) => {
    const order = await referenceById(db, "purchase-orders", input.purchaseOrderId);
    if (input.receivedDate < order.orderedDate) throw new HttpError(422, "INVALID_RECEIPT", "Receipt date cannot precede the order date.");
    const previous = await db.query<{ line_items: DeliveryRecord["lineItems"] }>("SELECT line_items FROM delivery_records WHERE purchase_order_id=$1", [order.id]);
    for (const line of input.lineItems) {
      const ordered = order.lineItems.find((item) => item.sku === line.sku);
      const received = previous.rows.reduce((sum, receipt) => sum + receipt.line_items.filter((item) => item.sku === line.sku).reduce((total, item) => total + item.quantity, 0), 0);
      if (!ordered || line.quantity + received > ordered.quantity) throw new HttpError(422, "INVALID_RECEIPT", `Receipt quantity for ${line.sku} exceeds the remaining purchase order quantity, or the SKU is not on the order.`);
    }
    const receipt = { ...input, id: randomUUID(), lineItems: input.lineItems.map((line) => ({ ...line, id: randomUUID() })) };
    await db.query("INSERT INTO delivery_records(id, delivery_number, purchase_order_id, received_date, line_items) VALUES ($1,$2,$3,$4,$5::jsonb)", [receipt.id, receipt.deliveryNumber, receipt.purchaseOrderId, receipt.receivedDate, JSON.stringify(receipt.lineItems)]);
    await appendAudit(db, actor, "delivery_created", receipt.id, `Created immutable goods receipt ${receipt.deliveryNumber}.`);
    return receipt;
  }, true);
}
