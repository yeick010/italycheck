// Payment hooks on an x402ResourceServer (per request: paid routes build a fresh server each time).
// - logPayment: records the outcome (verified / settled / failed + short reason) into the request log object.
// - readableMcpFailures: MCP only. @x402/mcp's createPaymentWrapper turns a THROWN verify error (the CDP facilitator
//   answers HTTP 400 {isValid:false,...}, which HTTPFacilitatorClient throws as VerifyError) into a bare
//   "Internal Server Error". Recovering the throw as {isValid:false, invalidReason} makes the wrapper return its
//   standard payment-required tool result (isError, structuredContent {x402Version, error, resource, accepts}),
//   like the HTTP middleware's 402. Same for thrown settle errors ("Payment settlement failed: <reason>").
//   Never marks anything valid/successful, so the handler never runs and nothing settles on a failure.

const short = (s, n = 160) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// "invalid_payload: contract call failed: unable to call contract: execution reverted" -> readable reason.
export function readableReason(reason, message) {
  const raw = [reason, message].filter(Boolean).join(": ") || "unknown reason";
  if (/insufficient[_ ](balance|funds)/i.test(raw)) return `insufficient funds (${raw})`;
  if (/execution reverted/i.test(raw)) return `insufficient funds or invalid authorization (${raw})`;
  return raw;
}
const errReason = e => readableReason(e?.invalidReason ?? e?.errorReason, e?.invalidMessage ?? e?.errorMessage ?? (e?.invalidReason || e?.errorReason ? undefined : e?.message));

export function logPayment(server, log) {
  if (!log) return server;
  server.onAfterVerify(({ result }) => {
    log.payment = result?.isValid ? "verified" : "failed";
    if (!result?.isValid) log.payment_reason ??= short("verify: " + readableReason(result?.invalidReason, result?.invalidMessage));
  });
  server.onVerifyFailure(({ error }) => { log.payment = "failed"; log.payment_reason = short("verify: " + errReason(error)); });
  server.onAfterSettle(() => { log.payment = "settled"; delete log.payment_reason; });
  server.onSettleFailure(({ error }) => { log.payment = "failed"; log.payment_reason = short("settle: " + errReason(error)); });
  return server;
}

export function readableMcpFailures(server) {
  server.onVerifyFailure(({ error }) => ({ recovered: true,
    result: { isValid: false, invalidReason: `payment verification failed: ${errReason(error)}`, ...(error?.payer ? { payer: error.payer } : {}) } }));
  server.onSettleFailure(({ error, requirements }) => ({ recovered: true,
    result: { success: false, errorReason: errReason(error), transaction: error?.transaction || "", network: error?.network || requirements?.network } }));
  return server;
}
