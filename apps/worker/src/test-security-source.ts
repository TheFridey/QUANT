import type { OnChainSecuritySource } from "./stage-runner.js";

/**
 * Test-only on-chain security source: every mint reads as an SPL Token mint with revoked mint and
 * freeze authority and low holder concentration, so integration tests stay offline and explicit.
 */
export const passingSecuritySource: OnChainSecuritySource = {
  async getMint(mint: string) {
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      data: {
        mint,
        programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        mintAuthority: null,
        freezeAuthority: null,
        supply: "1000000000000",
        decimals: 9,
        extensions: [],
        slot: null,
      },
    };
  },
  async getTopHolderConcentration() {
    return { ok: true, fetchedAt: new Date().toISOString(), data: { top10Pct: "12.000000", accountsSampled: 10, slot: null } };
  },
};
