// Free routes (catalog, offline format check): Hono + plain data only. The Worker serves them from createFreeApp(),
// loaded lazily without the x402 libraries; createApp() in app.js adds the same routes before the payment middleware.
import { Hono } from "hono";
import { itChecksum, parseVat } from "./core.js";
import { DESCRIPTIONS, priceCounterparty } from "./constants.js";

const netOf = env => env.X402_NETWORK || "eip155:8453";

export function addFreeRoutes(app, env = {}) {
  const network = netOf(env);
  const vatOn = env.ENABLE_VAT === "1"; // VIES off by default pending legal review
  app.get("/", c => c.json({
    name: "ItalyCheck", about: vatOn ? "Pay-per-call supplier verification for AI agents (EU VAT via VIES, Italian PA via IndicePA). Payment: x402, USDC or EURC on Base." : "Pay-per-call verification of Italian public administrations for AI agents (IndicePA). Payment: x402, USDC or EURC on Base.",
    endpoints: [
      { path: "/v1/pa", method: "GET", price: env.PRICE_PA || "$0.005", network, payment: "x402 exact, USDC or EURC (same nominal amount)", description: DESCRIPTIONS.pa },
      { path: "/v1/counterparty", method: "GET", price: priceCounterparty(env), network, payment: "x402 exact, USDC or EURC (same nominal amount)", description: DESCRIPTIONS.counterparty },
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
  return app;
}

// Same as createApp({ ...env, DISABLE_PAYMENTS: "1", FREE_ONLY: "1" }) without loading @x402/* (checked in tests).
export const createFreeApp = (env = {}) => addFreeRoutes(new Hono(), env);
