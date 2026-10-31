import { describe, expect, it } from "vitest";
import { SolanaRpcSecurityClient, SPL_TOKEN_PROGRAM_ID } from "./solana-rpc.js";

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

/** getAccountInfo(jsonParsed) for JUP as returned by api.mainnet-beta.solana.com on 2026-10-31. */
const jupAccount = {
  jsonrpc: "2.0",
  result: {
    context: { apiVersion: "4.3.2", slot: 463701887 },
    value: {
      data: {
        parsed: {
          info: { decimals: 6, freezeAuthority: null, isInitialized: true, mintAuthority: null, supply: "6861485837037475" },
          type: "mint",
        },
        program: "spl-token",
        space: 82,
      },
      executable: false,
      lamports: 74276338103,
      owner: SPL_TOKEN_PROGRAM_ID,
      space: 82,
    },
  },
  id: 1,
};

function rpc(responder: (method: string) => unknown, status = 200): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    return new Response(JSON.stringify(responder(method)), { status });
  }) as typeof fetch;
}

describe("SolanaRpcSecurityClient", () => {
  it("reads mint and freeze authority from a real jsonParsed mint account", async () => {
    const client = new SolanaRpcSecurityClient("https://rpc.example", rpc(() => jupAccount));
    const mint = await client.getMint(JUP);
    expect(mint.ok).toBe(true);
    if (!mint.ok) return;
    expect(mint.data.programId).toBe(SPL_TOKEN_PROGRAM_ID);
    expect(mint.data.mintAuthority).toBeNull();
    expect(mint.data.freezeAuthority).toBeNull();
    expect(mint.data.supply).toBe("6861485837037475");
    expect(mint.data.slot).toBe(463701887);
  });

  it("reports the public endpoint's 429 on getTokenLargestAccounts as UPSTREAM, never a value", async () => {
    // Exact body the public RPC returned for every getTokenLargestAccounts call on 2026-10-31.
    const client = new SolanaRpcSecurityClient(
      "https://rpc.example",
      rpc(() => ({ jsonrpc: "2.0", error: { code: 429, message: "Too many requests for a specific RPC call" }, id: 1 })),
    );
    const holders = await client.getTopHolderConcentration(JUP, "6861485837037475");
    expect(holders.ok).toBe(false);
    if (!holders.ok) expect(holders.code).toBe("UPSTREAM");
  });

  it("computes top-10 concentration with integer maths", async () => {
    const accounts = Array.from({ length: 12 }, (_, index) => ({ address: `acct${index}`, amount: index < 10 ? "50" : "1" }));
    const client = new SolanaRpcSecurityClient(
      "https://rpc.example",
      rpc(() => ({ jsonrpc: "2.0", result: { context: { slot: 1 }, value: accounts }, id: 1 })),
    );
    const holders = await client.getTopHolderConcentration(JUP, "1000");
    expect(holders.ok && holders.data.top10Pct).toBe("50.000000");
    expect(holders.ok && holders.data.accountsSampled).toBe(10);
  });

  it("refuses to derive concentration from a zero supply", async () => {
    const client = new SolanaRpcSecurityClient("https://rpc.example", rpc(() => ({})));
    const holders = await client.getTopHolderConcentration(JUP, "0");
    expect(holders.ok).toBe(false);
  });

  it("rejects non-mint accounts and transport failures without echoing the RPC URL", async () => {
    const notMint = new SolanaRpcSecurityClient(
      "https://rpc.example/?api-key=secret",
      rpc(() => ({ jsonrpc: "2.0", result: { value: { data: { parsed: { type: "account", info: {} } }, owner: SPL_TOKEN_PROGRAM_ID } }, id: 1 })),
    );
    expect((await notMint.getMint(JUP)).ok).toBe(false);
    const down = new SolanaRpcSecurityClient("https://rpc.example/?api-key=secret", (async () => {
      throw new TypeError("fetch failed https://rpc.example/?api-key=secret");
    }) as typeof fetch);
    const result = await down.getMint(JUP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("secret");
  });
});
