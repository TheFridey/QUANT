import { createHash } from "node:crypto";
import ts from "typescript";
import { STRATEGY_CONTRACT_VERSION } from "./strategy-interface.js";

export type CompileResult =
  | { ok: true; javascript: string; artifactHash: string; contractVersion: typeof STRATEGY_CONTRACT_VERSION }
  | { ok: false; error: string };

/** Transpile strategy source. Compilation does not execute the strategy. */
export function compileStrategySource(source: string): CompileResult {
  const transpiled = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      strict: false,
    },
  });
  const diagnostics = transpiled.diagnostics ?? [];
  const errors = diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const message = errors
      .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"))
      .join("; ");
    return { ok: false, error: message || "TypeScript compilation failed" };
  }
  const javascript = transpiled.outputText;
  if (!/\bonBar\b/.test(javascript)) {
    return { ok: false, error: "Compiled artifact does not contain onBar" };
  }
  return {
    ok: true,
    javascript,
    artifactHash: sha256(javascript),
    contractVersion: STRATEGY_CONTRACT_VERSION,
  };
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
