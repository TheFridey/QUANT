/**
 * Allowed browser origins for HTTP CORS and Socket.IO (D25).
 * Never use `origin: true` / reflect-any — restrict to WEB_ORIGIN plus local paper defaults.
 */
export function allowedWebOrigins(webOrigin = process.env.WEB_ORIGIN): string[] {
  const defaults = ["http://127.0.0.1:4317", "http://localhost:4317"];
  const configured = webOrigin?.trim();
  const origins = configured ? [configured, ...defaults] : defaults;
  return [...new Set(origins)];
}

export function isAllowedSocketOrigin(origin: string | undefined, allowed = allowedWebOrigins()): boolean {
  // Non-browser clients (no Origin) are allowed for local tooling; browsers must match.
  if (!origin) return true;
  return allowed.includes(origin);
}
