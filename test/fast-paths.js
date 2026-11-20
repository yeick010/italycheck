// Tests for the 2026-10-30 fixes: plain-data fast paths (CPU), revenue-state (incassi), probe exclusion (pagamenti falliti).
// Offline: no network (on-chain reads use a mock RPC; x402 402s are built from static data).
import { createApp } from "../src/app.js";
import { fastUnpaid402 } from "../src/fast-paths.js";
import { handleMcp, mcpUnpaid, _resetMcpCache } from "../src/remote-mcp.js";
import { paidRoute, unpaid402 } from "../src/worker.js";
import { chainPayments, makeRpc, walletSnapshot, PAY_TO, TOKENS, TRANSFER_TOPIC } from "../scripts/lib/onchain.mjs";
import { buildRevenueState } from "../scripts/revenue-state.mjs";
import { segmentsOutsideProbes, probeUaFilter, INTERNAL_PROBE_WINDOWS } from "../scripts/lib/probes.mjs";
let failed = 0;
const ok = (n, c, extra = "") => { if (!c) failed++; console.log(`${c ? "PASS" : "FAIL"}  ${n} ${extra}`); };
const snap = async r => ({ status: r.status, headers: [...r.headers].filter(([k]) => k !== "date"), body: await r.text() });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Offline facilitator: answer /supported for Base mainnet + Sepolia so the library path can build mainnet 402s without CDP keys.
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = String(u?.url ?? u);
  if (url.endsWith("/supported")) return new Response(JSON.stringify({ kinds: ["eip155:8453", "eip155:84532"].map(network => ({ x402Version: 2, scheme: "exact", network })), extensions: ["bazaar"], signers: {} }), { headers: { "content-type": "application/json" } });
  return realFetch(u, init);
};

// ── Fast unpaid 402 == x402 library 402, byte for byte ──
const PA = "https://italycheck.example/v1/pa?cf=80016350821";
for (const [name, env, url] of [
  ["testnet", { X402_NETWORK: "eip155:84532" }, PA],
  ["mainnet (wrangler.toml)", { X402_NETWORK: "eip155:8453", PAY_TO: "0xde8380854ef9c926093832501d95a47f4c63fe7c", ENABLE_VAT: "0" }, PA],
  ["DISABLE_EURC", { X402_NETWORK: "eip155:8453", DISABLE_EURC: "1" }, PA],
  ["custom price $0.01", { X402_NETWORK: "eip155:8453", PRICE_PA: "$0.01" }, PA],
  ["other query / no query", { X402_NETWORK: "eip155:8453" }, "https://italycheck.example/v1/pa"],
  ["odd query", { X402_NETWORK: "eip155:8453" }, "https://italycheck.example/v1/pa?cf=1&x=%20y"],
]) {
  const lib = await snap(await createApp(env).fetch(new Request(url), env));
  const f = fastUnpaid402(url, env);
  const fast = f && await snap(new Response(f.body, { status: f.status, headers: f.headers }));
  ok(`fast 402 == library 402: ${name}`, f && same(fast, lib), f ? "" : "fast path returned null");
}
ok("fast 402 declines VAT-enabled / free / unknown network / unparseable price",
  fastUnpaid402(PA, { ENABLE_VAT: "1" }) === null && fastUnpaid402(PA, { DISABLE_PAYMENTS: "1" }) === null
  && fastUnpaid402(PA, { X402_NETWORK: "eip155:1" }) === null && fastUnpaid402(PA, { PRICE_PA: "0.005 USDC" }) === null
  && fastUnpaid402("https://italycheck.example/v1/vat", {}) === null);
{ unpaid402.clear();
  const env = { X402_NETWORK: "eip155:8453" }, log = {};
  const r = await snap(await paidRoute(new Request(PA), env, log));
  const lib = await snap(await createApp(env).fetch(new Request(PA), env));
  ok("paidRoute uses fast 402 (non-browser) and equals library", same(r, lib) && unpaid402.size === 1);
  const b = await paidRoute(new Request(PA, { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } }), env);
  ok("browser paywall still goes through the library", (b.headers.get("content-type") || "").includes("text/html")); }

// ── Fast MCP == SDK (stateless JSON) ──
const MCP = "https://italycheck.example/mcp";
const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const req = (msg, extra = {}) => new Request(MCP, { method: "POST", headers: { ...H, ...extra }, body: JSON.stringify(msg) });
async function cmp(name, msg, env = { X402_NETWORK: "eip155:8453" }, extra = {}, expectFast = true) {
  const log = {};
  const fast = await snap(await handleMcp(req(msg, extra), env, log, msg));
  const sdk = await snap(await handleMcp(req(msg, extra), env));
  ok(`MCP ${name}: ${expectFast ? "fast" : "fallback"} == SDK`, same(fast, sdk) && !!log.mcp_fast === expectFast,
    same(fast, sdk) ? `fast=${!!log.mcp_fast}` : `\n   fast=${JSON.stringify(fast).slice(0, 400)}\n   sdk =${JSON.stringify(sdk).slice(0, 400)}`);
}
const init = v => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
await cmp("initialize 2025-06-18", init("2025-06-18"));
await cmp("initialize 2025-11-25", init("2025-11-25"));
await cmp("initialize 2024-11-05", init("2024-11-05"));
await cmp("initialize unsupported version -> latest", init("1999-01-01"));
await cmp("initialize string id", { ...init("2025-03-26"), id: "abc" });
await cmp("initialize missing clientInfo (error)", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }, undefined, {}, false);
await cmp("notifications/initialized -> 202", { jsonrpc: "2.0", method: "notifications/initialized" });
await cmp("ping", { jsonrpc: "2.0", id: 7, method: "ping" });
await cmp("tools/list", { jsonrpc: "2.0", id: 2, method: "tools/list" }, undefined, { "mcp-protocol-version": "2025-06-18" });
await cmp("tools/list PRICE_PA $0.01", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { X402_NETWORK: "eip155:8453", PRICE_PA: "$0.01" });
await cmp("tools/list free mode", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { DISABLE_PAYMENTS: "1" });
await cmp("tools/list with cursor param", { jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "x" } }, undefined, {}, false);
await cmp("unsupported protocol header", { jsonrpc: "2.0", id: 2, method: "tools/list" }, undefined, { "mcp-protocol-version": "1999-01-01" }, false);
await cmp("bad accept header", { jsonrpc: "2.0", id: 2, method: "tools/list" }, undefined, { accept: "application/json" }, false);
await cmp("batch request", [{ jsonrpc: "2.0", id: 2, method: "tools/list" }], undefined, {}, false);
await cmp("prompts/list (not supported)", { jsonrpc: "2.0", id: 3, method: "prompts/list" }, undefined, {}, false);
{ _resetMcpCache?.();
  const call = (cf = "80016350821", extra = {}) => ({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "lookup_italian_pa", arguments: { cf }, ...extra } });
  const fake = { content: [{ type: "text", text: "{\"x402Version\":2}" }], structuredContent: { x402Version: 2, accepts: [] }, isError: true };
  mcpUnpaid.set(new URL("/mcp#lookup_italian_pa", MCP).toString(), fake);
  await cmp("tools/call unpaid, cached payment-required", call());
  await cmp("tools/call unpaid, other cf", call("00743110157"));
  await cmp("tools/call validate_vat (falls back)", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "validate_vat", arguments: { piva: "IT00743110157" } } }, undefined, {}, false);
  _resetMcpCache?.(); }

// ── Lazy-import refactor (2026-11-20): plain-data copies of library values stay equal to the libraries ──
{ const sdk = await import("@modelcontextprotocol/sdk/types.js");
  const c = await import("../src/constants.js");
  ok("MCP protocol versions == SDK", same(c.MCP_SUPPORTED_PROTOCOL_VERSIONS, sdk.SUPPORTED_PROTOCOL_VERSIONS) && c.MCP_LATEST_PROTOCOL_VERSION === sdk.LATEST_PROTOCOL_VERSION);
  const bz = await import("@x402/extensions/bazaar");
  const fp = await import("../src/fast-paths.js");
  const decl = bz.declareDiscoveryExtension(c.PA_DISCOVERY);
  const lib = { ...decl, bazaar: bz.bazaarResourceServerExtension.enrichDeclaration(decl.bazaar, { method: "GET", adapter: null, path: "/v1/pa" }) };
  ok("Bazaar /v1/pa declaration == library (same keys order)", JSON.stringify(fp.paBazaarExtensions()) === JSON.stringify(lib));
  const http = await import("@x402/core/http");
  const sample = { x402Version: 2, error: "Payment required", resource: { url: "https://x.example/v1/pa?cf=1", description: "àèìòù € 日本 \u{1F600}" }, accepts: [], big: "x".repeat(70000) };
  ok("payment-required header encoding == @x402/core/http (UTF-8, >32 KB)", fp.encodePaymentRequiredHeader(sample) === http.encodePaymentRequiredHeader(sample));
  const app = await import("../src/app.js");
  ok("app.js re-exports constants unchanged", app.DESCRIPTIONS === c.DESCRIPTIONS && app.EURC === c.EURC && app.PA_DISCOVERY === c.PA_DISCOVERY && app.acceptsFor === c.acceptsFor);
  const fa = await import("../src/free-app.js");
  let freeSame = true;
  for (const e of [{ X402_NETWORK: "eip155:8453" }, { X402_NETWORK: "eip155:84532", ENABLE_VAT: "1", PRICE_PA: "$0.01" }])
    for (const u of ["/", "/v1/vat/format?vat=IT00743110157", "/v1/vat/format", "/robots.txt", "/v1/pa?cf=80016350821"]) {
      const a = await snap(await fa.createFreeApp(e).fetch(new Request("https://italycheck.example" + u), e));
      const b = await snap(await app.createApp({ ...e, DISABLE_PAYMENTS: "1", FREE_ONLY: "1" }).fetch(new Request("https://italycheck.example" + u), e));
      if (!same(a, b)) { freeSame = false; console.log("   differs:", u, JSON.stringify(a).slice(0, 200), JSON.stringify(b).slice(0, 200)); }
    }
  ok("createFreeApp == createApp(FREE_ONLY) for /, format, 404, /v1/pa", freeSame);
  const rm = await import("../src/remote-mcp.js");
  ok("remote-mcp.js and fast-paths.js share one unpaid MCP cache", rm.mcpUnpaid === fp.mcpUnpaid); }

// ── Worker entry end to end (dynamic imports): fast routes, library routes, smoke-test shapes ──
{ const worker = (await import("../src/worker.js")).default;
  const env = { X402_NETWORK: "eip155:8453", PAY_TO: "0xde8380854ef9c926093832501d95a47f4c63fe7c", ENABLE_VAT: "0", PRICE_PA: "$0.005" };
  const logs = []; const orig = console.log; console.log = (o, ...r) => typeof o === "object" ? logs.push(o) : orig(o, ...r);
  try {
    const root = await worker.fetch(new Request("https://italycheck.example/"), env, { waitUntil() {} });
    const rj = await root.json();
    ok("worker GET / -> 200 catalog via lazily imported app", root.status === 200 && rj.name === "ItalyCheck" && rj.endpoints[0].price === "$0.005");
    const nf = await worker.fetch(new Request("https://italycheck.example/robots.txt"), env, {});
    ok("worker unknown path -> 404", nf.status === 404);
    unpaid402.clear();
    const pa = await worker.fetch(new Request("https://italycheck.example/v1/pa?cf=80016350821"), env, {});
    const pr = JSON.parse(atob(pa.headers.get("payment-required")));
    ok("worker /v1/pa -> 402, 5000 USDC + EURC to PAY_TO, fast path", pa.status === 402 && logs.at(-1).fast_402 === true
      && same(pr.accepts.map(a => [a.amount, a.asset, a.payTo]), [["5000", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", env.PAY_TO], ["5000", "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", env.PAY_TO]]));
    const init = await worker.fetch(req({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }), env, {});
    ok("worker /mcp initialize -> fast 200", init.status === 200 && (await init.json()).result.serverInfo.name === "italycheck" && logs.at(-1).mcp_fast === true);
    const tl = await worker.fetch(req({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env, {});
    ok("worker /mcp tools/list -> fast, 2 tools", tl.status === 200 && (await tl.json()).result.tools.length === 2 && logs.at(-1).mcp_fast === true);
    const pl = await worker.fetch(req({ jsonrpc: "2.0", id: 3, method: "prompts/list" }), env, {});
    const plj = await pl.json();
    ok("worker /mcp prompts/list -> SDK path (lazily imported), JSON-RPC error", !logs.at(-1).mcp_fast && plj.error?.code === -32601, JSON.stringify(plj).slice(0, 120));
  } finally { console.log = orig; } }

// ── Revenue state from on-chain logs (mock RPC) ──
{ const pad = a => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
  const head = 1000, headTs = Date.parse("2026-10-30T09:00:00Z") / 1000;
  const log = (block, from, token, units, tx) => ({ blockNumber: "0x" + block.toString(16), address: token, transactionHash: tx,
    topics: [TRANSFER_TOPIC, pad(from), pad(PAY_TO)], data: "0x" + units.toString(16) });
  const logs = [log(900, "0xaaaa000000000000000000000000000000000001", TOKENS.USDC, 5000, "0x01"),
    log(950, "0xaaaa000000000000000000000000000000000001", TOKENS.EURC, 5000, "0x02"),
    log(960, "0x00D17A447f286fd673c6bFFb59fDe031b65ee5d8", TOKENS.USDC, 5000, "0x03")];
  const calls = [];
  const fetchImpl = async (url, init) => { const { method, params } = JSON.parse(init.body); calls.push(method);
    const result = method === "eth_blockNumber" ? "0x" + head.toString(16)
      : method === "eth_getBlockByNumber" ? { timestamp: "0x" + (headTs - 2 * (head - parseInt(params[0], 16))).toString(16) }
      : method === "eth_getLogs" ? logs
      : method === "eth_call" ? (params[0].to === TOKENS.USDC ? "0x" + (15000).toString(16) : "0x" + (5000).toString(16))
      : method === "eth_getTransactionCount" ? "0x0" : null;
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) }; };
  const rpc = makeRpc({ rpcs: ["mock://rpc"], fetchImpl, delayMs: 0 });
  const chain = await chainPayments("2026-10-12T22:00:00Z", { rpc });
  const s = buildRevenueState(chain, await walletSnapshot({ rpc, block: chain.scanned_blocks[1] }), { now: Date.parse("2026-10-30T09:05:00Z"), rpcs: [...rpc.used] });
  ok("revenue-state: counts real payments, excludes own test wallet",
    s.real_payments_count === 2 && s.real_revenue_usdc === 0.005 && s.real_revenue_eurc === 0.005 && s.excluded_transfers.length === 1
    && s.excluded_transfers[0].why === "own test wallet" && s.real_payers_count === 1 && s.returning_payers.length === 1, JSON.stringify({ n: s.real_payments_count, usdc: s.real_revenue_usdc, eurc: s.real_revenue_eurc }));
  ok("revenue-state: balances, block, Rome time and sources cited",
    s.usdc_balance === 0.015 && s.eurc_balance === 0.005 && s.last_scanned_block === head && s.last_check_rome === "2026-10-30 10:05:00 Europe/Rome"
    && s.real_payments[0].explorer === "https://basescan.org/tx/0x01" && s.sources.rpc[0] === "mock://rpc" && calls.includes("eth_getTransactionCount")); }

// ── Probe exclusion (failed-payment metric) ──
{ const w = INTERNAL_PROBE_WINDOWS[0], a = Date.parse(w.from), b = Date.parse(w.to);
  ok("probe windows: split around the 24/10 probe", same(segmentsOutsideProbes(a - 10, b + 10), [[a - 10, a], [b, b + 10]]));
  ok("probe windows: untouched outside, empty inside", same(segmentsOutsideProbes(b + 1, b + 5), [[b + 1, b + 5]]) && same(segmentsOutsideProbes(a + 1, b - 1), []));
  ok("probe UA filter", same(probeUaFilter(), { key: "ua", operation: "not_includes", type: "string", value: "italycheck-probe" })); }

if (failed) { console.log(`${failed} FAILED`); process.exitCode = 1; }
