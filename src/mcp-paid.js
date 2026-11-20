// Paid MCP pieces, loaded with one dynamic import() from remote-mcp.js only when lookup_italian_pa is called.
// Named re-exports (instead of import("@x402/mcp")) let esbuild tree-shake the rest of @x402/mcp out of the bundle.
export { createPaymentWrapper, extractPaymentFromMeta } from "@x402/mcp";
export { buildX402 } from "./app.js";
