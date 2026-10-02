import type { AppData, ExtractedField, Invoice } from "../domain/types.js";

const extracted = (
  invoiceNumber: string,
  supplier: string,
  date: string,
  total: string,
  confidence = 0.98,
): ExtractedField[] => [
  { label: "Invoice number", value: invoiceNumber, confidence, source: "demo_extraction" },
  { label: "Supplier", value: supplier, confidence: 0.97, source: "demo_extraction" },
  { label: "Invoice date", value: date, confidence: 0.99, source: "demo_extraction" },
  { label: "Total", value: total, confidence: 0.96, source: "demo_extraction" },
];

const invoices: Array<Omit<Invoice, "version">> = [
  {
    id: "inv-001",
    invoiceNumber: "NFM-24081",
    supplierId: "sup-001",
    date: "2026-09-18",
    dueDate: "2026-10-18",
    purchaseOrderId: "po-001",
    deliveryRecordId: "del-001",
    currency: "USD",
    lineItems: [
      { id: "il-001", sku: "BRG-6204", description: "Sealed ball bearing", quantity: 24, unitPrice: 18.5 },
      { id: "il-002", sku: "BLT-M8", description: "M8 zinc flange bolt", quantity: 100, unitPrice: 0.42 },
    ],
    tax: 38.88,
    status: "matched",
    extractedFields: extracted("NFM-24081", "Northstar Fasteners", "Sep 18, 2026", "$524.88"),
  },
  {
    id: "inv-002",
    invoiceNumber: "ALP-8837",
    supplierId: "sup-002",
    date: "2026-09-20",
    dueDate: "2026-10-20",
    purchaseOrderId: "po-002",
    deliveryRecordId: "del-002",
    currency: "USD",
    lineItems: [
      { id: "il-003", sku: "FLT-A20", description: "Air intake filter", quantity: 10, unitPrice: 13.5 },
    ],
    tax: 0,
    status: "needs_review",
    extractedFields: extracted("ALP-8837", "Alpine Industrial Supply", "Sep 20, 2026", "$135.00"),
  },
  {
    id: "inv-003",
    invoiceNumber: "PAC-11029",
    supplierId: "sup-003",
    date: "2026-09-21",
    dueDate: "2026-10-21",
    purchaseOrderId: "po-003",
    deliveryRecordId: "del-003",
    currency: "USD",
    lineItems: [
      { id: "il-004", sku: "GLV-N15", description: "Nitrile work gloves, box", quantity: 30, unitPrice: 9.8 },
    ],
    tax: 23.52,
    status: "needs_review",
    extractedFields: extracted("PAC-11029", "Pacific Safety Co.", "Sep 21, 2026", "$317.52"),
  },
  {
    id: "inv-004",
    invoiceNumber: "MER-55210",
    supplierId: "sup-004",
    date: "2026-09-22",
    dueDate: "2026-10-22",
    purchaseOrderId: "po-004",
    deliveryRecordId: "del-004",
    currency: "USD",
    lineItems: [
      { id: "il-005", sku: "LUB-46", description: "Hydraulic oil ISO 46", quantity: 8, unitPrice: 64 },
    ],
    tax: 40.96,
    status: "possible_duplicate",
    extractedFields: extracted("MER-55210", "Meridian Lubricants", "Sep 22, 2026", "$552.96"),
  },
  {
    id: "inv-005",
    invoiceNumber: "MER-55210",
    supplierId: "sup-004",
    date: "2026-09-23",
    dueDate: "2026-10-23",
    purchaseOrderId: "po-004",
    deliveryRecordId: "del-004",
    currency: "USD",
    lineItems: [
      { id: "il-006", sku: "LUB-46", description: "Hydraulic oil ISO 46", quantity: 8, unitPrice: 64 },
    ],
    tax: 40.96,
    status: "possible_duplicate",
    extractedFields: extracted("MER-55210", "Meridian Lubricants", "Sep 23, 2026", "$552.96"),
  },
  {
    id: "inv-006",
    invoiceNumber: "ECO-9014",
    supplierId: "sup-005",
    date: "2026-09-24",
    dueDate: "2026-10-24",
    purchaseOrderId: "po-005",
    deliveryRecordId: "del-005",
    currency: "USD",
    lineItems: [
      { id: "il-007", sku: "BOX-DW", description: "Double-wall cartons", quantity: 200, unitPrice: 1.15 },
    ],
    tax: 18.4,
    status: "needs_review",
    extractedFields: [
      { label: "Invoice number", value: "ECO-9014", confidence: 0.96, source: "demo_extraction" },
      { label: "Supplier", value: "EcoPack Solutions", confidence: 0.61, source: "demo_extraction" },
      { label: "Invoice date", value: "Sep 24, 2026", confidence: 0.95, source: "demo_extraction" },
      { label: "Total", value: "", confidence: 0, source: "demo_extraction" },
    ],
  },
  {
    id: "inv-007",
    invoiceNumber: "NFM-24096",
    supplierId: "sup-001",
    date: "2026-09-25",
    dueDate: "2026-10-25",
    purchaseOrderId: "po-006",
    deliveryRecordId: "del-006",
    currency: "USD",
    lineItems: [
      { id: "il-008", sku: "WSH-M8", description: "M8 stainless washer", quantity: 500, unitPrice: 0.12 },
    ],
    tax: 4.8,
    status: "ready_to_export",
    extractedFields: extracted("NFM-24096", "Northstar Fasteners", "Sep 25, 2026", "$64.80"),
  },
];

export const initialData: AppData = {
  invoices: invoices.map((invoice) => ({ ...invoice, version: 1 })),
  suppliers: [
    { id: "sup-001", name: "Northstar Fasteners", code: "NSF-014", location: "Columbus, OH" },
    { id: "sup-002", name: "Alpine Industrial Supply", code: "AIS-208", location: "Denver, CO" },
    { id: "sup-003", name: "Pacific Safety Co.", code: "PSC-091", location: "Portland, OR" },
    { id: "sup-004", name: "Meridian Lubricants", code: "MRL-156", location: "Tulsa, OK" },
    { id: "sup-005", name: "EcoPack Solutions", code: "EPS-044", location: "Richmond, VA" },
  ],
  purchaseOrders: [
    {
      id: "po-001", poNumber: "PO-10482", supplierId: "sup-001", orderedDate: "2026-09-02",
      lineItems: [
        { id: "pol-001", sku: "BRG-6204", description: "Sealed ball bearing", quantity: 24, unitPrice: 18.5 },
        { id: "pol-002", sku: "BLT-M8", description: "M8 zinc flange bolt", quantity: 100, unitPrice: 0.42 },
      ],
    },
    {
      id: "po-002", poNumber: "PO-10491", supplierId: "sup-002", orderedDate: "2026-09-05",
      lineItems: [{ id: "pol-003", sku: "FLT-A20", description: "Air intake filter", quantity: 10, unitPrice: 12 }],
    },
    {
      id: "po-003", poNumber: "PO-10495", supplierId: "sup-003", orderedDate: "2026-09-07",
      lineItems: [{ id: "pol-004", sku: "GLV-N15", description: "Nitrile work gloves, box", quantity: 30, unitPrice: 9.8 }],
    },
    {
      id: "po-004", poNumber: "PO-10502", supplierId: "sup-004", orderedDate: "2026-09-08",
      lineItems: [{ id: "pol-005", sku: "LUB-46", description: "Hydraulic oil ISO 46", quantity: 8, unitPrice: 64 }],
    },
    {
      id: "po-005", poNumber: "PO-10509", supplierId: "sup-005", orderedDate: "2026-09-11",
      lineItems: [{ id: "pol-006", sku: "BOX-DW", description: "Double-wall cartons", quantity: 200, unitPrice: 1.15 }],
    },
    {
      id: "po-006", poNumber: "PO-10518", supplierId: "sup-001", orderedDate: "2026-09-15",
      lineItems: [{ id: "pol-007", sku: "WSH-M8", description: "M8 stainless washer", quantity: 500, unitPrice: 0.12 }],
    },
  ],
  deliveryRecords: [
    {
      id: "del-001", deliveryNumber: "GRN-7281", purchaseOrderId: "po-001", receivedDate: "2026-09-17",
      lineItems: [
        { id: "dl-001", sku: "BRG-6204", description: "Sealed ball bearing", quantity: 24 },
        { id: "dl-002", sku: "BLT-M8", description: "M8 zinc flange bolt", quantity: 100 },
      ],
    },
    {
      id: "del-002", deliveryNumber: "GRN-7290", purchaseOrderId: "po-002", receivedDate: "2026-09-19",
      lineItems: [{ id: "dl-003", sku: "FLT-A20", description: "Air intake filter", quantity: 10 }],
    },
    {
      id: "del-003", deliveryNumber: "GRN-7294", purchaseOrderId: "po-003", receivedDate: "2026-09-20",
      lineItems: [{ id: "dl-004", sku: "GLV-N15", description: "Nitrile work gloves, box", quantity: 24 }],
    },
    {
      id: "del-004", deliveryNumber: "GRN-7301", purchaseOrderId: "po-004", receivedDate: "2026-09-21",
      lineItems: [{ id: "dl-005", sku: "LUB-46", description: "Hydraulic oil ISO 46", quantity: 8 }],
    },
    {
      id: "del-005", deliveryNumber: "GRN-7308", purchaseOrderId: "po-005", receivedDate: "2026-09-23",
      lineItems: [{ id: "dl-006", sku: "BOX-DW", description: "Double-wall cartons", quantity: 200 }],
    },
    {
      id: "del-006", deliveryNumber: "GRN-7312", purchaseOrderId: "po-006", receivedDate: "2026-09-24",
      lineItems: [{ id: "dl-007", sku: "WSH-M8", description: "M8 stainless washer", quantity: 500 }],
    },
  ],
  reviewHistory: [
    { id: "hist-001", invoiceId: "inv-007", action: "approved", user: "Maya Chen", timestamp: "2026-09-25T09:42:00Z", detail: "Approved for local CSV export." },
    { id: "hist-002", invoiceId: "inv-002", action: "created", user: "Demo intake", timestamp: "2026-09-25T08:30:00Z", detail: "Rule-based check identified a price variance." },
    { id: "hist-003", invoiceId: "inv-006", action: "created", user: "Demo intake", timestamp: "2026-09-24T16:18:00Z", detail: "Fields require manual verification." },
    { id: "hist-004", invoiceId: "inv-003", action: "created", user: "Demo intake", timestamp: "2026-09-24T14:05:00Z", detail: "Invoice quantity exceeds goods received." },
  ],
};
