// Cloudflare Workers entry (Free plan: 100k req/day, 10ms CPU).
// Paid routes: a fresh app per request. Sharing an app with payment middleware (and its in-flight promises)
// across requests made some requests hang on Workers (tested). Expensive pieces are cached as plain data in
// app.js (facilitator "supported", CDP JWT auth headers).
// Unpaid requests to paid routes (no PAYMENT-SIGNATURE / X-PAYMENT header) get a cached 402 (plain data:
// status, headers, body text) keyed by full URL; built once per URL via the normal middleware path.
// Free routes (catalog, format check) use one app per isolate WITHOUT payment middleware: no shared I/O.
// Cold isolates: only plain-data modules are imported statically (constants, cache, fast paths). The heavy graphs are
// loaded with dynamic import() when a request needs them: app.js (Hono + @x402/* + @coinbase/x402) for paid routes,
// free-app.js (Hono only) for free routes, remote-mcp.js (MCP SDK + zod) for MCP requests the fast path declines. Each import is evaluated once
// per isolate. esbuild (wrangler) keeps one bundle but wraps lazily-imported modules so their top-level code runs on
// first import, not at isolate startup.
import { PlainCache } from "./cache.js";
import { fastUnpaid402, fastMcp, mcpUnpaid } from "./fast-paths.js";
const createApp = async (...a) => (await import("./app.js")).createApp(...a);
const handleMcp = async (...a) => (await import("./remote-mcp.js")).handleMcp(...a);
const cachedUnpaid = url => { const hit = mcpUnpaid.get(url); return hit && structuredClone(hit); };
const PAID = /^\/v1\/(pa|vat)(\/?$)/;
let freeApp = null;
export const unpaid402 = new PlainCache(500, 3600_000);

// Same browser test as @x402/core (HTML paywall vs JSON 402), so it is part of the cache key.
const isBrowser = req => (req.headers.get("accept") || "").includes("text/html") && (req.headers.get("user-agent") || "").includes("Mozilla");
const hasPayment = req => req.headers.has("payment-signature") || req.headers.has("x-payment");
const toResponse = e => new Response(e.body, { status: e.status, headers: e.headers });

export async function paidRoute(req, env, ctx, log = null) {
  if (req.method !== "GET" || hasPayment(req)) return (await createApp(env, log)).fetch(req, env, ctx);
  const browser = isBrowser(req);
  const key = (browser ? "h " : "j ") + req.url;
  const hit = unpaid402.get(key);
  if (hit) return toResponse(hit);
  const fast = browser ? null : fastUnpaid402(req.url, env); // plain data, no app/x402 server (CPU on cold isolates)
  if (fast) { if (log) log.fast_402 = true; unpaid402.set(key, fast); return toResponse(fast); }
  const res = await (await createApp(env)).fetch(req, env, ctx);
  if (res.status !== 402) return res;
  const e = { status: res.status, headers: [...res.headers], body: await res.text() };
  unpaid402.set(key, e);
  return toResponse(e);
}

async function route(req, env, ctx, path, log, mcpMsg) {
  if (path === "/mcp") {
    // Fast path here (before loading the SDK); remote-mcp.js re-checks it, so pass undefined to skip that.
    const fast = mcpMsg !== undefined && fastMcp(req, mcpMsg, env, cachedUnpaid);
    if (fast) { if (log) log.mcp_fast = true; return fast; }
    return handleMcp(req, env, log, undefined);
  }
  if (PAID.test(path)) return paidRoute(req, env, ctx, log);
  freeApp ??= (await import("./free-app.js")).createFreeApp(env); // = createApp({ ...env, DISABLE_PAYMENTS: "1", FREE_ONLY: "1" }), no x402
  return freeApp.fetch(req, env, ctx);
}

// Parsed POST /mcp body (read from a clone so the SDK transport can still read the stream) + its log fields
// (JSON-RPC method, tool name). Batches report the first message. Bodies over 64 KB are not parsed (CPU).
// msg is undefined when not parsed, which sends the request down the SDK path.
export async function mcpBody(req) {
  if (req.method !== "POST" || +(req.headers.get("content-length") || 0) > 65536) return { info: {}, msg: undefined };
  let msg;
  try { msg = JSON.parse(await req.clone().text()); } catch { return { info: { mcp_method: "unparsable" }, msg: undefined }; }
  const m = Array.isArray(msg) ? msg[0] : msg;
  const o = { mcp_method: typeof m?.method === "string" ? m.method.slice(0, 60) : null };
  if (o.mcp_method === "tools/call") { o.tool = String(m.params?.name ?? "").slice(0, 60); o.has_mcp_payment = !!m.params?._meta?.["x402/payment"]; }
  return { info: o, msg };
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
