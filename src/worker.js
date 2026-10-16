// Cloudflare Workers entry (Free plan: 100k req/day, 10ms CPU).
// Paid routes: a fresh app per request. Sharing an app with payment middleware (and its in-flight promises)
// across requests made some requests hang on Workers (tested). Expensive pieces are cached as plain data in
// app.js (facilitator "supported", CDP JWT auth headers).
// Free routes (catalog, format check) use one app per isolate WITHOUT payment middleware: no shared I/O.
import { createApp } from "./app.js";
import { handleMcp } from "./remote-mcp.js";
const PAID = /^\/v1\/(pa|vat)(\/?$)/;
let freeApp = null;
export default {
  fetch(req, env, ctx) {
    const path = new URL(req.url).pathname;
    if (path === "/mcp") return handleMcp(req, env);
    if (PAID.test(path)) return createApp(env).fetch(req, env, ctx);
    freeApp ??= createApp({ ...env, DISABLE_PAYMENTS: "1", FREE_ONLY: "1" });
    return freeApp.fetch(req, env, ctx);
  },
};
