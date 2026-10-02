import { useEffect, useRef, useState } from "react";
import type { Page } from "../App";
import { documentTypes, emptyInvoiceInput, MAX_DOCUMENT_BYTES, type InvoiceInput } from "../domain/validation";
import { InvoiceForm } from "../components/InvoiceForm";
import { ErrorMessage } from "../components/Feedback";
import { useAppState } from "../state/appState";

export function Upload({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const { request, refresh } = useAppState();
  const input = useRef<HTMLInputElement>(null);
  const intent = useRef<{ payload: string; file: File | null; id: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [fileError, setFileError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) { setPreview(""); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const chooseFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const selected = files[0];
    setFile(null);
    setFileError("");
    if (files.length !== 1) { setFileError("Choose exactly one document."); return; }
    if (!documentTypes.some((type) => type === selected.type)) { setFileError("Choose a PDF, PNG, or JPG document."); return; }
    if (selected.size === 0 || selected.size > MAX_DOCUMENT_BYTES) { setFileError("Choose a non-empty file no larger than 10 MiB."); return; }
    setFile(selected);
  };
  const save = async (invoice: InvoiceInput) => {
    const payload = JSON.stringify(invoice);
    if (!intent.current || intent.current.payload !== payload || intent.current.file !== file) intent.current = { payload, file, id: crypto.randomUUID() };
    const metadata = { requestId: intent.current.id, invoice };
    let body: unknown = metadata;
    if (file) {
      const form = new FormData();
      form.append("data", JSON.stringify(metadata));
      form.append("document", file);
      body = form;
    }
    setSaving(true);
    try {
      const result = await request<{ id: string }>("/invoices", { method: "POST", body });
      refresh();
      onNavigate({ name: "review", invoiceId: result.id });
    } finally { setSaving(false); }
  };
  return <div>
    <section className="page-heading"><span className="eyebrow">Invoice intake</span><h1>New invoice</h1><p>Attach a document or enter a manual draft. Saved records are shared with your authorized team.</p></section>
    <div className="upload-layout">
      <section className="panel">
        <div className="panel-header"><div><h2>Invoice fields</h2><p>Manual entry - OCR is not connected</p></div></div>
        <InvoiceForm initial={emptyInvoiceInput()} onSave={save} disabled={Boolean(fileError)} hasDocument={Boolean(file)} />
      </section>
      <aside className="upload-side">
        <section className="panel">
          <div className={`drop-zone compact ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); if (!saving) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); if (!saving) chooseFiles(event.dataTransfer.files); }}>
            <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg" className="sr-only" aria-label="Invoice document" disabled={saving} onChange={(event) => { chooseFiles(event.target.files); event.target.value = ""; }} />
            <span className="upload-icon" aria-hidden="true">DOC</span><h2>{file?.name ?? "Optional source document"}</h2><p>{file ? `${(file.size / 1024).toFixed(1)} KiB` : "Drop one PDF, PNG, or JPG up to 10 MiB"}</p>
            <button className="button secondary" type="button" disabled={saving} onClick={() => input.current?.click()}>{file ? "Choose a different file" : "Choose file"}</button>
            {(file || fileError) && <button className="text-button" type="button" disabled={saving} onClick={() => { setFile(null); setFileError(""); }}>Clear document</button>}
          </div>
          <ErrorMessage error={fileError} />
          {preview && file && <img className="document-preview" src={preview} alt={`Preview of ${file.name}`} />}
          {file?.type === "application/pdf" && <p className="help-text panel-padding">PDFs are stored as authenticated downloads, not embedded in the application.</p>}
        </section>
        <section className="info-card"><div><h2>Private, persistent intake</h2><p>The source file is stored in your PostgreSQL database and is accessible only to signed-in team members. Documents are not sent to an OCR, AI, ERP, or payment provider.</p></div></section>
      </aside>
    </div>
  </div>;
}
