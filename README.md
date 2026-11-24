# ItalyCheck (MVP)

[![ItalyCheck MCP server](https://mcprush.com/badge/italycheck-mcp/card.svg)](https://mcprush.com/to/italycheck-mcp?ref=badge)
Verifica fornitori pagata a chiamata dagli agenti AI. Solo fonti pubbliche gratuite. Pagamento x402 (USDC o EURC su Base).

## Endpoint
| Path | Prezzo | Fonte |
|---|---|---|
| `GET /v1/vat?vat=IT00743110157` | $0.01 | EU VIES REST (passthrough in tempo reale, nessuna conservazione) |
| `GET /v1/pa?cf=80016350821` | $0.005 USDC o €0.005 EURC | IndicePA, dataset "Enti" (AgID, CC BY 4.0, attribuzione obbligatoria). Addebito solo se l'ente è trovato (200): codice fiscale malformato 400, non trovato 404, IndicePA giù 502, nessun addebito |
| `GET /v1/counterparty?id=80016350821` | $0.01 USDC o €0.01 EURC | Verifica controparte: checksum + IndicePA "Enti" + "Unità Organizzative che ricevono fatture elettroniche" (AgID, CC BY 4.0). Solo dati PA. Input malformato, check digit errato o IndicePA giù: risposta 400/422/502, nessun addebito |
| `GET /v1/vat/format?vat=...` | gratis | checksum P.IVA offline |
| `GET /` | gratis | catalogo con descrizioni per agenti |

## Uso
    npm install
    npm test              # test live su VIES + IndicePA, 402 x402, MCP
    npm run dev           # senza pagamenti, porta 8787
    npm start             # con x402 (testnet Base Sepolia, facilitator x402.org)
    ITALYCHECK_URL=https://... npm run mcp   # server MCP stdio (proxy). ITALYCHECK_LOCAL=1 = lookup locali

## Passare in produzione (NON fatto)
1. `PAY_TO` = indirizzo wallet Base di Yeison.
2. `X402_NETWORK=eip155:8453`; facilitator CDP (`npm i @coinbase/x402`, chiavi `CDP_API_KEY_ID/SECRET`; 1.000 tx/mese gratis, poi $0.001).
3. `npx wrangler deploy` su Cloudflare Workers Free (uso commerciale consentito, 100k richieste/giorno, 10 ms CPU).
4. Lo scopre il Bazaar dopo il primo pagamento regolato tramite facilitator CDP. Pubblicare il MCP su MCPize/Smithery.

## Vincoli legali
- Il disclaimer VIES consente l'uso solo per verificare la partita IVA per operazioni intracomunitarie. È vietata ogni estrazione non conforme e l'abuso viene bloccato per IP (es. stessa partita IVA più volte al giorno). Quindi niente cache condivisa, niente archivi, niente scraping massivo.
- IndicePA: CC BY 4.0, va citata la fonte "© AgID – IndicePA".

## Stato del deploy (16/10/2026)
- Online: https://italycheck.italycheck.workers.dev (Cloudflare Workers Free, Base Sepolia testnet, facilitator x402.org)
- A pagamento: `/v1/pa` ($0.005) e `/v1/counterparty` ($0.01, `PRICE_COUNTERPARTY`, default nel codice). `/v1/vat` (VIES) disattivato: `ENABLE_VAT="0"`, in attesa di parere legale.
- Deploy: `CLOUDFLARE_ACCOUNT_ID=... npx -y -p node@22 node ./node_modules/wrangler/bin/wrangler.js deploy` (wrangler 4 richiede Node 22).
- Il Worker crea una nuova app per ogni richiesta e mette in cache solo la risposta "supported" del facilitator, come dati. Condividere promise in corso tra più richieste bloccava le richieste su Workers.

## Mainnet (16/10/2026, sera)
- Rete Base mainnet `eip155:8453`, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, facilitator CDP. I segreti `CDP_API_KEY_ID` e `CDP_API_KEY_SECRET` sono in Cloudflare (`wrangler secret`).
- Bazaar: estensione discovery con schema e esempio. Validato da CDP `/x402/validate`: valid true.
- MCP remoto: `POST /mcp` (Streamable HTTP, stateless). `lookup_italian_pa` ($0.005) e `verify_italian_counterparty` ($0.01) si pagano con x402 via MCP (`@x402/mcp`); un risultato `isError` non viene addebitato.
- CPU: `src/bazaar-shim.js` (alias wrangler) salta la rivalidazione ajv per ogni richiesta. JWT CDP e risposta "supported" sono in cache come dati.
- Vedi SUBMISSIONS.md per la discovery.

## EURC (24/10/2026)
- `/v1/pa` e il tool MCP `lookup_italian_pa` accettano anche EURC su Base, oltre a USDC. USDC resta la prima opzione (default) in `accepts`; EURC è la seconda, stesso importo nominale (0.005 EURC = `5000` unità, 6 decimali), stesso `payTo`.
- EURC Base mainnet `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` (Circle: https://developers.circle.com/stablecoins/eurc-contract-addresses). Base Sepolia `0x808456652fdb597867f38412077A9182bf77359F`. Dominio EIP-712 letto on-chain: name `EURC`, version `2`.
- Il facilitator CDP accetta ogni ERC-20 con EIP-3009 (USDC, EURC) sulle sue reti EVM: https://docs.cdp.coinbase.com/x402/support/faq
- Nota per chi compra: i client `@x402` 2.28 con `spendControls` predefiniti accettano solo gli asset predefiniti (USDC). Per pagare in EURC servono `spendControls.allowedAssets` con EURC, oppure `allowedAssets: true`.
- Per disattivare EURC: variabile `DISABLE_EURC="1"`.

## Risposta 402 leggibile e discovery (24/11/2026)
- Analisi 7 giorni (17–24/11): 4.810 risposte 402, tutte su `GET /v1/pa`; il corpo JSON era `{}` e tutto stava solo nell'header base64 `PAYMENT-REQUIRED`. ~1.500 richieste a `/.well-known/x402`, `/openapi.json`, `/llms.txt` finivano in 404; 137 `POST /v1/pa` in 404.
- Ora il corpo del 402 JSON ripete l'oggetto `PAYMENT-REQUIRED` decodificato (header e `accepts` invariati) e aggiunge `message` e `howToPay`: prezzo, asset, rete, header `PAYMENT-SIGNATURE`, esempio `@x402/fetch`, regola di addebito, link alla documentazione. Con `X-PAYMENT` (v1) arriva anche un `hint`.
- `POST`/altri metodi su `/v1/pa` e `/v1/counterparty` senza pagamento: 405 `Allow: GET, HEAD` con la GET da usare.
- Nuovi documenti gratuiti: `/.well-known/x402` (formato x402scan, senza ownershipProofs), `/openapi.json` (con `x-payment-info`), `/llms.txt`.
- HEAD resta 402 senza corpo, senza lookup e senza addebito. Prezzi, wallet, termini e `wrangler.toml` invariati.
- Smoke: `SMOKE_GUIDE_INFO=1` (o `PRE_SMOKE_GUIDE_INFO=1` per lo script di deploy) per versioni precedenti.

## /v1/pa: niente addebito se non trovato (24/11/2026)
- Decisione di Yeison (24/11/2026 11:52): "la ricerca enti non deve addebitare se il codice fiscale è malformato o non trovato".
- `GET /v1/pa`: 200 solo se l'ente è in IndicePA (addebitato). Codice fiscale malformato o mancante 400, non trovato 404 (`status: "not_found"`), IndicePA irraggiungibile 502: il middleware x402 non fa settle (nessun addebito). Stesso schema di `/v1/counterparty`.
- MCP `lookup_italian_pa`: negli stessi casi il risultato è `isError`, quindi niente settle.
- Prezzi (5000 / 10000), wallet, asset e `wrangler.toml` invariati. Smoke: `SMOKE_BILLING_INFO=1` (`PRE_SMOKE_BILLING_INFO=1` nello script di deploy) per versioni precedenti.
