import type { InvoiceStatus } from "../domain/types";

export const statusLabels: Record<InvoiceStatus, string> = {
  needs_review: "Needs review",
  possible_duplicate: "Possible duplicate",
  matched: "Matched",
  ready_to_export: "Ready to export",
  correction_requested: "Correction requested",
  escalated: "Escalated",
  exported: "Exported",
  voided: "Voided",
};

export function StatusPill({ status }: { status: InvoiceStatus }) {
  return <span className={`status-pill status-${status}`}>{statusLabels[status]}</span>;
}
