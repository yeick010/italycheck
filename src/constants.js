// Plain data shared by the fast paths (src/fast-paths.js) and the library paths (src/app.js, src/remote-mcp.js).
// No imports on purpose: the Worker entry loads this module eagerly, while the heavy graphs (Hono + x402, MCP SDK
// + zod) are loaded with dynamic import() only when a request needs them (CPU on cold isolates).

export const DESCRIPTIONS = {
  vat: "Validate an EU VAT number (incl. Italian partita IVA) live against the European Commission VIES service. Use when an agent must confirm a supplier or customer is VAT-registered before invoicing, reverse-charge, onboarding or payment. Input: ?vat=IT00743110157 (country prefix optional, defaults to IT). Returns valid/invalid, registered name and address when the member state discloses them. Italian numbers are checksum-validated offline first.",
  pa: "Look up an Italian public administration or public-service operator by 11-digit codice fiscale in IndicePA (AgID). Use when an agent must verify a public-sector counterparty, find its official PEC (certified email) addresses, or confirm it exists before e-invoicing. Input: ?cf=80016350821.",
  counterparty: "Verify an Italian counterparty in one call before invoicing or paying: partita IVA / codice fiscale check digit, IndicePA public-administration record (name, category, institutional PEC, address) and the e-invoicing offices that receive FatturaPA via SDI (codice univoco ufficio, start date, PEC). Returns verdict pa_verificata | formato_valido_non_verificato | formato_non_valido with sources and CC BY 4.0 attribution. Public-administration data only: private companies are not confirmed (no VIES, no company PEC). Malformed input, a wrong check digit or an IndicePA outage are not charged. Input: ?id=80016350821.",
};
export const PRICE_COUNTERPARTY_DEFAULT = "$0.01";
export const priceCounterparty = env => env.PRICE_COUNTERPARTY || PRICE_COUNTERPARTY_DEFAULT;

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

// Bazaar discovery declaration for GET /v1/pa (also used by the plain-data 402 in fast-paths.js).
export const PA_DISCOVERY = { method: "GET",
  input: { cf: "80016350821" },
  inputSchema: { properties: { cf: { type: "string", pattern: "^[0-9]{11}$", description: "11-digit codice fiscale of the Italian public entity" } }, required: ["cf"] },
  output: { example: PA_EXAMPLE } };

const COUNTERPARTY_EXAMPLE = { input: "80016350821", id: "80016350821", status: "ok", verdict: "pa_verificata", format: { checksumOk: true },
  pa: { isPublicAdministration: true, entities: [PA_EXAMPLE.entities[0]] },
  pa_einvoice: { offices: [{ codiceUnivocoUfficio: "0WEP9F", name: "Coord.to Interventi COIME - Direzione Amministrativa", codiceIPA: "c_g273", codiceFiscaleSfe: "80016350821", einvoiceSince: "2015-03-31", peppol: null, address: "Largo Carlo Traina 1 Villa Forni 90129", pec: [] }], total: 78, truncated: false },
  vies: { status: "disabled" }, attribution: "Data © AgID - IndicePA, CC BY 4.0" };

// Bazaar discovery declaration for GET /v1/counterparty (also used by the plain-data 402 in fast-paths.js).
export const COUNTERPARTY_DISCOVERY = { method: "GET",
  input: { id: "80016350821" },
  inputSchema: { properties: { id: { type: "string", pattern: "^(IT)?[0-9]{11}$", description: "Italian partita IVA or numeric codice fiscale (11 digits, optional IT prefix)" } }, required: ["id"] },
  output: { example: COUNTERPARTY_EXAMPLE } };

// MCP protocol versions as in @modelcontextprotocol/sdk/types.js (checked equal in test/fast-paths.js), so the
// MCP fast path does not load the SDK (its types module builds hundreds of zod schemas at import time).
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
export const MCP_LATEST_PROTOCOL_VERSION = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];
