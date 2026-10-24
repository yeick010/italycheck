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

// Payment failures against a mock facilitator (CDP style: HTTP 400 {isValid:false} is thrown as VerifyError).
{
  const http = await import("node:http");
  const { x402Client } = await import("@x402/core/client");
  const { ExactEvmScheme } = await import("@x402/evm");
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const { handleMcp, _resetMcpCache } = await import("../src/remote-mcp.js");
  const worker = (await import("../src/worker.js")).default;
  const NET = "eip155:84532";
  let mode = "verify400";
  const REVERT = { isValid: false, invalidReason: "invalid_payload", invalidMessage: "contract call failed: unable to call contract: execution reverted", payer: "0x0000000000000000000000000000000000000001" };
  const srv = http.createServer((q, s) => {
    const send = (code, o) => { s.writeHead(code, { "content-type": "application/json" }); s.end(JSON.stringify(o)); };
    q.resume(); q.on("end", () => {
      if (q.url.endsWith("/supported")) return send(200, { kinds: [{ x402Version: 2, scheme: "exact", network: NET }], extensions: [], signers: {} });
      if (q.url.endsWith("/verify")) return mode === "verify400" ? send(400, REVERT) : send(200, { isValid: true, payer: REVERT.payer });
      if (q.url.endsWith("/settle")) return mode === "settle400" ? send(400, { success: false, errorReason: "invalid_transaction_state", errorMessage: "execution reverted", transaction: "", network: NET })
        : send(200, { success: true, transaction: "0x" + "ab".repeat(32), network: NET, payer: REVERT.payer });
      send(404, {});
    });
  });
  await new Promise(r => srv.listen(0, r));
  const env = { X402_NETWORK: NET, FACILITATOR_URL: `http://127.0.0.1:${srv.address().port}` };
  const client = new x402Client().register(NET, new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())));
  const rpc = (meta, headers = {}) => new Request("https://italycheck.example/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup_italian_pa", arguments: { cf: "80016350821" }, ...(meta ? { _meta: meta } : {}) } }) });
  _resetMcpCache();
  const pr = (await (await handleMcp(rpc(), env)).json()).result.structuredContent;
  const meta = { "x402/payment": await client.createPaymentPayload(pr) };
  const origErr = console.error; console.error = () => {};

  const v = (await (await handleMcp(rpc(meta), env)).json()).result;
  const ve = v.structuredContent;
  ok("MCP verify 400 -> x402 payment-required result (not Internal Server Error)", v.isError === true && ve?.x402Version === 2 && ve.accepts?.length === 2 && ve.resource?.url?.endsWith("/mcp#lookup_italian_pa")
    && JSON.parse(v.content[0].text).error === ve.error, ve?.error);
  ok("MCP verify 400: readable reason", /^payment verification failed: insufficient funds or invalid authorization \(invalid_payload: .*execution reverted\)$/.test(ve?.error || ""));

  const lines = []; const origLog = console.log; console.log = o => lines.push(o);
  await (await worker.fetch(rpc(meta, { "user-agent": "x".repeat(200) }), env, {})).text();
  console.log = origLog;
  const L = lines.find(o => o?.path === "/mcp") || {};
  ok("request log: mcp_method/tool/payment/ua (clone keeps body for transport)", L.method === "POST" && L.mcp_method === "tools/call" && L.tool === "lookup_italian_pa" && L.has_payment_header === false && L.has_mcp_payment === true
    && L.status === 200 && L.payment === "failed" && /^verify: .*execution reverted/.test(L.payment_reason) && L.ua.length === 80 && !("ip" in L), JSON.stringify(L).slice(0, 200));

  const h402 = await createApp(env).fetch(new Request("https://italycheck.example/v1/pa?cf=80016350821", { headers: { "payment-signature": Buffer.from(JSON.stringify(await client.createPaymentPayload(
    JSON.parse(Buffer.from((await createApp(env).fetch(new Request("https://italycheck.example/v1/pa?cf=80016350821"))).headers.get("payment-required"), "base64").toString())))).toString("base64") } }), env);
  const herr = JSON.parse(Buffer.from(h402.headers.get("payment-required") || "", "base64").toString() || "{}").error;
  ok("HTTP /v1/pa verify 400 -> 402 with facilitator reason (unchanged)", h402.status === 402 && herr === "invalid_payload: contract call failed: unable to call contract: execution reverted", herr);

  mode = "settle400";
  const st = (await (await handleMcp(rpc(meta), env)).json()).result;
  ok("MCP settle 400 -> x402 payment-required result with reason", st.isError === true && st.structuredContent?.accepts?.length === 2 && st.structuredContent.error === "Payment settlement failed: insufficient funds or invalid authorization (invalid_transaction_state: execution reverted)", st.structuredContent?.error);

  mode = "ok";
  const good = (await (await handleMcp(rpc(meta), env)).json()).result;
  ok("MCP paid success path unchanged (tool result + payment-response meta)", !good.isError && JSON.parse(good.content[0].text).status === "found" && good._meta?.["x402/payment-response"]?.success === true);
  console.error = origErr;
  srv.close();
}
