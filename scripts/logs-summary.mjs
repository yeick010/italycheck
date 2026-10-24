#!/usr/bin/env node
// ItalyCheck request summary from Workers Logs (Workers Observability telemetry query API).
// Usage: CLOUDFLARE_API_TOKEN=... node scripts/logs-summary.mjs [--hours 24] [--account <id>] [--script italycheck] [--top 10]
// API: POST https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/observability/telemetry/query
//   (https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
// Token permission: "Workers Observability" (the query endpoint accepts "Workers Observability Write"; Account scope).
// Counts the one structured log per request written by src/worker.js (fields: path, method, mcp_method, tool,
// has_payment_header, has_mcp_payment, status, payment, payment_reason, ua, country, colo). Prints JSON; never the token.
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ACCOUNT = arg("--account", process.env.CLOUDFLARE_ACCOUNT_ID || "3f0071e891f5fc1d8a71ba5cd8f0b074");
const SCRIPT = arg("--script", "italycheck");
const HOURS = Number(arg("--hours", 24));
const TOP = Number(arg("--top", 10));
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.log(JSON.stringify({ error: "CLOUDFLARE_API_TOKEN not set" })); process.exit(1); }

const to = Date.now(), from = to - HOURS * 3600_000;
const BASE_FILTERS = [
  { key: "$metadata.service", operation: "eq", type: "string", value: SCRIPT },
  { key: "path", operation: "exists", type: "string" }, // only our per-request log lines, not invocation logs
];
const DIMS = [["path", "string"], ["method", "string"], ["status", "number"], ["mcp_method", "string"], ["tool", "string"],
  ["has_payment_header", "boolean"], ["has_mcp_payment", "boolean"], ["payment", "string"], ["payment_reason", "string"],
  ["ua", "string"], ["country", "string"]];

async function query(body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`, {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const msg = (j.errors || []).map(e => `${e.code ?? ""} ${e.message}`.trim()).join("; ") || `HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403 || /auth|permission/i.test(msg))
      throw new Error(`token lacks permission for the Workers Observability telemetry API: add Account > "Workers Observability" (Edit/Write; the query endpoint lists "Workers Observability Write") to the token (${msg})`);
    throw new Error(msg);
  }
  return j.result;
}

async function countBy(key, type) {
  const res = await query({ queryId: `italycheck-summary-${key}`, view: "calculations", timeframe: { from, to }, ignoreSeries: true, limit: TOP,
    parameters: { filters: BASE_FILTERS, calculations: [{ operator: "count", alias: "n" }], groupBys: [{ type, value: key }],
      orderBy: { value: "n", order: "desc" }, limit: TOP } });
  const out = {};
  for (const a of res?.calculations?.[0]?.aggregates || []) {
    const g = (a.groups || []).find(x => x.key === key);
    out[g ? String(g.value) : "(none)"] = a.count ?? a.value;
  }
  return out;
}

try {
  const total = await query({ queryId: "italycheck-summary-total", view: "calculations", timeframe: { from, to }, ignoreSeries: true,
    parameters: { filters: BASE_FILTERS, calculations: [{ operator: "count", alias: "n" }] } });
  const summary = { script: SCRIPT, window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), hours: HOURS },
    requests: total?.calculations?.[0]?.aggregates?.[0]?.count ?? 0, by: {} };
  for (const [k, t] of DIMS) summary.by[k === "ua" ? "top_user_agents" : k] = await countBy(k, t);
  console.log(JSON.stringify(summary, null, 2));
} catch (e) { console.log(JSON.stringify({ error: e.message })); process.exit(1); }
