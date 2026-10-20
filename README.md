# ItalyCheck (MVP)

[![ItalyCheck MCP server](https://mcprush.com/badge/italycheck-mcp/card.svg)](https://mcprush.com/to/italycheck-mcp?ref=badge)
Verifica fornitori pagata a chiamata dagli agenti AI. Solo fonti pubbliche gratuite. Pagamento x402 (USDC su Base).

## Endpoint
| Path | Prezzo | Fonte |
|---|---|---|
| `GET /v1/vat?vat=IT00743110157` | $0.01 | EU VIES REST (passthrough in tempo reale, nessuna conservazione) |
| `GET /v1/pa?cf=80016350821` | $0.005 | IndicePA, dataset "Enti" (AgID, CC BY 4.0, attribuzione obbligatoria) |
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
- Solo `/v1/pa` a pagamento. `/v1/vat` (VIES) disattivato: `ENABLE_VAT="0"`, in attesa di parere legale.
- Deploy: `CLOUDFLARE_ACCOUNT_ID=... npx -y -p node@22 node ./node_modules/wrangler/bin/wrangler.js deploy` (wrangler 4 richiede Node 22).
- Il Worker crea una nuova app per ogni richiesta e mette in cache solo la risposta "supported" del facilitator, come dati. Condividere promise in corso tra più richieste bloccava le richieste su Workers.

## Mainnet (16/10/2026, sera)
- Rete Base mainnet `eip155:8453`, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, facilitator CDP. I segreti `CDP_API_KEY_ID` e `CDP_API_KEY_SECRET` sono in Cloudflare (`wrangler secret`).
- Bazaar: estensione discovery con schema e esempio. Validato da CDP `/x402/validate`: valid true.
- MCP remoto: `POST /mcp` (Streamable HTTP, stateless). `lookup_italian_pa` si paga con x402 via MCP (`@x402/mcp`).
- CPU: `src/bazaar-shim.js` (alias wrangler) salta la rivalidazione ajv per ogni richiesta. JWT CDP e risposta "supported" sono in cache come dati.
- Vedi SUBMISSIONS.md per la discovery.
