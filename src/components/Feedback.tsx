import { useState } from "react";
import { errorMessage } from "../services/api";
import { useAppState } from "../state/appState";

export function ErrorMessage({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return <div className="error-message" role="alert"><p>{errorMessage(error)}</p>{onRetry && <button type="button" className="button secondary" onClick={onRetry}>Try again</button>}</div>;
}
export function Loading({ label = "Loading..." }: { label?: string }) {
  return <div className="loading-state" role="status">{label}</div>;
}
export function Pagination({ page, total, limit, onPage, disabled = false }: { page: number; total: number; limit: number; onPage: (page: number) => void; disabled?: boolean }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return <nav className="pagination" aria-label="Pagination">
    <span>{total === 0 ? "No records" : `${Math.min((page - 1) * limit + 1, total)}-${Math.min(page * limit, total)} of ${total}`}</span>
    <div><button className="button secondary" type="button" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>Previous</button><span>Page {page} of {pages}</span><button className="button secondary" type="button" disabled={disabled || page >= pages} onClick={() => onPage(page + 1)}>Next</button></div>
  </nav>;
}
export function DownloadButton({ path, filename, label = "Download" }: { path: string; filename: string; label?: string }) {
  const { download } = useAppState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const handleDownload = async () => {
    setBusy(true);
    setError(null);
    try { await download(path, filename); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <><button type="button" className="button secondary" disabled={busy} onClick={() => void handleDownload()}>{busy ? "Downloading..." : label}</button><ErrorMessage error={error} /></>;
}
