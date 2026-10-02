import { describe, expect, it } from "vitest";
import { initialData } from "../data/demoData";
import { readyToExportCsv } from "./csv";

describe("ready invoice CSV", () => {
  it("includes only invoices marked ready to export", () => {
    const csv = readyToExportCsv(initialData);
    expect(csv).toContain("NFM-24096");
    expect(csv).not.toContain("ALP-8837");
    expect(csv.split("\n")).toHaveLength(2);
  });
  it.each(["=1+1", "+cmd", "-10+20", "@SUM(1)", "  =1", "\tformula"])("neutralizes spreadsheet formula text (%s)", (invoiceNumber) => {
    const invoice = { ...initialData.invoices[6], invoiceNumber };
    expect(readyToExportCsv({ ...initialData, invoices: [invoice] })).toContain(`'${invoiceNumber}`);
  });
  it("quotes commas, quotes, CR and newlines correctly", () => {
    const invoice = { ...initialData.invoices[6], invoiceNumber: 'A,"B"\r\nC' };
    expect(readyToExportCsv({ ...initialData, invoices: [invoice] })).toContain('"A,""B""\r\nC"');
  });
  it("returns only the header for no approved invoices and excludes exported and voided records", () => {
    const invoices = initialData.invoices.map((invoice) => ({ ...invoice, status: "exported" as const }));
    expect(readyToExportCsv({ ...initialData, invoices }).split("\r\n")).toHaveLength(1);
  });
  it("fails explicitly for incomplete export references", () => {
    expect(() => readyToExportCsv({ ...initialData, suppliers: [] })).toThrow("valid references");
    expect(() => readyToExportCsv({ ...initialData, purchaseOrders: [] })).toThrow("valid references");
  });
});
