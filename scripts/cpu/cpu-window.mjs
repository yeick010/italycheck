// Read-only: CPU quantiles for italycheck in [since, until]. Never prints the token.
const [since, until] = process.argv.slice(2);
const TOKEN = process.env.CLOUDFLARE_API_TOKEN, A = "3f0071e891f5fc1d8a71ba5cd8f0b074";
const Q = `query($a:String!,$f:AccountWorkersInvocationsAdaptiveFilter_InputObject!){viewer{accounts(filter:{accountTag:$a}){
 byVer: workersInvocationsAdaptive(limit:20, filter:$f){ sum{requests errors cpuTimeUs} quantiles{cpuTimeP50 cpuTimeP99 cpuTimeP999} dimensions{scriptVersion} }
 byStatus: workersInvocationsAdaptive(limit:20, filter:$f){ sum{requests} dimensions{status} }
 overall: workersInvocationsAdaptive(limit:1, filter:$f){ sum{requests errors} quantiles{cpuTimeP50 cpuTimeP99 cpuTimeP999} }}}}`;
const f = { datetime_geq: since, datetime_leq: until, scriptName: "italycheck" };
const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: Q, variables: { a: A, f } }) });
const j = await r.json();
if (j.errors?.length) { console.log(JSON.stringify(j.errors.map(e => e.message))); process.exit(1); }
const a = j.data.viewer.accounts[0], ms = us => us == null ? null : Math.round(us / 10) / 100;
const fmt = g => ({ requests: g.sum.requests, errors: g.sum.errors, p50: ms(g.quantiles.cpuTimeP50), p99: ms(g.quantiles.cpuTimeP99), p999: ms(g.quantiles.cpuTimeP999) });
console.log(JSON.stringify({ window: [since, until], overall: a.overall[0] ? fmt(a.overall[0]) : null,
  byVersion: a.byVer.map(g => ({ v: g.dimensions.scriptVersion, ...fmt(g) })),
  statuses: Object.fromEntries(a.byStatus.map(g => [g.dimensions.status, g.sum.requests])) }, null, 1));
