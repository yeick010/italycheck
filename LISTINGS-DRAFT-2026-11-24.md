# ItalyCheck – bozze schede directory (24/11/2026)

SOLO BOZZE. Nessun login, invio, iscrizione, pubblicazione o pagamento è stato fatto da questo lavoro. Ogni pubblicazione, il percorso a pagamento da 39 USD su mcp.so e qualsiasi chiamata x402 regolata restano bloccati fino all'ok diretto di Yeison. Prezzi, wallet, termini e `wrangler.toml` non sono stati toccati.

Testi e prezzi sotto riproducono il servizio live verificato oggi (richieste gratuite soltanto: catalogo, discovery, 402 non pagati, `tools/list`, una `tools/call` non pagata e il checksum gratuito). Niente è stato inventato.

## Stato verificato oggi (24/11/2026, 08:35–08:38 ora di Roma, Europe/Rome)

- Servizio live: https://italycheck.italycheck.workers.dev
- Versione Worker: `432d8804` (100% del traffico), deploy 24/11/2026 alle 08:21:57 (ora di Roma), commit `258b5bf`. Introduce il corpo 402 leggibile e i documenti gratuiti di discovery.
- `GET /` 200: catalogo ItalyCheck, pagamento x402 in USDC o EURC su Base (`eip155:8453`).
- `GET /.well-known/x402` 200, `GET /openapi.json` 200 (`info.version` 0.2.2), `GET /llms.txt` 200. Online da questo deploy.
- Official MCP Registry: `io.github.yeick010/italycheck` **v0.2.2** è la versione attiva (`isLatest: true`), pubblicata il 23/11/2026 alle 09:38:49 (ora di Roma). Descrizione registry: "Italian PA lookup (IndicePA): name, PEC, address. Counterparty check, P.IVA format. Paid via x402." Endpoint remoto: `https://italycheck.italycheck.workers.dev/mcp`. Scheda: https://registry.modelcontextprotocol.io/v0/servers/io.github.yeick010%2Fitalycheck/versions/latest
- Repo pubblico: https://github.com/yeick010/italycheck (`private: false`, `visibility: public`, branch `main`).
- MCP remoto (`POST /mcp`, Streamable HTTP, stateless): `initialize` e `tools/list` gratuiti. `serverInfo.version` dichiarato dal Worker: **0.2.0** (non 0.2.2: è quanto risponde il live; il registry e `/openapi.json` dicono 0.2.2). Tool:
  - `lookup_italian_pa` — 0,005 USDC o 0,005 EURC su Base. Una chiamata non pagata torna `isError` con i requisiti x402 v2, senza addebito.
  - `verify_italian_counterparty` — 0,01 USDC o 0,01 EURC su Base. Non addebitato su input malformato, check digit errato o IndicePA irraggiungibile. Chiamata non pagata: `isError`, senza addebito.
  - `check_partita_iva_format` — gratis. Verificato oggi: `{"countryCode":"IT","vatNumber":"00743110157","checksumOk":true}`.
- REST:
  - `GET /v1/pa` (e `HEAD`) senza pagamento: 402. Prezzo 5000 unità (0,005) USDC o EURC, `payTo` `0xde8380854ef9c926093832501d95a47f4c63fe7c`. **Addebito su ogni risposta 200**, anche `status: not_found` (non è una PA) e `status: error` (cf malformato). Il messaggio 402 invita a validare le 11 cifre prima, gratis, con `GET /v1/vat/format`.
  - `GET /v1/counterparty` (e `HEAD`) senza pagamento: 402. Prezzo 10000 unità (0,01) USDC o EURC, stesso `payTo`. **Nessun addebito** su 400 (input malformato), 422 (check digit errato) o 502 (IndicePA irraggiungibile): lo settle avviene solo sul 200.
  - `GET /v1/vat/format?vat=00743110157` 200, gratis.
- I 402 HTTP includono `extensions.bazaar` (input GET + `queryParams`, output JSON con esempio) più `resource.description`. Le `tools/call` MCP non pagate **non** includono `extensions.bazaar`: hanno `resource.url` tipo `/mcp#lookup_italian_pa`, descrizione, `serviceName`, tag e `accepts`.
- mcp.so: **non presente**. La ricerca ufficiale https://mcp.so/search?q=italycheck restituisce "0 results" / "No servers match \"italycheck\"".
- x402 Bazaar (CDP, sola lettura):
  - **Già indicizzato:** `https://italycheck.italycheck.workers.dev/v1/pa` (tipo `http`, x402 v2, USDC e EURC, stessa descrizione del 402). Ultimo aggiornamento catalogo: 23/11/2026 alle 05:06:46 (ora di Roma). Qualità ultimi 30 giorni: 31 chiamate, 6 pagatori unici, ultima chiamata 23/11/2026 alle 05:06:46 (ora di Roma).
  - **Non indicizzati:** `GET /v1/counterparty` e i tool MCP. Conferma: `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=0xde8380854ef9c926093832501d95a47f4c63fe7c` restituisce `pagination.total: 1` (solo `/v1/pa`). Le ricerche su "italycheck", "IndicePA" e l'URL di `/v1/counterparty` non fanno apparire quella risorsa.

VIES / `GET /v1/vat` non è offerto dal catalogo live (resta disattivato): non va citato come prodotto disponibile.

---

## Requisiti di pubblicazione, da pagine pubbliche (24/11/2026)

### mcp.so — percorso "free review" (da usare) e upsell da 39 USD (da non usare)

Fonti: https://mcp.so/submit (HTML della form, meta description, testo in pagina) e FAQ in homepage https://mcp.so ("How can I submit my MCP Server to mcp.so?"). Nessun account è stato aperto e nulla è stato inviato.

Cosa c'è sulla form pubblica, prima del login:

- Tipi selezionabili: **MCP Server**, **Remote Server**, **MCP Client**, **AI Product**. Il testo introduttivo parla anche di CLI, Agent Skills e Loops.
- **Repository URL** (obbligatorio), placeholder `https://github.com/owner/repository`.
- **Name** (campo "Project name"; non è marcato come obbligatorio sulla form visibile).
- Checkbox **Paid submission** 39 USD una tantum: "Publish immediately without review", "Verified badge", "Featured and priority placement", "Dofollow project link", "Pay and submit automatically".
- In testata c'è **Sign In**. La pagina non dice in modo esplicito se l'invio senza login è impossibile. Fonti di terzi (verificate su pagine pubbliche a novembre 2026) indicano che il login è richiesto; non è stato verificato qui perché non si deve fare login.

Il percorso gratuito esiste ed è il default se **non** si spunta Paid submission:

- Meta description della pagina submit: "Choose free review or publish immediately with Premium."
- Il testo a pagamento parla di pubblicazione immediata senza review: l'alternativa è la review.
- FAQ homepage: "Enter your repository or server URL and we fetch the details; you can then review the name, description, config and tools before submitting. Listings go live after review."
- Non è indicato un tempo di review. Non risulta un costo sul percorso senza checkbox.

Dopo il fetch (passo descritto in FAQ, non visibile senza invio) possono comparire campi da rivedere: name, description, config, tools. La form statica **non** mostra un campo "hosted endpoint URL", anche se il testo dice che i remote server si elencano con un URL ospitato. Se quel campo appare dopo aver scelto Remote Server o dopo il login, usare l'URL MCP sotto. Non pagare e non spuntare i 39 USD.

### x402 Bazaar (CDP) — niente modulo, indicizzazione dopo uno settle

Fonti ufficiali (24/11/2026):

- https://docs.cdp.coinbase.com/x402/bazaar
- https://docs.cdp.coinbase.com/x402/support/faq ("How do I get my endpoint listed?", "How long until my endpoint appears?", "Can MCP tools be discovered in the Bazaar?", "How do I update or remove my listing?")
- https://docs.cdp.coinbase.com/x402/validate-endpoint
- API pubbliche senza chiave: `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/search`, `/discovery/resources`, `/discovery/merchant`

Regole attuali (facilitator CDP, che è quello di ItalyCheck):

1. Non esiste un form di registrazione.
2. Il server deve rispondere 402 su HTTPS pubblico e dichiarare metadati Bazaar. Per le route HTTP, il 402 di ItalyCheck lo fa già (`resource.description`, `extensions.bazaar.info.input` / `output` con esempio).
3. L'indicizzazione parte dopo **un pagamento regolato (settle)** tramite il facilitator CDP. Il verify da solo non basta. Il payment payload deve contenere `paymentPayload.resource` pari all'URL della risorsa. Tempo dichiarato: 10–15 minuti. Il catalogo è in cache fino a 10 minuti.
4. `POST https://api.cdp.coinbase.com/platform/v2/x402/validate` è una preflight gratuita, senza pagamento e senza indicizzazione. Non è stata chiamata in questo lavoro (il controllo richiesto era un GET di sola lettura sul catalogo).
5. Visibilità: filtro a 30 giorni. Una risorsa già chiamata che non ha attività da 30 giorni esce dai risultati. Non c'è un meccanismo di delisting manuale.
6. Aggiornare la scheda = cambiare i metadati del 402 e completare un nuovo pagamento regolato.
7. I tool MCP *possono* finire nel catalogo (chiave: URL del server + nome del tool), ma "un settled payment triggers it" e "an MCP server declares its own" metadati Bazaar. Oggi le `tools/call` non pagate di ItalyCheck **non** espongono `extensions.bazaar`. Senza quell'estensione, un eventuale pagamento regolato sul tool MCP potrebbe non produrre una scheda utilizzabile. Non va tentato un pagamento MCP solo per l'indicizzazione finché i metadati Bazaar del tool non sono dichiarati (quella modifica al Worker richiederebbe un ok a parte e un deploy sotto D4).
8. Qualità in search: volume e pagatori unici a 30 giorni, completezza di description, output schema e metadati di servizio.

La bozza interna del 30/10 (`SUBMISSIONS.md`) diceva anche "descrizione < 500 caratteri" e "wallet diverso da PAY_TO". Nelle pagine CDP rilette oggi **non** risulta un limite ufficiale di 500 caratteri, né l'obbligo di un wallet diverso da `payTo`. La descrizione già in catalogo per `/v1/pa` è di 290 caratteri. Quella live del 402 di `/v1/counterparty` è di 616 caratteri: va usata così com'è, senza accorciarla in modo inventato. Un wallet diverso da `payTo` resta una precauzione pratica (evita un auto-pagamento), non un requisito documentato da CDP.

Costo per indicizzare `/v1/counterparty`: **0,01 USDC oppure 0,01 EURC** su Base (il prezzo della risorsa), pagati da un wallet acquirente. Non è 0,005 USDC. `/v1/pa` è già in catalogo, quindi una nuova chiamata pagata a 0,005 USDC **non** è necessaria solo per elencarlo. Qualsiasi chiamata regolata resta bloccata fino all'ok di Yeison.

---

## 1. Bozza mcp.so (https://mcp.so/submit) — solo free review

Compilare così. Non spuntare Paid submission.

| Campo (form pubblica o review post-fetch) | Valore da incollare |
|---|---|
| Project type | **Remote Server** |
| Repository URL * | `https://github.com/yeick010/italycheck` |
| Name | ItalyCheck |
| Hosted endpoint URL (se il campo compare dopo "Remote Server" o dopo il login) | `https://italycheck.italycheck.workers.dev/mcp` |
| Paid submission (39 USD) | **Lasciare spento.** Non pagare. Invio solo con free review. |

Testi da usare nella review (name, description, config, tools), se la FAQ è corretta e quei campi appaiono dopo il fetch.

**Short description**

```
Verify Italian public administrations by codice fiscale (IndicePA): official name, PEC and address. Counterparty check ($0.01) and free partita IVA checksum. Pay per call via x402 (USDC or EURC on Base). No signup, no API key.
```

**Long description**

```
ItalyCheck is a remote MCP server and HTTP API for AI agents that need to verify Italian public-sector counterparties.

Data comes from IndicePA (AgID, CC BY 4.0; attribution required). ItalyCheck is not affiliated with or endorsed by AgID. Public-administration data only: private companies are not confirmed (no VIES, no company PEC).

Remote MCP (Streamable HTTP, no auth, no API key):
https://italycheck.italycheck.workers.dev/mcp

Tools:
- lookup_italian_pa ($0.005 USDC or EURC on Base, x402 v2): IndicePA record by 11-digit codice fiscale (name, category, PEC, address). REST: GET /v1/pa?cf=... Charged on every HTTP 200, including not_found and malformed cf. Validate the 11 digits first with the free tool below.
- verify_italian_counterparty ($0.01 USDC or EURC on Base, x402 v2): check digit + IndicePA record + SDI e-invoicing offices (codice univoco ufficio, start date, PEC). Verdict: pa_verificata | formato_valido_non_verificato | formato_non_valido. Not charged on HTTP 400, 422 or 502. REST: GET /v1/counterparty?id=...
- check_partita_iva_format (free): offline Italian partita IVA check digit. REST: GET /v1/vat/format?vat=...

Official MCP Registry: io.github.yeick010/italycheck v0.2.2.
Free discovery docs: https://italycheck.italycheck.workers.dev/ (catalog), /.well-known/x402, /openapi.json, /llms.txt.
Source: https://github.com/yeick010/italycheck
```

**Tags** (se il campo c'è): `italy`, `public-administration`, `pec`, `e-invoicing`, `kyb`, `x402`, `base`, `usdc`, `eurc`, `counterparty`

**Categoria** (se il campo c'è): Finance / Data, se disponibile; altrimenti lasciare quella proposta dal fetch.

**Config MCP da incollare** (Streamable HTTP, nessuna autenticazione):

```json
{
  "mcpServers": {
    "italycheck": {
      "url": "https://italycheck.italycheck.workers.dev/mcp"
    }
  }
}
```

Claude Code, se serve un comando:

```
claude mcp add --transport http italycheck https://italycheck.italycheck.workers.dev/mcp
```

Homepage / website, se richiesto: https://github.com/yeick010/italycheck (è anche il `websiteUrl` del registry). Alternativa già live: https://italycheck.italycheck.workers.dev/

---

## 2. Bozza x402 Bazaar (CDP) — nessuna form da inviare

Non c'è una scheda da "pubblicare" a mano. La scheda è ciò che il 402 già espone. Sotto: stato, metadati live da riusare, e l'unica azione a pagamento eventuale.

### 2.a `GET /v1/pa` — già in catalogo, nessuna azione necessaria

- Resource: `https://italycheck.italycheck.workers.dev/v1/pa`
- Type: `http`
- x402Version: 2
- Accepts (live e in catalogo): exact, `eip155:8453`, amount `5000` (0,005), USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` e EURC `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42`, payTo `0xde8380854ef9c926093832501d95a47f4c63fe7c`
- Description (290 caratteri, identica al 402 e al catalogo):

```
Look up an Italian public administration or public-service operator by 11-digit codice fiscale in IndicePA (AgID). Use when an agent must verify a public-sector counterparty, find its official PEC (certified email) addresses, or confirm it exists before e-invoicing. Input: ?cf=80016350821.
```

- Bazaar `info.input` già servito: `{"type":"http","method":"GET","queryParams":{"cf":"80016350821"}}`
- Bazaar `info.output`: JSON, esempio `status: found` / Comune di Palermo (dati IndicePA, CC BY 4.0).
- Una nuova chiamata pagata a 0,005 USDC non serve solo per tenere questa riga in elenco (ultima attività 23/11/2026; finestra 30 giorni).

### 2.b `GET /v1/counterparty` — metadati già nel 402, **non** in catalogo

Per farla apparire serve l'ok di Yeison a **un** pagamento regolato di **0,01 USDC o 0,01 EURC** su Base, su questa URL, tramite facilitator CDP, con un client x402 v2 che includa `paymentPayload.resource`. Esempio di chiamata (da non eseguire senza ok):

`GET https://italycheck.italycheck.workers.dev/v1/counterparty?id=80016350821`

Metadati già live nel 402, da lasciare invariati (niente deploy, niente modifica a prezzi/wallet/termini):

- Resource URL: `https://italycheck.italycheck.workers.dev/v1/counterparty` (con esempio `?id=80016350821`)
- Description (616 caratteri, testo esatto del 402):

```
Verify an Italian counterparty in one call before invoicing or paying: partita IVA / codice fiscale check digit, IndicePA public-administration record (name, category, institutional PEC, address) and the e-invoicing offices that receive FatturaPA via SDI (codice univoco ufficio, start date, PEC). Returns verdict pa_verificata | formato_valido_non_verificato | formato_non_valido with sources and CC BY 4.0 attribution. Public-administration data only: private companies are not confirmed (no VIES, no company PEC). Malformed input, a wrong check digit or an IndicePA outage are not charged. Input: ?id=80016350821.
```

- Accepts: exact, `eip155:8453`, amount `10000` (0,01), stessi asset e stesso payTo di `/v1/pa`.
- Bazaar `info.input` già servito: `{"type":"http","method":"GET","queryParams":{"id":"80016350821"}}`
- Bazaar `info.output`: JSON, esempio con `verdict`, `format`, `pa`, `pa_einvoice`, `vies.status: disabled`, attribuzione CC BY 4.0.
- Addebito: solo su HTTP 200. Un id di esempio valido (80016350821, Comune di Palermo) evita 400/422. Un 502 di IndicePA non viene addebitato, ma in quel caso lo settle non parte e l'indicizzazione no.

Preflight opzionale e gratuito, prima di pagare (solo se Yeison lo chiede): `POST https://api.cdp.coinbase.com/platform/v2/x402/validate` con `resource` = `https://italycheck.italycheck.workers.dev/v1/counterparty?id=80016350821` e `method` = `GET`. Non indica e non paga.

Verifica dopo (GET, gratis): stessa query merchant usata oggi, oppure search `italycheck` / l'URL di `/v1/counterparty`. Attesa dichiarata: 10–15 minuti.

### 2.c Tool MCP — non in catalogo; non pagare per indicizzarli adesso

URL che il 402 MCP già dichiara:

- `https://italycheck.italycheck.workers.dev/mcp#lookup_italian_pa` (0,005 USDC/EURC)
- `https://italycheck.italycheck.workers.dev/mcp#verify_italian_counterparty` (0,01 USDC/EURC)

Manca `extensions.bazaar` (inputSchema / output) nella risposta di pagamento del tool. Le FAQ CDP dicono che un server MCP deve dichiarare da sé quei metadati. **Non** chiedere a Yeison una chiamata pagata sui tool MCP solo per il Bazaar, finché quella dichiarazione non c'è. `/v1/pa` è già scopribile; `/v1/counterparty` è la sola risorsa HTTP ancora da indicizzare.

---

## Cosa Yeison deve approvare

Due azioni distinte. Nessuna è stata eseguita.

### A. Invio mcp.so, solo free review

- **Azione:** aprire https://mcp.so/submit, accedere (Sign In in testata; le fonti pubbliche di novembre 2026 indicano un login, probabilmente GitHub, non verificato qui), scegliere Remote Server, incollare i campi di questa bozza, controllare name/description/config/tools se compaiono dopo il fetch, inviare **senza** Paid submission.
- **Costo:** 0 USD, se la checkbox da 39 USD resta spenta. Tempo di review non pubblicato.
- **Login:** account mcp.so / Sign In (verosimilmente GitHub, da confermare in pagina dopo l'accesso). Serve l'account di Yeison.
- **Fuori dall'ok:** pagare 39 USD, qualsiasi upgrade Premium/featured, modificare prezzi o testi del servizio live.

### B. Indicizzazione Bazaar di `GET /v1/counterparty`

- **Azione:** una chiamata HTTP regolata a `GET https://italycheck.italycheck.workers.dev/v1/counterparty?id=80016350821` con un client x402 v2 (per esempio `@x402/fetch` + `@x402/evm`) tramite il facilitator CDP, con `paymentPayload.resource` impostato. Poi controllare il catalogo con un GET gratuito.
- **Costo:** **0,01 USDC oppure 0,01 EURC** su Base (non 0,005). È il prezzo pubblico della risorsa, non una tariffa di listing. Eventuale commissione facilitator CDP (le prime 1.000 transazioni/mese del merchant sono gratis, poi 0,001 USD a settle) è a parte e non è un costo di "submission".
- **Login / wallet:** nessun login CDP da parte di Yeison per il catalogo (le API discovery sono pubbliche). Serve un wallet Base con almeno 0,01 USDC o EURC, e un client x402. Le docs CDP non obbligano un wallet diverso da `payTo`; usare un wallet diverso da `0xde8380…fe7c` resta una precauzione pratica.
- **Non richiesto per questa approvazione:** una chiamata pagata a `/v1/pa` (già in catalogo); una chiamata pagata a un tool MCP; modifiche al Worker; deploy.

Se Yeison approva solo A, si invia mcp.so e si lascia `/v1/counterparty` fuori dal Bazaar. Se approva solo B, si fa lo settle da 0,01 e mcp.so resta fermo. Se approva entrambi, si possono fare in qualunque ordine.

---

## Fuori da questa bozza (invariato rispetto al 30/10, non oggetto di questo task)

Smithery risulta chiuso a nuovi server (chiusura del task Registry + Smithery). awesome-remote-mcp-servers / awesome-x402 restano PR su GitHub: servono un ok e un login GitHub a parte, non coperti da questo file.
