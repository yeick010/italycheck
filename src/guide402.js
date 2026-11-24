// Readable 402 body + free discovery documents (conversion task 24/11/2026, approved scope: D4, no price/wallet/terms change).
// Before this, an unpaid JSON GET got 402 with body "{}": everything was only in the base64 PAYMENT-REQUIRED header.
// The body now repeats the decoded PAYMENT-REQUIRED object unchanged (x402Version, error, resource, accepts, extensions)
// and adds "message" + "howToPay". x402 v2 clients read the header first (@x402/core getPaymentRequiredResponse),
// so the header and accepts stay authoritative and byte-identical. Prices/amounts are read from the header, never typed here.
import { decodePaymentRequiredHeader } from "@x402/core/http";
const BASE_DOCS = "https://github.com/yeick010/italycheck";
const SITE = "https://italycheck.italycheck.workers.dev";

// Per-route facts that the header does not carry. Charging rules must match the code: /v1/pa answers 400/404/502 (not charged)
// on malformed cf, not found or IndicePA failure (since 24/11/2026); /v1/counterparty answers 400/422/502 (not charged) likewise.
export const ROUTE_INFO = {
  "/v1/pa": { query: "cf", example: "80016350821", input: "cf = 11-digit codice fiscale of the Italian public entity",
    charging: "Not charged when the answer is 400 (malformed cf), 404 (not found in IndicePA) or 502 (IndicePA unreachable): payment is settled only on 200 (entity found).",
    alsoSee: "/v1/counterparty?id=... (counterparty verdict incl. SDI e-invoicing offices; not charged on bad input or IndicePA outage)" },
  "/v1/counterparty": { query: "id", example: "80016350821", input: "id = Italian partita IVA or numeric codice fiscale (11 digits, optional IT prefix)",
    charging: "Not charged when the answer is 400 (malformed input), 422 (wrong check digit) or 502 (IndicePA unreachable): payment is settled only on 200.",
    alsoSee: "/v1/pa?cf=... (IndicePA record only)" },
};

const decode = h => { try { return decodePaymentRequiredHeader(h); } catch { return null; } }; // UTF-8 aware (the example has "©")
// "5000" with 6 decimals -> "0.005"
export const atomicToDecimal = (a, d = 6) => { const s = String(a).padStart(d + 1, "0"); return (s.slice(0, -d) + "." + s.slice(-d)).replace(/\.?0+$/, ""); };
const NETWORK_NAMES = { "eip155:8453": "Base mainnet", "eip155:84532": "Base Sepolia testnet" };

// Body text for a JSON 402 { status, headers, body }. Returns null if the header is missing/unreadable (keep the original).
export function guide402Body(entry, path, { legacyHeader = false } = {}) {
  const headers = new Headers(entry.headers);
  const pr = decode(headers.get("payment-required") || "");
  const info = ROUTE_INFO[path];
  if (!pr || !info || !Array.isArray(pr.accepts) || !pr.accepts.length) return null;
  const a0 = pr.accepts[0];
  const assets = pr.accepts.map(a => a.extra?.name === "USD Coin" ? "USDC" : (a.extra?.name || a.asset));
  const amount = atomicToDecimal(a0.amount);
  const net = `${a0.network}${NETWORK_NAMES[a0.network] ? " (" + NETWORK_NAMES[a0.network] + ")" : ""}`;
  const message = `Payment required: ${amount} ${assets.join(" or ")} per call (amount ${a0.amount}, 6 decimals) on ${net}, paid with x402 v2. ` +
    `Decode the PAYMENT-REQUIRED response header (base64 JSON, same object as this body without message/howToPay), sign one entry of accepts ` +
    `(EIP-3009 transferWithAuthorization, no gas for the payer), then repeat this exact GET with the PAYMENT-SIGNATURE request header. ` + info.charging;
  const body = { ...pr,
    message,
    ...(legacyHeader ? { hint: "This request carried X-PAYMENT (x402 v1). This server speaks x402 v2: send the signed payload in the PAYMENT-SIGNATURE header instead." } : {}),
    howToPay: {
      protocol: "x402 v2 (exact scheme)", network: a0.network, price: { amount, currency: assets, atomicAmount: a0.amount, decimals: 6, payTo: a0.payTo },
      input: info.input, example: `GET ${SITE}${path}?${info.query}=${info.example}`,
      steps: ["GET the URL without payment -> 402 + PAYMENT-REQUIRED header",
        "pick one entry of accepts (USDC first, EURC same nominal amount), sign it with an x402 client",
        "repeat the same GET with header PAYMENT-SIGNATURE: <base64 payment payload>",
        "200 + PAYMENT-RESPONSE header (settlement receipt). X-PAYMENT (x402 v1) is not read."],
      client: { npm: "npm i @x402/fetch @x402/evm viem",
        code: "import { wrapFetchWithPaymentFromConfig } from '@x402/fetch'; import { ExactEvmScheme } from '@x402/evm'; import { privateKeyToAccount } from 'viem/accounts'; " +
          "const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.env.KEY)) }] }); " +
          `const r = await pay('${SITE}${path}?${info.query}=${info.example}');` },
      eurcNote: "@x402 clients with default spendControls accept USDC only; to pay in EURC allow the EURC asset (spendControls.allowedAssets).",
      mcp: `Same data as MCP tools over Streamable HTTP at ${SITE}/mcp (lookup_italian_pa, verify_italian_counterparty; payment in params._meta["x402/payment"]).`,
      alsoSee: info.alsoSee,
      docs: [BASE_DOCS, SITE + "/", SITE + "/openapi.json", SITE + "/llms.txt"],
    },
  };
  return JSON.stringify(body);
}

// JSON 402 entry -> same status and headers, readable body. Only replaces the library's empty "{}" body.
export function withGuide(entry, path, opts) {
  if (entry.status !== 402 || (entry.body !== "{}" && entry.body !== "")) return entry;
  const ct = new Headers(entry.headers).get("content-type") || "";
  if (!ct.includes("application/json")) return entry;
  const body = guide402Body(entry, path, opts);
  return body ? { ...entry, body } : entry;
}

// POST/PUT/... to a paid route without a payment header: 405 + Allow, with the GET to use (was a bare Hono 404).
export function methodNotAllowed(path, method) {
  const info = ROUTE_INFO[path];
  return new Response(JSON.stringify({ error: "method_not_allowed", message: `${method} is not supported on ${path}. Use GET ${path}?${info.query}=${info.example} (x402 v2: unpaid GET answers 402 with payment instructions).`, docs: BASE_DOCS }),
    { status: 405, headers: { allow: "GET, HEAD", "content-type": "application/json" } });
}

// ───── Free discovery documents (static, built once per isolate) ─────
// Requested ~1,500 times in 7 days and all 404 before (x402 crawlers: /.well-known/x402, /openapi.json, /llms.txt).
// Prices come from the same env/defaults as the 402 (fast-paths.js ROUTES), passed in by the caller.
let docsCache = null;
export function discoveryDocs(prices) {
  const k = JSON.stringify(prices);
  if (docsCache?.k === k) return docsCache.v;
  const usd = p => String(p).replace("$", "");
  const resources = [`${SITE}/v1/pa?cf=80016350821`, `${SITE}/v1/counterparty?id=80016350821`];
  const x402 = { version: 1, resources,
    instructions: `# ItalyCheck\nItalian public-administration checks for AI agents (IndicePA, AgID, CC BY 4.0). x402 v2, USDC or EURC on Base (eip155:8453).\n` +
      `- GET /v1/pa?cf=<11 digits>: ${prices.pa} per call. IndicePA record (name, category, PEC, address); not charged on 400/404/502 (malformed cf, not found, IndicePA outage).\n` +
      `- GET /v1/counterparty?id=<partita IVA or codice fiscale>: ${prices.counterparty} per call. Verdict pa_verificata | formato_valido_non_verificato | formato_non_valido + SDI e-invoicing offices; not charged on 400/422/502.\n` +
      `- Free: GET /v1/vat/format?vat=<partita IVA> (offline check digit). MCP: POST /mcp (Streamable HTTP).\nDocs: ${BASE_DOCS}` };
  const op = (summary, q, desc, price, pattern, notCharged) => ({ get: { summary, operationId: summary.replace(/\W+/g, "_").toLowerCase(),
    parameters: [{ name: q, in: "query", required: true, description: desc, schema: { type: "string", pattern } }],
    "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: usd(price) }, network: "eip155:8453", assets: ["USDC", "EURC"] },
    responses: { 200: { description: "Result (JSON), charged" }, ...notCharged, 402: { description: "Payment required (x402 v2: PAYMENT-REQUIRED header; retry with PAYMENT-SIGNATURE)" } } } });
  const openapi = { openapi: "3.1.0",
    info: { title: "ItalyCheck", version: "0.2.2", description: "Pay-per-call verification of Italian public administrations for AI agents (IndicePA). Payment: x402 v2, USDC or EURC on Base.", "x-docs": BASE_DOCS },
    servers: [{ url: SITE }],
    paths: {
      "/v1/pa": op("Look up Italian public administration", "cf", "11-digit codice fiscale", prices.pa, "^[0-9]{11}$", { 400: { description: "Malformed cf, not charged" }, 404: { description: "Not found in IndicePA, not charged" }, 502: { description: "IndicePA unreachable, not charged" } }),
      "/v1/counterparty": op("Verify Italian counterparty", "id", "Italian partita IVA or numeric codice fiscale (11 digits, optional IT prefix)", prices.counterparty, "^(IT)?[0-9]{11}$", { 400: { description: "Malformed input, not charged" }, 422: { description: "Wrong check digit, not charged" }, 502: { description: "IndicePA unreachable, not charged" } }),
      "/v1/vat/format": { get: { summary: "Free offline partita IVA check digit", operationId: "vat_format", parameters: [{ name: "vat", in: "query", required: true, schema: { type: "string" } }], responses: { 200: { description: "Format result" } } } },
    } };
  const llms = `# ItalyCheck\n\n> Italian public-administration and counterparty checks for AI agents. Data: IndicePA (AgID), CC BY 4.0. Payment: x402 v2, USDC or EURC on Base (eip155:8453), no account or API key.\n\n` +
    `## Paid endpoints\n- [GET /v1/pa?cf=80016350821](${SITE}/v1/pa?cf=80016350821): ${prices.pa} per call. IndicePA record of a public administration (name, category, PEC, address); not charged on malformed cf, not found or IndicePA outage.\n` +
    `- [GET /v1/counterparty?id=80016350821](${SITE}/v1/counterparty?id=80016350821): ${prices.counterparty} per call. Verdict + SDI e-invoicing offices; not charged on bad input or IndicePA outage.\n\n` +
    `## How to pay\nUnpaid GET -> 402 with PAYMENT-REQUIRED header (base64 JSON, also in the body). Sign one entry of accepts with an x402 v2 client (e.g. @x402/fetch + @x402/evm) and repeat the GET with PAYMENT-SIGNATURE.\n\n` +
    `## Free\n- [GET /v1/vat/format?vat=00743110157](${SITE}/v1/vat/format?vat=00743110157): offline check digit.\n- MCP (Streamable HTTP): ${SITE}/mcp\n\n## Docs\n- ${BASE_DOCS}\n- ${SITE}/openapi.json\n`;
  const json = o => ({ body: JSON.stringify(o), type: "application/json" });
  const v = { "/.well-known/x402": json(x402), "/.well-known/x402.json": json(x402), "/openapi.json": json(openapi),
    "/llms.txt": { body: llms, type: "text/plain; charset=utf-8" } };
  docsCache = { k, v };
  return v;
}
