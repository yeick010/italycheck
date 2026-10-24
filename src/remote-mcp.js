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

export async function handleMcp(req, env, log = null) {
  const mcp = new McpServer({ name: "italycheck", version: "0.2.0" });
  mcp.tool("check_partita_iva_format", "Free offline check of an Italian partita IVA (11 digits + check digit). Does not confirm registration.",
    { piva: z.string().describe("Italian partita IVA, e.g. 00743110157") },
    async ({ piva }) => { const p = parseVat(piva); return out({ ...p, checksumOk: p.countryCode === "IT" ? itChecksum(p.vatNumber) : null }); });

  if (req.method === "POST") {
    const resource = { url: new URL("/mcp#lookup_italian_pa", req.url).toString(), description: DESCRIPTIONS.pa.replace(" Input: ?cf=80016350821.", ""),
      mimeType: "application/json", serviceName: "ItalyCheck", tags: ["italy", "public-administration", "pec", "kyb", "e-invoicing"] };
    const handler = async ({ cf }) => out(await ipaLookup(cf));
    mcp.tool("lookup_italian_pa", DESCRIPTIONS.pa.replace(" Input: ?cf=80016350821.", "") + ` Costs ${env.PRICE_PA || "$0.005"} in USDC (or ${(env.PRICE_PA || "$0.005").replace("$", "")} EURC) on Base via x402.`,
      { cf: z.string().describe("11-digit codice fiscale, e.g. 80016350821") },
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
