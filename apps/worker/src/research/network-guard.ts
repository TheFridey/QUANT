import net from "node:net";

/**
 * Blocks every outbound connection of the current process: sockets (so HTTP, HTTPS, TLS, Postgres and Redis
 * clients all fail) and `fetch`. Installed by the campaign evaluator before it touches a job, so a
 * deterministic evaluation cannot read anything that is not in its job file. Returns the number of blocked
 * attempts so far.
 */
export class NetworkBlockedError extends Error {
  constructor(what: string) {
    super(`NETWORK_BLOCKED: ${what} is not allowed inside a deterministic evaluation`);
    this.name = "NetworkBlockedError";
  }
}

export function installNetworkBlock(): { blocked: () => number } {
  let blocked = 0;
  net.Socket.prototype.connect = function blockedConnect(): never {
    blocked += 1;
    throw new NetworkBlockedError("opening a socket");
  } as unknown as typeof net.Socket.prototype.connect;
  globalThis.fetch = (async () => {
    blocked += 1;
    throw new NetworkBlockedError("fetch");
  }) as typeof fetch;
  return { blocked: () => blocked };
}
