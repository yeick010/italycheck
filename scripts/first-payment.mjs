// ONE paid x402 call to ItalyCheck on Base mainnet (triggers x402 Bazaar indexing via the CDP facilitator).
// Usage: PAYER_PRIVATE_KEY=0x... node scripts/first-payment.mjs
// The payer must be a SEPARATE wallet (not PAY_TO) holding a few cents of USDC on Base. Cost: 0.005 USDC.
// Gas is paid by the facilitator (EIP-3009 transferWithAuthorization); no ETH needed.
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const URL_ = process.env.ITALYCHECK_URL || "https://italycheck.italycheck.workers.dev/v1/pa?cf=80016350821";
const PAY_TO = "0xde8380854ef9c926093832501d95a47f4c63fe7c".toLowerCase();
const MAX_ATOMIC = 10000n; // safety cap: refuse anything above 0.01 USDC

const pk = process.env.PAYER_PRIVATE_KEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) { console.error("Set PAYER_PRIVATE_KEY (0x + 64 hex)."); process.exit(1); }
const account = privateKeyToAccount(pk);
if (account.address.toLowerCase() === PAY_TO) { console.error("Payer must differ from PAY_TO."); process.exit(1); }

// Preflight: check the 402 offer before signing anything.
const pre = await fetch(URL_);
if (pre.status !== 402) { console.error("Expected 402, got", pre.status); process.exit(1); }
const offer = JSON.parse(Buffer.from(pre.headers.get("payment-required"), "base64").toString()).accepts[0];
console.log("Offer:", offer);
if (offer.network !== "eip155:8453" || offer.payTo.toLowerCase() !== PAY_TO ||
    offer.asset.toLowerCase() !== "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" || BigInt(offer.amount) > MAX_ATOMIC) {
  console.error("Offer does not match expected network/payTo/USDC/amount cap. Aborting."); process.exit(1);
}

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
});
console.log("Paying from", account.address, "...");
const res = await fetchWithPayment(URL_, { method: "GET" });
console.log("HTTP", res.status);
console.log("Body:", JSON.stringify(await res.json().catch(() => null), null, 2));
const hdr = res.headers.get("payment-response") || res.headers.get("x-payment-response");
if (hdr) {
  const s = decodePaymentResponseHeader(hdr);
  console.log("Settlement:", s);
  if (s?.transaction) console.log("Tx:", `https://basescan.org/tx/${s.transaction}`);
} else console.log("No payment-response header (payment may not have settled).");
const ext = res.headers.get("extension-responses");
if (ext) console.log("Extension responses (bazaar status):", Buffer.from(ext, "base64").toString());
