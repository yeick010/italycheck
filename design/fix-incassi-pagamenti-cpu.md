# Fix: incassi, pagamenti falliti, CPU — 30/10/2026

Branch `fix/incassi-pagamenti-cpu` (da `main` c4a8e58), **non pushato, non deployato**. Nessuna scrittura su Cloudflare, Stripe, Coinbase o on-chain; solo letture pubbliche (RPC Base, API Observability Cloudflare in sola lettura, GET pubblici a produzione).

## 1. Incassi: `italycheck_revenue_state.json` fermo al 18/10

**Causa.** Nessuno script né job ha mai aggiornato quel file: nel repo e sul box non c'è codice che lo scriva. È stato scritto a mano una volta il 18/10 alle 06:05 (Europe/Rome) e già allora era incompleto (mancavano i pagamenti delle 06:46 e 14:00 dello stesso giorno). Il ripristino del box del 23/10 l'ha solo ricopiato (mtime 23/10 17:18).

**Fix.** `scripts/revenue-state.mjs` rigenera il file da dati on-chain pubblici; la logica on-chain è condivisa con `growth-eval.mjs` in `scripts/lib/onchain.mjs` (prima era duplicata). Uso: `node scripts/revenue-state.mjs [--print] [--out path] [--since ISO]`. Vecchio file salvato in `design/revenue_state.before-2026-10-30.json`.

**Dati aggiornati** (scritti il 30/10 alle 10:14 Europe/Rome, blocco 53281106, RPC base.publicnode.com; fonte: `eth_getLogs` Transfer → PAY_TO 0xde83…fe7c sui contratti USDC/EURC di Base, `balanceOf`, `eth_getTransactionCount`):

| Ora (Europe/Rome) | Importo | Tx |
|---|---|---|
| 18/10 05:19 | 0.005 USDC | 0xb739a9cd… |
| 18/10 06:46 | 0.005 USDC | 0x2e4c19ac… |
| 18/10 14:00 | 0.005 USDC | 0x9478dda2… |
| 24/10 11:52 | 0.005 USDC | 0x34614970… |
| 24/10 17:09 | 0.005 USDC | 0x972b74a4… |
| 26/10 13:04 | 0.005 USDC | 0x504dc8ae… |
| 27/10 11:08 | 0.005 USDC | 0xa400e3d0… |

Totale: **7 pagamenti, 0.035 USDC, 0 EURC, 7 pagatori unici, 0 di ritorno.** Escluso: un trasferimento di test da 0.005 USDC dal nostro wallet (16/10 22:45, 0x906437fe…). Saldo USDC 0.04 = 0.035 + 0.005 di test; nonce del wallet 0 (non è mai uscito nulla). Le tx del 26/10 e del 27/10 sono state ricontrollate con `eth_getTransactionReceipt` su mainnet.base.org: status 1, 5000 unità USDC verso PAY_TO. Hash completi e link a basescan nel JSON.

**Ancora aperto.** Non c'è uno scheduler: il file si aggiorna solo lanciando lo script. Proposta (non attivata): una routine giornaliera che esegua `node scripts/revenue-state.mjs`.

## 2. Pagamenti falliti (2/2 nel campione)

**Evidenza** (API Workers Observability, sola lettura, eventi 20–30/10 con campo `payment`):
- 24/10 20:34:11 e 20:35:41 (Europe/Rome): 4 eventi `failed` (2 MCP con UA `italycheck-probe/1`, 2 `/v1/pa` con UA `node`). Motivo: `verify: insufficient funds or invalid authorization (invalid_payload: contract call failed: unable to call contract: execution reverted)`.
- 26/10 13:04 (UA AnnalistChecks, US) e 27/10 11:08 (UA agents-trust-delivery/1, DE): `settled`, 200; corrispondono ai pagamenti on-chain.

**Causa.** I fallimenti erano **le nostre sonde**: `/tmp/ic/probe.mjs` ("Empty-wallet probe: fresh random key (never funded)"), lanciato dopo il deploy del 24/10 (file di output con mtime 24/10 20:34:10 e 20:35:40, Europe/Rome). Una chiave nuova senza fondi firma un `transferWithAuthorization` e il facilitator lo rifiuta correttamente con "execution reverted". La sonda metteva l'UA di test solo sulle chiamate MCP, non su quelle HTTP, quindi metà dei fallimenti sembrava traffico di clienti. **Codice di pagamento: nessun bug trovato.** Dal 24/10 i tentativi reali sono 2 su 2 andati a buon fine.

**Fix (metriche, non pagamenti).**
- `scripts/lib/probes.mjs`: filtro UA `italycheck-probe` (`not_includes`) e una finestra fissa per la sonda del 24/10 (18:34:00–18:36:30Z, cioè 20:34:00–20:36:30 Europe/Rome).
- `growth-eval.mjs` conta escludendo entrambi. `logs-summary.mjs` esclude l'UA di sonda per default; `--include-probes` le include.
- `scripts/probe-empty-wallet.mjs`: versione nel repo della sonda, con l'UA di sonda su **ogni** richiesta. Non l'ho eseguita.
- Ora (30/10 10:20 Europe/Rome) i log disponibili partono dal 27/10 10:21 Europe/Rome (retention 3 giorni), quindi la sonda è già fuori finestra. growth-eval su 7 giorni riporta 1 tentativo loggato, 1 settled e 0 falliti; il campione è troppo piccolo per dare un tasso (soglia 5).

**Limite.** Due casi reali sono pochissimi: non provano che pagatori diversi non avrebbero problemi (per esempio una rete o un asset diverso). Nei log non c'è nessun fallimento di un cliente reale da analizzare.

## 3. CPU (p99 ≈ 53 ms contro il limite di 10 ms del piano Free)

**Diagnosi.** Il traffico è basso e distribuito su molti colo, quindi molte richieste arrivano su isolate appena creati. La prima richiesta per isolate paga la compilazione lazy di V8 e l'inizializzazione delle librerie: MCP SDK + zod + McpServer, oppure createApp + inizializzazione x402 + JWT CDP. Questo spiega p50 ≈ 5.5 ms contro p99 ≈ 53 ms. Traffico nelle 72 h fino al 30/10 (Observability): 6831 richieste; /mcp 2987 (initialize 1022, tools/list 811, notifications 732, tools/call 9), /v1/pa 1410 (402: 1246), 404: 2455. Le rotte calde sono quindi 402 non pagato, initialize, tools/list e notifications.

**Fix.** `src/fast-paths.js` risponde a queste rotte con dati statici, senza caricare SDK e x402:
- `fastUnpaid402`: 402 di `/v1/pa` per client non-browser, **identico byte per byte** a quello della libreria (testato su testnet, mainnet, DISABLE_EURC, prezzo custom, query diverse, e confrontato con la produzione live). Il paywall HTML per i browser e i casi non coperti (VAT attivo, rete o prezzo sconosciuti) passano dalla libreria.
- `fastMcp`: initialize, notifications/initialized, ping, tools/list e tools/call non pagato con risposta in cache. Le risposte sono identiche a quelle dell'SDK (testato). Tutto il resto, cioè errori, batch, header di protocollo non supportati, chiamate pagate e altri metodi, ricade sull'SDK.
- `createApp` non costruisce più il server x402 in modalità gratuita.

**Metodo di misura** (`bench/cpu-bench.mjs`, stesso script per prima e dopo; il "prima" è un worktree di `main`):
- Bundle esbuild di `src/worker.js` come in produzione (alias bazaar-shim, condizioni workerd/worker/browser).
- Per ogni scenario, un processo Node 20 nuovo: `process.cpuUsage()` sulla prima richiesta ("cold", cioè un isolate nuovo) e poi su 200 richieste calde (p50 e p99).
- Rete stub in-process (facilitator, IndicePA) e chiave Ed25519 finta per il percorso JWT.
- Mediana di 4 esecuzioni. Valori in ms di CPU locale.

| Scenario | cold prima → dopo | p50 caldo | p99 caldo |
|---|---|---|---|
| 402 /v1/pa (stesso URL) | 13.7 → **1.3** | 0.04 → 0.04 | 1.2 → 1.1 |
| 402 /v1/pa (URL nuovo) | 13.7 → **1.3** | 0.47 → 0.17 | 7.2 → 5.9 |
| MCP initialize | 17.2 → **1.9** | 0.78 → 0.12 | 12.0 → **1.4** |
| MCP notifications/initialized | 15.0 → **1.6** | 0.65 → 0.08 | 9.2 → **1.1** |
| MCP tools/list | 18.7 → **2.0** | 0.86 → 0.13 | 9.5 → **1.9** |
| MCP tools/call non pagato | 27.5 → 27.4 | 0.88 → 0.17 | 10.0 → **1.9** |
| / (gratis) | 2.3 → 1.9 | 0.05 → 0.05 | 0.9 → 1.1 |
| 404 | 2.4 → 2.1 | 0.04 → 0.04 | 0.6 → 0.9 |
| /v1/pa pagato ok | 8.6 → 21.4* | 1.0 → 1.0 | 8.9 → 9.3 |
| MCP pagato ok | 6.6 → 10.7* | 1.5 → 1.5 | 13.1 → 11.1 |
| pagamento non valido | 18.0 → 20.6* | 0.6 → 0.6 | 7.7 → 7.6 |

\* Questi non sono peggioramenti reali. Il bench prepara il pagamento con una richiesta non pagata non cronometrata. Prima quella richiesta scaldava le librerie x402; ora passa dal fast path, quindi l'inizializzazione si sposta sulla prima richiesta pagata. Il costo totale per isolate non cambia. Le richieste pagate sono rare (2 nelle 72 h), e la prima tools/call non pagata per isolate costa ancora quanto prima (9 nelle 72 h).

**Limiti della misura.** È tempo CPU di Node in locale, non tempo CPU di workerd su Cloudflare. L'import e lo startup dello script (circa 59 ms in locale) non sono contati, come su Cloudflare, dove lo startup ha un limite separato di 1 s. Le macchine sono diverse e le richieste non includono il JIT di produzione. Il miglioramento atteso è nel p99 (prime richieste su isolate freddi), ma **il p99 reale si saprà solo dopo il deploy**, con `scripts/cf-usage.mjs` / growth-eval dopo 24–48 h. Nei log non c'è la CPU per evento (invocation_logs = false).

Verifica extra: `wrangler dev --local` (Node 22, solo locale, testnet): 402, tools/list, initialize e tools/call non pagato rispondono correttamente sotto workerd.

## File cambiati
- Nuovi: `src/fast-paths.js`, `scripts/lib/onchain.mjs`, `scripts/lib/probes.mjs`, `scripts/revenue-state.mjs`, `scripts/probe-empty-wallet.mjs`, `bench/cpu-bench.mjs`, `test/fast-paths.js`, `design/revenue_state.before-2026-10-30.json`, questo file.
- Modificati: `src/app.js`, `src/remote-mcp.js`, `src/worker.js`, `scripts/growth-eval.mjs`, `scripts/logs-summary.mjs`, `test/run.js` (test live del 402 contro la produzione; exit code ≠ 0 se un test fallisce, prima usciva sempre con 0), `package.json` (`npm test` esegue anche `test/fast-paths.js`), `.gitignore` (`bench/.out/`).
- Fuori dal repo: `/workspace/italycheck_revenue_state.json` rigenerato.

## Test
`npm test`: **64 PASS, 0 FAIL** (31 in `test/run.js` + 33 in `test/fast-paths.js`). Include equivalenza fast/library per il 402, fast/SDK per MCP, fallback, revenue-state con RPC mock ed esclusione delle sonde.

## Deploy (solo dopo l'ok di Yeison)
```
cd /workspace/italycheck
git checkout fix/incassi-pagamenti-cpu && npm test
CLOUDFLARE_ACCOUNT_ID=3f0071e891f5fc1d8a71ba5cd8f0b074 npx -y -p node@22 node ./node_modules/wrangler/bin/wrangler.js deploy
# verifica
curl -si 'https://italycheck.italycheck.workers.dev/v1/pa?cf=80016350821' -H 'user-agent: italycheck-probe/1' | head -5   # atteso 402 + payment-required
curl -s -X POST https://italycheck.italycheck.workers.dev/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'user-agent: italycheck-probe/1' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# dopo 24-48 h
node scripts/cf-usage.mjs ; node scripts/growth-eval.mjs --days 7 --no-append ; node scripts/revenue-state.mjs
# merge (opzionale): git checkout main && git merge fix/incassi-pagamenti-cpu && git push
```
Rollback: `wrangler rollback` (stesso prefisso npx/node@22) oppure ridistribuire `main`.

## Ancora sconosciuto
- La CPU reale (p99) su Cloudflare dopo il deploy.
- Se i 7 pagatori siano agenti reali o crawler o test di terzi: la chain prova solo che il denaro è arrivato.
- Nessuno scheduler per `revenue-state.mjs`: serve una routine, se Yeison la vuole.
- La CPU per evento non è nei log (invocation_logs = false).
- Il tipo di chiave CDP in produzione (non letta). Il percorso JWT è stato misurato con una chiave Ed25519 finta.
