# CPU fix 3: MCP transport fast paths (20/11/2026)

Branch `fix/mcp-fast-paths` from main 86cb48b. Static imports stay as on main: the lazy-import attempt
(`fix/cpu-lazy-import`, version f523ccab, rolled back) showed that Cloudflare bills a dynamic import evaluated inside a
request but not the module evaluation at isolate startup.

## Which requests exceed 10 ms (logs 13-20/11/2026, a6844a94 / 2f644f20, italycheck-probe excluded)
Method: `scripts/cpu/slow-rows.mjs` (GraphQL, max CPU per second) joined with the request log lines
(`scripts/cpu/fetch-events.mjs`) by second (`scripts/cpu/join.py`). 1,368 seconds had a request at >= 10 ms.
Attributed (exact = only request in that second; likely = only non-fast-path request in that second):

| shape | exact | likely | all requests | med / max ms |
|---|---|---|---|---|
| POST /mcp tools/list via SDK (472 of 508 = SentinelOracle) | 32 | 438 | 508 | 17.7-21.7 / 111 |
| POST /mcp server/discover via SDK (400 = protocol header, 200 = -32601) | 45 | 114 | 379 | 15-17 / 36.5 |
| GET /mcp 200 (stateless SSE) | 4 | 75 | 280 | 13-14 / 34 |
| POST /v1/pa 404 (builds the paid app) | 21 | 39 | 139 | 13-16 / 31.7 |
| GET /mcp 406 | 16 | 33 | 192 | 13 / 28.8 |
| GET /v1/pa 402 fast path (cold isolates) | 76 | 0 | 3,464 | 11.9 / 34.4 |
| MCP tools/call via SDK (paid tool flow) | 4 | 16 | 25 | 24-27 / 31 |
| prompts/list, resources/list, initialize via SDK, HEAD/OPTIONS /mcp, 404s | ~40 | ~15 | | 11-18 |
304 seconds were ambiguous (several slow-path requests in the same second, mostly MCP crawlers: GET /mcp + server/discover).

## Change
`src/fast-paths.js` answers, in the SDK transport's own order, with the same bytes (checked per shape against the SDK in
`test/fast-paths.js`):
- any method other than GET/POST/DELETE -> 405 (`Allow: GET, POST, DELETE`)
- GET without `text/event-stream` -> 406; GET with an unsupported `MCP-Protocol-Version` -> 400; GET otherwise -> the
  same never-ending SSE stream (keep-alive comment every 15 s)
- POST: bad Accept -> 406; non-JSON Content-Type (SDK `isJsonContentType`) -> 415; unparsable JSON -> 400 -32700;
  non-object / non-2.0 message -> 400 "Invalid JSON-RPC message"
- unsupported `MCP-Protocol-Version` on any non-initialize request or notification -> 400 (initialize ignores the header)
- any notification -> 202; ping / tools/list with `_meta` / `cursor` params
- server/discover, prompts/*, resources/*, completion/complete, logging/setLevel -> JSON-RPC -32601
- POST (no payment header) to /v1/pa or /v1/counterparty -> Hono's 404 without building the paid app
Batches, DELETE, id null, odd params, tools/call (except cached unpaid) still go to the SDK. SDK-path requests now log
`mcp_sdk`, `mcp_pv`, `mcp_params` (keys only), `mcp_batch`, `mcp_id_type` to find the next shapes.
