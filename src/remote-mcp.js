// Remote MCP endpoint (Streamable HTTP, stateless) for the Worker: POST /mcp.
// lookup_italian_pa and verify_italian_counterparty are paid with x402 MCP payments (@x402/mcp);
// check_partita_iva_format is free. The x402 server is built only when a paid tool is actually called with a payment. tools/list and
// unpaid tools/call use plain data cached at module scope (accepts array, payment-required result).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPaymentWrapper, extractPaymentFromMeta } from "@x402/mcp";
import { z } from "zod";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildX402, acceptsFor, DESCRIPTIONS, priceCounterparty } from "./app.js";
import { ipaLookup, itChecksum, parseVat, counterpartyCheck } from "./core.js";
import { PlainCache } from "./cache.js";
import { readableMcpFailures } from "./payments.js";
import { fastMcp, MCP_SERVER_INFO, TOOL_FORMAT, paToolDescription, PA_ARG_DESCRIPTION,
  COUNTERPARTY_TOOL, counterpartyToolDescription, COUNTERPARTY_ARG_DESCRIPTION } from "./fast-paths.js";

const out = o => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const TTL = 3600_000;
const acceptsCache = new Map(); // price key -> { v, t }
export const mcpUnpaid = new PlainCache(50, TTL); // resource URL -> payment-required tool result
export const _resetMcpCache = () => { acceptsCache.clear(); mcpUnpaid.clear(); };

async function getAccepts(env, network, payTo, server, price) {
  const k = `${network}|${payTo}|${price}|${env.DISABLE_EURC || ""}`;
  const c = acceptsCache.get(k);
  if (c && Date.now() - c.t < TTL) return structuredClone(c.v);
  const v = (await Promise.all(acceptsFor(price, network, payTo, env)
    .map(o => server.buildPaymentRequirements(o)))).flat(); // USDC first, then EURC
  acceptsCache.set(k, { v: structuredClone(v), t: Date.now() });
  return v;
}

// Registers one x402-paid tool. Unpaid calls are answered from the cached payment-required result (plain data).
function paidTool(mcp, req, env, log, { name, description, price, argName, argDescription, resourceDescription, tags, handler }) {
  const resource = { url: new URL("/mcp#" + name, req.url).toString(), description: resourceDescription,
    mimeType: "application/json", serviceName: "ItalyCheck", tags };
  mcp.tool(name, description, { [argName]: z.string().describe(argDescription) },
    async (args, extra) => {
      const unpaid = !extractPaymentFromMeta({ _meta: extra?._meta });
      if (unpaid) { const hit = mcpUnpaid.get(resource.url); if (hit) return structuredClone(hit); }
      const { network, payTo, server } = buildX402(env, log);
      readableMcpFailures(server); // thrown verify/settle errors -> x402 payment-required result, not "Internal Server Error"
      await server.initialize();
      const accepts = await getAccepts(env, network, payTo, server, price);
      const res = await createPaymentWrapper(server, { accepts, resource })(handler)(args, extra);
      // Cached in the SDK's own key order (content, structuredContent, isError) so the fast path returns the same bytes.
      if (unpaid && res?.isError && res.structuredContent?.x402Version) mcpUnpaid.set(resource.url, CallToolResultSchema.parse(structuredClone(res)));
      return res;
    });
}

// msg: the parsed JSON-RPC body when the caller already has it (worker.js). Common methods are answered as plain
// data (fast-paths.js); everything else goes through the SDK below. Pass msg = undefined to force the SDK path.
export async function handleMcp(req, env, log = null, msg = undefined) {
  if (msg !== undefined) {
    const fast = fastMcp(req, msg, env, url => { const hit = mcpUnpaid.get(url); return hit && structuredClone(hit); });
    if (fast) { if (log) log.mcp_fast = true; return fast; }
  }
  const mcp = new McpServer({ ...MCP_SERVER_INFO });
  mcp.tool(TOOL_FORMAT.name, TOOL_FORMAT.description,
    { [TOOL_FORMAT.arg]: z.string().describe(TOOL_FORMAT.argDescription) },
    async ({ piva }) => { const p = parseVat(piva); return out({ ...p, checksumOk: p.countryCode === "IT" ? itChecksum(p.vatNumber) : null }); });

  if (req.method === "POST") {
    paidTool(mcp, req, env, log, { name: "lookup_italian_pa", description: paToolDescription(env), price: env.PRICE_PA || "$0.005",
      argName: "cf", argDescription: PA_ARG_DESCRIPTION, resourceDescription: DESCRIPTIONS.pa.replace(" Input: ?cf=80016350821.", ""),
      tags: ["italy", "public-administration", "pec", "kyb", "e-invoicing"], handler: async ({ cf }) => out(await ipaLookup(cf)) });
    // isError (bad input, wrong check digit, IndicePA down) -> @x402/mcp cancels settlement: not charged.
    paidTool(mcp, req, env, log, { name: COUNTERPARTY_TOOL, description: counterpartyToolDescription(env), price: priceCounterparty(env),
      argName: "id", argDescription: COUNTERPARTY_ARG_DESCRIPTION, resourceDescription: DESCRIPTIONS.counterparty.replace(" Input: ?id=80016350821.", ""),
      tags: ["italy", "public-administration", "kyb", "counterparty", "e-invoicing", "sdi"],
      handler: async ({ id }) => { const { httpStatus, ...r } = await counterpartyCheck(id); return httpStatus === 200 ? out(r) : { ...out(r), isError: true }; } });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  return transport.handleRequest(req);
}
