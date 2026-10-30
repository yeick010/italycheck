// Our own test traffic, excluded from funnel/payment metrics (growth-eval, logs-summary).
// Evidence for the window: /tmp/ic/probe.mjs ("Empty-wallet probe: fresh random key (never funded)") run on
// 24/10 ~20:34–20:36 Europe/Rome; its MCP calls had UA "italycheck-probe/1" but its plain HTTP calls had UA "node",
// so the UA filter alone misses 2 of the 4 failed payments. scripts/probe-empty-wallet.mjs now tags every request.
export const INTERNAL_PROBE_UA = "italycheck-probe";
export const INTERNAL_PROBE_WINDOWS = [
  { from: "2026-10-24T18:34:00Z", to: "2026-10-24T18:36:30Z", why: "empty-wallet x402 probe after deploy (4 failed payments: 2 MCP + 2 HTTP)" },
];
/** Observability filter dropping events whose UA marks them as our probes. */
export const probeUaFilter = () => ({ key: "ua", operation: "not_includes", type: "string", value: INTERNAL_PROBE_UA });
/** Split [from,to) into the sub-ranges that do not overlap any probe window (ms epoch). */
export function segmentsOutsideProbes(from, to, windows = INTERNAL_PROBE_WINDOWS) {
  const ws = windows.map(w => [Date.parse(w.from), Date.parse(w.to)]).filter(([a, b]) => b > from && a < to).sort((x, y) => x[0] - y[0]);
  const out = []; let cur = from;
  for (const [a, b] of ws) { if (a > cur) out.push([cur, a]); cur = Math.max(cur, b); }
  if (cur < to) out.push([cur, to]);
  return out;
}
