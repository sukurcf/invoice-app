import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, downloadFile, errorMessage, isAbort, requestJson } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("API transport", () => {
  it("uses same-origin credentials, CSRF headers, and JSON payloads", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await requestJson("/invoices", { method: "POST", body: { value: 1 } }, "token")).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith("/api/invoices", expect.objectContaining({ credentials: "same-origin", cache: "no-store", body: '{"value":1}' }));
    const headers = fetch.mock.calls[0][1].headers as Headers;
    expect(headers.get("x-csrf-token")).toBe("token");
  });
  it("does not set a multipart content type manually", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await requestJson("/invoices", { method: "POST", body: new FormData() });
    expect((fetch.mock.calls[0][1].headers as Headers).has("content-type")).toBe(false);
  });
  it("preserves validation details and request IDs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "Invalid input.", details: [{ path: "email", message: "Bad email." }] }, requestId: "request-123" }), { status: 400, headers: { "Content-Type": "application/json" } })));
    await expect(requestJson("/invoices")).rejects.toThrow("email: Bad email");
    expect(errorMessage(new ApiError(400, "BAD", "Try again", "id-1"))).toContain("Request ID: id-1");
  });
  it("surfaces network errors and non-JSON proxy responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(requestJson("/invoices")).rejects.toThrow("Cannot reach");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>proxy</html>", { status: 502 })));
    await expect(requestJson("/invoices")).rejects.toThrow("HTTP 502");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>index</html>", { status: 200 })));
    await expect(requestJson("/invoices")).rejects.toThrow("unexpected response");
  });
  it("rejects external paths and preserves abort errors", async () => {
    await expect(requestJson("https://example.com")).rejects.toThrow("relative");
    await expect(requestJson("//example.com")).rejects.toThrow("relative");
    const abort = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(requestJson("/invoices")).rejects.toBe(abort);
    expect(isAbort(abort)).toBe(true);
    expect(isAbort(new Error("other"))).toBe(false);
    expect(errorMessage(null)).toContain("failed");
  });
  it("downloads a blob and releases its URL", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("csv")));
    const create = vi.fn().mockReturnValue("blob:test");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await downloadFile("/exports/id/download", "invoices.csv");
    expect(click).toHaveBeenCalled();
    expect(document.querySelector("a")).toBeNull();
    await vi.runAllTimersAsync();
    expect(revoke).toHaveBeenCalledWith("blob:test");
    vi.useRealTimers();
  });
});
