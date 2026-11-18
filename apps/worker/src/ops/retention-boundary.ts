import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Administrative recovery remains confined to explicitly selected local disposable databases. */
export function assertDisposableRetentionTarget(raw: string | undefined): string {
  if (!raw) throw new Error("DATABASE_URL_REQUIRED_EXPLICITLY");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("RETENTION_TARGET_INVALID"); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/odin_test(?:_[a-zA-Z0-9_]+)?$/.test(url.pathname)
    || [...url.searchParams.keys()].some((k) => !['connection_limit', 'pool_timeout', 'schema'].includes(k))) {
    throw new Error("RETENTION_REQUIRES_LOCAL_DISPOSABLE_DATABASE");
  }
  return raw;
}

/** Reject traversal, Windows alternate streams and linked ancestors before any archive I/O. */
export function confinedArchivePath(root: string, component: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(component) || component.endsWith('.')
    || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(component)
    || basename(component) !== component || isAbsolute(component)) throw new Error("UNSAFE_ARCHIVE_COMPONENT");
  const base = resolve(root);
  let walk = base;
  for (;;) {
    if (existsSync(walk) && lstatSync(walk).isSymbolicLink()) throw new Error("ARCHIVE_LINK_REFUSED");
    const parent = dirname(walk);
    if (parent === walk) break;
    walk = parent;
  }
  const candidate = join(base, component);
  if (existsSync(candidate)) {
    if (lstatSync(candidate).isSymbolicLink()) throw new Error("ARCHIVE_LINK_REFUSED");
    const rel = relative(realpathSync(base), realpathSync(candidate));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error("ARCHIVE_ESCAPE_REFUSED");
  }
  return candidate;
}
