import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * PCR-1 deploys migration-first (the previous build must keep working on the migrated schema). That is only
 * safe if the migration is purely additive: new nullable columns, or NOT NULL columns with a constant default,
 * and nothing that rewrites, renames, drops or locks existing data. This test pins that property.
 */
const sql = readFileSync(
  fileURLToPath(new URL("../prisma/migrations/20261102120000_order_position_lifecycle/migration.sql", import.meta.url)),
  "utf8",
);
const statements = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

describe("PCR-1 migration is additive and backward-compatible", () => {
  it("contains only ADD COLUMN statements that old code can ignore", () => {
    expect(statements.length).toBe(5);
    for (const statement of statements) {
      expect(statement).toMatch(/^ALTER TABLE "(Order|Position|StrategyAllocation)" ADD COLUMN "\w+" (TEXT|DECIMAL\(38,8\))( NOT NULL DEFAULT 0)?$/);
    }
  });

  it("never drops, renames, retypes, rewrites or builds an index", () => {
    // Executable statements only (the comments explain why these are absent).
    expect(statements.join(";\n")).not.toMatch(/\b(DROP|RENAME|ALTER COLUMN|TYPE\s+\w|UPDATE|DELETE|TRUNCATE|CREATE\s+(UNIQUE\s+)?INDEX)\b/i);
  });

  it("every NOT NULL column has a constant default (no table rewrite, no failure on existing rows)", () => {
    for (const statement of statements.filter((s) => /NOT NULL/.test(s))) {
      expect(statement).toMatch(/NOT NULL DEFAULT 0$/);
    }
  });
});
