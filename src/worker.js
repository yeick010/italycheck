// Cloudflare Workers entry (Free plan: 100k req/day, 10ms CPU).
// Paid routes: a fresh app per request. Sharing an app with payment middleware (and its in-flight promises)
// across requests made some requests hang on Workers (tested). Expensive pieces are cached as plain data in
// app.js (facilitator "supported", CDP JWT auth headers).
// Unpaid requests to paid routes (no PAYMENT-SIGNATURE / X-PAYMENT header) get a cached 402 (plain data:
// status, headers, body text) keyed by full URL; built once per URL via the normal middleware path.
// Free routes (catalog, format check) use one app per isolate WITHOUT payment middleware: no shared I/O.
import { createApp } from "./app.js";
import { handleMcp } from "./remote-mcp.js";
import { PlainCache } from "./cache.js";
import { fastUnpaid402, NO_BODY, BAD_JSON } from "./fast-paths.js";
const PAID = /^\/v1\/(pa|vat|counterparty)(\/?$)/;
let freeApp = null;
export const unpaid402 = new PlainCache(500, 3600_000);

// Same browser test as @x402/core (HTML paywall vs JSON 402), so it is part of the cache key.
const isBrowser = req => (req.headers.get("accept") || "").includes("text/html") && (req.headers.get("user-agent") || "").includes("Mozilla");
const hasPayment = req => req.headers.has("payment-signature") || req.headers.has("x-payment");
const toResponse = e => new Response(e.body, { status: e.status, headers: e.headers });

// Hono's 404 for methods the paid routes don't serve (POST /v1/pa ...): no app or x402 server needed (byte-checked in tests).
const notFound = () => new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain; charset=UTF-8" } });

// HEAD to a paid route (approved by Yeison 20/11/2026 22:24): always the unpaid JSON GET 402 (same status and headers,
// incl. PAYMENT-REQUIRED), no body. Never runs the lookup or a settlement, even with a payment header (HEAD carries no data).
// Before this, HEAD fell through to the app: 200 without payment and a full IndicePA lookup.
async function headPaid(req, env, ctx, log) {
  if (log) log.head_402 = true;
  const key = "j " + req.url;
  let e = unpaid402.get(key);
  if (!e) { e = fastUnpaid402(req.url, env); if (e) { if (log) log.fast_402 = true; unpaid402.set(key, e); } }
  if (!e) { // library path (non-default configs): the GET it stands for, without payment headers, body dropped
    const h = new Headers(req.headers); h.delete("payment-signature"); h.delete("x-payment"); h.set("accept", "application/json");
    const res = await createApp(env).fetch(new Request(req.url, { method: "GET", headers: h }), env, ctx);
    return new Response(null, { status: res.status, headers: res.headers });
  }
  return new Response(null, { status: e.status, headers: e.headers });
}

export async function paidRoute(req, env, ctx, log = null) {
  if (req.method !== "GET" && req.method !== "HEAD" && !hasPayment(req)) { if (log) log.fast_404 = true; return notFound(); }
  if (req.method === "HEAD") return headPaid(req, env, ctx, log);
  if (hasPayment(req)) return createApp(env, log).fetch(req, env, ctx);
  const browser = isBrowser(req);
  const key = (browser ? "h " : "j ") + req.url;
  const hit = unpaid402.get(key);
  if (hit) return toResponse(hit);
  const fast = browser ? null : fastUnpaid402(req.url, env); // plain data, no app/x402 server (CPU on cold isolates)
  if (fast) { if (log) log.fast_402 = true; unpaid402.set(key, fast); return toResponse(fast); }
  const res = await createApp(env).fetch(req, env, ctx);
  if (res.status !== 402) return res;
  const e = { status: res.status, headers: [...res.headers], body: await res.text() };
  unpaid402.set(key, e);
  return toResponse(e);
}

function route(req, env, ctx, path, log, mcpMsg) {
  if (path === "/mcp") return handleMcp(req, env, log, mcpMsg).then(res => {
    if (log && !log.mcp_fast) Object.assign(log, mcpSdkShape(req, mcpMsg));
    return res;
  });
  if (PAID.test(path)) return paidRoute(req, env, ctx, log);
  freeApp ??= createApp({ ...env, DISABLE_PAYMENTS: "1", FREE_ONLY: "1" });
  return freeApp.fetch(req, env, ctx);
}

// Parsed POST /mcp body (read from a clone so the SDK transport can still read the stream) + its log fields
// (JSON-RPC method, tool name). Batches report the first message. Bodies over 64 KB are not parsed (CPU).
// msg is undefined when not parsed, which sends the request down the SDK path.
export async function mcpBody(req) {
  if (req.method !== "POST" || +(req.headers.get("content-length") || 0) > 65536) return { info: {}, msg: NO_BODY };
  let msg;
  try { msg = JSON.parse(await req.clone().text()); } catch { return { info: { mcp_method: "unparsable" }, msg: BAD_JSON }; }
  const m = Array.isArray(msg) ? msg[0] : msg;
  const o = { mcp_method: typeof m?.method === "string" ? m.method.slice(0, 60) : null };
  if (o.mcp_method === "tools/call") { o.tool = String(m.params?.name ?? "").slice(0, 60); o.has_mcp_payment = !!m.params?._meta?.["x402/payment"]; }
  return { info: o, msg };
}
// Shape of an MCP request the fast path declined (for the next round of fast paths). No values, no headers beyond these.
export function mcpSdkShape(req, msg) {
  const m = Array.isArray(msg) ? msg[0] : msg;
  return { mcp_sdk: true, mcp_pv: (req.headers.get("mcp-protocol-version") || "").slice(0, 20) || null,
    mcp_batch: Array.isArray(msg) || undefined, mcp_params: m && typeof m === "object" && m.params && typeof m.params === "object" ? Object.keys(m.params).slice(0, 6).join(",") : null,
    mcp_id_type: m && typeof m === "object" && "id" in m ? (m.id === null ? "null" : typeof m.id) : null };
}
export const mcpInfo = async req => (await mcpBody(req)).info;

// One structured log line per request (Workers Logs indexes the fields). No IPs, headers, payment payloads or secrets.
export function requestLog(req, path) {
  const cf = req.cf || {};
  return { path, method: req.method, has_payment_header: hasPayment(req),
    ua: (req.headers.get("user-agent") || "").slice(0, 80), country: cf.country ?? null, colo: cf.colo ?? null };
}

export default {
  async fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    const log = requestLog(req, path);
    let mcpMsg;
    if (path === "/mcp") { const b = await mcpBody(req); Object.assign(log, b.info); mcpMsg = b.msg; }
    try {
      const res = await route(req, env, ctx, path, log, mcpMsg);
      log.status = res.status;
      return res;
    } catch (e) {
      log.status = 500; log.error = String(e?.message || e).slice(0, 160);
      throw e;
    } finally { console.log(log); }
  },
};
