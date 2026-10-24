#!/usr/bin/env node
// Cloudflare Workers usage check for ItalyCheck vs the Workers Free plan limits.
// Usage: CLOUDFLARE_API_TOKEN=... node scripts/cf-usage.mjs [--script italycheck] [--account <id>]
// Needs a token with "Account Analytics: Read". Prints JSON only; never prints the token.
// Free plan (https://developers.cloudflare.com/workers/platform/limits/): 100,000 requests/day per ACCOUNT
// (all Workers together), reset 00:00 UTC, then Error 1027; 10 ms CPU per request, else Error 1102 (exceededCpu).
// Exit code: 0 ok, 1 error, 2 warning threshold reached (>=70% daily or any exceededCpu/Resources today).

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ACCOUNT = arg("--account", process.env.CLOUDFLARE_ACCOUNT_ID || "3f0071e891f5fc1d8a71ba5cd8f0b074");
const SCRIPT = arg("--script", "italycheck");
const FREE_DAILY = Number(process.env.CF_FREE_DAILY_REQUESTS || 100_000);
const FREE_CPU_MS = 10;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.log(JSON.stringify({ error: "CLOUDFLARE_API_TOKEN not set" })); process.exit(1); }

const Q = `query($a:String!,$s:Time!,$u:Time!,$f:AccountWorkersInvocationsAdaptiveFilter_InputObject!){viewer{accounts(filter:{accountTag:$a}){
  byStatus: workersInvocationsAdaptive(limit:100, filter:$f){ sum{requests errors subrequests cpuTimeUs} dimensions{status} }
  overall: workersInvocationsAdaptive(limit:1, filter:$f){ sum{requests} quantiles{cpuTimeP50 cpuTimeP99 cpuTimeP999} }
}}}`;

async function window(since, until, script) {
  const f = { datetime_geq: since.toISOString(), datetime_leq: until.toISOString(), ...(script ? { scriptName: script } : {}) };
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: Q, variables: { a: ACCOUNT, s: f.datetime_geq, u: f.datetime_leq, f } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) {
    const msg = (j.errors || []).map(e => e.message).join("; ") || `HTTP ${r.status}`;
    throw new Error(/auth|permission|not authorized/i.test(msg) ? `token lacks Account Analytics:Read (${msg})` : msg);
  }
  const acc = j.data.viewer.accounts[0] || { byStatus: [], overall: [] };
  const statuses = {}; let requests = 0, errors = 0, cpuUs = 0;
  for (const g of acc.byStatus) {
    statuses[g.dimensions.status] = (statuses[g.dimensions.status] || 0) + g.sum.requests;
    requests += g.sum.requests; errors += g.sum.errors; cpuUs += g.sum.cpuTimeUs;
  }
  const q = acc.overall[0]?.quantiles || {};
  const ms = us => (us == null ? null : Math.round(us / 10) / 100);
  return { requests, errors, statuses, cpu_total_ms: ms(cpuUs), cpu_avg_ms: requests ? ms(cpuUs / requests) : null,
    cpu_p50_ms: ms(q.cpuTimeP50), cpu_p99_ms: ms(q.cpuTimeP99), cpu_p999_ms: ms(q.cpuTimeP999),
    exceeded_cpu: statuses.exceededCpu || 0,
    exceeded_resources: (statuses.exceededResources || 0) + (statuses.exceededMemory || 0) };
}

try {
  const now = new Date();
  const midnightUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [d1, d7, todayAcct] = await Promise.all([
    window(new Date(now - 864e5), now, SCRIPT),
    window(new Date(now - 7 * 864e5), now, SCRIPT),
    window(midnightUtc, now, null), // what the free daily limit actually counts: whole account since 00:00 UTC
  ]);
  const hoursToday = Math.max((now - midnightUtc) / 36e5, 0.25);
  const projected = Math.round(todayAcct.requests / hoursToday * 24);
  const pctToday = +(100 * todayAcct.requests / FREE_DAILY).toFixed(2);
  const out = {
    generated_at: now.toISOString(), account: ACCOUNT, script: SCRIPT, free_daily_limit: FREE_DAILY, free_cpu_ms_per_request: FREE_CPU_MS,
    requests_24h: d1.requests,
    pct_of_free_daily: +(100 * d1.requests / FREE_DAILY).toFixed(2),
    errors_24h: d1.errors,
    exceeded_cpu_24h: d1.exceeded_cpu,
    exceeded_resources_24h: d1.exceeded_resources,
    cpu_p50_ms: d1.cpu_p50_ms,
    cpu_p99_ms: d1.cpu_p99_ms,
    cpu_avg_ms: d1.cpu_avg_ms,
    cpu_over_free_limit_share: d1.cpu_p50_ms > FREE_CPU_MS ? ">50%" : d1.cpu_p99_ms > FREE_CPU_MS ? "1-50% (tolerated burst so far; 1102 risk if sustained)" : "<1%",
    statuses_24h: d1.statuses,
    account_today_utc: { requests: todayAcct.requests, pct_of_free_daily: pctToday, projected_full_day: projected,
      projected_pct: +(100 * projected / FREE_DAILY).toFixed(2), exceeded_cpu: todayAcct.exceeded_cpu },
    last_7d: { requests: d7.requests, avg_per_day: Math.round(d7.requests / 7), errors: d7.errors, exceeded_cpu: d7.exceeded_cpu,
      cpu_p50_ms: d7.cpu_p50_ms, cpu_p99_ms: d7.cpu_p99_ms, cpu_total_ms: d7.cpu_total_ms, statuses: d7.statuses },
    // Workers Paid (Standard): $5/mo incl. 10M req + 30M CPU ms; then $0.30/M req, $0.02/M CPU ms.
    paid_plan_estimate_usd_month: (() => {
      const req = d7.requests / 7 * 30, cpu = d7.cpu_total_ms / 7 * 30;
      return +(5 + Math.max(0, req - 10e6) / 1e6 * 0.30 + Math.max(0, cpu - 30e6) / 1e6 * 0.02).toFixed(2);
    })(),
    note: "workersInvocationsAdaptive is sampled/adaptive; counts are estimates. Data lag ~1-5 min.",
  };
  out.alert = pctToday >= 90 || out.account_today_utc.projected_pct >= 90 ? "CRITICAL" : (pctToday >= 70 || out.account_today_utc.projected_pct >= 70 || todayAcct.exceeded_cpu > 0 || d1.exceeded_resources > 0) ? "WARN" : "OK";
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.alert === "OK" ? 0 : 2);
} catch (e) {
  console.log(JSON.stringify({ error: String(e.message).replaceAll(TOKEN, "***") }));
  process.exit(1);
}
