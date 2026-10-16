// Wrangler alias for "@x402/extensions/bazaar" inside the Worker bundle.
// The Hono middleware re-validates Bazaar route schemas with ajv on every construction (~15-20 ms CPU),
// and the Worker builds the middleware per request. Our schema is static and validated in `npm test`,
// so the per-request validation is skipped here. Everything else is the real module.
export * from "../node_modules/@x402/extensions/dist/esm/bazaar/index.mjs";
export function validateBazaarRouteExtensions() {}
