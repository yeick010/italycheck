// Read-only Base mainnet reads for ItalyCheck revenue (public JSON-RPC, no keys, no writes).
// Revenue truth = ERC-20 Transfer logs of USDC/EURC to PAY_TO. Used by growth-eval.mjs and revenue-state.mjs.
export const PAY_TO = "0xde8380854ef9c926093832501d95a47f4c63fe7c";
export const TOKENS = { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", EURC: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" };
export const EXCLUDED_PAYERS = ["0x00D17A447f286fd673c6bFFb59fDe031b65ee5d8"].map(a => a.toLowerCase()); // own test wallet
export const RPCS = ["https://base.publicnode.com", "https://mainnet.base.org"];
export const RPC_MAX_RANGE = 49_999; // publicnode getLogs limit is 50k blocks
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_BLOCK_SECONDS = 2;

let rpcId = 0;
// fetchImpl is injectable for tests. Returns { result, url } so callers can cite which RPC answered.
export function makeRpc({ rpcs = RPCS, fetchImpl = fetch, retries = 6, delayMs = 500 } = {}) {
  const used = new Set();
  async function rpc(method, params) {
    let last;
    for (let attempt = 0; attempt < retries; attempt++) {
      const url = rpcs[attempt % rpcs.length];
      try {
        const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
        const j = await r.json();
        if (j.error) throw new Error(`${url}: ${j.error.message}`);
        used.add(url);
        return j.result;
      } catch (e) { last = e; if (delayMs) await new Promise(res => setTimeout(res, delayMs * (attempt + 1))); }
    }
    throw last;
  }
  rpc.used = used;
  return rpc;
}

const hex = n => "0x" + n.toString(16);
const topicAddr = a => "0x" + a.toLowerCase().slice(2).padStart(64, "0");

// All USDC/EURC transfers to PAY_TO since an ISO date (block estimated from Base's 2 s block time, minus a 2000-block margin).
export async function chainPayments(since, { rpc = makeRpc(), payTo = PAY_TO, excluded = EXCLUDED_PAYERS } = {}) {
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const latestTs = parseInt((await rpc("eth_getBlockByNumber", [hex(latest), false])).timestamp, 16) * 1000;
  const start = Math.max(0, latest - Math.ceil((latestTs - Date.parse(since)) / 1000 / BASE_BLOCK_SECONDS) - 2000);
  const symbolOf = Object.fromEntries(Object.entries(TOKENS).map(([s, a]) => [a.toLowerCase(), s]));
  const logs = [];
  for (let f = start; f <= latest; f += RPC_MAX_RANGE + 1) {
    const t = Math.min(f + RPC_MAX_RANGE, latest);
    logs.push(...await rpc("eth_getLogs", [{ fromBlock: hex(f), toBlock: hex(t), address: Object.values(TOKENS), topics: [TRANSFER_TOPIC, null, topicAddr(payTo)] }]));
  }
  const tsCache = {};
  const payments = [], excludedTransfers = [];
  for (const l of logs) {
    tsCache[l.blockNumber] ??= parseInt((await rpc("eth_getBlockByNumber", [l.blockNumber, false])).timestamp, 16) * 1000;
    const from = "0x" + l.topics[1].slice(26).toLowerCase();
    const amount = Number(BigInt(l.data)) / 1e6; // USDC and EURC both have 6 decimals
    const p = { ts: tsCache[l.blockNumber], block: parseInt(l.blockNumber, 16), token: symbolOf[l.address.toLowerCase()], amount, from, tx: l.transactionHash };
    if (amount <= 0 || excluded.includes(from) || from === payTo.toLowerCase()) excludedTransfers.push(p); else payments.push(p);
  }
  const byTs = (a, b) => a.ts - b.ts;
  return { payments: payments.sort(byTs), excluded: excludedTransfers.sort(byTs), scanned_blocks: [start, latest], chain_head_ts: latestTs };
}

// balanceOf(PAY_TO) for each token (raw 6-decimal units) and the wallet's outgoing tx count, at the given block.
export async function walletSnapshot({ rpc = makeRpc(), payTo = PAY_TO, block = "latest" } = {}) {
  const tag = typeof block === "number" ? hex(block) : block;
  const data = "0x70a08231" + payTo.toLowerCase().slice(2).padStart(64, "0");
  const balances = {};
  for (const [sym, addr] of Object.entries(TOKENS)) balances[sym] = Number(BigInt(await rpc("eth_call", [{ to: addr, data }, tag])));
  const nonce = parseInt(await rpc("eth_getTransactionCount", [payTo, tag]), 16);
  return { balances_raw: balances, nonce };
}
