#!/usr/bin/env node
// Production smoke test (read-only, no payment): node scripts/smoke.mjs [baseUrl]
// Exit 0 only if every check passes. User-Agent "italycheck-probe/1 smoke" so metrics scripts exclude it.
// Checks: GET / 200 catalog; readable 402 body + POST 405 + /.well-known/x402, /openapi.json, /llms.txt (SMOKE_GUIDE_INFO); POST /mcp initialize + tools/list (3 tools); HEAD /mcp 405 (+ GET /mcp 406, prompts/list -32601); GET+HEAD /v1/pa 402 at 5000; GET+HEAD /v1/counterparty 402 at 10000
// (USDC then EURC on Base mainnet, payTo = Yeison's wallet, as in wrangler.toml).
const BASE = (process.argv[2] || "https://italycheck.italycheck.workers.dev").replace(/\/$/, "");
const UA = { "user-agent": "italycheck-probe/1 smoke" };
const NET = "eip155:8453", PAY_TO = "0xde8380854ef9c926093832501d95a47f4c63fe7c";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", EURC = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42";
let failed = 0;
const ok = (name, cond, extra = "") => { if (!cond) failed++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
// SMOKE_HEAD_INFO=1: HEAD /v1/* checks are reported but not counted (only for versions older than the HEAD 402 fix,
// i.e. the deploy preflight and the post-rollback check when the rollback target predates it).
const okHead = (name, cond, extra = "") => process.env.SMOKE_HEAD_INFO === "1" && !cond
  ? console.log(`INFO  ${name}${extra ? "  " + extra : ""}  (not counted: SMOKE_HEAD_INFO=1)`) : ok(name, cond, extra);
// SMOKE_GUIDE_INFO=1: readable 402 body / discovery docs / POST 405 checks reported but not counted (versions before
// the 24/11/2026 conversion change, i.e. the deploy preflight and the post-rollback check on 02b91488).
const okGuide = (name, cond, extra = "") => process.env.SMOKE_GUIDE_INFO === "1" && !cond
  ? console.log(`INFO  ${name}${extra ? "  " + extra : ""}  (not counted: SMOKE_GUIDE_INFO=1)`) : ok(name, cond, extra);
const mcp = (body) => fetch(BASE + "/mcp", { method: "POST", headers: { ...UA, "content-type": "application/json",
  accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) });
const accepts = (pr, amount) => JSON.stringify((pr.accepts || []).map(a => [a.scheme, a.network, a.amount, a.asset, a.payTo]))
  === JSON.stringify([["exact", NET, amount, USDC, PAY_TO], ["exact", NET, amount, EURC, PAY_TO]]);
async function paid402(path, amount) {
  const r = await fetch(BASE + path, { headers: { ...UA, accept: "application/json" } });
  let pr = {};
  try { pr = JSON.parse(Buffer.from(r.headers.get("payment-required") || "", "base64").toString("utf8")); } catch {}
  ok(`GET ${path} -> 402, ${amount} USDC+EURC to payTo on Base`, r.status === 402 && pr.x402Version === 2 && accepts(pr, amount),
    `status=${r.status} accepts=${JSON.stringify((pr.accepts || []).map(a => a.amount + "@" + String(a.asset).slice(0, 6)))}`);
  let bj = {};
  try { bj = JSON.parse(await r.text()); } catch {}
  const { message, howToPay, hint, ...same } = bj;
  okGuide(`GET ${path} -> readable body: decoded PAYMENT-REQUIRED + message + howToPay (price ${amount}, payTo, docs)`,
    JSON.stringify(same) === JSON.stringify(pr) && typeof message === "string" && message.includes("PAYMENT-SIGNATURE")
    && howToPay?.price?.atomicAmount === amount && howToPay?.price?.payTo === PAY_TO && (howToPay?.docs || []).includes("https://github.com/yeick010/italycheck"),
    `bodyKeys=${Object.keys(bj).join(",")}`);
  const po = await fetch(BASE + path, { method: "POST", headers: UA });
  okGuide(`POST ${path.split("?")[0]} -> 405 Allow: GET, HEAD`, po.status === 405 && po.headers.get("allow") === "GET, HEAD", `status=${po.status}`);
  const h = await fetch(BASE + path, { method: "HEAD", headers: { ...UA, accept: "application/json" } });
  let hp = {};
  try { hp = JSON.parse(Buffer.from(h.headers.get("payment-required") || "", "base64").toString("utf8")); } catch {}
  const hb = await h.text();
  okHead(`HEAD ${path} -> 402, ${amount} USDC+EURC to payTo on Base, no body`, h.status === 402 && hp.x402Version === 2 && accepts(hp, amount) && hb === "",
    `status=${h.status} body=${hb.length}`);
}
try {
  const root = await fetch(BASE + "/", { headers: UA });
  const rj = await root.json().catch(() => ({}));
  ok("GET / -> 200 catalog", root.status === 200 && rj.name === "ItalyCheck" && Array.isArray(rj.endpoints), `status=${root.status}`);
  const init = await mcp({ method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  const ij = await init.json().catch(() => ({}));
  ok("POST /mcp initialize -> 200 serverInfo italycheck", init.status === 200 && ij.result?.serverInfo?.name === "italycheck", `status=${init.status}`);
  const tl = await mcp({ method: "tools/list", params: {} });
  const names = ((await tl.json().catch(() => ({}))).result?.tools || []).map(t => t.name);
  ok("POST /mcp tools/list -> lookup_italian_pa, verify_italian_counterparty, check_partita_iva_format",
    tl.status === 200 && ["lookup_italian_pa", "verify_italian_counterparty", "check_partita_iva_format"].every(n => names.includes(n)), `tools=${names.join(",")}`);
  ok("POST /mcp tools/list -> exactly 3 tools", names.length === 3, `n=${names.length}`);
  const head = await fetch(BASE + "/mcp", { method: "HEAD", headers: UA });
  ok("HEAD /mcp -> 405 Allow: GET, POST, DELETE", head.status === 405 && head.headers.get("allow") === "GET, POST, DELETE", `status=${head.status} allow=${head.headers.get("allow")}`);
  const g = await fetch(BASE + "/mcp", { headers: { ...UA, accept: "text/html" } });
  const gj = await g.json().catch(() => ({}));
  ok("GET /mcp (no event-stream) -> 406 JSON-RPC error", g.status === 406 && gj.error?.code === -32000, `status=${g.status}`);
  const pl = await mcp({ method: "prompts/list" });
  const plj = await pl.json().catch(() => ({}));
  ok("POST /mcp prompts/list -> -32601 Method not found", pl.status === 200 && plj.error?.code === -32601, `status=${pl.status}`);
  await paid402("/v1/pa?cf=80016350821", "5000");
  await paid402("/v1/counterparty?id=80016350821", "10000");
  for (const [p, t] of [["/.well-known/x402", "application/json"], ["/openapi.json", "application/json"], ["/llms.txt", "text/plain"]]) {
    const d = await fetch(BASE + p, { headers: UA });
    okGuide(`GET ${p} -> 200 ${t}`, d.status === 200 && (d.headers.get("content-type") || "").startsWith(t), `status=${d.status}`);
  }
} catch (e) { ok("smoke run without network errors", false, String(e?.message || e)); }
console.log(failed ? `SMOKE FAILED (${failed})` : "SMOKE OK");
process.exitCode = failed ? 1 : 0;
