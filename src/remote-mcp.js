// Remote MCP endpoint (Streamable HTTP, stateless) for the Worker: POST /mcp.
// lookup_italian_pa is paid with x402 MCP payments (@x402/mcp); check_partita_iva_format is free.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPaymentWrapper } from "@x402/mcp";
import { z } from "zod";
import { buildX402, DESCRIPTIONS } from "./app.js";
import { ipaLookup, itChecksum, parseVat } from "./core.js";

const out = o => ({ content: [{ type: "text", text: JSON.stringify(o) }] });

export async function handleMcp(req, env) {
  const mcp = new McpServer({ name: "italycheck", version: "0.2.0" });
  mcp.tool("check_partita_iva_format", "Free offline check of an Italian partita IVA (11 digits + check digit). Does not confirm registration.",
    { piva: z.string().describe("Italian partita IVA, e.g. 00743110157") },
    async ({ piva }) => { const p = parseVat(piva); return out({ ...p, checksumOk: p.countryCode === "IT" ? itChecksum(p.vatNumber) : null }); });

  if (req.method === "POST") {
    // Payment requirements are only needed for tool calls; tools/list stays cheap.
    const { network, payTo, server } = buildX402(env);
    await server.initialize();
    const accepts = await server.buildPaymentRequirements({ scheme: "exact", network, payTo, price: env.PRICE_PA || "$0.005" });
    const paid = createPaymentWrapper(server, { accepts, resource: {
      url: new URL("/mcp#lookup_italian_pa", req.url).toString(), description: DESCRIPTIONS.pa.replace(" Input: ?cf=80016350821.", ""),
      mimeType: "application/json", serviceName: "ItalyCheck", tags: ["italy", "public-administration", "pec", "kyb", "e-invoicing"] } });
    mcp.tool("lookup_italian_pa", DESCRIPTIONS.pa.replace(" Input: ?cf=80016350821.", "") + ` Costs ${env.PRICE_PA || "$0.005"} in USDC on Base via x402.`,
      { cf: z.string().describe("11-digit codice fiscale, e.g. 80016350821") },
      paid(async ({ cf }) => out(await ipaLookup(cf))));
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  return transport.handleRequest(req);
}
