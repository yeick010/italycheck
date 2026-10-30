#!/usr/bin/env node
// Rebuilds italycheck_revenue_state.json from Base mainnet (read-only public RPC). Replaces the old hand-run check
// (no script existed: the file was written by hand on 18/10 06:05 and never again).
// Usage: node scripts/revenue-state.mjs [--out /workspace/italycheck_revenue_state.json] [--since 2026-10-12T22:00:00Z] [--print]
// Every number carries its source: RPC URL(s), block range, tx hash per payment. No keys, no writes on-chain.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chainPayments, walletSnapshot, makeRpc, PAY_TO, TOKENS, EXCLUDED_PAYERS } from "./lib/onchain.mjs";

const HISTORY_START = "2026-10-12T22:00:00Z"; // 13/10 00:00 Rome, before launch (16/10)
const rome = ms => new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Rome" }) + " Europe/Rome";
const round6 = x => Math.round(x * 1e6) / 1e6;

// Pure: chain scan + wallet snapshot -> state object (same core fields as the 18/10 file, plus sources).
export function buildRevenueState(chain, snap, { now = Date.now(), rpcs = [] } = {}) {
  const sum = tok => round6(chain.payments.filter(p => p.token === tok).reduce((s, p) => s + p.amount, 0));
  const payers = [...new Set(chain.payments.map(p => p.from))];
  const perPayer = Object.fromEntries(payers.map(a => [a, chain.payments.filter(p => p.from === a).length]));
  return {
    last_check: new Date(now).toISOString(), last_check_rome: rome(now),
    last_scanned_block: chain.scanned_blocks[1], first_scanned_block: chain.scanned_blocks[0], chain_head_time_rome: rome(chain.chain_head_ts),
    pay_to: PAY_TO,
    usdc_balance_raw: snap.balances_raw.USDC, usdc_balance: snap.balances_raw.USDC / 1e6,
    eurc_balance_raw: snap.balances_raw.EURC, eurc_balance: snap.balances_raw.EURC / 1e6,
    wallet_nonce: snap.nonce,
    real_revenue_usdc: sum("USDC"), real_revenue_eurc: sum("EURC"),
    real_payments_count: chain.payments.length,
    real_payers: payers, real_payers_count: payers.length,
    returning_payers: payers.filter(a => perPayer[a] >= 2),
    real_payments: chain.payments.map(p => ({ from: p.from, token: p.token, amount: p.amount, block: p.block,
      time: new Date(p.ts).toISOString(), time_rome: rome(p.ts), tx: p.tx, explorer: `https://basescan.org/tx/${p.tx}` })),
    excluded_transfers: chain.excluded.map(p => ({ from: p.from, token: p.token, amount: p.amount, block: p.block, time_rome: rome(p.ts), tx: p.tx,
      why: EXCLUDED_PAYERS.includes(p.from) ? "own test wallet" : "self/zero transfer" })),
    sources: {
      method: "eth_getLogs Transfer(from, to=PAY_TO) on USDC and EURC contracts, blocks first..last_scanned_block; eth_getBlockByNumber for times; balanceOf + eth_getTransactionCount at last_scanned_block",
      rpc: rpcs, tokens: TOKENS, since: HISTORY_START, script: "scripts/revenue-state.mjs",
      caveat: "On-chain transfers prove money received, not who the payer is (agent, crawler or test). Balance includes any non-payment transfers.",
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const out = arg("--out", "/workspace/italycheck_revenue_state.json");
  try {
    const rpc = makeRpc();
    const chain = await chainPayments(arg("--since", HISTORY_START), { rpc });
    const snap = await walletSnapshot({ rpc, block: chain.scanned_blocks[1] });
    const state = buildRevenueState(chain, snap, { rpcs: [...rpc.used] });
    const json = JSON.stringify(state, null, 2) + "\n";
    if (process.argv.includes("--print")) process.stdout.write(json);
    else { writeFileSync(out, json); console.log(JSON.stringify({ wrote: out, payments: state.real_payments_count, usdc: state.real_revenue_usdc, eurc: state.real_revenue_eurc, block: state.last_scanned_block })); }
  } catch (e) { console.log(JSON.stringify({ error: String(e?.message || e) })); process.exit(1); }
}
