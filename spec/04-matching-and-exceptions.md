# 4. Matching and exceptions

> Part of the [Invoice Exception Assistant specification](./README.md). Applies to version **1.0.0**.

The rule engine is the heart of the product. It is a single, pure TypeScript module,
[`src/services/invoiceChecks.ts`](../src/services/invoiceChecks.ts), used by the server for every decision and
by nothing else — the browser only *displays* what the server returns. It is deterministic: the same data
always produces the same exceptions, in the same order.

## 4.1 Concepts

- **Three-way match** – comparing an **invoice** with its **purchase order** (what was agreed) and its
  **goods receipt** (what arrived).
- **Exception** – one rule finding. It is *derived* every time it is needed and never stored.
- **Evidence** – the structured explanation attached to an exception: a title, a plain-language
  explanation, the source values, and (where relevant) the calculation. See [§4.7](#47-evidence-structure).
- **Blocking** – *every* exception blocks approval and export. There are no warnings, no severities that
  can be waived, and no administrator override.
- **Reservation** – quantity that an approved or exported invoice has already "used up" on a PO or receipt.

## 4.2 Where and when the rules run

| Moment | Code path | Effect |
| --- | --- | --- |
| Draft created | `createInvoice` → `checkedStatus` | Sets the initial [status](#46-status-derivation) |
| Fields saved | `updateInvoice` → `checkedStatus` | Re-derives the status; records a new version |
| **Approve** | `reviewInvoice` → `exceptionsFor` | Any exception ⇒ `422 UNRESOLVED_EXCEPTIONS`; nothing changes |
| **Export** | `createExport` → `exceptionsFor` for *every* selected invoice | Any exception ⇒ `422`; **no part of the batch** is created |
| Invoice opened | `invoiceDetail` | Live exceptions are returned for display |
| Queue / Exports lists | `listInvoices` | `exceptionCount` and the first exception's title, per row |

**Context.** Rules compare an invoice with data outside it. For each request the server loads
([`invoiceContext`](../server/repository.ts)): the referenced suppliers, purchase orders and receipts, plus the
**related invoices** — every non-voided invoice that either (a) has the same supplier and the same normalized
invoice number as one of the invoices being checked, or (b) is `ready_to_export`/`exported` on the same PO or
receipt. Those two groups are all the engine ever needs, so it does not read the whole invoice table.

## 4.3 Rule catalog

The engine returns evidence in this order: required-field rules, duplicate, price (including unknown SKU),
PO-quantity, receipt-quantity, field checks. A **voided** invoice has no exceptions at all.

| # | Rule | Evidence `id` | `type` | Severity | Raised when |
| --- | --- | --- | --- | :---: | --- |
| 1 | Invoice number required | `required-number` | `missing_field` | high | Blank after trimming |
| 2 | Supplier required | `required-supplier` | `missing_field` | high | No supplier (or the legacy placeholder `unassigned`) |
| 3 | Invoice date valid | `required-date` | `missing_field` | high | Not a valid ISO date (including empty) |
| 4 | Due date valid | `required-due-date` | `missing_field` | high | Not a valid ISO date (including empty) |
| 5 | At least one line | `required-lines` | `missing_field` | high | No line items |
| 6 | Purchase order linked | `required-po` | `missing_field` | high | No PO found for the invoice |
| 7 | PO belongs to the supplier | `required-po-supplier` | `missing_field` | high | `PO.supplierId ≠ invoice.supplierId` |
| 8 | Goods receipt linked | `required-delivery` | `missing_field` | high | No receipt found for the invoice |
| 9 | Receipt belongs to the PO | `required-delivery-po` | `missing_field` | high | `receipt.purchaseOrderId ≠ invoice.purchaseOrderId` |
| 10 | Input is schema-valid | `required-invalid-{n}` | `missing_field` | high | Any violation of the invoice input schema (due date before invoice date, a price with three decimals, duplicate SKU, total above the maximum…). Title is `"{path}: {message}"` |
| 11 | **Duplicate** | `duplicate-{otherInvoiceId}` | `duplicate` | high | Another non-voided invoice has the same supplier and the same normalized invoice number |
| 12 | SKU not on the PO | `required-sku-{lineId}` | `missing_field` | high | A line's SKU does not appear on the linked PO |
| 13 | **Price tolerance** | `price-{lineId}` | `price` | high | Invoice unit price > PO unit price by more than 5 % (exact cents) |
| 14 | **PO quantity** | `ordered-quantity-{lineId}` | `quantity` | high | Invoiced quantity > quantity still available on the PO |
| 15 | **Receipt quantity** | `quantity-{lineId}` | `quantity` | high | Invoiced quantity > quantity still available on the receipt |
| 16 | Provenance field present | `missing-{label}` | `missing_field` | medium | One of the four provenance fields is blank |
| 17 | Field confidence | `confidence-{label}` | `field_confidence` | medium | A field's extraction confidence is below 80 % (only sample data has confidences) |

Rules 12–15 produce **one evidence item per offending line**. Rules 7, 12, 13 and 14 need a linked PO; rules 9
and 15 need a linked receipt. When the PO or receipt is missing, rules 6 and 8 report that instead.

## 4.4 Precise definitions

### Duplicate detection (rule 11)

Two invoices are duplicates when **all** hold: they are different records; neither is `voided`; they have the
**same non-empty supplier**; and `normalizedInvoiceNumber(a) = normalizedInvoiceNumber(b)` where

```text
normalizedInvoiceNumber(x) = NFKC(x).trim().replace(/\s+/g, " ").toLowerCase()
```

Consequences:

- Detection is **symmetric**: both records are flagged, and each cites the other in its `Existing record`
  value.
- Only the **first** matching record is cited, even if several duplicates exist.
- An empty invoice number or missing supplier never matches anything.
- Different suppliers may legitimately reuse the same number.
- Voiding a record removes it from consideration immediately; this is how a duplicate is resolved.

### Price tolerance (rule 13)

For each invoice line whose SKU exists on the PO, work in **integer cents**:

```text
invoiceCents = round(invoiceUnitPrice × 100)
orderCents   = round(poUnitPrice × 100)
pass  ⇔  invoiceCents × 100  ≤  orderCents × (100 + 5)
```

The constant is `ALLOWED_PRICE_VARIANCE_PERCENT = 5`. Percentages shown to users are rounded for display only
and play no part in the decision.

| PO price | Invoice price | Result |
| ---: | ---: | --- |
| 10.00 | 10.50 | **pass** – exactly +5 % is allowed |
| 10.00 | 10.51 | **exception** – `($10.51 - $10.00) / $10.00 = 5.1%` |
| 10.00 | 9.00 | pass – a lower price is never flagged |
| 20.00 | 21.00 | pass – exactly +5 % |
| 12.00 | 13.50 | **exception** – `= 12.5%` |
| 0.00 | 0.00 | pass |
| 0.00 | 0.01 | **exception** – "The PO price is zero; a positive invoice price requires correction." (no percentage can be computed) |

The evidence lists *Invoice* (`qty × price`), *Purchase order* (`qty × PO price` at the **invoice** quantity) and
*Difference* (the dollar difference between the two line totals).

### Quantity reservation (rules 14 and 15)

```text
committed(sku, scope) = Σ quantity of that SKU on OTHER invoices that
                        • share the same PO (scope = PO) or the same receipt (scope = receipt), and
                        • have status ready_to_export or exported

rule 14:  available = max(0, PO line quantity − committed(sku, PO))              exception if invoiceQty > available
rule 15:  available = max(0, receipt line quantity − committed(sku, receipt))    exception if invoiceQty > available
```

Key properties:

- Only **approved (`ready_to_export`) and `exported`** invoices reserve quantity. Drafts, `matched`,
  `needs_review`, `escalated`, `correction_requested` and `voided` invoices reserve nothing. Two drafts can
  therefore both look clean; **the second approval is the one that fails**. The global lock
  ([§5.5](./05-invoice-lifecycle.md#55-concurrency-control)) makes that outcome race-free.
- An invoice never counts against itself.
- A SKU absent from the PO (or receipt) has a line quantity of `0`, so any positive invoiced quantity exceeds it.
- The `calculation` text for rule 15 reads `N invoiced - A delivered = D unreceived`, where **`A` is the
  *available* quantity after reservations**, and the explanation states how many units are already committed.
- There is no partial-delivery tolerance: invoiced quantity must be **≤** what is available.

### Required fields (rules 1–10)

A draft may be saved with anything missing, but it can never be approved until each of these holds. Rule 10
re-runs the full input schema ([§3.5](./03-domain-model.md#35-invoices)) against the stored invoice, so
constraints such as "due date not before invoice date" or "no duplicate SKUs" are also approval prerequisites
even if the data reached the database by another route.

### Provenance checks (rules 16–17)

The four generated provenance fields (*Invoice number, Supplier, Invoice date, Total*) are checked for blank
values (medium severity) and, if a `confidence` is present, for confidence **< 0.80**
(`MINIMUM_FIELD_CONFIDENCE = 0.8`; a value of exactly 0.80 passes). Manually entered fields have no
confidence, so rule 17 only ever fires on the synthetic sample data.

## 4.5 Worked examples

All outputs below were produced by running the engine on the sample data
([§3.12](./03-domain-model.md#312-sample-dataset)) or on the stated inputs.

**1. Clean match – `inv-001`.** Invoice, PO and receipt agree line by line (24 bearings @ 18.50, 100 bolts @
0.42). No exceptions → status `matched`; *Approve for export* is enabled.

**2. Price variance – `inv-002`.** Invoice 10 × $13.50 against PO 10 × $12.00:
`price-<line>` — `($13.50 - $12.00) / $12.00 = 12.5%`, difference $15.00. Resolution: correct a data-entry
error (edit with a reason) or request a correction from the supplier (internal note).

**3. Short delivery – `inv-003`.** 30 gloves invoiced, 24 received:
`quantity-<line>` — `30 invoiced - 24 delivered = 6 unreceived`.

**4. Duplicate pair – `inv-004` / `inv-005`.** Both MER-55210 from Meridian Lubricants. Each shows
`duplicate-<other id>` "Possible duplicate invoice". Voiding `inv-005` (with a reason) clears the flag on
`inv-004`, which can then be approved.
*Follow-up:* if instead `inv-005` is renumbered to `MER-55211` while `inv-004` is already approved, the
duplicate flag disappears but **two quantity exceptions appear** — `ordered-quantity-…` (*available PO quantity
= 0*) and `quantity-…` (*available delivered quantity = 0*) — because `inv-004` holds all 8 units.

**5. Low confidence and missing field – `inv-006`.** Two exceptions: `confidence-Supplier` (61 % < 80 %) and
`missing-Total`. Saving the invoice (with a reason) **replaces the provenance fields with manual ones** —
Total is rebuilt from the lines as `$248.40` and no confidence exists — so both exceptions disappear and the
status becomes `matched`.

**6. Cumulative reservation.** PO and receipt both cover **10 units of X**. Invoice A bills 6 units and is
approved. Invoice B also bills 6 units:

| Evidence | Detail |
| --- | --- |
| `ordered-quantity-…` | Invoice quantity 6; **available PO quantity 4** |
| `quantity-…` | Invoice quantity 6; available delivered quantity 4; unreceived quantity 2 (`6 invoiced - 4 delivered = 2 unreceived`) |

While A is only a draft, B has no exceptions. Once A is approved, B cannot be. If A is later reopened by an
administrator it becomes a draft again and frees its units; voiding it afterwards keeps them free.

**7. Empty draft.** An invoice saved with nothing filled in has **11** exceptions: seven required-field
items (rules 1–6 and 8; rules 7 and 9 need a PO/receipt to compare against) plus four blank-provenance items.
This is expected for a draft and is why *Approve* is disabled.

## 4.6 Status derivation

When an invoice is created or its fields are saved, the stored `status` is set from the result:

| Evidence found | Status |
| --- | --- |
| Any `duplicate` item | `possible_duplicate` |
| Otherwise, any item | `needs_review` |
| None | `matched` |

Other transitions (approve, correction, escalate, void, reopen, export) set their own status; *reopen* always
sets `needs_review` regardless of the current evidence.

**The label is a snapshot; the evidence is live.** The status is only recomputed when *that invoice* is saved.
So an invoice labeled `matched` can later show exceptions (a duplicate arrives, another invoice reserves its
units), and a `needs_review` invoice can become clean when its competitor is voided. Therefore:

- the **review page and the queue's "Exception reason" column** always show live evidence;
- **approval and export always re-check**, so a stale label can never cause a bad approval;
- the **dashboard counts** group by the stored label, so they can briefly disagree with live evidence.

## 4.7 Evidence structure

Each item is an `ExceptionEvidence` ([`types.ts`](../src/domain/types.ts)):

```json
{
  "id": "price-5f0c…",
  "type": "price",
  "title": "Price exceeds PO tolerance for FLT-A20",
  "explanation": "The invoice unit price exceeds the 5% tolerance. Comparisons use exact cents; displayed percentages are rounded.",
  "severity": "high",
  "sourceValues": [
    { "label": "Invoice",         "value": "10 x $13.50" },
    { "label": "Purchase order",  "value": "10 x $12.00" },
    { "label": "Difference",      "value": "$15.00" }
  ],
  "calculation": "($13.50 - $12.00) / $12.00 = 12.5%"
}
```

`id` is stable only within one version of an invoice because line IDs are regenerated on every save.
`sourceValues` are display strings, not machine-readable numbers; do not parse them.

## 4.8 Overlaps and quirks

These are real properties of the current implementation, listed so nobody is surprised:

1. **Overlapping evidence.** One underlying gap can raise several items. An empty invoice number raises both
   `required-number` and `missing-Invoice number`. A line whose SKU is not on the PO raises up to **three**:
   `required-sku-…`, `ordered-quantity-…` (available 0) and — if a receipt is linked — `quantity-…`.
2. **Unstable evidence IDs across versions** (line IDs change on save).
3. **Only the first duplicate is cited**, even when several exist.
4. **Receipt-quantity wording.** The calculation says "delivered" but shows the *available* quantity after
   reservations (§4.4).
5. **`UNRESOLVED_EXCEPTIONS` details.** The API returns the exception list in the error `details`, but the
   web UI does not need it — the review page already shows live evidence.

## 4.9 What the rules do not check

- Tax correctness or rates (tax is just a validated amount).
- Currency conversion (USD only).
- Payment terms, early-payment discounts, or due-date policy beyond "due date ≥ invoice date".
- Line **descriptions** (matching is by SKU only), units of measure, or price breaks.
- Whether the invoice date falls after the receipt date, or within a PO validity window.
- PO or receipt *header* totals; only line quantities and unit prices are compared.
- Supplier identity beyond the selected supplier record (bank details, tax IDs, etc.).
- Anything about the **document image** — nothing is extracted from or compared with the uploaded file.

## 4.10 Changing the rules safely

The two tunable constants are `ALLOWED_PRICE_VARIANCE_PERCENT` and `MINIMUM_FIELD_CONFIDENCE` in
`invoiceChecks.ts`. Because exceptions are derived, **a rule change takes effect immediately on existing data**:

- Tightening a rule can make already-approved invoices fail the **export-time re-check**; they must then be
  reopened (administrator) and corrected before they can be exported.
- Loosening a rule never changes history; past decisions and snapshots are untouched.
- Update `invoiceChecks.test.ts` and the integration tests that assert specific evidence, and revise this
  document. Per-supplier or configurable tolerances are listed on the
  [roadmap](./13-limitations-and-roadmap.md#133-roadmap-suggestions).
