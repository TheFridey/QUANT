// Starts `next dev` / `next start` bound to loopback unless WEB_HOST says otherwise (audit M4).
// Usage: node scripts/next-serve.mjs <dev|start>
import { spawn } from "node:child_process";
import process from "node:process";

export function nextServeArgs(mode, env) {
  if (mode !== "dev" && mode !== "start") throw new Error(`unknown mode ${mode}`);
  const host = env.WEB_HOST && env.WEB_HOST.trim() ? env.WEB_HOST.trim() : "127.0.0.1";
  const port = env.WEB_PORT && /^\d+$/.test(env.WEB_PORT) ? env.WEB_PORT : "4317";
  return [mode, "--hostname", host, "--port", port];
}

if (process.argv[1]?.endsWith("next-serve.mjs")) {
  const args = nextServeArgs(process.argv[2], process.env);
  const child = spawn("next", args, { stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}
