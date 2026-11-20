// Loaded lazily by src/worker.js (dynamic import): Hono + x402 are only evaluated when a request needs them.
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { viesCheck, ipaLookup } from "./core.js";
import { addFreeRoutes } from "./free-app.js";
import { logPayment } from "./payments.js";
import { DESCRIPTIONS, EURC, PA_DISCOVERY, acceptsFor } from "./constants.js";
export { DESCRIPTIONS, EURC, PA_DISCOVERY, acceptsFor }; // moved to constants.js (no imports); re-exported for callers

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

const netOf = env => env.X402_NETWORK || "eip155:8453"; // Base mainnet; testnet = eip155:84532
const payToOf = env => env.PAY_TO || "0xde8380854ef9c926093832501d95a47f4c63fe7c"; // Yeison's Base wallet

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

  addFreeRoutes(app, env); // GET /, GET /v1/vat/format (src/free-app.js)

  if (env.DISABLE_PAYMENTS !== "1") {
    // x402 server only for apps that charge (the free app never builds it: CPU on cold isolates).
    const { server } = buildX402(env, log);
    server.registerExtension(bazaarResourceServerExtension);
    app.use(paymentMiddleware({
      ...(vatOn ? { "GET /v1/vat": { accepts: [{ scheme: "exact", price: env.PRICE_VAT || "$0.01", network, payTo }], description: DESCRIPTIONS.vat, mimeType: "application/json" } } : {}),
      "GET /v1/pa": { accepts: acceptsFor(env.PRICE_PA || "$0.005", network, payTo, env), description: DESCRIPTIONS.pa, mimeType: "application/json",
        extensions: declareDiscoveryExtension(PA_DISCOVERY) },
    }, server));
  }

  if (env.FREE_ONLY === "1") return app; // safety: free app never serves paid routes
  if (vatOn) app.get("/v1/vat", async c => c.json(await viesCheck(c.req.query("vat"))));
  app.get("/v1/pa", async c => c.json(await ipaLookup(c.req.query("cf"))));
  return app;
}
