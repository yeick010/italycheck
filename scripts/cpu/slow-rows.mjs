// Read-only: per-second rows of italycheck invocations with max CPU, in [since, until]. Never prints the token.
const TOKEN = process.env.CLOUDFLARE_API_TOKEN, A = "3f0071e891f5fc1d8a71ba5cd8f0b074";
const [since, until, minUs] = process.argv.slice(2);
const Q = `query($a:String!,$f:AccountWorkersInvocationsAdaptiveFilter_InputObject!){viewer{accounts(filter:{accountTag:$a}){
 g: workersInvocationsAdaptive(limit:10000, filter:$f, orderBy:[datetime_ASC]){ sum{requests} max{cpuTime} dimensions{datetime scriptVersion status} }}}}`;
const rowsAll = [];
for (let t = Date.parse(since); t < Date.parse(until); t += 6 * 3600e3) {
const f = { datetime_geq: new Date(t).toISOString(), datetime_lt: new Date(Math.min(Date.parse(until), t + 6 * 3600e3)).toISOString(), scriptName: "italycheck" };
const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: Q, variables: { a: A, f } }) });
const j = await r.json();
if (j.errors?.length) { console.log(JSON.stringify(j.errors.map(e => e.message))); process.exit(1); }
const g = j.data.viewer.accounts[0].g; if (g.length >= 10000) console.error("truncated", f.datetime_geq); rowsAll.push(...g); }
const rows = rowsAll;
console.error("rows", rows.length);
for (const x of rows) if (x.max.cpuTime >= +(minUs || 0)) console.log(x.dimensions.datetime, x.dimensions.scriptVersion.slice(0, 8), x.dimensions.status, x.sum.requests, (x.max.cpuTime / 1000).toFixed(2));
