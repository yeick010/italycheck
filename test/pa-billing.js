// /v1/pa and MCP lookup_italian_pa: charged only when the entity is found (Yeison 24/11/2026 11:52: "la ricerca enti non deve
// addebitare se il codice fiscale è malformato o non trovato"). Offline: IndicePA and the facilitator are mocked.
import { createApp } from "../src/app.js";
import { paLookup, ipaLookup } from "../src/core.js";
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

// ── core: paLookup status mapping ──
{ const f = await paLookup("80016350821"); ok("paLookup found -> 200", f.httpStatus === 200 && f.status === "found" && f.entities[0].name === "Comune di Palermo" && !("charged" in f));
  const n = await paLookup("00743110157"); ok("paLookup not found -> 404 not charged", n.httpStatus === 404 && n.status === "not_found" && n.charged === false && /Not charged/.test(n.hint));
  calls.ipa = 0;
  for (const bad of ["abc", "", undefined, "8001635082", "800163508211"]) { const b = await paLookup(bad);
    ok(`paLookup malformed ${JSON.stringify(bad)} -> 400 not charged, no IndicePA call`, b.httpStatus === 400 && b.error === "expected_11_digit_codice_fiscale" && b.charged === false); }
  ok("malformed cf: IndicePA never queried", calls.ipa === 0);
  for (const m of ["down", "ckan_error", "html"]) { ipaMode = m; const r = await paLookup("80016350821"); ipaMode = "ok";
    ok(`paLookup IndicePA ${m} -> 502 not charged`, r.httpStatus === 502 && r.error === "ipa_unreachable" && r.charged === false); }
  const raw = await ipaLookup("80016350821"); ok("ipaLookup shape unchanged (no httpStatus)", raw.status === "found" && !("httpStatus" in raw)); }

// ── free app (no payments): HTTP statuses, no internal field ──
{ const free = createApp({ DISABLE_PAYMENTS: "1" });
  const st = async p => { const r = await free.request(p); return [r.status, await r.json()]; };
  let [s, j] = await st("/v1/pa?cf=80016350821"); ok("GET /v1/pa found -> 200, no httpStatus field", s === 200 && j.status === "found" && !("httpStatus" in j));
  [s, j] = await st("/v1/pa?cf=00743110157"); ok("GET /v1/pa not found -> 404 JSON", s === 404 && j.status === "not_found" && j.charged === false);
  [s, j] = await st("/v1/pa?cf=12"); ok("GET /v1/pa malformed -> 400 JSON", s === 400 && j.error === "expected_11_digit_codice_fiscale");
  [s, j] = await st("/v1/pa"); ok("GET /v1/pa missing cf -> 400", s === 400);
  ipaMode = "down"; [s, j] = await st("/v1/pa?cf=80016350821"); ipaMode = "ok"; ok("GET /v1/pa IndicePA down -> 502", s === 502 && j.error === "ipa_unreachable");
  const root = await (await free.request("/")).json(); const e = root.endpoints.find(x => x.path === "/v1/pa");
  ok("catalog: /v1/pa still $0.005, states the charging rule", e.price === "$0.005" && /only on 200/.test(e.charged) && /404 not found/.test(e.charged)); }

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
  calls.settle = 0; calls.verify = 0; let r = await pay("80016350821", via);
  ok(`HTTP paid found (${via}) -> 200 + settled once + PAYMENT-RESPONSE`, r.status === 200 && (await r.json()).status === "found" && calls.settle === 1 && !!r.headers.get("payment-response"), `settle=${calls.settle}`);
  calls.settle = 0; r = await pay("00743110157", via);
  ok(`HTTP paid not found (${via}) -> 404, NOT settled, no PAYMENT-RESPONSE`, r.status === 404 && (await r.json()).status === "not_found" && calls.settle === 0 && !r.headers.get("payment-response"), `settle=${calls.settle}`);
  calls.settle = 0; r = await pay("123", via);
  ok(`HTTP paid malformed cf (${via}) -> 400, NOT settled`, r.status === 400 && calls.settle === 0, `settle=${calls.settle}`);
  calls.settle = 0; r = await pay(null, via);
  ok(`HTTP paid missing cf (${via}) -> 400, NOT settled`, r.status === 400 && calls.settle === 0, `settle=${calls.settle}`);
  calls.settle = 0; ipaMode = "down"; r = await pay("80016350821", via); ipaMode = "ok";
  ok(`HTTP paid IndicePA down (${via}) -> 502, NOT settled`, r.status === 502 && calls.settle === 0, `settle=${calls.settle}`);
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
  calls.settle = 0; let g = await call("80016350821");
  ok("MCP paid found -> result + settled once", !g.isError && JSON.parse(g.content[0].text).status === "found" && g._meta?.["x402/payment-response"]?.success === true && calls.settle === 1, `settle=${calls.settle}`);
  calls.settle = 0; g = await call("00743110157");
  ok("MCP paid not found -> isError, NOT settled", g.isError === true && JSON.parse(g.content[0].text).status === "not_found" && calls.settle === 0, `settle=${calls.settle}`);
  calls.settle = 0; g = await call("12x");
  ok("MCP paid malformed cf -> isError, NOT settled", g.isError === true && JSON.parse(g.content[0].text).error === "expected_11_digit_codice_fiscale" && calls.settle === 0, `settle=${calls.settle}`);
  calls.settle = 0; ipaMode = "down"; g = await call("80016350821"); ipaMode = "ok";
  ok("MCP paid IndicePA down -> isError, NOT settled", g.isError === true && JSON.parse(g.content[0].text).error === "ipa_unreachable" && calls.settle === 0, `settle=${calls.settle}`);
  ok("MCP result text has no internal httpStatus", !("httpStatus" in JSON.parse(g.content[0].text))); }

// ── docs describe the new rule ──
{ const d = paToolDescription({}); ok("tool description: price unchanged + not charged unless found", d.includes("Costs $0.005 in USDC") && /charged only when the entity is found/.test(d) && /not found/.test(d));
  const docs = discoveryDocs({ pa: "$0.005", counterparty: "$0.01" });
  const o = JSON.parse(docs["/openapi.json"].body).paths["/v1/pa"].get;
  ok("openapi /v1/pa: 400/404/502 not charged, price 0.005", o.responses[404] && /not charged/.test(o.responses[404].description) && o.responses[400] && o.responses[502] && o["x-payment-info"].price.amount === "0.005");
  ok("llms.txt + .well-known/x402 state /v1/pa not charged on malformed/not found", /not charged on malformed cf, not found/.test(docs["/llms.txt"].body) && /not charged on 400\/404\/502/.test(JSON.parse(docs["/.well-known/x402"].body).instructions)); }
