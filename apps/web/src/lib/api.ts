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

const NOTICE_KEY = "odin_login_notice";

/**
 * Audit M5: revoke the token server-side before forgetting it, so a copied token stops working.
 * The local token is always cleared. Returns false when the server could not confirm revocation.
 */
export async function signOut(): Promise<boolean> {
  const session = token();
  let revoked = session === null;
  if (session) {
    try {
      const response = await fetch(`${apiBase()}/api/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${session}` },
      });
      revoked = response.ok;
    } catch {
      revoked = false;
    }
  }
  setToken(null);
  if (!revoked && typeof window !== "undefined") {
    sessionStorage.setItem(
      NOTICE_KEY,
      "Signed out on this device, but the server did not confirm the session was revoked. It expires on its own; sign in and out again when the API is reachable.",
    );
  }
  return revoked;
}

/** One-shot notice shown on the login page (e.g. after a sign-out the server could not confirm). */
export function takeLoginNotice(): string | null {
  if (typeof window === "undefined") return null;
  const notice = sessionStorage.getItem(NOTICE_KEY);
  if (notice) sessionStorage.removeItem(NOTICE_KEY);
  return notice;
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
