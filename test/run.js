import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { itChecksum } from "../src/core.js";
import { createApp } from "../src/app.js";
const ok = (n, c, extra = "") => console.log(`${c ? "PASS" : "FAIL"}  ${n} ${extra}`);

ok("checksum valid IT", itChecksum("00743110157"));
ok("checksum invalid IT", !itChecksum("00743110158"));

const free = createApp({ DISABLE_PAYMENTS: "1", ENABLE_VAT: "1" });
const get = async (a, p) => { const r = await a.request(p); return [r.status, await r.json().catch(() => null), r]; };
let [s, j] = await get(free, "/v1/vat?vat=IT00743110157"); ok("VIES IT valid (live)", j.valid === true, `${j.status} ${j.name}`);
[s, j] = await get(free, "/v1/vat?vat=DE811569869"); ok("VIES DE (live)", j.status !== undefined, `${j.status} ${j.name ?? j.error ?? ""}`);
[s, j] = await get(free, "/v1/vat?vat=FR40303265045"); ok("VIES FR (live)", j.status !== undefined, `${j.status} ${j.name ?? j.error ?? ""}`);
[s, j] = await get(free, "/v1/vat?vat=IT12345678901"); ok("IT bad checksum rejected offline", j.reason === "italian_checksum_failed");
[s, j] = await get(free, "/v1/pa?cf=80016350821"); ok("IndicePA Comune di Palermo (live)", j.status === "found", `${j.entities?.[0]?.name} PEC=${j.entities?.[0]?.pec}`);
[s, j] = await get(free, "/v1/pa?cf=00743110157"); ok("IndicePA private company -> not_found", j.status === "not_found");

const paid = createApp({ X402_NETWORK: "eip155:84532" });
const r = await paid.request("/v1/pa?cf=80016350821");
const pr = r.headers.get("payment-required");
let req = null; try { req = JSON.parse(Buffer.from(pr, "base64").toString()); } catch {}
ok("x402: unpaid request -> 402", r.status === 402, `status=${r.status}`);
ok("x402: payment requirements header", !!req, req ? JSON.stringify(req.accepts?.[0]) : String(pr).slice(0, 80));

const t = new StdioClientTransport({ command: "node", args: ["src/mcp.js"], env: { ...process.env, ITALYCHECK_LOCAL: "1" } });
const c = new Client({ name: "t", version: "1" }); await c.connect(t);
const tools = await c.listTools(); ok("MCP lists tools", tools.tools.length === 2, tools.tools.map(x => x.name).join(","));
const res = await c.callTool({ name: "validate_vat", arguments: { vat: "IT00743110157" } });
ok("MCP validate_vat (live)", JSON.parse(res.content[0].text).valid === true);
await c.close();
const { validateBazaarRouteExtensions } = await import("@x402/extensions/bazaar");
try { validateBazaarRouteExtensions(createApp.__routes ?? {}); ok("bazaar validator available", true); } catch (e) { ok("bazaar validator available", false, e.message); }
