#!/usr/bin/env node
// Empty-wallet x402 probe: a fresh random key (never funded) signs a payment for MCP tools/call and (with HTTP=1) /v1/pa.
// Expected result: the facilitator rejects at verify ("insufficient funds ... execution reverted"); no money can move.
// EVERY request carries UA "italycheck-probe/1" so growth-eval / logs-summary drop it from the funnel and payment
// metrics (scripts/lib/probes.mjs). The 24/10 run of the old ad-hoc copy sent the HTTP calls with UA "node", which
// made 2 of its 4 failures look like customer traffic.
// Usage: BASE=http://127.0.0.1:8787 [HTTP=1] node scripts/probe-empty-wallet.mjs   (default BASE is production)
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { INTERNAL_PROBE_UA } from "./lib/probes.mjs";
const BASE = process.env.BASE || "https://italycheck.italycheck.workers.dev";
const UA = `${INTERNAL_PROBE_UA}/1`;
const acct = privateKeyToAccount(generatePrivateKey());
const client = new x402Client().register("eip155:8453", new ExactEvmScheme(acct));
const H = { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": UA };
const call = meta => fetch(BASE + "/mcp", { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name: "lookup_italian_pa", arguments: { cf: "80016350821" }, ...(meta ? { _meta: meta } : {}) } }) }).then(r => r.json());
const unpaid = await call();
const payload = await client.createPaymentPayload(unpaid.result.structuredContent);
console.log("MCP paid (empty wallet):", JSON.stringify(await call({ "x402/payment": payload })).slice(0, 1500));
if (process.env.HTTP) {
  const U = BASE + "/v1/pa?cf=80016350821";
  const r402 = await fetch(U, { headers: { "user-agent": UA } });
  const req = JSON.parse(Buffer.from(r402.headers.get("payment-required"), "base64").toString());
  const p2 = await client.createPaymentPayload(req);
  const r = await fetch(U, { headers: { "user-agent": UA, "payment-signature": Buffer.from(JSON.stringify(p2)).toString("base64") } });
  const pr2 = r.headers.get("payment-required");
  console.log("HTTP paid (empty wallet):", r.status, pr2 ? JSON.parse(Buffer.from(pr2, "base64").toString()).error : await r.text());
}
