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
  const { withGuide } = await import("../src/guide402.js");
  ok("paidRoute uses fast 402 (non-browser) and equals library + readable body", r.status === lib.status && same(r.headers, lib.headers)
    && lib.body === "{}" && r.body === withGuide(lib, "/v1/pa").body && unpaid402.size === 1);
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
await cmp("tools/list with cursor param", { jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "x" } }, undefined, {}, true);
await cmp("unsupported protocol header", { jsonrpc: "2.0", id: 2, method: "tools/list" }, undefined, { "mcp-protocol-version": "1999-01-01" }, true);
await cmp("bad accept header", { jsonrpc: "2.0", id: 2, method: "tools/list" }, undefined, { accept: "application/json" }, true);
await cmp("batch request", [{ jsonrpc: "2.0", id: 2, method: "tools/list" }], undefined, {}, false);
await cmp("prompts/list (not supported, now fast -32601)", { jsonrpc: "2.0", id: 3, method: "prompts/list" }, undefined, {}, true);
{ _resetMcpCache?.();
  const call = (cf = "80016350821", extra = {}) => ({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "lookup_italian_pa", arguments: { cf }, ...extra } });
  const fake = { content: [{ type: "text", text: "{\"x402Version\":2}" }], structuredContent: { x402Version: 2, accepts: [] }, isError: true };
  mcpUnpaid.set(new URL("/mcp#lookup_italian_pa", MCP).toString(), fake);
  await cmp("tools/call unpaid, cached payment-required", call());
  await cmp("tools/call unpaid, other cf", call("00743110157"));
  await cmp("tools/call validate_vat (falls back)", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "validate_vat", arguments: { piva: "IT00743110157" } } }, undefined, {}, false);
  _resetMcpCache?.(); }


// ── Transport-level fast paths (2026-11-20): same bytes as the SDK transport for each shape seen in production logs ──
{ const { mcpBody } = await import("../src/worker.js");
  const env = { X402_NETWORK: "eip155:8453" };
  const mk = (method, headers = {}, body) => () => new Request(MCP, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  async function cmpT(name, make, expectFast = true) {
    const r1 = make(), log = {};
    const fast = await snap(await handleMcp(r1, env, log, (await mcpBody(r1)).msg));
    const sdk = await snap(await handleMcp(make(), env));
    ok(`MCP ${name}: ${expectFast ? "fast" : "fallback"} == SDK`, same(fast, sdk) && !!log.mcp_fast === expectFast,
      same(fast, sdk) ? `fast=${!!log.mcp_fast} status=${fast.status}` : `\n   fast=${JSON.stringify(fast).slice(0, 400)}\n   sdk =${JSON.stringify(sdk).slice(0, 400)}`);
  }
  const J = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const call = (method, params, id = 5) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
  for (const m of ["HEAD", "PUT", "PATCH", "OPTIONS"]) await cmpT(`${m} /mcp -> 405`, mk(m, m === "HEAD" || m === "OPTIONS" ? {} : J, m === "HEAD" || m === "OPTIONS" ? undefined : "{}"));
  await cmpT("GET /mcp no accept -> 406", mk("GET"));
  await cmpT("GET /mcp text/html -> 406", mk("GET", { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0" }));
  await cmpT("GET /mcp event-stream + bad protocol header -> 400", mk("GET", { accept: "text/event-stream", "mcp-protocol-version": "2099-01-01" }));
  { const r1 = mk("GET", { accept: "text/event-stream" })(), log = {};
    const f = await handleMcp(r1, env, log, (await mcpBody(r1)).msg), sdk = await handleMcp(mk("GET", { accept: "text/event-stream" })(), env);
    const h = r => JSON.stringify([r.status, [...r.headers]]);
    ok("MCP GET /mcp event-stream: fast SSE stream, same status + headers as SDK", log.mcp_fast === true && h(f) === h(sdk), `${h(f)} vs ${h(sdk)}`);
    await f.body.cancel(); await sdk.body.cancel(); }
  await cmpT("POST no accept -> 406", mk("POST", { "content-type": "application/json" }, call("tools/list")));
  await cmpT("POST accept json only -> 406", mk("POST", { "content-type": "application/json", accept: "application/json" }, call("tools/list")));
  await cmpT("POST text/plain -> 415", mk("POST", { ...J, "content-type": "text/plain" }, call("tools/list")));
  await cmpT("POST application/json-rpc -> 415", mk("POST", { ...J, "content-type": "application/json-rpc" }, call("tools/list")));
  await cmpT("POST charset param ok", mk("POST", { ...J, "content-type": "Application/JSON; charset=utf-8" }, call("tools/list")));
  await cmpT("POST invalid JSON -> 400", mk("POST", J, "{not json"));
  await cmpT("POST empty body -> 400", mk("POST", J, ""));
  await cmpT("POST JSON number -> invalid JSON-RPC 400", mk("POST", J, "42"));
  await cmpT("POST jsonrpc 1.0 -> invalid JSON-RPC 400", mk("POST", J, { jsonrpc: "1.0", id: 1, method: "tools/list" }));
  await cmpT("POST {} -> invalid JSON-RPC 400", mk("POST", J, {}));
  await cmpT("POST id null (fallback)", mk("POST", J, { jsonrpc: "2.0", id: null, method: "tools/list" }), false);
  const PV = { ...J, "mcp-protocol-version": "2026-06-01" };
  await cmpT("server/discover + unsupported protocol header -> 400", mk("POST", PV, call("server/discover")));
  await cmpT("tools/list + unsupported protocol header -> 400", mk("POST", PV, call("tools/list")));
  await cmpT("notification + unsupported protocol header -> 400", mk("POST", PV, { jsonrpc: "2.0", method: "notifications/initialized" }));
  await cmpT("initialize ignores unsupported protocol header", mk("POST", PV, call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } })));
  await cmpT("initialize 2026 version in body -> latest", mk("POST", J, call("initialize", { protocolVersion: "2026-06-01", capabilities: { roots: { listChanged: true } }, clientInfo: { name: "x", version: "1" } })));
  for (const meth of ["server/discover", "prompts/list", "prompts/get", "resources/list", "resources/templates/list", "resources/read", "completion/complete", "logging/setLevel"]) {
    await cmpT(`${meth} -> -32601`, mk("POST", J, call(meth)));
    await cmpT(`${meth} with params -> -32601`, mk("POST", { ...J, "mcp-protocol-version": "2025-06-18" }, call(meth, { cursor: "a", _meta: { progressToken: 1 } }, "s1")));
  }
  await cmpT("tools/list cursor", mk("POST", J, call("tools/list", { cursor: "abc" })));
  await cmpT("tools/list _meta", mk("POST", J, call("tools/list", { _meta: { progressToken: "t" } })));
  await cmpT("tools/list cursor + _meta, string id", mk("POST", J, call("tools/list", { cursor: "x", _meta: {} }, "req-1")));
  await cmpT("tools/list cursor null (fallback)", mk("POST", J, call("tools/list", { cursor: null })), false);
  await cmpT("tools/list unknown param (fallback)", mk("POST", J, call("tools/list", { foo: 1 })), false);
  await cmpT("ping _meta", mk("POST", J, call("ping", { _meta: { progressToken: 2 } })));
  await cmpT("notifications/cancelled -> 202", mk("POST", J, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }));
  await cmpT("unknown notification -> 202", mk("POST", J, { jsonrpc: "2.0", method: "notifications/whatever" }));
  await cmpT("batch (fallback)", mk("POST", J, [call("tools/list")]), false);
  await cmpT("DELETE (fallback)", mk("DELETE", { accept: "application/json, text/event-stream" }), false);
  await cmpT("tools/call check_partita_iva_format (fallback)", mk("POST", J, call("tools/call", { name: "check_partita_iva_format", arguments: { piva: "00743110157" } })), false);
  await cmpT("unknown request method (fallback)", mk("POST", J, call("tasks/list")), false);
  // POST /v1/pa and /v1/counterparty: Hono 404 without building the paid app
  for (const path of ["/v1/pa?cf=80016350821", "/v1/counterparty?id=80016350821"]) {
    const u = "https://italycheck.example" + path, log = {};
    const fast = await snap(await paidRoute(new Request(u, { method: "POST", body: "{}" }), env, {}, log));
    const lib = await snap(await createApp(env).fetch(new Request(u, { method: "POST", body: "{}" }), env));
    const fj = JSON.parse(fast.body);
    ok(`POST ${path.split("?")[0]} -> 405 Allow: GET, HEAD with the GET to use (library: 404), no paid app`, lib.status === 404 && fast.status === 405
      && new Headers(fast.headers).get("allow") === "GET, HEAD" && fj.error === "method_not_allowed" && fj.message.includes("GET " + path.split("?")[0]) && log.fast_405 === true, JSON.stringify(fast).slice(0, 160));
  }
}


// ── Worker entry: transport fast paths + SDK-shape log fields ──
{ const worker = (await import("../src/worker.js")).default;
  const env = { X402_NETWORK: "eip155:8453" }, logs = [], orig = console.log;
  console.log = (o, ...r) => typeof o === "object" ? logs.push(o) : orig(o, ...r);
  try {
    const h = await worker.fetch(new Request(MCP, { method: "HEAD" }), env, {});
    ok("worker HEAD /mcp -> 405 fast", h.status === 405 && logs.at(-1).mcp_fast === true && !logs.at(-1).mcp_sdk);
    const b = await worker.fetch(new Request(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_partita_iva_format", arguments: { piva: "00743110157" } } }) }), env, {});
    const l = logs.at(-1);
    ok("worker SDK-path request logs its shape (pv, param keys, id type)", b.status === 200 && l.mcp_sdk === true && l.mcp_pv === "2025-06-18" && l.mcp_params === "name,arguments" && l.mcp_id_type === "number", JSON.stringify(l));
    const p = await worker.fetch(new Request("https://italycheck.example/v1/pa?cf=80016350821", { method: "POST" }), env, {});
    ok("worker POST /v1/pa -> 405 fast", p.status === 405 && logs.at(-1).fast_405 === true);
    const v = await worker.fetch(new Request("https://italycheck.example/v1/vat", { method: "POST" }), env, {});
    ok("worker POST /v1/vat (not served) -> 404 fast", v.status === 404 && logs.at(-1).fast_404 === true);
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
