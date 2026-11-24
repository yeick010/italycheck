// /v1/pa and MCP lookup_italian_pa: settled on EVERY paid call (found, not_found, malformed/missing cf, IndicePA unreachable),
// the pre-7bb1b15 behavior restored by Yeison 24/11/2026 12:09 ("retifico, fali pagare, perche per noi comunque è un costo").
// Offline: IndicePA and the facilitator are mocked.
import { createApp } from "../src/app.js";
import { ipaLookup } from "../src/core.js";
import { MCP_SERVER_INFO } from "../src/fast-paths.js";
import { handleMcp, _resetMcpCache } from "../src/remote-mcp.js";
import { paidRoute, unpaid402 } from "../src/worker.js";
import { paToolDescription } from "../src/fast-paths.js";
import { discoveryDocs } from "../src/guide402.js";
let failed = 0;
const ok = (n, c, extra = "") => { if (!c) failed++; console.log(`${c ? "PASS" : "FAIL"}  ${n} ${extra}`); };
process.on("exit", () => { if (failed) { console.log(`${failed} FAILED`); process.exitCode = 1; } });
const dec = h => JSON.parse(Buffer.from(h, "base64").toString());
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const ENTE = { Codice_IPA: "c_g273", Denominazione_ente: "Comune di Palermo", Tipologia: "Pubbliche Amministrazioni", Codice_ateco: "84.11.10",
  Indirizzo: "Piazza Pretoria, 1", CAP: "90133", Sito_istituzionale: "www.comune.palermo.it", Tipo_Mail1: "Pec", Mail1: "protocollo@cert.comune.palermo.it" };
const calls = { ipa: 0, verify: 0, settle: 0 };
let ipaMode = "ok";
const NET = "eip155:84532", PAYER = "0x0000000000000000000000000000000000000001";
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = String(u?.url ?? u);
  if (url.includes("indicepa.gov.it")) {
    calls.ipa++;
    if (ipaMode === "down") throw new TypeError("fetch failed");
    if (ipaMode === "ckan_error") return json({ success: false, error: { message: "x" } }, 500);
    if (ipaMode === "html") return new Response("<html>maintenance</html>", { status: 503 });
    const f = JSON.parse(new URL(url).searchParams.get("filters"));
    return json({ success: true, result: { records: f.Codice_fiscale_ente === "80016350821" ? [ENTE] : [] } });
  }
  if (url.startsWith("https://fac.example")) {
    if (url.endsWith("/supported")) return json({ kinds: [NET, "eip155:8453"].map(network => ({ x402Version: 2, scheme: "exact", network })), extensions: ["bazaar"], signers: {} });
    if (url.endsWith("/verify")) { calls.verify++; return json({ isValid: true, payer: PAYER }); }
    if (url.endsWith("/settle")) { calls.settle++; return json({ success: true, transaction: "0x" + "ab".repeat(32), network: NET, payer: PAYER }); }
  }
  if (url.endsWith("/supported")) return json({ kinds: ["eip155:8453", "eip155:84532"].map(network => ({ x402Version: 2, scheme: "exact", network })), extensions: ["bazaar"], signers: {} });
  return realFetch(u, init);
};

// ── core: ipaLookup result per case (body only; billing does not depend on it) ──
{ const f = await ipaLookup("80016350821"); ok("ipaLookup found", f.status === "found" && f.entities[0].name === "Comune di Palermo" && !("httpStatus" in f) && !("charged" in f));
  const n = await ipaLookup("00743110157"); ok("ipaLookup not found -> status not_found", n.status === "not_found" && n.isPublicAdministration === false);
  calls.ipa = 0;
  for (const bad of ["abc", "", undefined, "8001635082", "800163508211"]) { const b = await ipaLookup(bad);
    ok(`ipaLookup malformed ${JSON.stringify(bad)} -> status error expected_11_digit_codice_fiscale`, b.status === "error" && b.error === "expected_11_digit_codice_fiscale"); }
  ok("malformed cf: IndicePA never queried", calls.ipa === 0);
  for (const m of ["down", "ckan_error", "html"]) { ipaMode = m; const r = await ipaLookup("80016350821"); ipaMode = "ok";
    ok(`ipaLookup IndicePA ${m} -> status error ipa_unreachable (not a false not_found)`, r.status === "error" && r.error === "ipa_unreachable"); } }

// ── free app (no payments): /v1/pa always 200 (as before 7bb1b15) ──
{ const free = createApp({ DISABLE_PAYMENTS: "1" });
  const st = async p => { const r = await free.request(p); return [r.status, await r.json()]; };
  let [s, j] = await st("/v1/pa?cf=80016350821"); ok("GET /v1/pa found -> 200", s === 200 && j.status === "found");
  [s, j] = await st("/v1/pa?cf=00743110157"); ok("GET /v1/pa not found -> 200 status not_found", s === 200 && j.status === "not_found" && !("charged" in j));
  [s, j] = await st("/v1/pa?cf=12"); ok("GET /v1/pa malformed -> 200 status error", s === 200 && j.error === "expected_11_digit_codice_fiscale");
  [s, j] = await st("/v1/pa"); ok("GET /v1/pa missing cf -> 200 status error", s === 200 && j.status === "error");
  ipaMode = "down"; [s, j] = await st("/v1/pa?cf=80016350821"); ipaMode = "ok"; ok("GET /v1/pa IndicePA down -> 200 status error ipa_unreachable", s === 200 && j.error === "ipa_unreachable");
  const root = await (await free.request("/")).json(); const e = root.endpoints.find(x => x.path === "/v1/pa");
  ok("catalog: /v1/pa still $0.005, says every paid lookup is charged", e.price === "$0.005" && /every paid lookup/.test(e.charged) && /not_found/.test(e.charged) && !/not charged/i.test(e.charged)); }

// ── paid HTTP flow with the mock facilitator: settle only when found ──
const { x402Client } = await import("@x402/core/client");
const { ExactEvmScheme } = await import("@x402/evm");
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const env = { X402_NETWORK: NET, FACILITATOR_URL: "https://fac.example" };
const client = new x402Client().register(NET, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
const pay = async (cf, via = "app") => { const u = `https://italycheck.example/v1/pa${cf === null ? "" : "?cf=" + encodeURIComponent(cf)}`;
  const pr = dec((await createApp(env).fetch(new Request(u), env)).headers.get("payment-required"));
  ok(`402 for ${JSON.stringify(cf)} asks 5000 (unchanged)`, pr.accepts.every(a => a.amount === "5000"));
  const h = Buffer.from(JSON.stringify(await client.createPaymentPayload(pr))).toString("base64");
  const req = new Request(u, { headers: { "payment-signature": h, accept: "application/json" } });
  return via === "worker" ? paidRoute(req, env, {}) : createApp(env).fetch(req, env); };
for (const via of ["app", "worker"]) {
  for (const [name, cf, mode, status] of [["found", "80016350821", "ok", "found"], ["not found", "00743110157", "ok", "not_found"], ["malformed cf", "123", "ok", "error"],
    ["missing cf", null, "ok", "error"], ["IndicePA down", "80016350821", "down", "error"]]) {
    calls.settle = 0; ipaMode = mode; const r = await pay(cf, via); ipaMode = "ok";
    ok(`HTTP paid ${name} (${via}) -> 200 status ${status} + settled once + PAYMENT-RESPONSE`, r.status === 200 && (await r.json()).status === status && calls.settle === 1 && !!r.headers.get("payment-response"), `status=${r.status} settle=${calls.settle}`);
  }
}

// ── HEAD: still 402, empty body, no lookup, no verify/settle ──
{ unpaid402.clear(); calls.ipa = 0; calls.verify = 0; calls.settle = 0;
  for (const cf of ["80016350821", "00743110157", "123"]) {
    const h = await paidRoute(new Request(`https://italycheck.example/v1/pa?cf=${cf}`, { method: "HEAD" }), env, {});
    ok(`HEAD /v1/pa?cf=${cf} -> 402, empty body`, h.status === 402 && (await h.text()) === "" && dec(h.headers.get("payment-required")).accepts.every(a => a.amount === "5000")); }
  ok("HEAD: no IndicePA lookup, no verify/settle", calls.ipa === 0 && calls.verify === 0 && calls.settle === 0); }

// ── MCP lookup_italian_pa: isError (not settled) unless found ──
{ const rpc = (args, meta) => new Request("https://italycheck.example/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "lookup_italian_pa", arguments: args, ...(meta ? { _meta: meta } : {}) } }) });
  _resetMcpCache();
  const u = (await (await handleMcp(rpc({ cf: "80016350821" }), env)).json()).result;
  ok("MCP unpaid -> payment-required 5000, isError", u.isError === true && u.structuredContent.accepts.every(a => a.amount === "5000"));
  const meta = { "x402/payment": await client.createPaymentPayload(u.structuredContent) };
  const call = async cf => (await (await handleMcp(rpc({ cf }, meta), env)).json()).result;
  for (const [name, cf, mode, check] of [["found", "80016350821", "ok", t => t.status === "found"], ["not found", "00743110157", "ok", t => t.status === "not_found"],
    ["malformed cf", "12x", "ok", t => t.error === "expected_11_digit_codice_fiscale"], ["IndicePA down", "80016350821", "down", t => t.error === "ipa_unreachable"]]) {
    calls.settle = 0; ipaMode = mode; const g = await call(cf); ipaMode = "ok";
    ok(`MCP paid ${name} -> result (not isError) + settled once`, !g.isError && check(JSON.parse(g.content[0].text)) && g._meta?.["x402/payment-response"]?.success === true && calls.settle === 1, `settle=${calls.settle}`);
  }
  const init = await (await handleMcp(new Request("https://italycheck.example/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) }), env)).json();
  ok("MCP initialize serverInfo.version = 0.2.2 (= server.json)", init.result.serverInfo.version === "0.2.2" && MCP_SERVER_INFO.version === JSON.parse((await import("node:fs")).readFileSync(new URL("../server.json", import.meta.url))).version); }

// ── docs describe the restored rule (no claim of free errors on /v1/pa) ──
{ const d = paToolDescription({}); ok("tool description: price unchanged + charged on every paid call", d.includes("Costs $0.005 in USDC") && /charged on every paid call/.test(d) && !/not charged:/.test(d));
  const docs = discoveryDocs({ pa: "$0.005", counterparty: "$0.01" });
  const o = JSON.parse(docs["/openapi.json"].body).paths["/v1/pa"].get;
  ok("openapi /v1/pa: no 400/404/502 not-charged responses, price 0.005", !o.responses[400] && !o.responses[404] && !o.responses[502] && o["x-payment-info"].price.amount === "0.005" && /not_found/.test(o.responses[200].description));
  const x = JSON.parse(docs["/.well-known/x402"].body).instructions, l = docs["/llms.txt"].body;
  const paLine = t => t.split("\n").find(z => z.includes("/v1/pa?cf="));
  ok("llms.txt + .well-known/x402: /v1/pa charged also on not_found/malformed, no 'not charged' claim", /charged on every paid lookup/.test(paLine(x)) && /charged on every paid lookup/.test(paLine(l)) && !/not charged/i.test(paLine(x) + paLine(l)));
  const cp = JSON.parse(docs["/openapi.json"].body).paths["/v1/counterparty"].get;
  ok("counterparty docs unchanged: 400/422/502 not charged", /not charged/.test(cp.responses[422].description) && /not charged on 400\/422\/502/.test(x)); }
