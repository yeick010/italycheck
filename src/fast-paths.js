// CPU fast paths for the two most common request kinds on the Free plan (10 ms CPU):
//  1. unpaid GET /v1/pa and /v1/counterparty (JSON 402): built from plain data, no Hono app, no x402 server, no facilitator call.
//  2. MCP handshake/discovery (initialize, notifications/initialized, ping, tools/list) and cached unpaid
//     tools/call: answered as plain JSON-RPC without constructing McpServer + zod + transport.
// Both are byte-for-byte checked against the library output in test/run.js; anything unusual (other networks,
// odd prices, browsers, batches, bad headers, unknown methods) returns null and takes the normal library path.
// No library imports: this module is loaded eagerly by the Worker entry, while @x402/*, Hono, the MCP SDK and zod are
// loaded with dynamic import() only on the library path. The few library pieces reproduced here (base64 header
// encoding, MCP protocol versions, the Bazaar declarations) are checked against the libraries in tests.
import { DESCRIPTIONS, EURC, PA_DISCOVERY, COUNTERPARTY_DISCOVERY, priceCounterparty,
  MCP_SUPPORTED_PROTOCOL_VERSIONS as SUPPORTED_PROTOCOL_VERSIONS, MCP_LATEST_PROTOCOL_VERSION as LATEST_PROTOCOL_VERSION } from "./constants.js";
import { PlainCache } from "./cache.js";

export const mcpUnpaid = new PlainCache(50, 3600_000); // resource URL -> payment-required tool result (filled by remote-mcp.js)

// As @x402/core/http: PAYMENT_REQUIRED_CACHE_CONTROL and encodePaymentRequiredHeader (UTF-8 JSON -> base64).
const PAYMENT_REQUIRED_CACHE_CONTROL = "no-store";
export function encodePaymentRequiredHeader(pr) {
  const bytes = new TextEncoder().encode(JSON.stringify(pr));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// What declareDiscoveryExtension(d) + bazaarResourceServerExtension.enrichDeclaration(..., { method: d.method }) return
// (@x402/extensions/bazaar) for a GET query-param route; deep-equal checked in test/fast-paths.js.
export function bazaarExtensions(d) {
  return { bazaar: {
    info: { input: { type: "http", method: d.method, queryParams: d.input }, output: { type: "json", example: d.output.example } },
    schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
      properties: {
        input: { type: "object",
          properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: [d.method] },
            queryParams: { type: "object", ...d.inputSchema } },
          required: ["type", "method"], additionalProperties: false },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
      },
      required: ["input"] } } };
}

// USDC per network as in @x402/evm DEFAULT_ASSETS (name/version = EIP-712 domain).
const USDC = {
  "eip155:8453": { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" },
  "eip155:84532": { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2" },
};
// "$0.005" -> "5000" (6 decimals) with string math; anything else -> null (library path).
export function usdAtomic(price) {
  const m = /^\$(\d+)(?:\.(\d{1,6}))?$/.exec(String(price));
  if (!m) return null;
  return String(BigInt(m[1] + (m[2] || "").padEnd(6, "0")));
}

// Paid GET routes served by the fast 402: path -> price (env), Bazaar declaration, description.
const ROUTES = {
  "/v1/pa": { price: env => env.PRICE_PA || "$0.005", discovery: PA_DISCOVERY, description: DESCRIPTIONS.pa },
  "/v1/counterparty": { price: priceCounterparty, discovery: COUNTERPARTY_DISCOVERY, description: DESCRIPTIONS.counterparty },
};
const tpl402 = {}; // path -> { k, v } (v = object without resource.url)
function route402Template(path, env) {
  const r = ROUTES[path];
  const network = env.X402_NETWORK || "eip155:8453";
  const payTo = env.PAY_TO || "0xde8380854ef9c926093832501d95a47f4c63fe7c";
  const price = r.price(env);
  const k = `${network}|${payTo}|${price}|${env.DISABLE_EURC || ""}`;
  if (tpl402[path]?.k === k) return tpl402[path].v;
  const usdc = USDC[network], amount = usdAtomic(price);
  if (!usdc || !amount) return null;
  const opt = (asset, name, version) => ({ scheme: "exact", network, amount, asset, payTo, maxTimeoutSeconds: 300, extra: { name, version } });
  const accepts = [opt(usdc.asset, usdc.name, usdc.version)];
  if (EURC[network] && env.DISABLE_EURC !== "1") accepts.push(opt(EURC[network], "EURC", "2"));
  const extensions = bazaarExtensions(r.discovery); // = middleware: declaration narrowed by the Bazaar server extension to GET
  const v = { description: r.description, accepts, extensions };
  tpl402[path] = { k, v };
  return v;
}

// Plain-data 402 entry { status, headers, body } for an unpaid JSON GET to a paid route, or null for the library path.
export function fastUnpaid402(url, env) {
  if (env.ENABLE_VAT === "1" || env.DISABLE_PAYMENTS === "1") return null;
  const path = new URL(url).pathname;
  if (!Object.hasOwn(ROUTES, path)) return null;
  const t = route402Template(path, env);
  if (!t) return null;
  const pr = { x402Version: 2, error: "Payment required", resource: { url, description: t.description, mimeType: "application/json" },
    accepts: t.accepts, extensions: t.extensions };
  return { status: 402, body: "{}", headers: [["cache-control", PAYMENT_REQUIRED_CACHE_CONTROL], ["content-type", "application/json"],
    ["payment-required", encodePaymentRequiredHeader(pr)]] };
}

// ───────────── MCP ─────────────
export const MCP_SERVER_INFO = { name: "italycheck", version: "0.2.0" };
export const TOOL_FORMAT = { name: "check_partita_iva_format",
  description: "Free offline check of an Italian partita IVA (11 digits + check digit). Does not confirm registration.",
  arg: "piva", argDescription: "Italian partita IVA, e.g. 00743110157" };
export const paToolDescription = env => DESCRIPTIONS.pa.replace(" Input: ?cf=80016350821.", "") +
  ` Costs ${env.PRICE_PA || "$0.005"} in USDC (or ${(env.PRICE_PA || "$0.005").replace("$", "")} EURC) on Base via x402.`;
export const PA_ARG_DESCRIPTION = "11-digit codice fiscale, e.g. 80016350821";
export const COUNTERPARTY_TOOL = "verify_italian_counterparty";
export const counterpartyToolDescription = env => DESCRIPTIONS.counterparty.replace(" Input: ?id=80016350821.", "") +
  ` Costs ${priceCounterparty(env)} in USDC (or ${priceCounterparty(env).replace("$", "")} EURC) on Base via x402.`;
export const COUNTERPARTY_ARG_DESCRIPTION = "Italian partita IVA or numeric codice fiscale (11 digits, optional IT prefix), e.g. 80016350821";
// Paid MCP tools: name -> argument name (both answered from the cached payment-required result when unpaid).
export const PAID_TOOLS = { lookup_italian_pa: "cf", [COUNTERPARTY_TOOL]: "id" };

const schema = (arg, description) => ({ $schema: "http://json-schema.org/draft-07/schema#", type: "object",
  properties: { [arg]: { type: "string", description } }, required: [arg] });
let toolsCache = null;
function toolsList(env) {
  const d = paToolDescription(env) + "\n" + counterpartyToolDescription(env);
  if (toolsCache?.d === d) return toolsCache.v;
  const v = { tools: [
    { name: TOOL_FORMAT.name, description: TOOL_FORMAT.description, inputSchema: schema(TOOL_FORMAT.arg, TOOL_FORMAT.argDescription), execution: { taskSupport: "forbidden" } },
    { name: "lookup_italian_pa", description: paToolDescription(env), inputSchema: schema("cf", PA_ARG_DESCRIPTION), execution: { taskSupport: "forbidden" } },
    { name: COUNTERPARTY_TOOL, description: counterpartyToolDescription(env), inputSchema: schema("id", COUNTERPARTY_ARG_DESCRIPTION), execution: { taskSupport: "forbidden" } },
  ] };
  toolsCache = { d, v };
  return v;
}

const isObj = o => o !== null && typeof o === "object" && !Array.isArray(o);
const jsonRes = (result, id) => new Response(JSON.stringify({ result, jsonrpc: "2.0", id }), { status: 200, headers: { "content-type": "application/json" } });

// msg = parsed JSON body (worker.js parses it once for the request log). getUnpaid(url) = cached payment-required result.
export function fastMcp(req, msg, env, getUnpaid) {
  if (req.method !== "POST" || !isObj(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return null;
  const accept = req.headers.get("accept") || "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return null;
  if (!(req.headers.get("content-type") || "").includes("application/json")) return null;
  const pv = req.headers.get("mcp-protocol-version");
  if (pv !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(pv)) return null;
  const { method, id, params } = msg;
  if (method === "notifications/initialized" && !("id" in msg) && (params === undefined || isObj(params))) return new Response(null, { status: 202 });
  if (!(typeof id === "string" || (typeof id === "number" && Number.isInteger(id)))) return null;
  const noParams = params === undefined || (isObj(params) && Object.keys(params).length === 0);
  if (method === "ping" && noParams) return jsonRes({}, id);
  if (method === "tools/list" && noParams) return jsonRes(toolsList(env), id);
  if (method === "initialize" && isObj(params) && typeof params.protocolVersion === "string" && isObj(params.capabilities)
      && isObj(params.clientInfo) && typeof params.clientInfo.name === "string" && typeof params.clientInfo.version === "string") {
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : LATEST_PROTOCOL_VERSION;
    return jsonRes({ protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: MCP_SERVER_INFO }, id);
  }
  if (method === "tools/call" && isObj(params) && typeof params.name === "string" && Object.hasOwn(PAID_TOOLS, params.name)
      && isObj(params.arguments) && typeof params.arguments[PAID_TOOLS[params.name]] === "string" && !params._meta) {
    const hit = getUnpaid(new URL("/mcp#" + params.name, req.url).toString());
    if (hit) return jsonRes(hit, id);
  }
  return null;
}
