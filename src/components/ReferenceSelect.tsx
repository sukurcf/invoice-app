import { useId, useState } from "react";
import type { PageResult } from "../domain/api";
import type { DeliveryRecord, PurchaseOrder, Supplier } from "../domain/types";
import { useDebouncedValue, useResource } from "../state/appState";
import { ErrorMessage } from "./Feedback";

type Reference = Supplier | PurchaseOrder | DeliveryRecord;
function referenceLabel(item: Reference): string {
  if ("poNumber" in item) return item.poNumber;
  if ("deliveryNumber" in item) return item.deliveryNumber;
  return `${item.name} (${item.code})`;
}

export function ReferenceSelect({ kind, label, value, onChange, parentId, initialLabel, disabled = false, required = false }: {
  kind: "suppliers" | "purchase-orders" | "deliveries"; label: string; value: string; onChange: (id: string) => void;
  parentId?: string; initialLabel?: string; disabled?: boolean; required?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedLabel, setSelectedLabel] = useState("");
  const term = useDebouncedValue(search);
  const filter = parentId ? `&${kind === "purchase-orders" ? "supplierId" : "purchaseOrderId"}=${encodeURIComponent(parentId)}` : "";
  const resource = useResource<PageResult<Reference>>(disabled ? null : `/${kind}?limit=20&page=${page}&search=${encodeURIComponent(term)}${filter}`);
  const items = resource.data?.items ?? [];
  return <div className="reference-select">
    <label htmlFor={id}>{label}</label>
    <input aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}...`} maxLength={100} value={search} disabled={disabled} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
    <select id={id} value={value} disabled={disabled} required={required} onChange={(event) => {
      const item = items.find((entry) => entry.id === event.target.value);
      setSelectedLabel(item ? referenceLabel(item) : "");
      onChange(event.target.value);
    }}>
      <option value="">Select {label.toLowerCase()}</option>
      {value && !items.some((item) => item.id === value) && <option value={value}>{selectedLabel || initialLabel || value}</option>}
      {items.map((item) => <option key={item.id} value={item.id}>{referenceLabel(item)}</option>)}
    </select>
    <ErrorMessage error={resource.error} onRetry={resource.reload} />
    {resource.loading && <small role="status">Loading choices...</small>}
    {!disabled && resource.data?.total === 0 && <small>No matching records. Ask an administrator to add reference data.</small>}
    {resource.data && resource.data.total > 20 && <div className="choice-pagination"><button type="button" disabled={page <= 1 || resource.loading} onClick={() => setPage(page - 1)}>Previous choices</button><span>Page {page}</span><button type="button" disabled={page * 20 >= resource.data.total || resource.loading} onClick={() => setPage(page + 1)}>More choices</button></div>}
  </div>;
}
