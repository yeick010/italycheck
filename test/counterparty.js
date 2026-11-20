// Tests for the "verifica controparte" tool (GET /v1/counterparty, MCP verify_italian_counterparty), $0.01 via x402.
// Offline first (IndicePA and the facilitator are mocked through globalThis.fetch), then two live read-only IndicePA checks.
import { createApp } from "../src/app.js";
import { counterpartyCheck, counterpartyId, IPA_UO_SFE, UO_SFE_LIMIT } from "../src/core.js";
import { fastUnpaid402 } from "../src/fast-paths.js";
import { handleMcp, mcpUnpaid, _resetMcpCache } from "../src/remote-mcp.js";
import { paidRoute, unpaid402 } from "../src/worker.js";
let failed = 0;
const ok = (n, c, extra = "") => { if (!c) failed++; console.log(`${c ? "PASS" : "FAIL"}  ${n} ${extra}`); };
const snap = async r => ({ status: r.status, headers: [...r.headers].filter(([k]) => k !== "date"), body: await r.text() });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dec = h => JSON.parse(Buffer.from(h, "base64").toString());
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// ── Mocks: IndicePA (Comune di Palermo, 3 offices, total 250 -> truncated) + facilitator with call counters ──
const ENTE = { Codice_IPA: "c_g273", Denominazione_ente: "Comune di Palermo", Tipologia: "Pubbliche Amministrazioni", Codice_ateco: "84.11.10",
  Indirizzo: "Piazza Pretoria, 1", CAP: "90133", Sito_istituzionale: "www.comune.palermo.it", Tipo_Mail1: "Pec", Mail1: "protocollo@cert.comune.palermo.it", Tipo_Mail2: "Altro", Mail2: "x@comune.palermo.it" };
const UO = i => ({ Codice_IPA: "c_g273", Codice_uni_uo: "UFF00" + i, Descrizione_uo: "Ufficio " + i, Codice_fiscale_sfe: "80016350821", Data_avvio_sfe: "2015-03-31",
  Cod_peppol: null, Indirizzo: "Via Roma " + i, CAP: "90100", Tipo_Mail1: i === 1 ? "Pec" : "Altro", Mail1: `uff${i}@cert.comune.palermo.it`, Data_aggiornamento: "2025-12-10" });
const calls = { ipa: [], verify: 0, settle: 0 };
let ipaMode = "ok";
const realFetch = globalThis.fetch;
const NET = "eip155:84532", PAYER = "0x0000000000000000000000000000000000000001";
globalThis.fetch = async (u, init) => {
  const url = String(u?.url ?? u);
  if (url.includes("indicepa.gov.it") && ipaMode !== "live") {
    calls.ipa.push(url);
    if (ipaMode === "down") throw new TypeError("fetch failed");
    if (ipaMode === "ckan_error") return json({ success: false, error: { message: "x" } }, 500);
    const f = JSON.parse(new URL(url).searchParams.get("filters"));
    const pa = f.Codice_fiscale_ente === "80016350821";
    if (url.includes(IPA_UO_SFE)) return json({ success: true, result: { records: pa ? [UO(1), UO(2), UO(3)] : [], total: pa ? 250 : 0 } });
    return json({ success: true, result: { records: pa ? [ENTE] : [] } });
  }
  if (url.startsWith("https://fac.example")) {
    if (url.endsWith("/supported")) return json({ kinds: [NET, "eip155:8453"].map(network => ({ x402Version: 2, scheme: "exact", network })), extensions: ["bazaar"], signers: {} });
    if (url.endsWith("/verify")) { calls.verify++; return json({ isValid: true, payer: PAYER }); }
    if (url.endsWith("/settle")) { calls.settle++; return json({ success: true, transaction: "0x" + "ab".repeat(32), network: NET, payer: PAYER }); }
  }
  if (url.endsWith("/supported")) return json({ kinds: ["eip155:8453", "eip155:84532"].map(network => ({ x402Version: 2, scheme: "exact", network })), extensions: ["bazaar"], signers: {} });
  return realFetch(u, init);
};

// ── Core: ids, verdicts, attribution, no VIES, not-billable cases ──
ok("id normalization (IT prefix, spaces, dots)", counterpartyId("IT 007.431.10157") === "00743110157" && counterpartyId("80016350821") === "80016350821"
  && counterpartyId("RSSMRA80A01H501U") === null && counterpartyId("") === null && counterpartyId(undefined) === null && counterpartyId("DE811569869") === null);
{ calls.ipa = [];
  const r = await counterpartyCheck("80016350821");
  ok("PA -> pa_verificata, entity + PEC, e-invoicing offices", r.httpStatus === 200 && r.verdict === "pa_verificata" && r.format.checksumOk === true
    && r.pa.isPublicAdministration && r.pa.entities[0].name === "Comune di Palermo" && same(r.pa.entities[0].pec, ["protocollo@cert.comune.palermo.it"])
    && r.pa_einvoice.offices.length === 3 && r.pa_einvoice.offices[0].codiceUnivocoUfficio === "UFF001" && same(r.pa_einvoice.offices[0].pec, ["uff1@cert.comune.palermo.it"])
    && same(r.pa_einvoice.offices[1].pec, []), r.verdict);
  ok("truncation reported (total > returned)", r.pa_einvoice.total === 250 && r.pa_einvoice.truncated === true);
  ok("CC BY 4.0 attribution + both IndicePA datasets cited", /© AgID - IndicePA, CC BY 4\.0/.test(r.attribution) && r.sources.length === 2
    && r.sources.every(s => s.license === "CC BY 4.0" && s.retrievedAt === r.checkedAt) && r.sources[1].url.endsWith("unita-organizzative-che-ricevono-fatture-elettroniche"));
  ok("VIES off, no company data queried", r.vies.status === "disabled" && calls.ipa.length === 2 && calls.ipa.every(u => u.startsWith("https://indicepa.gov.it/ipa-dati/api/3/action/datastore_search?")));
  ok("UO query: same IndicePA API, by codice fiscale, limit + field selection", calls.ipa.some(u => u.includes(IPA_UO_SFE) && u.includes(`limit=${UO_SFE_LIMIT}`) && u.includes("fields=") && u.includes(encodeURIComponent('{"Codice_fiscale_ente":"80016350821"}')))); }
{ const r = await counterpartyCheck("IT00743110157");
  ok("private company -> formato_valido_non_verificato (not confirmed)", r.httpStatus === 200 && r.verdict === "formato_valido_non_verificato" && r.pa.isPublicAdministration === false
    && r.pa_einvoice.offices.length === 0 && /NOT confirmed/.test(r.disclaimer)); }
{ calls.ipa = [];
  const r = await counterpartyCheck("00743110158");
  ok("wrong check digit -> formato_non_valido, 422, no IndicePA call", r.httpStatus === 422 && r.verdict === "formato_non_valido" && calls.ipa.length === 0);
  const b = await counterpartyCheck("abc");
  ok("malformed id -> 400 error", b.httpStatus === 400 && b.error === "expected_11_digit_partita_iva_or_codice_fiscale" && calls.ipa.length === 0); }
for (const m of ["down", "ckan_error"]) { ipaMode = m; const r = await counterpartyCheck("80016350821"); ipaMode = "ok";
  ok(`IndicePA ${m} -> 502 ipa_unreachable (not a verdict)`, r.httpStatus === 502 && r.error === "ipa_unreachable" && !r.verdict); }

// ── HTTP: free app shape, 402 price, fast 402 == library ──
{ const free = createApp({ DISABLE_PAYMENTS: "1" });
  let r = await free.request("/v1/counterparty?id=80016350821"); let j = await r.json();
  ok("GET /v1/counterparty 200, no internal httpStatus field", r.status === 200 && j.verdict === "pa_verificata" && !("httpStatus" in j));
  r = await free.request("/v1/counterparty?id=00743110158"); ok("GET bad check digit -> 422", r.status === 422 && (await r.json()).verdict === "formato_non_valido");
  r = await free.request("/v1/counterparty"); ok("GET missing id -> 400", r.status === 400);
  const root = await (await free.request("/")).json();
  ok("catalog lists /v1/counterparty at $0.01 and /v1/pa still $0.005", root.endpoints.find(e => e.path === "/v1/counterparty")?.price === "$0.01" && root.endpoints.find(e => e.path === "/v1/pa")?.price === "$0.005"); }
{ const env = { X402_NETWORK: "eip155:8453" };
  const c = dec((await createApp(env).fetch(new Request("https://italycheck.example/v1/counterparty?id=80016350821"), env)).headers.get("payment-required"));
  const p = dec((await createApp(env).fetch(new Request("https://italycheck.example/v1/pa?cf=80016350821"), env)).headers.get("payment-required"));
  ok("402 counterparty: USDC + EURC on Base, amount 10000 ($0.01)", c.accepts.length === 2 && c.accepts.every(a => a.amount === "10000" && a.network === "eip155:8453")
    && c.accepts[0].asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" && c.accepts[1].asset === "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", JSON.stringify(c.accepts.map(a => a.amount)));
  ok("402 lookup_italian_pa unchanged: amount 5000 ($0.005)", p.accepts.every(a => a.amount === "5000"));
  ok("402 counterparty: Bazaar discovery declared", c.extensions?.bazaar?.info?.input?.queryParams?.id === "80016350821" || !!c.extensions?.bazaar, JSON.stringify(c.extensions?.bazaar?.info?.input ?? {}).slice(0, 120)); }
const CP = "https://italycheck.example/v1/counterparty?id=80016350821";
for (const [name, env, url] of [
  ["testnet", { X402_NETWORK: "eip155:84532" }, CP],
  ["mainnet (wrangler.toml)", { X402_NETWORK: "eip155:8453", PAY_TO: "0xde8380854ef9c926093832501d95a47f4c63fe7c", ENABLE_VAT: "0", PRICE_PA: "$0.005" }, CP],
  ["DISABLE_EURC", { X402_NETWORK: "eip155:8453", DISABLE_EURC: "1" }, CP],
  ["custom PRICE_COUNTERPARTY $0.02", { X402_NETWORK: "eip155:8453", PRICE_COUNTERPARTY: "$0.02" }, CP],
  ["no query", { X402_NETWORK: "eip155:8453" }, "https://italycheck.example/v1/counterparty"],
]) {
  const lib = await snap(await createApp(env).fetch(new Request(url), env));
  const f = fastUnpaid402(url, env);
  const fast = f && await snap(new Response(f.body, { status: f.status, headers: f.headers }));
  ok(`fast 402 == library 402 (counterparty): ${name}`, f && same(fast, lib), f ? "" : "fast path returned null");
}
{ unpaid402.clear(); const env = { X402_NETWORK: "eip155:8453" }, log = {};
  const r = await snap(await paidRoute(new Request(CP), env, {}, log));
  ok("worker paidRoute: /v1/counterparty served by fast 402", r.status === 402 && log.fast_402 === true && unpaid402.size === 1);
  const pa = await snap(await paidRoute(new Request("https://italycheck.example/v1/pa?cf=80016350821"), env, {}));
  ok("worker paidRoute: /v1/pa and /v1/counterparty 402s differ only by route data", pa.status === 402 && dec(new Headers(pa.headers).get("payment-required")).accepts[0].amount === "5000"
    && dec(new Headers(r.headers).get("payment-required")).accepts[0].amount === "10000"); unpaid402.clear(); }

// ── HEAD on paid routes: 402 like GET, no body, no IndicePA lookup, no verify/settle (Yeison 20/11/2026 22:24) ──
{ const PA = "https://italycheck.example/v1/pa?cf=80016350821";
  const head = (u, h = {}) => new Request(u, { method: "HEAD", headers: h });
  for (const [name, env] of [["mainnet", { X402_NETWORK: "eip155:8453", PAY_TO: "0xde8380854ef9c926093832501d95a47f4c63fe7c", ENABLE_VAT: "0", PRICE_PA: "$0.005" }],
    ["library path (ENABLE_VAT=1)", { X402_NETWORK: "eip155:8453", ENABLE_VAT: "1" }]]) {
    for (const [u, amount] of [[PA, "5000"], [CP, "10000"]]) {
      const path = new URL(u).pathname;
      unpaid402.clear(); calls.ipa = []; calls.verify = 0; calls.settle = 0;
      const log = {}; const h = await snap(await paidRoute(head(u), env, {}, log));
      const g = await snap(await paidRoute(new Request(u), env, {}));
      ok(`HEAD ${path} (${name}) -> 402, empty body, ${amount}`, h.status === 402 && h.body === "" && log.head_402 === true
        && dec(new Headers(h.headers).get("payment-required")).accepts.every(a => a.amount === amount), `status=${h.status} body=${h.body.length}`);
      ok(`HEAD ${path} (${name}) headers == GET 402 headers`, g.status === 402 && same(h.headers, g.headers));
      ok(`HEAD ${path} (${name}) -> no IndicePA lookup, no verify/settle`, calls.ipa.length === 0 && calls.verify === 0 && calls.settle === 0, `ipa=${calls.ipa.length}`);
      calls.ipa = [];
      const hp = await snap(await paidRoute(head(u, { "payment-signature": "eyJ4NDAyVmVyc2lvbiI6Mn0=" }), env, {}));
      ok(`HEAD ${path} (${name}) with payment header -> 402, no lookup, not charged`, hp.status === 402 && hp.body === "" && calls.ipa.length === 0 && calls.verify === 0 && calls.settle === 0);
    }
  }
  unpaid402.clear(); calls.ipa = [];
  const env = { X402_NETWORK: "eip155:8453" };
  await paidRoute(new Request(PA), env, {}); // GET fills the cache, HEAD reuses it
  const log = {}; const h = await snap(await paidRoute(head(PA, { accept: "text/html", "user-agent": "Mozilla/5.0" }), env, {}, log));
  ok("HEAD (browser headers, cache hit) -> JSON 402, no body, no lookup", h.status === 402 && h.body === "" && unpaid402.size === 1 && calls.ipa.length === 0
    && new Headers(h.headers).get("content-type") === "application/json");
  const { default: worker } = await import("../src/worker.js");
  const out = []; const cl = console.log; console.log = o => out.push(o);
  let wr; try { wr = await worker.fetch(head(CP), env, {}); } finally { console.log = cl; }
  ok("worker.fetch HEAD /v1/counterparty -> 402, logged head_402", wr.status === 402 && (await wr.text()) === "" && out[0]?.head_402 === true && out[0]?.status === 402 && calls.ipa.length === 0);
  unpaid402.clear(); }

// ── Paid flows with the mock facilitator: charged only for a verdict ──
{ const { x402Client } = await import("@x402/core/client");
  const { ExactEvmScheme } = await import("@x402/evm");
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const env = { X402_NETWORK: NET, FACILITATOR_URL: "https://fac.example" };
  const client = new x402Client().register(NET, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
  const pay = async id => { const u = `https://italycheck.example/v1/counterparty?id=${encodeURIComponent(id)}`;
    const pr = dec((await createApp(env).fetch(new Request(u), env)).headers.get("payment-required"));
    const h = Buffer.from(JSON.stringify(await client.createPaymentPayload(pr))).toString("base64");
    return createApp(env).fetch(new Request(u, { headers: { "payment-signature": h } }), env); };
  calls.settle = 0; let r = await pay("80016350821");
  ok("HTTP paid PA lookup -> 200 + settled once", r.status === 200 && (await r.json()).verdict === "pa_verificata" && calls.settle === 1 && !!r.headers.get("payment-response"), `settle=${calls.settle}`);
  calls.settle = 0; r = await pay("00743110158");
  ok("HTTP paid wrong check digit -> 422, NOT settled", r.status === 422 && calls.settle === 0, `settle=${calls.settle}`);
  calls.settle = 0; ipaMode = "down"; r = await pay("80016350821"); ipaMode = "ok";
  ok("HTTP paid during IndicePA outage -> 502, NOT settled", r.status === 502 && calls.settle === 0, `settle=${calls.settle}`);

  const rpc = (args, meta) => new Request("https://italycheck.example/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "verify_italian_counterparty", arguments: args, ...(meta ? { _meta: meta } : {}) } }) });
  _resetMcpCache();
  const u1 = (await (await handleMcp(rpc({ id: "80016350821" }), env)).json()).result;
  const prm = u1.structuredContent;
  ok("MCP unpaid -> payment-required, $0.01 USDC + EURC, own resource", u1.isError === true && prm?.accepts?.length === 2 && prm.accepts.every(a => a.amount === "10000")
    && prm.resource?.url?.endsWith("/mcp#verify_italian_counterparty") && mcpUnpaid.size === 1);
  const pa1 = (await (await handleMcp(new Request("https://italycheck.example/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "lookup_italian_pa", arguments: { cf: "80016350821" } } }) }), env)).json()).result.structuredContent;
  ok("MCP lookup_italian_pa still $0.005 (separate accepts cache)", pa1.accepts.every(a => a.amount === "5000") && mcpUnpaid.size === 2);
  const meta = { "x402/payment": await client.createPaymentPayload(prm) };
  calls.settle = 0; const g = (await (await handleMcp(rpc({ id: "80016350821" }, meta), env)).json()).result;
  ok("MCP paid -> verdict + settled once", !g.isError && JSON.parse(g.content[0].text).verdict === "pa_verificata" && g._meta?.["x402/payment-response"]?.success === true && calls.settle === 1, `settle=${calls.settle}`);
  calls.settle = 0; const bad = (await (await handleMcp(rpc({ id: "00743110158" }, meta), env)).json()).result;
  ok("MCP paid wrong check digit -> isError, NOT settled", bad.isError === true && JSON.parse(bad.content[0].text).verdict === "formato_non_valido" && calls.settle === 0, `settle=${calls.settle}`);
  // Fast path: cached unpaid payment-required result == SDK path
  const msg = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "verify_italian_counterparty", arguments: { id: "IT00743110157" } } };
  const log = {}; const fast = await snap(await handleMcp(rpc({ id: "IT00743110157" }), env, log, msg));
  const sdk = await snap(await handleMcp(rpc({ id: "IT00743110157" }), env));
  ok("MCP unpaid tools/call (counterparty): fast == SDK", log.mcp_fast === true && same(fast, sdk), `fast=${!!log.mcp_fast} ${JSON.stringify(fast).slice(0,300)} || ${JSON.stringify(sdk).slice(0,300)}`);
  { const pm = { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "lookup_italian_pa", arguments: { cf: "80016350821" } } };
    const pr = () => new Request("https://italycheck.example/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(pm) });
    const lg = {}; const f = await snap(await handleMcp(pr(), env, lg, pm)); const s2 = await snap(await handleMcp(pr(), env));
    ok("MCP unpaid tools/call (lookup_italian_pa, real cached result): fast == SDK byte for byte", lg.mcp_fast === true && same(f, s2)); }
  const l2 = {}; await handleMcp(rpc({ cf: "x" }), env, l2, { ...msg, params: { ...msg.params, arguments: { cf: "x" } } });
  ok("MCP fast path declines wrong argument name", !l2.mcp_fast);
  _resetMcpCache(); }

// ── MCP tools/list: fast == SDK, three tools, prices in descriptions ──
{ const env = { X402_NETWORK: "eip155:8453" };
  const req = () => new Request("https://italycheck.example/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  const log = {}; const fast = await snap(await handleMcp(req(), env, log, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
  const sdk = await snap(await handleMcp(req(), env));
  const tools = JSON.parse(fast.body).result.tools;
  ok("tools/list fast == SDK with verify_italian_counterparty", log.mcp_fast === true && same(fast, sdk) && tools.map(t => t.name).join(",") === "check_partita_iva_format,lookup_italian_pa,verify_italian_counterparty");
  ok("tool descriptions: $0.01 counterparty, $0.005 PA, input schema id", /Costs \$0\.01 in USDC \(or 0\.01 EURC\)/.test(tools[2].description) && /Costs \$0\.005 /.test(tools[1].description)
    && same(tools[2].inputSchema.required, ["id"])); }

// ── Live, read-only (IndicePA open data) ──
ipaMode = "live";
try {
  const r = await counterpartyCheck("80016350821");
  ok("live: Comune di Palermo -> pa_verificata with e-invoicing offices", r.verdict === "pa_verificata" && r.pa.entities[0]?.codiceIPA === "c_g273" && r.pa_einvoice.offices.length > 0
    && r.pa_einvoice.offices.every(o => /^[A-Z0-9]{6}$/.test(o.codiceUnivocoUfficio)), `offices=${r.pa_einvoice.offices.length}/${r.pa_einvoice.total}`);
  const p = await counterpartyCheck("IT00743110157");
  ok("live: private company -> formato_valido_non_verificato", p.verdict === "formato_valido_non_verificato");
} catch (e) { ok("live IndicePA checks", false, e.message); }

globalThis.fetch = realFetch;
if (failed) { console.log(`${failed} FAILED`); process.exitCode = 1; }
