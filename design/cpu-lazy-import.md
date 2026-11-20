# CPU fix 2: lazy imports (20/11/2026)

Branch `fix/cpu-lazy-import`. **Not deployed.**

## Problem
Since the 30/10 deploy: n=58,155, p50 1.42 ms, p99 22.47 ms (goal < 10 ms on Workers Free), steady at 22-23 ms each week.
The fast paths already answer the common requests in about 1 ms. The remaining cost is per isolate: the bundle evaluated the whole
x402 + Hono + @coinbase/x402 graph and the MCP SDK + zod at the top level, even for requests that never use them.

## Change
- `src/constants.js`: plain data with no imports (descriptions, EURC, discovery declarations, acceptsFor, prices, MCP protocol versions).
- `src/fast-paths.js`: no library imports. Base64 header encoding, Bazaar declarations and MCP protocol versions are reproduced locally and checked against the libraries in `test/fast-paths.js`. It owns the unpaid MCP cache.
- `src/worker.js`: only plain-data modules are imported statically. `app.js` (paid routes), `free-app.js` (free routes, Hono only) and `remote-mcp.js` (MCP SDK) are loaded with `import()`. The MCP fast path runs before the SDK is loaded.
- `src/remote-mcp.js`: `@x402/mcp` and `app.js` load only when a paid tool runs (`src/mcp-paid.js`).
- No changes to prices, wallet/payTo, terms, wrangler.toml, TAXUD or PEC.

## Bundle (wrangler deploy --dry-run)
Wrangler (esbuild) still produces **one module**. Dynamically imported modules are wrapped in lazy `__esm` initialisers
(`Promise.resolve().then(() => (init_app(), app_exports))`), so their top-level code runs on first use, not at isolate startup.
Measured on wrangler's real output (`bench/eval-split.mjs`, Node on the box, 5 runs):

| | compile (parse) | top-level evaluation |
|---|---|---|
| origin/main 86cb48b | 27-29 ms | 41-44 ms |
| this branch | 21-22 ms | ~3 ms |

The upload grows 1,941 KiB -> 2,080 KiB (gzip 344 -> 359 KiB) because of the esbuild wrappers. Parse time still goes down.

## Bench (`node bench/cpu-bench.mjs`, ms CPU, box)
See the report in the task; files `bench-before-86cb48b.txt` / `bench-after-56ba3bf.txt` were in /workspace/deploy-check.
Fast-path cold requests are unchanged (~1.1-1.3 ms) and import drops from ~63-72 ms to ~34-47 ms. The first request of a slow
kind in an isolate pays the deferred evaluation: unpaid MCP tools/call 24 -> 57 ms (once per isolate, then cached),
paid HTTP 17-19 -> 22-25 ms, free `/` 1.9 -> 2.6 ms.

## Open question that only production can answer
Whether Cloudflare counts isolate startup in a request's CPU time. If it does (likely, given p99 ≈ 22 ms, close to the
startup cost), p99 should drop clearly. If not, the gain is smaller, and the first paid request per isolate costs a few ms more.
Re-measure p99 after deploy with enough requests (see `/workspace/deploy-check/cpu-window.mjs`).

## Deploy (only with Yeison's confirmation)
`scripts/deploy-with-rollback.sh <live-version-id> <commit>`: tests, dry-run build, live-version check, deploy, smoke
(`scripts/smoke.mjs`) x3, automatic rollback to `<live-version-id>` on failure. `DRY_RUN=1` stops before deploying.

## Deploy outcome (20/11/2026, Europe/Rome): ROLLED BACK
- 20:46:45 deploy of 93322e6 with `scripts/deploy-with-rollback.sh`: preflight 117/117 tests, version
  `f523ccab-84b2-4704-a05c-c1b48d5d6528`, smoke all green (/, /mcp initialize + tools/list, /v1/pa 402 @5000, /v1/counterparty 402 @10000).
- Watching the logs: fast-path requests were normal (19:47Z: 8 requests, avg 2.46 ms, max 7.84 ms), 0 errors, 0 exceededCpu.
  But the two requests that took the SDK path paid the lazy load inside the request:
  - 19:48Z `tools/list` without the fast path (SentinelOracle client): **110.97 ms** CPU
  - 19:49Z `HEAD /mcp` → 405: **68.11 ms** CPU
  The same `HEAD /mcp` → 405 on a6844a94 (static imports) cost at most 11.9–12.8 ms (minute max, 20/11 02:13Z and 15:46Z).
- 20:51:55 manual `wrangler rollback` to `2f644f20-e939-47b5-ba1c-c33d1a07ad27`, smoke green again. main not moved (stays 86cb48b).

**Conclusion:** on Cloudflare, top-level evaluation at isolate startup is NOT charged (or charged far less) to the request,
while a dynamic import() evaluated inside a request is. The premise of this fix was wrong: lazy loading moves free startup
work into billed request time. The 22 ms p99 comes from requests that take the library paths (SDK-path MCP, paid, browser
402), not from startup.

**Next proposal:** keep the static imports (eager evaluation at startup) and widen the plain-data fast paths for what still
reaches the SDK: `HEAD`/`GET /mcp` (405), `tools/list` and `initialize` with headers the fast path rejects today, other
discovery methods (`resources/list`, `prompts/list` → -32601). The dependency-free fast-paths/constants refactor from this
branch can be kept, without the dynamic imports in worker.js / remote-mcp.js.
