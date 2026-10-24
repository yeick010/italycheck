// MCP server (stdio). Mode A (default): proxies to a deployed ItalyCheck URL; if payment is required it returns the x402 requirements.
// Mode B: ITALYCHECK_LOCAL=1 runs lookups locally (for the operator / testing only).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { viesCheck, ipaLookup } from "./core.js";
import { DESCRIPTIONS } from "./app.js";

const BASE = process.env.ITALYCHECK_URL || "http://localhost:8787";
const LOCAL = process.env.ITALYCHECK_LOCAL === "1";
async function remote(path) {
  const r = await fetch(BASE + path, { headers: process.env.X_PAYMENT ? { "PAYMENT-SIGNATURE": process.env.X_PAYMENT } : {} });
  if (r.status === 402) return { paymentRequired: true, howToPay: "x402: retry with an x402-capable client (e.g. @x402/fetch) and a Base USDC or EURC wallet.", requirements: r.headers.get("payment-required") || (await r.text()) };
  return r.json();
}
const out = o => ({ content: [{ type: "text", text: JSON.stringify(o, null, 2) }] });
const s = new McpServer({ name: "italycheck", version: "0.1.0" });
s.tool("validate_vat", DESCRIPTIONS.vat, { vat: z.string().describe("VAT number, e.g. IT00743110157 or DE811569869") },
  async ({ vat }) => out(LOCAL ? await viesCheck(vat) : await remote(`/v1/vat?vat=${encodeURIComponent(vat)}`)));
s.tool("lookup_italian_pa", DESCRIPTIONS.pa, { cf: z.string().describe("11-digit codice fiscale of the public entity") },
  async ({ cf }) => out(LOCAL ? await ipaLookup(cf) : await remote(`/v1/pa?cf=${encodeURIComponent(cf)}`)));
await s.connect(new StdioServerTransport());
