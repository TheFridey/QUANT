import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canTransitionModel, checkModelTransition, MODEL_STATES, MODEL_TRANSITIONS, TERMINAL_MODEL_STATES, type ModelState } from "./model-lifecycle.js";

const MIGRATION = fileURLToPath(new URL("../../../shared/prisma/migrations/20261104100000_genesis_model_registry_shadow/migration.sql", import.meta.url));
const HASH = "b".repeat(64);
const now = new Date("2026-11-04T12:00:00Z");
const base = { modelVersionId: "m1", artefactHash: HASH, actor: "genesis-test", reason: "evidence", now };

describe("GENESIS model lifecycle", () => {
  it("terminal states have no exits and every state is reachable from EXPERIMENTAL", () => {
    for (const s of TERMINAL_MODEL_STATES) expect(MODEL_TRANSITIONS[s]).toEqual([]);
    const seen = new Set<ModelState>(["EXPERIMENTAL"]);
    const queue: ModelState[] = ["EXPERIMENTAL"];
    while (queue.length) {
      for (const n of MODEL_TRANSITIONS[queue.shift()!]) {
        if (seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    expect([...seen].sort()).toEqual([...MODEL_STATES].sort());
  });

  it("refuses skipping stages and leaving terminal states", () => {
    expect(canTransitionModel("EXPERIMENTAL", "SHADOW_CANDIDATE")).toBe(false);
    expect(canTransitionModel("HISTORICALLY_ELIGIBLE", "PAPER_APPROVED")).toBe(false);
    expect(canTransitionModel("REJECTED", "EXPERIMENTAL")).toBe(false);
    expect(canTransitionModel("RETIRED", "SHADOW_CANDIDATE")).toBe(false);
    expect(checkModelTransition({ ...base, from: "EXPERIMENTAL", to: "SHADOW_VALIDATED" })).toMatchObject({ ok: false, code: "ILLEGAL_TRANSITION" });
    expect(checkModelTransition({ ...base, from: "EXPERIMENTAL", to: "LIVE" })).toMatchObject({ ok: false, code: "UNKNOWN_STATE" });
    expect(checkModelTransition({ ...base, from: "EXPERIMENTAL", to: "HISTORICALLY_ELIGIBLE" })).toEqual({ ok: true });
    expect(checkModelTransition({ ...base, reason: " ", from: "EXPERIMENTAL", to: "HISTORICALLY_ELIGIBLE" })).toMatchObject({ code: "REASON_REQUIRED" });
  });

  it("PAPER_CANDIDATE and PAPER_APPROVED need an operator; PAPER_APPROVED needs a current approval of this artefact", () => {
    expect(checkModelTransition({ ...base, from: "SHADOW_VALIDATED", to: "PAPER_CANDIDATE" })).toMatchObject({ code: "OPERATOR_REQUIRED" });
    expect(checkModelTransition({ ...base, actor: "operator:ops", from: "SHADOW_VALIDATED", to: "PAPER_CANDIDATE" })).toEqual({ ok: true });
    const op = { ...base, actor: "operator:ops", from: "PAPER_CANDIDATE", to: "PAPER_APPROVED" };
    const approval = { id: "a1", modelVersionId: "m1", approvedBy: "operator:ops", approvedAt: new Date(now.getTime() - 1000), expiresAt: new Date(now.getTime() + 1000), subjectHash: HASH };
    expect(checkModelTransition({ ...op })).toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(checkModelTransition({ ...op, actor: "genesis-test", approval })).toMatchObject({ code: "OPERATOR_REQUIRED" });
    expect(checkModelTransition({ ...op, approval: { ...approval, subjectHash: "c".repeat(64) } })).toMatchObject({ code: "APPROVAL_MISMATCH" });
    expect(checkModelTransition({ ...op, approval: { ...approval, modelVersionId: "m2" } })).toMatchObject({ code: "APPROVAL_MISMATCH" });
    expect(checkModelTransition({ ...op, approval: { ...approval, approvedBy: "operator:other" } })).toMatchObject({ code: "APPROVAL_MISMATCH" });
    expect(checkModelTransition({ ...op, approval: { ...approval, expiresAt: now } })).toMatchObject({ code: "APPROVAL_EXPIRED" });
    expect(checkModelTransition({ ...op, approval })).toEqual({ ok: true });
    expect(checkModelTransition({ ...base, from: "SHADOW_CANDIDATE", to: "REJECTED", approval })).toMatchObject({ code: "APPROVAL_UNEXPECTED" });
  });

  it("the database transition table and state CHECK match the app table exactly", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const fn = sql.slice(sql.indexOf("odin_genesis_model_transition_allowed(from_state"), sql.indexOf("$$ LANGUAGE sql IMMUTABLE"));
    const pairs = [...fn.matchAll(/\('([A-Z_]+)', '([A-Z_]+)'\)/g)].map((m) => `${m[1]}->${m[2]}`).sort();
    const app = Object.entries(MODEL_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`)).sort();
    expect(pairs).toEqual(app);
    const check = sql.slice(sql.indexOf('"ModelLifecycleEvent_state_known"'), sql.indexOf('"ModelLifecycleEvent_sequence"'));
    for (const s of MODEL_STATES) expect(check).toContain(`'${s}'`);
  });
});
