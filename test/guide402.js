// Readable 402 body, 405 on non-GET, discovery documents (conversion task 24/11/2026). Offline.
import { createApp } from "../src/app.js";
import { fastUnpaid402 } from "../src/fast-paths.js";
import { paidRoute, unpaid402 } from "../src/worker.js";
import { withGuide, guide402Body, atomicToDecimal } from "../src/guide402.js";
import { handleMcp, _resetMcpCache } from "../src/remote-mcp.js";
let failed = 0;
const ok = (n, c, extra = "") => { if (!c) failed++; console.log(`${c ? "PASS" : "FAIL"}  ${n} ${extra}`); };
process.on("exit", () => { if (failed) { console.log(`${failed} FAILED`); process.exitCode = 1; } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = String(u?.url ?? u);
  if (url.endsWith("/supported")) return new Response(JSON.stringify({ kinds: ["eip155:8453", "eip155:84532"].map(network => ({ x402Version: 2, scheme: "exact", network })), extensions: ["bazaar"], signers: {} }), { headers: { "content-type": "application/json" } });
  return realFetch(u, init);
};
const worker = (await import("../src/worker.js")).default;
const MAIN = { X402_NETWORK: "eip155:8453", PAY_TO: "0xde8380854ef9c926093832501d95a47f4c63fe7c", ENABLE_VAT: "0" }; // = wrangler.toml
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", EURC = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", PAYTO = MAIN.PAY_TO;
const dec = h => JSON.parse(Buffer.from(h, "base64").toString());
const quiet = async f => { const o = console.log; console.log = (x, ...r) => typeof x === "object" ? null : o(x, ...r); try { return await f(); } finally { console.log = o; } };

ok("atomicToDecimal 5000 -> 0.005, 10000 -> 0.01, 1000000 -> 1", atomicToDecimal("5000") === "0.005" && atomicToDecimal("10000") === "0.01" && atomicToDecimal("1000000") === "1");

for (const [path, q, amount, usd] of [["/v1/pa", "cf", "5000", "0.005"], ["/v1/counterparty", "id", "10000", "0.01"]]) {
  const U = `https://italycheck.italycheck.workers.dev${path}?${q}=80016350821`;
  unpaid402.clear();
  const lib = await createApp(MAIN).fetch(new Request(U, { headers: { accept: "application/json" } }), MAIN);
  const libH = [...lib.headers].filter(([k]) => k !== "date"), libB = await lib.text();
  const g = await quiet(() => worker.fetch(new Request(U, { headers: { accept: "application/json", "user-agent": "agent/1" } }), MAIN, {}));
  const gH = [...g.headers].filter(([k]) => k !== "date"), gB = await g.text();
  const pr = dec(g.headers.get("payment-required")), body = JSON.parse(gB);
  ok(`GET ${path}: 402, headers identical to library (PAYMENT-REQUIRED untouched)`, g.status === 402 && JSON.stringify(gH) === JSON.stringify(libH));
  ok(`GET ${path}: header accepts = ${amount} USDC + EURC to payTo on Base (unchanged)`, pr.x402Version === 2 && JSON.stringify(pr.accepts.map(a => [a.scheme, a.network, a.amount, a.asset, a.payTo]))
    === JSON.stringify([["exact", "eip155:8453", amount, USDC, PAYTO], ["exact", "eip155:8453", amount, EURC, PAYTO]]));
  const { message, howToPay, ...rest } = body;
  ok(`GET ${path}: body = decoded PAYMENT-REQUIRED + message + howToPay`, libB === "{}" && JSON.stringify(rest) === JSON.stringify(pr));
  ok(`GET ${path}: message states price, assets, network, header names`, message.includes(`${usd} USDC or EURC`) && message.includes(`amount ${amount}`) && message.includes("eip155:8453 (Base mainnet)")
    && message.includes("PAYMENT-REQUIRED") && message.includes("PAYMENT-SIGNATURE"), message.slice(0, 120));
  ok(`GET ${path}: howToPay price/payTo from the header, example, client, docs`, howToPay.price.atomicAmount === amount && howToPay.price.amount === usd && howToPay.price.payTo === PAYTO
    && JSON.stringify(howToPay.price.currency) === '["USDC","EURC"]' && howToPay.example === `GET https://italycheck.italycheck.workers.dev${path}?${q}=80016350821`
    && howToPay.client.code.includes("wrapFetchWithPaymentFromConfig") && howToPay.docs.includes("https://github.com/yeick010/italycheck") && howToPay.docs.includes("https://italycheck.italycheck.workers.dev/"));
  ok(`GET ${path}: charging rule matches the code`, path === "/v1/pa" ? message.includes("Not charged when the answer is 400 (malformed cf), 404 (not found") && message.includes("502") : message.includes("Not charged when the answer is 400") && message.includes("502"));
  ok(`GET ${path}: body size reasonable (< 8 KB)`, gB.length < 8192, `bytes=${gB.length}`);
  const hit = await quiet(() => worker.fetch(new Request(U, { headers: { accept: "application/json" } }), MAIN, {}));
  ok(`GET ${path}: cache hit returns the same bytes`, (await hit.text()) === gB && unpaid402.size === 1);
  const h = await quiet(() => worker.fetch(new Request(U, { method: "HEAD" }), MAIN, {}));
  ok(`HEAD ${path}: 402, same PAYMENT-REQUIRED, empty body`, h.status === 402 && h.headers.get("payment-required") === g.headers.get("payment-required") && (await h.text()) === "");
  // HEAD first (cold cache) must still leave a readable body for the next GET
  unpaid402.clear();
  await quiet(() => worker.fetch(new Request(U, { method: "HEAD" }), MAIN, {}));
  const g2 = await quiet(() => worker.fetch(new Request(U), MAIN, {}));
  ok(`HEAD then GET ${path}: GET still gets the readable body`, (await g2.text()) === gB);
  const p = await quiet(() => worker.fetch(new Request(U, { method: "POST", body: "{}" }), MAIN, {}));
  ok(`POST ${path}: 405 Allow GET, HEAD`, p.status === 405 && p.headers.get("allow") === "GET, HEAD");
  const b = await paidRoute(new Request(U, { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } }), MAIN);
  ok(`GET ${path} browser: HTML paywall unchanged`, (b.headers.get("content-type") || "").includes("text/html"));
}

// No query: still 402 with the input hint (agents that forget the parameter)
{ unpaid402.clear();
  const r = await paidRoute(new Request("https://italycheck.example/v1/pa"), MAIN);
  const j = JSON.parse(await r.text());
  ok("GET /v1/pa without cf: 402 + input hint", r.status === 402 && j.howToPay.input.startsWith("cf = 11-digit")); }

// Failed payment (garbage v1 X-PAYMENT): same 402 header path, readable body + v1 hint, never 200
{ const r = await paidRoute(new Request("https://italycheck.example/v1/pa?cf=80016350821", { headers: { "x-payment": "garbage", accept: "application/json" } }), MAIN);
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
  ok("X-PAYMENT only (x402 v1): 402 with PAYMENT-REQUIRED and a PAYMENT-SIGNATURE hint", r.status === 402 && !!r.headers.get("payment-required") && /PAYMENT-SIGNATURE/.test(j.hint || ""), `status=${r.status}`);
  const s = await paidRoute(new Request("https://italycheck.example/v1/pa?cf=80016350821", { headers: { "payment-signature": "garbage", accept: "application/json" } }), MAIN);
  const st = await s.text(); let sj = {}; try { sj = JSON.parse(st); } catch {}
  ok("bad PAYMENT-SIGNATURE: 402, no v1 hint, never 200", s.status === 402 && !sj.hint, `status=${s.status}`); }

ok("withGuide leaves non-402 / non-JSON / non-empty bodies alone",
  withGuide({ status: 200, headers: [], body: "{}" }, "/v1/pa").body === "{}"
  && withGuide({ status: 402, headers: [["content-type", "text/html"]], body: "" }, "/v1/pa").body === ""
  && withGuide({ status: 402, headers: [["content-type", "application/json"]], body: '{"x":1}' }, "/v1/pa").body === '{"x":1}'
  && guide402Body({ status: 402, headers: [["content-type", "application/json"]], body: "{}" }, "/v1/pa") === null);

// Fast 402 itself unchanged (still byte-equal to the library; checked in fast-paths.js): body "{}"
ok("fastUnpaid402 still returns the library body {}", fastUnpaid402("https://italycheck.example/v1/pa?cf=1", MAIN).body === "{}");

// Discovery documents
for (const [path, type] of [["/.well-known/x402", "application/json"], ["/.well-known/x402.json", "application/json"], ["/openapi.json", "application/json"], ["/llms.txt", "text/plain"]]) {
  const r = await quiet(() => worker.fetch(new Request("https://italycheck.example" + path), MAIN, {}));
  const t = await r.text();
  ok(`GET ${path} -> 200 ${type}`, r.status === 200 && (r.headers.get("content-type") || "").startsWith(type) && t.length > 100);
  const h = await quiet(() => worker.fetch(new Request("https://italycheck.example" + path, { method: "HEAD" }), MAIN, {}));
  ok(`HEAD ${path} -> 200, no body`, h.status === 200 && (await h.text()) === "");
}
{ const x = await (await quiet(() => worker.fetch(new Request("https://italycheck.example/.well-known/x402"), MAIN, {}))).json();
  ok("/.well-known/x402: version 1, both paid resources, prices", x.version === 1 && x.resources.length === 2 && x.resources.every(u => u.startsWith("https://italycheck.italycheck.workers.dev/v1/"))
    && x.instructions.includes("$0.005") && x.instructions.includes("$0.01"));
  const o = await (await quiet(() => worker.fetch(new Request("https://italycheck.example/openapi.json"), MAIN, {}))).json();
  ok("/openapi.json: x-payment-info x402 fixed USD 0.005 / 0.01 + 402 responses", o.openapi === "3.1.0" && o.paths["/v1/pa"].get["x-payment-info"].price.amount === "0.005"
    && o.paths["/v1/counterparty"].get["x-payment-info"].price.amount === "0.01" && o.paths["/v1/pa"].get.responses[402] && o.paths["/v1/pa"].get["x-payment-info"].protocols[0] === "x402");
  const r = await quiet(() => worker.fetch(new Request("https://italycheck.example/robots.txt"), MAIN, {}));
  ok("unknown free path still 404", r.status === 404);
  const p = await quiet(() => worker.fetch(new Request("https://italycheck.example/openapi.json", { method: "POST" }), MAIN, {}));
  ok("POST /openapi.json not served as doc", p.status === 404); }

// MCP: tools/list descriptions carry the pay hint; unpaid tools/call result unchanged in shape
{ _resetMcpCache();
  const rpc = b => new Request("https://italycheck.example/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify(b) });
  const l = await (await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), MAIN, null, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).json();
  const t = Object.fromEntries(l.result.tools.map(x => [x.name, x.description]));
  ok("MCP tools/list: paid tools describe how to pay + docs, price unchanged", ["lookup_italian_pa", "verify_italian_counterparty"].every(n => t[n].includes('params._meta["x402/payment"]') && t[n].includes("https://github.com/yeick010/italycheck"))
    && t.lookup_italian_pa.includes("Costs $0.005 in USDC") && t.verify_italian_counterparty.includes("Costs $0.01 in USDC") && !t.check_partita_iva_format.includes("x402"));
  const sdk = await (await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), MAIN)).json();
  ok("MCP tools/list: fast path == SDK path", JSON.stringify(sdk) === JSON.stringify(l)); }
