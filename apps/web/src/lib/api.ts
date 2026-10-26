const TOKEN_KEY = "odin_token";

export function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4318";
}

export function token(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(value: string | null): void {
  if (value) sessionStorage.setItem(TOKEN_KEY, value);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  const session = token();
  if (session) headers.set("authorization", `Bearer ${session}`);
  const response = await fetch(`${apiBase()}/api${path}`, { ...init, headers });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (response.status === 401 && path !== "/auth/login") {
    setToken(null);
    window.location.href = "/login";
    throw new Error("Authentication required");
  }
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}
