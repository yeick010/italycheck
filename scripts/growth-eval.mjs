#!/usr/bin/env node
// ItalyCheck growth eval: revenue, payers, funnel, reliability and cost for a window vs the previous one,
// each metric checked against an explicit threshold (PASS / FAIL / N.D.), plus an overall verdict CRESCE / STABILE / CALA.
//
// Usage:
//   node scripts/growth-eval.mjs                      # last 7 days vs previous 7 days, appends one row to growth-history.jsonl
//   node scripts/growth-eval.mjs --days 7 --end 2026-10-24T18:00:00Z
//   node scripts/growth-eval.mjs --backfill-from 2026-10-13   # also (re)write weekly rows from that date (Europe/Rome midnight)
//   node scripts/growth-eval.mjs --no-append          # print only
// Sources (all free): Base mainnet public RPC (USDC/EURC Transfer logs to PAY_TO = revenue truth),
//   Cloudflare GraphQL Analytics (requests, errors, CPU, exceededCpu), Workers Observability logs (402s, payment attempts/outcomes).
// Env: CLOUDFLARE_API_TOKEN (optional; without it traffic/reliability checks are N.D.). Never printed.
// Output: JSON on stdout. Exit 0 always on success (the verdict is data, not a failure), 1 on fatal error.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chainPayments } from "./lib/onchain.mjs";
import { probeUaFilter, segmentsOutsideProbes } from "./lib/probes.mjs";

// ───────────── Thresholds (edit here) ─────────────
const THRESHOLDS = {
  paid_calls_wow_min_pct: 20,      // paid calls week-over-week growth ≥ +20%
  revenue_wow_min_pct: 20,         // revenue (USDC+EURC, 1:1 nominal) WoW ≥ +20%
  new_payers_min: 1,               // ≥ 1 new unique payer in the window
  returning_payers_min: 1,         // ≥ 1 payer who paid again within RETURNING_LOOKBACK_DAYS
  returning_lookback_days: 30,
  repeat_payer_rate_min_pct: 10,   // ≥ 10% of the window's payers have paid ≥ 2 times (all time)
  conversion_min_pct: 1,           // paid calls / unpaid 402s ≥ 1%
  failed_payment_rate_max_pct: 50, // failed / payment attempts ≤ 50%
  error_rate_max_pct: 1,           // Worker errors / requests < 1%
  exceeded_cpu_max: 0,             // exceededCpu invocations = 0
  cpu_p99_max_ms: 10,              // Free plan CPU limit per request
  cost_max_eur: 0,                 // €0 budget
  min_sample_paid_calls: 30,       // below this, growth % is noise → verdict confidence "bassa"
  verdict_drop_pct: -20,           // paid calls WoW ≤ −20% → CALA
  min_log_hours_for_extrapolation: 6,  // below this, 402s come from the baseline below (stima)
  unpaid_402_per_day_baseline: 175,    // observed ~150–200 unpaid 402/day on /v1/pa before logs existed (stima)
  min_payment_attempts: 5,         // fewer attempts → failed-payment rate is N.D. (too small)
  max_prelaunch_share_prev: 0.5,   // previous window > 50% before launch → WoW growth is N.D.
};
// ───────────── Config ─────────────
const PRICE = 0.005;
const SERVICE_START = "2026-10-15T22:00:00Z";  // ~16/10 Rome; on-chain history is scanned from HISTORY_START
const HISTORY_START = "2026-10-12T22:00:00Z";  // 13/10 00:00 Rome
const LOGS_START = "2026-10-24T18:35:00Z";     // Workers Logs enabled ~20:35 Rome
const LOGS_RETENTION_DAYS = 3;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "3f0071e891f5fc1d8a71ba5cd8f0b074";
const SCRIPT = "italycheck";
const FREE_DAILY_REQUESTS = 100_000;
const HISTORY_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "growth-history.jsonl");

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const flag = k => process.argv.includes(k);
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const scrub = s => (TOKEN ? String(s).replaceAll(TOKEN, "***") : String(s));
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const pct = (a, b) => (b ? r2((100 * a) / b) : null);
const growth = (cur, prev) => (prev ? r2((100 * (cur - prev)) / prev) : null);
const romeMidnightUtc = ymd => { // Europe/Rome midnight of a YYYY-MM-DD as a Date (handles CET/CEST)
  for (const off of [2, 1]) { const d = new Date(`${ymd}T00:00:00+0${off}:00`);
    if (d.toLocaleString("sv-SE", { timeZone: "Europe/Rome" }).startsWith(`${ymd} 00:00`)) return d; }
  return new Date(`${ymd}T00:00:00+01:00`);
};
const rome = d => new Date(d).toLocaleString("sv-SE", { timeZone: "Europe/Rome" }).slice(0, 16);

// ───────────── On-chain revenue (scripts/lib/onchain.mjs) ─────────────
function revenueMetrics(payments, from, to) {
  const inW = payments.filter(p => p.ts >= from && p.ts < to);
  const before = payments.filter(p => p.ts < from);
  const upTo = payments.filter(p => p.ts < to);
  const payers = [...new Set(inW.map(p => p.from))];
  const lookback = THRESHOLDS.returning_lookback_days * 864e5;
  const isNew = a => !before.some(p => p.from === a);
  const returning = payers.filter(a => inW.some(p => p.from === a &&
    upTo.some(q => q.from === a && q.ts < p.ts && p.ts - q.ts <= lookback)));
  const repeaters = payers.filter(a => upTo.filter(p => p.from === a).length >= 2);
  const sum = tok => r2(inW.filter(p => p.token === tok).reduce((s, p) => s + p.amount, 0) * 1000) / 1000;
  return {
    revenue_usdc: sum("USDC"), revenue_eurc: sum("EURC"),
    revenue_total_nominal: r2((sum("USDC") + sum("EURC")) * 1000) / 1000,
    paid_calls: inW.length,
    paid_calls_by_price: r2(inW.reduce((s, p) => s + p.amount, 0) / PRICE),
    unique_payers: payers.length,
    new_payers: payers.filter(isNew).length,
    returning_payers: returning.length,
    repeat_payer_rate_pct: payers.length ? pct(repeaters.length, payers.length) : null,
    payments: inW.map(p => ({ at_rome: rome(p.ts), token: p.token, amount: p.amount, payer: p.from, tx: p.tx })),
  };
}

// ───────────── Cloudflare analytics (GraphQL) ─────────────
async function cfGraphql(query, variables) {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors?.length) throw new Error((j.errors || []).map(e => e.message).join("; ") || `HTTP ${r.status}`);
  return j.data;
}
const GQ = `query($a:String!,$f:AccountWorkersInvocationsAdaptiveFilter_InputObject!){viewer{accounts(filter:{accountTag:$a}){
  byStatus: workersInvocationsAdaptive(limit:100, filter:$f){ sum{requests errors cpuTimeUs} dimensions{status} }
  overall: workersInvocationsAdaptive(limit:1, filter:$f){ sum{requests} quantiles{cpuTimeP50 cpuTimeP99} }
}}}`;
async function trafficMetrics(from, to) {
  if (!TOKEN) return { error: "CLOUDFLARE_API_TOKEN not set" };
  try {
    const f = { scriptName: SCRIPT, datetime_geq: new Date(from).toISOString(), datetime_leq: new Date(to).toISOString() };
    const acc = (await cfGraphql(GQ, { a: ACCOUNT, f })).viewer.accounts[0] || { byStatus: [], overall: [] };
    let requests = 0, errors = 0, cpuUs = 0; const statuses = {};
    for (const g of acc.byStatus) { statuses[g.dimensions.status] = g.sum.requests; requests += g.sum.requests; errors += g.sum.errors; cpuUs += g.sum.cpuTimeUs; }
    const q = acc.overall[0]?.quantiles || {};
    const days = Math.max((to - Math.max(from, Date.parse(SERVICE_START))) / 864e5, 1 / 24);
    return { requests, requests_per_day: Math.round(requests / days), errors, error_rate_pct: requests ? pct(errors, requests) : null,
      exceeded_cpu: statuses.exceededCpu || 0, exceeded_resources: (statuses.exceededResources || 0) + (statuses.exceededMemory || 0),
      cpu_p50_ms: q.cpuTimeP50 == null ? null : r2(q.cpuTimeP50 / 1000), cpu_p99_ms: q.cpuTimeP99 == null ? null : r2(q.cpuTimeP99 / 1000),
      cpu_total_ms: r2(cpuUs / 1000), statuses, note: "workersInvocationsAdaptive is sampled; counts are estimates" };
  } catch (e) { return { error: scrub(e.message) }; }
}

// ───────────── Workers Logs (402 funnel) ─────────────
// Counts exclude our own probes: UA filter + known probe time windows (see scripts/lib/probes.mjs).
async function logsCount(from, to, extra) {
  let n = 0;
  for (const [a, b] of segmentsOutsideProbes(from, to)) n += await logsCountRaw(a, b, [...extra, probeUaFilter()]);
  return n;
}
async function logsCountRaw(from, to, extra) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`, {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ queryId: "italycheck-growth-eval", view: "calculations", timeframe: { from, to }, ignoreSeries: true,
      parameters: { filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: SCRIPT },
        { key: "path", operation: "exists", type: "string" }, ...extra], filterCombination: "and",
        calculations: [{ operator: "count", alias: "n" }] } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error((j.errors || []).map(e => e.message).join("; ") || `HTTP ${r.status}`);
  return j.result?.calculations?.[0]?.aggregates?.[0]?.count ?? 0;
}
const F = (key, value, type = "string", operation = "eq") => ({ key, operation, type, value });
async function funnelMetrics(from, to, now) {
  const logsFrom = Math.max(Date.parse(LOGS_START), now - LOGS_RETENTION_DAYS * 864e5 + 60_000);
  const lf = Math.max(from, logsFrom), lt = Math.min(to, now);
  const coverage = lt > lf ? (lt - lf) / (to - from) : 0;
  const base = { logs_window_rome: lt > lf ? [rome(lf), rome(lt)] : null, logs_coverage_pct: r2(coverage * 100) };
  if (!TOKEN) return { ...base, error: "CLOUDFLARE_API_TOKEN not set" };
  if (coverage <= 0) return { ...base, no_logs: "nessun Workers Log per questa finestra (attivi dal 24/10 ~20:35 Roma, retention 3 gg)",
    unpaid_402_window_estimate: Math.round(THRESHOLDS.unpaid_402_per_day_baseline * Math.max(0, Math.min(to, now) - Math.max(from, Date.parse(SERVICE_START))) / 864e5),
    estimate: true, estimate_method: `baseline ${THRESHOLDS.unpaid_402_per_day_baseline}/giorno (nessun log)` };
  try {
    const [http402, mcpUnpaid, httpAttempts, mcpAttempts, failed, settled, total] = await Promise.all([
      logsCount(lf, lt, [F("status", 402, "number")]),
      logsCount(lf, lt, [F("mcp_method", "tools/call"), F("tool", "lookup_italian_pa"), F("has_mcp_payment", false, "boolean")]),
      logsCount(lf, lt, [F("path", "^/v1/(pa|vat)/?$", "string", "regex"), F("has_payment_header", true, "boolean")]),
      logsCount(lf, lt, [F("has_mcp_payment", true, "boolean")]),
      logsCount(lf, lt, [F("payment", "failed")]),
      logsCount(lf, lt, [F("payment", "settled")]),
      logsCount(lf, lt, []),
    ]);
    const unpaid = http402 + mcpUnpaid, attempts = httpAttempts + mcpAttempts;
    const scale = 1 / coverage, logHours = (lt - lf) / 36e5;
    const useLogs = logHours >= THRESHOLDS.min_log_hours_for_extrapolation;
    const est = coverage >= 0.9 ? unpaid : useLogs ? Math.round(unpaid * scale)
      : Math.round(THRESHOLDS.unpaid_402_per_day_baseline * Math.max(0, Math.min(to, now) - Math.max(from, Date.parse(SERVICE_START))) / 864e5);
    return { ...base, logged_requests: total, unpaid_402_http: http402, unpaid_mcp_payment_required: mcpUnpaid, unpaid_402_total: unpaid,
      payment_attempts: attempts, payments_failed: failed, payments_settled_logged: settled,
      failed_payment_rate_pct: attempts ? pct(failed, attempts) : null,
      unpaid_402_window_estimate: est, estimate: coverage < 0.9,
      estimate_method: coverage >= 0.9 ? "logs" : useLogs ? `logs ×${r2(scale)} (estrapolato)` : `baseline ${THRESHOLDS.unpaid_402_per_day_baseline}/giorno (solo ${r2(logHours)} h di log)`,
      payment_attempts_sample_ok: attempts >= THRESHOLDS.min_payment_attempts };
  } catch (e) { return { ...base, error: scrub(e.message) }; }
}

// ───────────── Checks & verdict ─────────────
const check = (id, metric, value, threshold, ok, note) =>
  ({ id, metric, value, threshold, result: value == null || ok == null ? "N.D." : ok ? "PASS" : "FAIL", ...(note ? { note } : {}) });

function evaluate(cur, prev, traffic, funnel, prelaunchShare) {
  const T = THRESHOLDS;
  const prelaunch = prelaunchShare > T.max_prelaunch_share_prev;
  const preNote = `finestra precedente per ${Math.round(prelaunchShare * 100)}% prima del lancio (16/10): confronto WoW non significativo`;
  const pcG = growth(cur.paid_calls, prev.paid_calls), revG = growth(cur.revenue_total_nominal, prev.revenue_total_nominal);
  const fromZero = (c, p) => (p === 0 && c > 0 ? "base precedente = 0: crescita % non definita, PASS solo perché > 0" : p === 0 ? "nessuna attività in entrambe le finestre" : null);
  const conv = funnel.unpaid_402_window_estimate ? pct(cur.paid_calls, funnel.unpaid_402_window_estimate) : null;
  const failRate = funnel.error || !funnel.payment_attempts_sample_ok ? null : funnel.failed_payment_rate_pct;
  const small = cur.paid_calls + prev.paid_calls < T.min_sample_paid_calls;
  const checks = [
    check("paid_calls_wow", "Chiamate pagate, crescita WoW %", prev.paid_calls ? pcG : (cur.paid_calls ? "n/d (da 0)" : 0),
      `≥ +${T.paid_calls_wow_min_pct}%`, prelaunch ? null : prev.paid_calls ? pcG >= T.paid_calls_wow_min_pct : cur.paid_calls > 0, prelaunch ? preNote : fromZero(cur.paid_calls, prev.paid_calls)),
    check("revenue_wow", "Ricavi, crescita WoW %", prev.revenue_total_nominal ? revG : (cur.revenue_total_nominal ? "n/d (da 0)" : 0),
      `≥ +${T.revenue_wow_min_pct}%`, prelaunch ? null : prev.revenue_total_nominal ? revG >= T.revenue_wow_min_pct : cur.revenue_total_nominal > 0, prelaunch ? preNote : fromZero(cur.revenue_total_nominal, prev.revenue_total_nominal)),
    check("new_payers", "Nuovi pagatori unici", cur.new_payers, `≥ ${T.new_payers_min}`, cur.new_payers >= T.new_payers_min),
    check("returning_payers", `Pagatori di ritorno (entro ${T.returning_lookback_days} gg)`, cur.returning_payers, `≥ ${T.returning_payers_min}`, cur.returning_payers >= T.returning_payers_min),
    check("repeat_payer_rate", "Tasso pagatori ripetuti %", cur.repeat_payer_rate_pct, `≥ ${T.repeat_payer_rate_min_pct}%`,
      cur.repeat_payer_rate_pct == null ? null : cur.repeat_payer_rate_pct >= T.repeat_payer_rate_min_pct),
    check("conversion", "Conversione 402 → pagata %", conv, `≥ ${T.conversion_min_pct}%`, conv == null ? null : conv >= T.conversion_min_pct,
      funnel.estimate ? `stima: 402 = ${funnel.unpaid_402_window_estimate} da ${funnel.estimate_method}` : null),
    check("failed_payments", "Pagamenti falliti / tentativi %", failRate, `≤ ${T.failed_payment_rate_max_pct}%`,
      failRate == null ? null : failRate <= T.failed_payment_rate_max_pct,
      funnel.error || funnel.no_logs || (funnel.payment_attempts == null ? "log non disponibili"
        : !funnel.payment_attempts_sample_ok ? `campione troppo piccolo: ${funnel.payments_failed}/${funnel.payment_attempts} falliti nei log (${funnel.logs_coverage_pct}% della finestra)`
        : funnel.estimate ? `solo intervallo coperto dai log (${funnel.logs_coverage_pct}%)` : null)),
    check("error_rate", "Errori Worker %", traffic.error ? null : traffic.error_rate_pct, `< ${T.error_rate_max_pct}%`,
      traffic.error_rate_pct == null ? null : traffic.error_rate_pct < T.error_rate_max_pct, traffic.error),
    check("exceeded_cpu", "exceededCpu", traffic.error ? null : traffic.exceeded_cpu, `= ${T.exceeded_cpu_max}`,
      traffic.error ? null : traffic.exceeded_cpu <= T.exceeded_cpu_max, traffic.error),
    check("cpu_p99", "CPU p99 (ms)", traffic.error ? null : traffic.cpu_p99_ms, `≤ ${T.cpu_p99_max_ms} ms`,
      traffic.cpu_p99_ms == null ? null : traffic.cpu_p99_ms <= T.cpu_p99_max_ms, traffic.error),
  ];
  // Cost: Workers Free is €0; flag if usage would force Workers Paid ($5/mo).
  const needsPaid = !traffic.error && (traffic.requests_per_day > 0.7 * FREE_DAILY_REQUESTS || traffic.exceeded_cpu > 0 || (traffic.cpu_p50_ms ?? 0) > 10);
  const cost = { current_eur_month: 0, workers_paid_needed: traffic.error ? null : needsPaid,
    reason: traffic.error ? "traffico N.D." : needsPaid ? "uso vicino ai limiti Free (richieste/giorno > 70% o CPU)" : `Free plan: ${traffic.requests_per_day}/giorno su ${FREE_DAILY_REQUESTS}` };
  checks.push(check("cost", "Costo mensile (€)", needsPaid ? "0 (Workers Paid ~5 $ in vista)" : 0, `≤ ${T.cost_max_eur} €`, !needsPaid));

  const fails = id => checks.find(c => c.id === id)?.result === "FAIL";
  let verdict;
  if (cur.paid_calls === 0 && prev.paid_calls === 0) verdict = "STABILE";
  else if ((prev.paid_calls && pcG <= T.verdict_drop_pct) || (cur.paid_calls === 0 && prev.paid_calls > 0)) verdict = "CALA";
  else if (checks.find(c => c.id === "paid_calls_wow")?.result === "PASS" && !fails("new_payers") && !fails("exceeded_cpu") && !fails("cost")) verdict = "CRESCE";
  else verdict = "STABILE";
  const notes = [small && `solo ${cur.paid_calls + prev.paid_calls} chiamate pagate nelle due finestre (< ${T.min_sample_paid_calls}): le % di crescita sono rumore`,
    prelaunch && preNote].filter(Boolean);
  return { checks, cost, verdict, confidence: small || prelaunch ? "bassa" : "media", confidence_note: notes.join("; ") || null,
    summary: { pass: checks.filter(c => c.result === "PASS").length, fail: checks.filter(c => c.result === "FAIL").length, nd: checks.filter(c => c.result === "N.D.").length } };
}

async function evalWindow(payments, from, to, now, kind) {
  const len = to - from;
  const [traffic, funnel] = await Promise.all([trafficMetrics(from, Math.min(to, now)), funnelMetrics(from, to, now)]);
  // Partial (still running) window: compare like-for-like elapsed time against the same slice of the previous window.
  const elapsed = Math.min(to, now) - from;
  const cur = revenueMetrics(payments, from, to), prev = revenueMetrics(payments, from - len, from - len + elapsed);
  const launch = Date.parse(SERVICE_START);
  const prelaunchShare = Math.min(1, Math.max(0, (launch - (from - len)) / elapsed));
  const ev = evaluate(cur, prev, traffic, funnel, prelaunchShare);
  return { kind, generated_at: new Date(now).toISOString(),
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), from_rome: rome(from), to_rome: rome(to), days: r2(len / 864e5),
      partial: to > now, ...(to > now ? { elapsed_days: r2(elapsed / 864e5), compared_with_previous_rome: [rome(from - len), rome(from - len + elapsed)] } : {}) },
    verdict: ev.verdict, confidence: ev.confidence, confidence_note: ev.confidence_note, summary: ev.summary,
    revenue: { current: cur, previous: { ...prev, payments: undefined },
      paid_calls_wow_pct: growth(cur.paid_calls, prev.paid_calls), revenue_wow_pct: growth(cur.revenue_total_nominal, prev.revenue_total_nominal) },
    traffic, funnel, cost: ev.cost, checks: ev.checks, thresholds: THRESHOLDS };
}

try {
  const now = Date.now();
  const days = Number(arg("--days", 7));
  const end = arg("--end") ? Date.parse(arg("--end")) : now;
  const backfillFrom = arg("--backfill-from");
  const chain = await chainPayments(HISTORY_START);
  const rows = [];
  if (backfillFrom) {
    const addDays = (ymd, n) => new Date(Date.parse(ymd + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
    for (let d = backfillFrom; romeMidnightUtc(d).getTime() < now; d = addDays(d, days))
      rows.push(await evalWindow(chain.payments, romeMidnightUtc(d).getTime(), romeMidnightUtc(addDays(d, days)).getTime(), now, "backfill_weekly"));
  }
  const current = await evalWindow(chain.payments, end - days * 864e5, end, now, "run");
  rows.push(current);
  if (!flag("--no-append")) {
    const keep = existsSync(HISTORY_FILE) ? readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean)
      .filter(l => { try { const r = JSON.parse(l); return !(backfillFrom && r.kind === "backfill_weekly"); } catch { return false; } }) : [];
    writeFileSync(HISTORY_FILE, [...keep, ...rows.map(r => JSON.stringify(r))].join("\n") + "\n");
  }
  console.log(JSON.stringify(backfillFrom ? { current, backfill: rows.slice(0, -1), all_payments_since_history_start: chain.payments.length } : current, null, 2));
} catch (e) { console.log(JSON.stringify({ error: scrub(e?.message || e) })); process.exit(1); }
