import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { itChecksum } from "../src/core.js";
import { createApp, acceptsFor } from "../src/app.js";
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
ok("x402: USDC first, EURC second", req?.accepts?.length === 2 && req.accepts[0].extra?.name === "USDC" && req.accepts[1].asset === "0x808456652fdb597867f38412077A9182bf77359F" && req.accepts[1].amount === "5000" && req.accepts[1].extra?.name === "EURC" && req.accepts[1].extra?.version === "2", req ? JSON.stringify(req.accepts?.[1]) : "");
{ const a = acceptsFor("$0.005", "eip155:8453", "0xde8380854ef9c926093832501d95a47f4c63fe7c");
  ok("x402 mainnet accepts: USDC + EURC (Base)", a.length === 2 && a[0].price === "$0.005" && a[1].price.asset === "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" && a[1].price.amount === "5000", JSON.stringify(a[1].price)); }

const t = new StdioClientTransport({ command: "node", args: ["src/mcp.js"], env: { ...process.env, ITALYCHECK_LOCAL: "1" } });
const c = new Client({ name: "t", version: "1" }); await c.connect(t);
const tools = await c.listTools(); ok("MCP lists tools", tools.tools.length === 2, tools.tools.map(x => x.name).join(","));
const res = await c.callTool({ name: "validate_vat", arguments: { vat: "IT00743110157" } });
ok("MCP validate_vat (live)", JSON.parse(res.content[0].text).valid === true);
await c.close();
const { validateBazaarRouteExtensions } = await import("@x402/extensions/bazaar");
try { validateBazaarRouteExtensions(createApp.__routes ?? {}); ok("bazaar validator available", true); } catch (e) { ok("bazaar validator available", false, e.message); }

// Cached unpaid 402 (worker.js) and cached MCP payment-required result (remote-mcp.js) must equal a fresh build.
{
  const { paidRoute, unpaid402 } = await import("../src/worker.js");
  const { handleMcp, mcpUnpaid, _resetMcpCache } = await import("../src/remote-mcp.js");
  const { PlainCache } = await import("../src/cache.js");
  const env = { X402_NETWORK: "eip155:84532" };
  const U = "https://italycheck.example/v1/pa?cf=80016350821";
  const snap = async r => ({ status: r.status, headers: [...r.headers].filter(([k]) => k !== "date"), body: await r.text() });
  unpaid402.clear();
  const fresh = await snap(await createApp(env).fetch(new Request(U), env));
  const miss = await snap(await paidRoute(new Request(U), env));
  const hit = await snap(await paidRoute(new Request(U), env));
  ok("402 cache: miss == fresh createApp", JSON.stringify(miss) === JSON.stringify(fresh), `status=${miss.status}`);
  ok("402 cache: hit == miss (status, headers, body)", JSON.stringify(hit) === JSON.stringify(miss) && unpaid402.size === 1);
  const prj = JSON.parse(Buffer.from(new Headers(hit.headers).get("payment-required"), "base64").toString());
  ok("402 cache: resource.url keeps query, bazaar present", prj.resource.url === U && !!prj.extensions?.bazaar && prj.accepts.length === 2);
  await paidRoute(new Request(U.replace("80016350821", "00743110157")), env);
  ok("402 cache: keyed by full URL incl. query", unpaid402.size === 2);
  const b = await paidRoute(new Request(U, { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } }), env);
  ok("402 cache: browser paywall cached separately", unpaid402.size === 3 && (b.headers.get("content-type") || "").includes("text/html"));
  const paidReq = await paidRoute(new Request(U, { headers: { "x-payment": "garbage" } }), env);
  ok("402 cache: requests with a payment header bypass cache", unpaid402.size === 3 && paidReq.status !== 200, `status=${paidReq.status}`);
  const lru = new PlainCache(2, 1000); lru.set("a", 1); lru.set("b", 2); lru.get("a"); lru.set("c", 3);
  ok("PlainCache LRU evicts least recently used", lru.get("b") === undefined && lru.get("a") === 1 && lru.get("c") === 3 && lru.size === 2);

  const rpc = body => new Request("https://italycheck.example/mcp", { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" } });
  const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup_italian_pa", arguments: { cf: "80016350821" } } };
  _resetMcpCache();
  const c1 = await (await handleMcp(rpc(call), env)).text();
  const c2 = await (await handleMcp(rpc(call), env)).text();
  const l1 = await (await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), env)).json();
  const pr1 = JSON.parse(c1).result?.structuredContent;
  ok("MCP unpaid tools/call: cache hit == miss", c1 === c2 && mcpUnpaid.size === 1 && pr1?.accepts?.length === 2 && pr1.accepts[0].extra?.name === "USDC" && pr1.accepts[1].extra?.name === "EURC", `accepts=${pr1?.accepts?.length}`);
  ok("MCP tools/list has both tools", l1.result?.tools?.map(x => x.name).join(",") === "check_partita_iva_format,lookup_italian_pa");
}
