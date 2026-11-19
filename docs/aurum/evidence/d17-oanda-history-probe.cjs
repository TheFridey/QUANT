// D17: bounded read-only OANDA practice history-depth probe. 10 GET /candles requests in total.
// Prints first-candle metadata per granularity only. Never prints the token or account id. Stores nothing.
const md = require("/srv/quant/app/repo/packages/market-data/dist/index.js");
const PRACTICE = "https://api-fxpractice.oanda.com";

async function main() {
  const creds = md.inventoryOandaCredentials(process.env);
  if (!creds.tokenPresent) throw new Error("token not present");
  if (creds.apiUrl.replace(/\/$/, "") !== PRACTICE) throw new Error("OANDA_API_URL is not the practice host; refusing");
  const client = new md.OandaPracticeMarketData(creds);
  const from = Date.parse("2000-01-01T00:00:00Z");
  const out = { probedAt: new Date().toISOString(), host: PRACTICE, instrument: "XAU_USD", requests: 0, earliest: [], page: null };

  for (const g of ["M1", "M5", "M15", "M30", "H1", "H4", "D"]) {
    const r = await client.candles({ instrument: "XAU_USD", granularity: g, price: "MBA", fromMs: from, count: 1, alignment: g === "D" ? "NEW_YORK_17" : "UTC" });
    out.requests++;
    if (!r.ok) { out.earliest.push({ granularity: g, ok: false, code: r.code, error: r.error }); continue; }
    const c = r.data.candles[0];
    out.earliest.push({ granularity: g, ok: true, firstOpen: c ? new Date(c.openTime).toISOString() : null, complete: c?.complete ?? null, mid: Boolean(c?.mid), bid: Boolean(c?.bid), ask: Boolean(c?.ask), tickVolume: c?.tickVolume ?? null });
    await new Promise((res) => setTimeout(res, 1100));
  }

  // S5 is not in the adapter's granularity list: one direct read-only GET to the same allow-listed practice host.
  {
    const url = new URL(`${PRACTICE}/v3/instruments/XAU_USD/candles`);
    url.searchParams.set("granularity", "S5");
    url.searchParams.set("price", "MBA");
    url.searchParams.set("from", new Date(from).toISOString());
    url.searchParams.set("count", "1");
    const res = await fetch(url, { method: "GET", redirect: "error", headers: { authorization: `Bearer ${process.env.OANDA_API_TOKEN}`, accept: "application/json", "accept-datetime-format": "RFC3339" } });
    out.requests++;
    if (!res.ok) out.earliest.push({ granularity: "S5", ok: false, http: res.status });
    else {
      const body = await res.json();
      const c = (body.candles || [])[0];
      out.earliest.push({ granularity: "S5", ok: true, firstOpen: c?.time ?? null, complete: c?.complete ?? null, mid: Boolean(c?.mid), bid: Boolean(c?.bid), ask: Boolean(c?.ask), tickVolume: c?.volume ?? null, via: "direct GET (adapter lacks S5)" });
    }
    await new Promise((res) => setTimeout(res, 1100));
  }

  // One full M1 page from a recent closed week, to confirm the 5,000-candle limit and bid/ask completeness on a page.
  {
    const r = await client.candles({ instrument: "XAU_USD", granularity: "M1", price: "MBA", fromMs: Date.parse("2026-11-09T00:00:00Z"), count: 5000, alignment: "UTC" });
    out.requests++;
    if (!r.ok) out.page = { ok: false, code: r.code, error: r.error };
    else {
      const cs = r.data.candles;
      const times = cs.map((c) => c.openTime);
      let gapsOver1m = 0, maxGapMin = 0;
      for (let i = 1; i < times.length; i++) { const g = (times[i] - times[i - 1]) / 60000; if (g > 1) { gapsOver1m++; maxGapMin = Math.max(maxGapMin, g); } }
      out.page = { ok: true, returned: cs.length, first: new Date(times[0]).toISOString(), last: new Date(times[times.length - 1]).toISOString(), incomplete: cs.filter((c) => !c.complete).length, missingBid: cs.filter((c) => !c.bid).length, missingAsk: cs.filter((c) => !c.ask).length, gapsOver1m, maxGapMin };
    }
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error("probe failed:", e instanceof Error ? e.message : String(e)); process.exit(1); });
