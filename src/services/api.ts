export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly requestId?: string) {
    super(message);
    this.name = "ApiError";
  }
}
export type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function responseError(response: Response): Promise<ApiError> {
  let body: unknown;
  try { body = await response.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return new ApiError(response.status, "HTTP_ERROR", `The server returned HTTP ${response.status}. Try again or contact your administrator.`);
  }
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.message !== "string") return new ApiError(response.status, "HTTP_ERROR", `The request failed (HTTP ${response.status}).`);
  const details = Array.isArray(body.error.details) ? body.error.details.filter(isRecord).map((detail) => typeof detail.message === "string" ? `${typeof detail.path === "string" && detail.path ? `${detail.path}: ` : ""}${detail.message}` : "").filter(Boolean).join(" ") : "";
  return new ApiError(response.status, typeof body.error.code === "string" ? body.error.code : "HTTP_ERROR",
    `${body.error.message}${details ? ` ${details}` : ""}`, typeof body.requestId === "string" ? body.requestId : undefined);
}
async function send(path: string, options: RequestInit): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("API paths must be relative to this application.");
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...options, credentials: "same-origin", cache: "no-store" });
  } catch (error) {
    if (error instanceof TypeError) throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the server. Check your connection and try again.");
    throw error;
  }
  if (!response.ok) throw await responseError(response);
  return response;
}
export async function requestJson<T>(path: string, options: RequestOptions = {}, csrfToken = ""): Promise<T> {
  const { body, ...init } = options;
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  if (body !== undefined && !(body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await send(path, { ...init, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  if (!response.headers.get("Content-Type")?.includes("application/json")) throw new ApiError(502, "INVALID_RESPONSE", "The API returned an unexpected response. Check the server and proxy configuration.");
  return response.json();
}
export async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await send(path, {});
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function errorMessage(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`).join(" ");
  if (error instanceof ApiError) return `${error.message}${error.requestId ? ` Request ID: ${error.requestId}` : ""}`;
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "The operation failed. Please try again.";
}
export function isAbort(error: unknown): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === "AbortError";
}
import { ZodError } from "zod";
