// Remote MCP endpoint (Streamable HTTP, stateless) for the Worker: POST /mcp.
// lookup_italian_pa is paid with x402 MCP payments (@x402/mcp); check_partita_iva_format is free.
// The x402 server is built only when lookup_italian_pa is actually called with a payment. tools/list and
// unpaid tools/call use plain data cached at module scope (accepts array, payment-required result).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPaymentWrapper, extractPaymentFromMeta } from "@x402/mcp";
import { z } from "zod";
import { buildX402, acceptsFor, DESCRIPTIONS } from "./app.js";
import { ipaLookup, itChecksum, parseVat } from "./core.js";
import { PlainCache } from "./cache.js";
import { readableMcpFailures } from "./payments.js";
import { fastMcp, MCP_SERVER_INFO, TOOL_FORMAT, paToolDescription, PA_ARG_DESCRIPTION } from "./fast-paths.js";

const out = o => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const TTL = 3600_000;
let acceptsCache = null; // { v, t, k }
export const mcpUnpaid = new PlainCache(50, TTL); // resource URL -> payment-required tool result
export const _resetMcpCache = () => { acceptsCache = null; mcpUnpaid.clear(); };

async function getAccepts(env, network, payTo, server) {
  const price = env.PRICE_PA || "$0.005";
  const k = `${network}|${payTo}|${price}|${env.DISABLE_EURC || ""}`;
  if (acceptsCache && acceptsCache.k === k && Date.now() - acceptsCache.t < TTL) return structuredClone(acceptsCache.v);
  const v = (await Promise.all(acceptsFor(price, network, payTo, env)
    .map(o => server.buildPaymentRequirements(o)))).flat(); // USDC first, then EURC
  acceptsCache = { v: structuredClone(v), t: Date.now(), k };
  return v;
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
    const resource = { url: new URL("/mcp#lookup_italian_pa", req.url).toString(), description: DESCRIPTIONS.pa.replace(" Input: ?cf=80016350821.", ""),
      mimeType: "application/json", serviceName: "ItalyCheck", tags: ["italy", "public-administration", "pec", "kyb", "e-invoicing"] };
    const handler = async ({ cf }) => out(await ipaLookup(cf));
    mcp.tool("lookup_italian_pa", paToolDescription(env),
      { cf: z.string().describe(PA_ARG_DESCRIPTION) },
      async (args, extra) => {
        const unpaid = !extractPaymentFromMeta({ _meta: extra?._meta });
        if (unpaid) { const hit = mcpUnpaid.get(resource.url); if (hit) return structuredClone(hit); }
        const { network, payTo, server } = buildX402(env, log);
        readableMcpFailures(server); // thrown verify/settle errors -> x402 payment-required result, not "Internal Server Error"
        await server.initialize();
        const accepts = await getAccepts(env, network, payTo, server);
        const res = await createPaymentWrapper(server, { accepts, resource })(handler)(args, extra);
        if (unpaid && res?.isError && res.structuredContent?.x402Version) mcpUnpaid.set(resource.url, structuredClone(res));
        return res;
      });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  return transport.handleRequest(req);
}
