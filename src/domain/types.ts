export type InvoiceStatus =
  | "needs_review"
  | "possible_duplicate"
  | "matched"
  | "ready_to_export"
  | "correction_requested"
  | "escalated"
  | "exported"
  | "voided";

export type ReviewAction =
  | "created"
  | "updated"
  | "approved"
  | "correction_requested"
  | "escalated"
  | "reopened"
  | "exported"
  | "voided";

export type ReviewDecision = "approved" | "correction_requested" | "escalated" | "reopened" | "voided";

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "reviewer";
  active: boolean;
  mustChangePassword: boolean;
}

export interface Supplier {
  id: string;
  name: string;
  code: string;
  location: string;
}

export interface LineItem {
  id: string;
  description: string;
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface ExtractedField {
  label: string;
  value: string;
  confidence?: number;
  source: "demo_extraction" | "manual";
}

export interface Invoice {
  id: string;
  version: number;
  invoiceNumber: string;
  supplierId: string;
  date: string;
  dueDate: string;
  purchaseOrderId: string;
  deliveryRecordId?: string;
  currency: "USD";
  lineItems: LineItem[];
  tax: number;
  status: InvoiceStatus;
  extractedFields: ExtractedField[];
  sourceFile?: {
    name: string;
    type: string;
    size?: number;
  };
  exportBatchId?: string;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplierId: string;
  orderedDate: string;
  lineItems: LineItem[];
}

export interface DeliveryRecord {
  id: string;
  deliveryNumber: string;
  purchaseOrderId: string;
  receivedDate: string;
  lineItems: Array<Pick<LineItem, "id" | "sku" | "description" | "quantity">>;
}

export interface ReviewHistory {
  id: string;
  invoiceId: string;
  invoiceNumber?: string;
  action: ReviewAction;
  user: string;
  timestamp: string;
  detail: string;
  version?: number;
  snapshot?: Invoice;
}

export interface ExceptionEvidence {
  id: string;
  type: "duplicate" | "price" | "quantity" | "field_confidence" | "missing_field";
  title: string;
  explanation: string;
  severity: "high" | "medium" | "low";
  sourceValues: Array<{ label: string; value: string }>;
  calculation?: string;
}

export interface AppData {
  invoices: Invoice[];
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  deliveryRecords: DeliveryRecord[];
  reviewHistory: ReviewHistory[];
}
