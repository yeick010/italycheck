// Read-only: dump italycheck request log lines (source fields) to events.jsonl, in 1h chunks. Never prints the token.
import { writeFileSync } from "node:fs";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN, A = "3f0071e891f5fc1d8a71ba5cd8f0b074";
const [from, to] = process.argv.slice(2).map(s => Date.parse(s));
const out = [];
for (let t = from; t < to; t += 3600e3) {
  const body = { queryId: "adhoc", timeframe: { from: t, to: Math.min(to, t + 3600e3) }, view: "events", limit: 2000,
    parameters: { filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: "italycheck" }] } };
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${A}/workers/observability/telemetry/query`, { method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null;
  for (let k = 0; k < 4 && !j; k++) { try { j = await r.clone().json(); } catch { await new Promise(z => setTimeout(z, 3000)); } }
  if (!j) { console.error("chunk failed", new Date(t).toISOString(), r.status); continue; }
  const ev = j.result?.events?.events || [];
  if (ev.length >= 2000) console.error("truncated chunk", new Date(t).toISOString());
  for (const e of ev) out.push({ ts: e.timestamp, v: e.$workers?.scriptVersion?.id?.slice(0, 8), ...e.source });
}
writeFileSync("events.jsonl", out.map(o => JSON.stringify(o)).join("\n"));
console.log("events", out.length, out.length ? new Date(Math.min(...out.map(o => o.ts))).toISOString() : "");
