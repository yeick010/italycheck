// CPU fast paths for the two most common request kinds on the Free plan (10 ms CPU):
//  1. unpaid GET /v1/pa (JSON 402): built from plain data, no Hono app, no x402 server, no facilitator call.
//  2. MCP handshake/discovery (initialize, notifications/initialized, ping, tools/list) and cached unpaid
//     tools/call: answered as plain JSON-RPC without constructing McpServer + zod + transport.
// Both are byte-for-byte checked against the library output in test/run.js; anything unusual (other networks,
// odd prices, browsers, batches, bad headers, unknown methods) returns null and takes the normal library path.
import { encodePaymentRequiredHeader, PAYMENT_REQUIRED_CACHE_CONTROL } from "@x402/core/http";
import { SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { DESCRIPTIONS, EURC, PA_DISCOVERY } from "./app.js";

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

let pa402 = null; // { k, head: object without resource.url }
function pa402Template(env) {
  const network = env.X402_NETWORK || "eip155:8453";
  const payTo = env.PAY_TO || "0xde8380854ef9c926093832501d95a47f4c63fe7c";
  const price = env.PRICE_PA || "$0.005";
  const k = `${network}|${payTo}|${price}|${env.DISABLE_EURC || ""}`;
  if (pa402?.k === k) return pa402.v;
  const usdc = USDC[network], amount = usdAtomic(price);
  if (!usdc || !amount) return null;
  const opt = (asset, name, version) => ({ scheme: "exact", network, amount, asset, payTo, maxTimeoutSeconds: 300, extra: { name, version } });
  const accepts = [opt(usdc.asset, usdc.name, usdc.version)];
  if (EURC[network] && env.DISABLE_EURC !== "1") accepts.push(opt(EURC[network], "EURC", "2"));
  // Same as the middleware: declaration, then the Bazaar server extension narrows input.method to the request method.
  const decl = declareDiscoveryExtension(PA_DISCOVERY);
  const extensions = { ...decl, bazaar: bazaarResourceServerExtension.enrichDeclaration(decl.bazaar, { method: "GET", adapter: null, path: "/v1/pa" }) };
  const v = { description: DESCRIPTIONS.pa, accepts, extensions };
  pa402 = { k, v };
  return v;
}

// Plain-data 402 entry { status, headers, body } for an unpaid JSON GET /v1/pa, or null for the library path.
export function fastUnpaid402(url, env) {
  if (env.ENABLE_VAT === "1" || env.DISABLE_PAYMENTS === "1" || new URL(url).pathname !== "/v1/pa") return null;
  const t = pa402Template(env);
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

const schema = (arg, description) => ({ $schema: "http://json-schema.org/draft-07/schema#", type: "object",
  properties: { [arg]: { type: "string", description } }, required: [arg] });
let toolsCache = null;
function toolsList(env) {
  const d = paToolDescription(env);
  if (toolsCache?.d === d) return toolsCache.v;
  const v = { tools: [
    { name: TOOL_FORMAT.name, description: TOOL_FORMAT.description, inputSchema: schema(TOOL_FORMAT.arg, TOOL_FORMAT.argDescription), execution: { taskSupport: "forbidden" } },
    { name: "lookup_italian_pa", description: d, inputSchema: schema("cf", PA_ARG_DESCRIPTION), execution: { taskSupport: "forbidden" } },
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
  if (method === "tools/call" && isObj(params) && params.name === "lookup_italian_pa" && isObj(params.arguments)
      && typeof params.arguments.cf === "string" && !params._meta) {
    const hit = getUnpaid(new URL("/mcp#lookup_italian_pa", req.url).toString());
    if (hit) return jsonRes(hit, id);
  }
  return null;
}
