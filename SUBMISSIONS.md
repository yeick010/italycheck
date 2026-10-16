# Discovery: submission pronte (NON inviate)

Serve un repo pubblico (es. github.com/yeick010/italycheck)
con questo codice (senza segreti: i segreti CDP sono solo in Cloudflare).

## 1. x402 Bazaar (CDP), gratis, niente modulo
- Endpoint già validato: POST https://api.cdp.coinbase.com/platform/v2/x402/validate -> valid:true, simulation accepted.
- Indicizzazione: scatta dopo il primo pagamento x402 regolato tramite facilitator CDP (fino a 15 min). L'annuncio sparisce dopo 30 giorni senza pagamenti.
- Serve 1 chiamata pagata reale: 0,005 USDC da un wallet Base diverso da PAY_TO. Per esempio:
  `npx @x402/fetch` / client x402 con wallet di Yeison. Approvazione esplicita richiesta: è una spesa.
- Descrizione < 500 caratteri (290), nessun testo tipo "istruzione" (policy anti prompt-injection).

## 2. Official MCP Registry (alimenta PulseMCP e Glama)
File: server.json (remote-only, streamable-http https://italycheck.italycheck.workers.dev/mcp)
    brew install mcp-publisher   # oppure binario da github.com/modelcontextprotocol/registry/releases
    mcp-publisher login github   # OAuth con l'account di Yeison -> namespace io.github.<user>/*
    mcp-publisher publish

## 3. Smithery
smithery.ai/new -> URL https://italycheck.italycheck.workers.dev/mcp (Streamable HTTP, pubblico, nessun auth).
Login Smithery richiesto. CLI: `smithery mcp publish "https://italycheck.italycheck.workers.dev/mcp" -n @<org>/italycheck`

## 4. Glama
Auto-ingest dall'Official Registry; poi "Claim ownership" con glama.json (maintainers: yeick010) nel repo.

## 5. mcp.so
mcp.so/submit, login GitHub, tipo Remote Server, URL /mcp. Una fonte di terzi segnala una submission a pagamento
(39 USD) per server remoti: verificare prima, non pagare senza approvazione.

## 6. PulseMCP
Ingest automatico dall'Official Registry (submit manuale segnalato in pausa).

## Testi per gli annunci
Nome: ItalyCheck
Breve (EN): Verify Italian public administrations by codice fiscale: official name, PEC (certified email), address, from IndicePA (AgID, CC BY 4.0). Pay-per-call via x402, USDC on Base. No signup, no API key.
Breve (IT): Verifica enti pubblici italiani per codice fiscale: denominazione, PEC, indirizzo da IndicePA (AgID, CC BY 4.0). Pagamento a chiamata via x402 in USDC su Base. Senza registrazione né API key.
Tag: italy, public-administration, pec, e-invoicing, kyb, x402, base, usdc
Tools: lookup_italian_pa (0,005 USDC), check_partita_iva_format (gratis)
