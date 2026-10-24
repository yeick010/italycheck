import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { viesCheck, ipaLookup, itChecksum, parseVat } from "./core.js";

export const DESCRIPTIONS = {
  vat: "Validate an EU VAT number (incl. Italian partita IVA) live against the European Commission VIES service. Use when an agent must confirm a supplier or customer is VAT-registered before invoicing, reverse-charge, onboarding or payment. Input: ?vat=IT00743110157 (country prefix optional, defaults to IT). Returns valid/invalid, registered name and address when the member state discloses them. Italian numbers are checksum-validated offline first.",
  pa: "Look up an Italian public administration or public-service operator by 11-digit codice fiscale in IndicePA (AgID). Use when an agent must verify a public-sector counterparty, find its official PEC (certified email) addresses, or confirm it exists before e-invoicing. Input: ?cf=80016350821.",
};

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
const EURC = {
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

export function buildX402(env = {}) {
  const network = env.X402_NETWORK || "eip155:8453"; // Base mainnet; testnet = eip155:84532
  const payTo = env.PAY_TO || "0xde8380854ef9c926093832501d95a47f4c63fe7c"; // Yeison's Base wallet
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
  const server = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());

  return { network, payTo, server };
}

export function createApp(env = {}) {
  const { network, payTo, server } = buildX402(env);
  server.registerExtension(bazaarResourceServerExtension);
  const vatOn = env.ENABLE_VAT === "1"; // VIES off by default pending legal review
  const app = new Hono();

  app.get("/", c => c.json({
    name: "ItalyCheck", about: vatOn ? "Pay-per-call supplier verification for AI agents (EU VAT via VIES, Italian PA via IndicePA). Payment: x402, USDC or EURC on Base." : "Pay-per-call verification of Italian public administrations for AI agents (IndicePA). Payment: x402, USDC or EURC on Base.",
    endpoints: [
      { path: "/v1/pa", method: "GET", price: env.PRICE_PA || "$0.005", network, payment: "x402 exact, USDC or EURC (same nominal amount)", description: DESCRIPTIONS.pa },
      { path: "/mcp", method: "POST", price: "per tool (x402 over MCP)", description: "Remote MCP server (Streamable HTTP, stateless). Tool lookup_italian_pa is paid via x402 MCP payments; check_partita_iva_format is free." },
      { path: "/v1/vat/format", method: "GET", price: "free", description: "Offline Italian partita IVA format/checksum check, no external call." },
      ...(vatOn ? [{ path: "/v1/vat", price: env.PRICE_VAT || "$0.01", description: DESCRIPTIONS.vat }] : []),
    ],
    license: { source: "IndicePA - Indice dei domicili digitali della Pubblica Amministrazione", publisher: "AgID - Agenzia per l'Italia Digitale", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", sourceUrl: "https://indicepa.gov.it/ipa-dati/dataset/enti", notice: "Data © AgID - IndicePA, CC BY 4.0. Retrieved in real time; not modified except for field selection/renaming. ItalyCheck is not affiliated with or endorsed by AgID." },
  }));

  app.get("/v1/vat/format", c => {
    const p = parseVat(c.req.query("vat"));
    return c.json({ ...p, checksumOk: p.countryCode === "IT" ? itChecksum(p.vatNumber) : null });
  });

  if (env.DISABLE_PAYMENTS !== "1") {
    app.use(paymentMiddleware({
      ...(vatOn ? { "GET /v1/vat": { accepts: [{ scheme: "exact", price: env.PRICE_VAT || "$0.01", network, payTo }], description: DESCRIPTIONS.vat, mimeType: "application/json" } } : {}),
      "GET /v1/pa": { accepts: acceptsFor(env.PRICE_PA || "$0.005", network, payTo, env), description: DESCRIPTIONS.pa, mimeType: "application/json",
        extensions: declareDiscoveryExtension({ method: "GET",
          input: { cf: "80016350821" },
          inputSchema: { properties: { cf: { type: "string", pattern: "^[0-9]{11}$", description: "11-digit codice fiscale of the Italian public entity" } }, required: ["cf"] },
          output: { example: PA_EXAMPLE } }) },
    }, server));
  }

  if (env.FREE_ONLY === "1") return app; // safety: free app never serves paid routes
  if (vatOn) app.get("/v1/vat", async c => c.json(await viesCheck(c.req.query("vat"))));
  app.get("/v1/pa", async c => c.json(await ipaLookup(c.req.query("cf"))));
  return app;
}
