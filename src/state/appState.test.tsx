import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admin, apiError, json, mockApi, renderApp, reviewer, session } from "../test/helpers";

afterEach(() => vi.unstubAllGlobals());

describe("authenticated application state", () => {
  it("shows sign-in on an absent session and preserves a requested deep link", async () => {
    let loggedIn = false;
    mockApi({ handle: (call) => {
      if (call.path === "/auth/me" && !loggedIn) return apiError("Sign in", 401, "UNAUTHENTICATED");
      if (call.path === "/auth/login") { loggedIn = true; return json(session); }
    } });
    renderApp("/invoices/inv-001");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "alex@example.test");
    await user.type(screen.getByLabelText("Password"), "a-valid-test-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "NFM-24081", level: 1 })).toBeInTheDocument();
  });
  it("reports login errors without creating a session", async () => {
    mockApi({ handle: (call) => call.path === "/auth/me" || call.path === "/auth/login" ? apiError("Email or password is incorrect.", 401, "INVALID_CREDENTIALS") : undefined });
    renderApp();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "alex@example.test");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect");
  });
  it("recovers from a failed session check without showing a success-shaped empty state", async () => {
    let fail = true;
    mockApi({ handle: (call) => call.path === "/auth/me" && fail ? apiError("Database unavailable", 503) : undefined });
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Welcome, Alex" })).toBeInTheDocument();
  });
  it("clears confidential views when a request indicates an expired session", async () => {
    let expire = false;
    mockApi({ handle: (call) => call.path === "/dashboard" && expire ? apiError("Session expired", 401, "SESSION_EXPIRED") : undefined });
    renderApp();
    await screen.findByRole("heading", { name: "Welcome, Alex" });
    expire = true;
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("heading", { name: "Sign in to your workspace" })).toBeInTheDocument();
    expect(screen.queryByText("Priority review")).not.toBeInTheDocument();
  });
  it("does not pretend logout succeeded when the network fails", async () => {
    let fail = true;
    mockApi({ handle: (call) => {
      if (call.path === "/auth/logout" && fail) throw new TypeError("offline");
      return undefined;
    } });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach");
    expect(screen.getByRole("heading", { name: "Welcome, Alex" })).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in to your workspace" })).toBeInTheDocument();
  });
  it("forces temporary-password changes and replaces the session after success", async () => {
    mockApi({ user: { ...reviewer, mustChangePassword: true }, handle: (call) => call.path === "/auth/change-password" ? json({ user: reviewer, csrfToken: "b".repeat(64) }) : undefined });
    renderApp("/invoices");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Current password"), "temporary-password");
    await user.type(screen.getByLabelText("New password"), "my-new-private-password");
    await user.type(screen.getByLabelText("Confirm new password"), "my-new-private-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("heading", { name: "Invoice queue" })).toBeInTheDocument();
  });
  it("validates password confirmation and displays server password errors", async () => {
    const api = mockApi({ handle: (call) => call.path === "/auth/change-password" ? apiError("The current password is incorrect.", 400) : undefined });
    renderApp("/account");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Current password"), "old-password");
    await user.type(screen.getByLabelText("New password"), "new-private-password");
    await user.type(screen.getByLabelText("Confirm new password"), "mismatched-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
    expect(api.calls.filter((call) => call.path === "/auth/change-password")).toHaveLength(0);
    await user.clear(screen.getByLabelText("Confirm new password"));
    await user.type(screen.getByLabelText("Confirm new password"), "new-private-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("current password is incorrect");
  });
  it("reports successful account changes and allows account navigation", async () => {
    mockApi();
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "Your account" }));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Current password"), "old-password");
    await user.type(screen.getByLabelText("New password"), "new-private-password");
    await user.type(screen.getByLabelText("Confirm new password"), "new-private-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Password changed");
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });
  it("hides admin navigation and rejects direct reviewer-only access", async () => {
    mockApi({ user: reviewer });
    renderApp("/users");
    expect(await screen.findByRole("heading", { name: "Administrator access required" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Team access" })).not.toBeInTheDocument();
  });
  it("renders an explicit unknown route and navigates back", async () => {
    mockApi({ user: admin });
    renderApp("/does-not-exist");
    await userEvent.click(await screen.findByRole("button", { name: "Return to overview" }));
    expect(await screen.findByRole("heading", { name: "Welcome, Alex" })).toBeInTheDocument();
  });
  it("ignores an aborted stale response after navigating to another invoice", async () => {
    let finish: ((value: Response) => void) | undefined;
    mockApi({ handle: (call) => {
      if (call.path === "/invoices/inv-001") return new Promise<Response>((resolve) => { finish = resolve; });
    } });
    const { router } = renderApp("/invoices/inv-001");
    await waitFor(() => expect(finish).toBeDefined());
    await act(() => router.navigate("/invoices/inv-002"));
    expect(await screen.findByRole("heading", { name: "ALP-8837", level: 1 })).toBeInTheDocument();
    await act(async () => { finish?.(apiError("Stale result", 500)); });
    expect(screen.queryByText(/Stale result/)).not.toBeInTheDocument();
  });
  it("guards unsaved drafts on browser close and route changes", async () => {
    mockApi();
    const { router } = renderApp("/invoices/new");
    await userEvent.type(await screen.findByLabelText("Invoice number"), "UNSAVED");
    const closing = new Event("beforeunload", { cancelable: true });
    fireEvent(window, closing);
    expect(closing.defaultPrevented).toBe(true);
    await act(() => router.navigate("/invoices"));
    expect(await screen.findByRole("alert")).toHaveTextContent("unsaved changes");
    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Invoice number")).toHaveValue("UNSAVED");
    await act(() => router.navigate("/invoices"));
    await userEvent.click(screen.getByRole("button", { name: "Discard changes and leave" }));
    expect(await screen.findByRole("heading", { name: "Invoice queue" })).toBeInTheDocument();
  });
});
