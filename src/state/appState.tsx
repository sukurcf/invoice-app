import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session } from "../domain/api";
import type { User } from "../domain/types";
import { ApiError, downloadFile, isAbort, requestJson, type RequestOptions } from "../services/api";

interface AppStateValue {
  user: User | null;
  loading: boolean;
  authError: unknown;
  retrySession: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  request: <T>(path: string, options?: RequestOptions) => Promise<T>;
  download: (path: string, filename: string) => Promise<void>;
  revision: number;
  refresh: () => void;
}
const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const csrf = useRef("");
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<unknown>(null);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [revision, setRevision] = useState(0);
  const acceptSession = useCallback((value: Session | null) => {
    csrf.current = value?.csrfToken ?? "";
    setSession(value);
  }, []);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const retrySession = useCallback(() => setSessionAttempt((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setAuthError(null);
    void requestJson<Session>("/auth/me", { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) acceptSession(value);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbort(error)) return;
      if (error instanceof ApiError && error.status === 401) acceptSession(null);
      else setAuthError(error);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [acceptSession, sessionAttempt]);

  const handleFailure = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401 && error.code !== "INVALID_CREDENTIALS") {
      acceptSession(null);
      refresh();
    }
    throw error;
  }, [acceptSession, refresh]);
  const request = useCallback(async <T,>(path: string, options?: RequestOptions): Promise<T> => {
    try { return await requestJson<T>(path, options, csrf.current); }
    catch (error) { return handleFailure(error); }
  }, [handleFailure]);
  const download = useCallback(async (path: string, filename: string): Promise<void> => {
    try { await downloadFile(path, filename); }
    catch (error) { handleFailure(error); }
  }, [handleFailure]);
  const login = useCallback(async (email: string, password: string) => {
    acceptSession(await request<Session>("/auth/login", { method: "POST", body: { email, password } }));
    refresh();
  }, [acceptSession, refresh, request]);
  const logout = useCallback(async () => {
    await request("/auth/logout", { method: "POST" });
    acceptSession(null);
    refresh();
  }, [acceptSession, refresh, request]);
  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    acceptSession(await request<Session>("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } }));
    refresh();
  }, [acceptSession, refresh, request]);
  const value = useMemo<AppStateValue>(() => ({
    user: session?.user ?? null, loading, authError, retrySession, login, logout, changePassword, request, download, revision, refresh,
  }), [session, loading, authError, retrySession, login, logout, changePassword, request, download, revision, refresh]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const context = useContext(AppStateContext);
  if (!context) throw new Error("useAppState must be used within AppStateProvider");
  return context;
}

export function useResource<T>(path: string | null) {
  const { request, revision } = useAppState();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ path: string | null; data?: T; loading: boolean; error: unknown }>({ path, loading: path !== null, error: null });
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (!path) {
      setState({ path, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({ path, data: previous.path === path ? previous.data : undefined, loading: true, error: null }));
    void request<T>(path, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setState({ path, data, loading: false, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !isAbort(error)) setState((previous) => ({ ...previous, loading: false, error }));
    });
    return () => controller.abort();
  }, [path, request, revision, attempt]);
  return { ...state, data: state.path === path ? state.data : undefined, loading: state.path !== path ? path !== null : state.loading, reload };
}

export function useDebouncedValue(value: string, delay = 200): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
}
