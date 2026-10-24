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
const PAID = /^\/v1\/(pa|vat)(\/?$)/;
let freeApp = null;
export const unpaid402 = new PlainCache(500, 3600_000);

// Same browser test as @x402/core (HTML paywall vs JSON 402), so it is part of the cache key.
const isBrowser = req => (req.headers.get("accept") || "").includes("text/html") && (req.headers.get("user-agent") || "").includes("Mozilla");
const hasPayment = req => req.headers.has("payment-signature") || req.headers.has("x-payment");
const toResponse = e => new Response(e.body, { status: e.status, headers: e.headers });

export async function paidRoute(req, env, ctx) {
  if (req.method !== "GET" || hasPayment(req)) return createApp(env).fetch(req, env, ctx);
  const key = (isBrowser(req) ? "h " : "j ") + req.url;
  const hit = unpaid402.get(key);
  if (hit) return toResponse(hit);
  const res = await createApp(env).fetch(req, env, ctx);
  if (res.status !== 402) return res;
  const e = { status: res.status, headers: [...res.headers], body: await res.text() };
  unpaid402.set(key, e);
  return toResponse(e);
}

export default {
  fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path === "/mcp") return handleMcp(req, env);
    if (PAID.test(path)) return paidRoute(req, env, ctx);
    freeApp ??= createApp({ ...env, DISABLE_PAYMENTS: "1", FREE_ONLY: "1" });
    return freeApp.fetch(req, env, ctx);
  },
};
