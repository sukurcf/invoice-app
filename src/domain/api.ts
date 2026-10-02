import type { DeliveryRecord, ExceptionEvidence, Invoice, InvoiceStatus, PurchaseOrder, ReviewHistory, Supplier, User } from "./types.js";

export interface Session {
  user: User;
  csrfToken: string;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  date: string;
  dueDate: string;
  status: InvoiceStatus;
  version: number;
  supplierName: string;
  supplierCode: string;
  purchaseOrderNumber: string;
  total: number;
  exceptionCount: number;
  exceptionReason: string;
}

export interface InvoiceDetail {
  invoice: Invoice;
  supplier?: Supplier;
  purchaseOrder?: PurchaseOrder;
  delivery?: DeliveryRecord;
  exceptions: ExceptionEvidence[];
  history: PageResult<ReviewHistory>;
}

export interface ExportBatch {
  id: string;
  createdAt: string;
  createdBy: string;
  invoiceCount: number;
}

export interface DashboardData {
  counts: Record<InvoiceStatus, number>;
  priority: InvoiceSummary[];
  history: ReviewHistory[];
}

export interface AuditEvent {
  id: string;
  action: string;
  entityId: string;
  user: string;
  detail: string;
  timestamp: string;
}
