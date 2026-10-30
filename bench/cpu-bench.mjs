#!/usr/bin/env node
// Local CPU benchmark of the Worker bundle (same esbuild alias as wrangler.toml), per request type, cold and warm.
// Usage: node bench/cpu-bench.mjs [--n 200] [--json]
// Method: esbuild bundles src/worker.js (alias @x402/extensions/bazaar -> src/bazaar-shim.js) to bench/.out/worker.mjs.
// For each scenario a FRESH Node process imports the bundle, then measures process.cpuUsage() (user+system) around
// worker.fetch(): the first call ("cold": first request of that kind in a new isolate) and N more ("warm": p50/p99).
// All network is stubbed in-process (facilitator /supported /verify /settle, IndicePA), so only our CPU is counted.
// Limits: Node/V8 on this box is not workerd on Cloudflare hardware; Cloudflare CPU time excludes startup and may
// differ by a constant factor. Use the numbers to compare before/after on the same machine, not as Cloudflare ms.
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "bench", ".out", "worker.mjs");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
export const SCENARIOS = ["free_root", "not_found_404", "pa_unpaid_402_same_url", "pa_unpaid_402_new_url", "mcp_initialize",
  "mcp_notifications_initialized", "mcp_tools_list", "mcp_tools_call_unpaid", "pa_paid_ok", "mcp_paid_ok", "pa_payment_garbage"];

if (process.argv[2] === "--child") {
  const [, , , scenario, n] = process.argv;
  await child(scenario, +n);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  execFileSync(join(ROOT, "node_modules/.bin/esbuild"), ["src/worker.js", "--bundle", "--format=esm", "--platform=node", "--log-level=error",
    "--conditions=workerd,worker,browser", "--alias:@x402/extensions/bazaar=./src/bazaar-shim.js", `--outfile=${OUT}`], { cwd: ROOT, stdio: "inherit" });
  const n = +arg("--n", 200);
  const rows = {};
  for (const s of SCENARIOS) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", s, String(n)], { cwd: ROOT, encoding: "utf8" });
    try { rows[s] = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { rows[s] = { error: (r.stderr || r.stdout).slice(-400) }; }
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log("scenario".padEnd(32), "import_ms".padStart(9), "cold_ms".padStart(8), "warm_p50".padStart(9), "warm_p99".padStart(9), "status");
    for (const [s, r] of Object.entries(rows)) console.log(s.padEnd(32), r.error ? "ERROR " + r.error : [r.import_ms, r.cold_ms, r.warm_p50_ms, r.warm_p99_ms].map(x => String(x).padStart(9)).join("") + "  " + r.status);
  }
}

async function child(scenario, n) {
  const { generateKeyPairSync } = await import("node:crypto");
  const { x402Client } = await import("@x402/core/client");
  const { ExactEvmScheme } = await import("@x402/evm");
  const { privateKeyToAccount } = await import("viem/accounts");
  const NET = "eip155:8453", PAYER = privateKeyToAccount("0x" + "11".repeat(32));
  // Fake Ed25519 CDP key (64 bytes seed+pub, base64) so the CDP JWT path runs like production. Never a real key.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "jwk" }).d, pub = publicKey.export({ format: "jwk" }).x;
  const secret = Buffer.concat([Buffer.from(seed, "base64url"), Buffer.from(pub, "base64url")]).toString("base64");
  const env = { X402_NETWORK: NET, PAY_TO: "0xde8380854ef9c926093832501d95a47f4c63fe7c", ENABLE_VAT: "0", PRICE_PA: "$0.005",
    CDP_API_KEY_ID: "bench-key-id", CDP_API_KEY_SECRET: secret };
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const IPA = { result: { records: [{ Codice_IPA: "c_g273", Denominazione_ente: "Comune di Palermo", Tipologia: "Pubbliche Amministrazioni", Codice_ateco: "84.11.10",
    Indirizzo: "Piazza Pretoria, 1", CAP: "90133", Sito_istituzionale: "www.comune.palermo.it", Tipo_Mail1: "Pec", Mail1: "protocollo@cert.comune.palermo.it" }] } };
  globalThis.fetch = async (u) => {
    const url = String(u?.url ?? u);
    if (url.includes("indicepa")) return json(IPA);
    if (url.endsWith("/supported")) return json({ kinds: [{ x402Version: 2, scheme: "exact", network: NET }], extensions: ["bazaar"], signers: {} });
    if (url.endsWith("/verify")) return json({ isValid: true, payer: PAYER.address });
    if (url.endsWith("/settle")) return json({ success: true, transaction: "0x" + "ab".repeat(32), network: NET, payer: PAYER.address });
    return json({}, 404);
  };
  const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  // Node loads undici/webstreams/WebCrypto lazily on first use; workerd has them built in. Touch them before timing.
  await new Response(new Request("https://x.invalid/", { method: "POST", body: "{}" }).body).text();
  new Headers({ a: "b" }); structuredClone({ a: 1 }); new TextEncoder().encode("x"); new URL("https://x.invalid/?a=1");
  await crypto.subtle.digest("SHA-256", new Uint8Array(1)); btoa("x"); atob("eA==");
  const t0 = cpu();
  const worker = (await import(OUT)).default;
  const importMs = cpu() - t0;
  const quiet = console.log; console.log = () => {}; console.error = () => {};
  const B = "https://italycheck.italycheck.workers.dev";
  const mcpReq = (body, id = 1) => new Request(B + "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id, ...body }),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" } });
  const client = new x402Client().register(NET, new ExactEvmScheme(PAYER));
  // Payment payloads are signed BEFORE timing (that is the client's CPU, not ours).
  let paHeader = null, mcpMeta = null;
  if (scenario === "pa_paid_ok") {
    const r = await worker.fetch(new Request(B + "/v1/pa?cf=99999999999"), env, {});
    const pr = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString());
    paHeader = Buffer.from(JSON.stringify(await client.createPaymentPayload(pr))).toString("base64");
  }
  if (scenario === "mcp_paid_ok") {
    const r = await (await worker.fetch(mcpReq({ method: "tools/call", params: { name: "lookup_italian_pa", arguments: { cf: "99999999999" } } }), env, {})).json();
    mcpMeta = { "x402/payment": await client.createPaymentPayload(r.result.structuredContent) };
  }
  // ^ these warm-up calls only happen for paid scenarios; they make "cold" for paid = first PAID request after one unpaid one.
  let i = 0;
  const make = {
    free_root: () => new Request(B + "/"),
    not_found_404: () => new Request(B + "/robots.txt"),
    pa_unpaid_402_same_url: () => new Request(B + "/v1/pa?cf=80016350821"),
    pa_unpaid_402_new_url: () => new Request(B + `/v1/pa?cf=${String(80016350821 + i++).padStart(11, "0")}`),
    mcp_initialize: () => mcpReq({ method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "b", version: "1" } } }),
    mcp_notifications_initialized: () => new Request(B + "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" } }),
    mcp_tools_list: () => mcpReq({ method: "tools/list", params: {} }),
    mcp_tools_call_unpaid: () => mcpReq({ method: "tools/call", params: { name: "lookup_italian_pa", arguments: { cf: "80016350821" } } }),
    pa_paid_ok: () => new Request(B + "/v1/pa?cf=80016350821", { headers: { "payment-signature": paHeader } }),
    mcp_paid_ok: () => mcpReq({ method: "tools/call", params: { name: "lookup_italian_pa", arguments: { cf: "80016350821" }, _meta: mcpMeta } }),
    pa_payment_garbage: () => new Request(B + "/v1/pa?cf=80016350821", { headers: { "payment-signature": "garbage" } }),
  }[scenario];
  const once = async () => { const req = make(); const a = cpu(); const r = await worker.fetch(req, env, { waitUntil() {} }); await r.text(); return [cpu() - a, r.status]; };
  const [cold, status] = await once();
  const warm = [];
  for (let k = 0; k < n; k++) warm.push((await once())[0]);
  warm.sort((a, b) => a - b);
  const q = p => !warm.length ? null : +warm[Math.min(warm.length - 1, Math.floor(p * warm.length))].toFixed(2);
  console.log = quiet;
  console.log(JSON.stringify({ import_ms: +importMs.toFixed(1), cold_ms: +cold.toFixed(2), warm_p50_ms: q(0.5), warm_p99_ms: q(0.99), status }));
}
