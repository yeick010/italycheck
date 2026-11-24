import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { viesCheck, ipaLookup, itChecksum, parseVat, counterpartyCheck } from "./core.js";
import { logPayment } from "./payments.js";

export const DESCRIPTIONS = {
  vat: "Validate an EU VAT number (incl. Italian partita IVA) live against the European Commission VIES service. Use when an agent must confirm a supplier or customer is VAT-registered before invoicing, reverse-charge, onboarding or payment. Input: ?vat=IT00743110157 (country prefix optional, defaults to IT). Returns valid/invalid, registered name and address when the member state discloses them. Italian numbers are checksum-validated offline first.",
  pa: "Look up an Italian public administration or public-service operator by 11-digit codice fiscale in IndicePA (AgID). Use when an agent must verify a public-sector counterparty, find its official PEC (certified email) addresses, or confirm it exists before e-invoicing. Input: ?cf=80016350821.",
  counterparty: "Verify an Italian counterparty in one call before invoicing or paying: partita IVA / codice fiscale check digit, IndicePA public-administration record (name, category, institutional PEC, address) and the e-invoicing offices that receive FatturaPA via SDI (codice univoco ufficio, start date, PEC). Returns verdict pa_verificata | formato_valido_non_verificato | formato_non_valido with sources and CC BY 4.0 attribution. Public-administration data only: private companies are not confirmed (no VIES, no company PEC). Malformed input, a wrong check digit or an IndicePA outage are not charged. Input: ?id=80016350821.",
};
export const PRICE_COUNTERPARTY_DEFAULT = "$0.01";
export const priceCounterparty = env => env.PRICE_COUNTERPARTY || PRICE_COUNTERPARTY_DEFAULT;

// Cache only plain data (never promises) across requests: Workers forbid awaiting I/O from another request.
let supportedCache = null;
let authCache = null;
class CachedFacilitatorClient extends HTTPFacilitatorClient {
  async getSupported() {
    if (supportedCache && Date.now() - supportedCache.t < 3600_000) return supportedCache.v;
    const v = await super.getSupported();
    supportedCache = { v, t: Date.now() };
    return v;
  }
}

const PA_EXAMPLE = { status: "found", isPublicAdministration: true, source: "IndicePA open data (AgID), CC BY 4.0",
  entities: [{ codiceIPA: "c_g273", name: "Comune di Palermo", category: "Pubbliche Amministrazioni", ateco: "84.11.10", address: "Piazza Pretoria, 1 - Palazzo Delle Aquile 90133", website: "www.comune.palermo.it", pec: ["protocollo@cert.comune.palermo.it"] }] };

// EURC (Circle, EIP-3009) per network. Addresses: https://developers.circle.com/stablecoins/eurc-contract-addresses
// EIP-712 domain read on-chain (name()="EURC", version()="2", decimals()=6) on Base mainnet and Base Sepolia.
export const EURC = {
  "eip155:8453": "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
  "eip155:84532": "0x808456652fdb597867f38412077A9182bf77359F",
};

// Payment options for a price: USDC first (default), then the same nominal amount in EURC when the network has it.
export function acceptsFor(price, network, payTo, env = {}) {
  const usdc = { scheme: "exact", price, network, payTo };
  const eurc = EURC[network];
  if (!eurc || env.DISABLE_EURC === "1") return [usdc];
  const amount = String(Math.round(parseFloat(String(price).replace(/[^0-9.]/g, "")) * 1e6));
  return [usdc, { scheme: "exact", price: { amount, asset: eurc, extra: { name: "EURC", version: "2" } }, network, payTo }];
}

const netOf = env => env.X402_NETWORK || "eip155:8453"; // Base mainnet; testnet = eip155:84532
const payToOf = env => env.PAY_TO || "0xde8380854ef9c926093832501d95a47f4c63fe7c"; // Yeison's Base wallet

const COUNTERPARTY_EXAMPLE = { input: "80016350821", id: "80016350821", status: "ok", verdict: "pa_verificata", format: { checksumOk: true },
  pa: { isPublicAdministration: true, entities: [PA_EXAMPLE.entities[0]] },
  pa_einvoice: { offices: [{ codiceUnivocoUfficio: "0WEP9F", name: "Coord.to Interventi COIME - Direzione Amministrativa", codiceIPA: "c_g273", codiceFiscaleSfe: "80016350821", einvoiceSince: "2015-03-31", peppol: null, address: "Largo Carlo Traina 1 Villa Forni 90129", pec: [] }], total: 78, truncated: false },
  vies: { status: "disabled" }, attribution: "Data © AgID - IndicePA, CC BY 4.0" };

// Bazaar discovery declaration for GET /v1/counterparty (also used by the plain-data 402 in fast-paths.js).
export const COUNTERPARTY_DISCOVERY = { method: "GET",
  input: { id: "80016350821" },
  inputSchema: { properties: { id: { type: "string", pattern: "^(IT)?[0-9]{11}$", description: "Italian partita IVA or numeric codice fiscale (11 digits, optional IT prefix)" } }, required: ["id"] },
  output: { example: COUNTERPARTY_EXAMPLE } };

// Bazaar discovery declaration for GET /v1/pa (also used by the plain-data 402 in fast-paths.js).
export const PA_DISCOVERY = { method: "GET",
  input: { cf: "80016350821" },
  inputSchema: { properties: { cf: { type: "string", pattern: "^[0-9]{11}$", description: "11-digit codice fiscale of the Italian public entity" } }, required: ["cf"] },
  output: { example: PA_EXAMPLE } };

export function buildX402(env = {}, log = null) {
  const network = netOf(env), payTo = payToOf(env);
  // CDP facilitator (mainnet) when keys are present; otherwise x402.org testnet facilitator.
  let facCfg = { url: env.FACILITATOR_URL || "https://x402.org/facilitator" };
  if (env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) {
    const base = createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET);
    // CDP JWTs (3 signatures per call) cost CPU; reuse them for 60s (they expire after 120s). Plain data only.
    facCfg = { url: base.url, createAuthHeaders: async () => {
      if (authCache && Date.now() - authCache.t < 60_000) return authCache.v;
      const v = await base.createAuthHeaders();
      authCache = { v, t: Date.now() };
      return v;
    } };
  }
  const facilitator = new CachedFacilitatorClient(facCfg);
  const server = logPayment(new x402ResourceServer(facilitator).register(network, new ExactEvmScheme()), log);

  return { network, payTo, server };
}

export function createApp(env = {}, log = null) {
  const network = netOf(env), payTo = payToOf(env);
  const vatOn = env.ENABLE_VAT === "1"; // VIES off by default pending legal review
  const app = new Hono();

  app.get("/", c => c.json({
    name: "ItalyCheck", about: vatOn ? "Pay-per-call supplier verification for AI agents (EU VAT via VIES, Italian PA via IndicePA). Payment: x402, USDC or EURC on Base." : "Pay-per-call verification of Italian public administrations for AI agents (IndicePA). Payment: x402, USDC or EURC on Base.",
    endpoints: [
      { path: "/v1/pa", method: "GET", price: env.PRICE_PA || "$0.005", network, payment: "x402 exact, USDC or EURC (same nominal amount)", charged: "every paid lookup (always 200): found, not_found, malformed cf (status error) and IndicePA unreachable (status error); validate the 11-digit cf first (free: /v1/vat/format)", description: DESCRIPTIONS.pa },
      { path: "/v1/counterparty", method: "GET", price: priceCounterparty(env), network, payment: "x402 exact, USDC or EURC (same nominal amount)", charged: "only on 200; not on 400 malformed input, 422 wrong check digit, 502 IndicePA unreachable", description: DESCRIPTIONS.counterparty },
      { path: "/mcp", method: "POST", price: "per tool (x402 over MCP)", description: "Remote MCP server (Streamable HTTP, stateless). Tools lookup_italian_pa and verify_italian_counterparty are paid via x402 MCP payments; check_partita_iva_format is free." },
      { path: "/v1/vat/format", method: "GET", price: "free", description: "Offline Italian partita IVA format/checksum check, no external call." },
      ...(vatOn ? [{ path: "/v1/vat", price: env.PRICE_VAT || "$0.01", description: DESCRIPTIONS.vat }] : []),
    ],
    license: { source: "IndicePA - Indice dei domicili digitali della Pubblica Amministrazione", publisher: "AgID - Agenzia per l'Italia Digitale", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", sourceUrl: "https://indicepa.gov.it/ipa-dati/dataset/enti", sourceUrls: ["https://indicepa.gov.it/ipa-dati/dataset/enti", "https://indicepa.gov.it/ipa-dati/dataset/unita-organizzative-che-ricevono-fatture-elettroniche"], notice: "Data © AgID - IndicePA, CC BY 4.0. Retrieved in real time; not modified except for field selection/renaming. ItalyCheck is not affiliated with or endorsed by AgID." },
  }));

  app.get("/v1/vat/format", c => {
    const p = parseVat(c.req.query("vat"));
    return c.json({ ...p, checksumOk: p.countryCode === "IT" ? itChecksum(p.vatNumber) : null });
  });

  if (env.DISABLE_PAYMENTS !== "1") {
    // x402 server only for apps that charge (the free app never builds it: CPU on cold isolates).
    const { server } = buildX402(env, log);
    server.registerExtension(bazaarResourceServerExtension);
    app.use(paymentMiddleware({
      ...(vatOn ? { "GET /v1/vat": { accepts: [{ scheme: "exact", price: env.PRICE_VAT || "$0.01", network, payTo }], description: DESCRIPTIONS.vat, mimeType: "application/json" } } : {}),
      "GET /v1/pa": { accepts: acceptsFor(env.PRICE_PA || "$0.005", network, payTo, env), description: DESCRIPTIONS.pa, mimeType: "application/json",
        extensions: declareDiscoveryExtension(PA_DISCOVERY) },
      "GET /v1/counterparty": { accepts: acceptsFor(priceCounterparty(env), network, payTo, env), description: DESCRIPTIONS.counterparty, mimeType: "application/json",
        extensions: declareDiscoveryExtension(COUNTERPARTY_DISCOVERY) },
    }, server));
  }

  if (env.FREE_ONLY === "1") return app; // safety: free app never serves paid routes
  if (vatOn) app.get("/v1/vat", async c => c.json(await viesCheck(c.req.query("vat"))));
  // Always 200 -> settled on every paid lookup: found, not_found, malformed cf, IndicePA unreachable (Yeison 24/11/2026 12:09).
  app.get("/v1/pa", async c => c.json(await ipaLookup(c.req.query("cf"))));
  // Non-200 (bad input, wrong check digit, IndicePA down) -> the x402 middleware does not settle: not charged.
  app.get("/v1/counterparty", async c => { const { httpStatus, ...body } = await counterpartyCheck(c.req.query("id")); return c.json(body, httpStatus); });
  return app;
}
