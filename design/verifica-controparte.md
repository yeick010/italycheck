# ItalyCheck – progetto tool "verifica controparte" (30/10/2026)
Autore: Scan Business & Revenue. Solo progettazione e analisi: nessun codice, nessun deploy, nessun prezzo deciso.

## 1. Cosa fa
Un agente passa un identificativo (partita IVA o codice fiscale) e riceve in una sola chiamata un verdetto strutturato sulla controparte:
- `format`: esito del checksum della P.IVA (offline, gratis, già presente come `check_partita_iva_format`).
- `pa`: se il CF è di un ente in IndicePA → denominazione, tipologia, codice IPA, PEC istituzionali, indirizzo (già presente come `lookup_italian_pa`).
- `pa_einvoice` (estensione proposta): uffici destinatari di fattura elettronica (Codice Univoco Ufficio) dell'ente, utile agli agenti di e-fattura/SDI.
- `vies`: solo dopo parere legale (oggi spento).
- `verdict`: `pa_verificata` | `formato_valido_non_verificato` | `formato_non_valido`, più `sources[]` con fonte, data e attribuzione "© AgID – IndicePA".
Prezzo unico per chiamata, la parte gratuita (checksum) resta anche come tool separato.

## 2. Fonti e cosa si può usare legalmente
| Fonte | Accesso | Note |
|---|---|---|
| Checksum P.IVA | algoritmo pubblico, offline | nessun vincolo |
| IndicePA open data (CKAN) | libero, licenza aperta | indicepa.it dichiara riuso gratuito; catalogo filtrabile CC-BY-4.0; attribuzione obbligatoria. https://www.indicepa.it/ipa-portale/dati-statistiche/open-data |
| IndicePA Web Service (incl. uffici FE per CF, PEC per codice IPA) | gratis ma serve "Authorization ID" da richiedere sul portale; utenza cancellata dopo 1 anno di inattività | https://www.indicepa.it/ipa-portale/dati-statistiche/web-service |
| PEC di IMPRESE (INI-PEC) | consultazione web puntuale libera; l'accesso applicativo/estrazione è previsto solo tramite "servizi evoluti ... regolamentati tramite apposite convenzioni" con InfoCamere (DM MiMIT 19/3/2013, art. 6 c.5); le convenzioni viste riguardano PA, con uso limitato a finalità istituzionali e divieto di duplicare i dati | https://trasparenza.aci.it/media/aci/file_archive/utente1023/2023/Det.%2012%20del%2027.02.2023%20PAT.pdf |
| VIES | spento finché non c'è parere legale (termini contro estrazione non conforme, blocco IP) | vedi PIANO-2026-10-30.md |

Conclusione: "PEC" nel tool oggi può voler dire solo PEC della PA da IndicePA. Le PEC di imprese private NON vanno prese facendo scraping di INI-PEC. Le strade legali sono una convenzione con InfoCamere (fattibilità per un operatore privato: sconosciuta) o un rivenditore autorizzato a costo per chiamata (vedi sotto).

## 3. Concorrenza e prezzi (listini pubblici openapi.com, letti il 30/10/2026)
Fonte: https://console.openapi.com/it/apis/company/pricing e https://openapi.it/prodotti/company-start-italia (prezzi + IVA)
- `IT-pa` (un ente pubblico): €0,020 (100 gratuite/mese) – è il diretto equivalente del nostro IndicePA a $0,005.
- `IT-pec` (PEC impresa): €0,030 base, €0,015 miglior prezzo, 30 gratuite/mese.
- `IT-sdicode` (codice SDI impresa): €0,030 base, €0,019 miglior prezzo.
- `EU-vies`: €0,020 base, €0,014 miglior prezzo.
- `IT-start` (anagrafica + stato attività Registro Imprese, codice destinatario): €0,05 a ricarica, da €0,015 in abbonamento, 30 gratuite/mese.
- `IT-closed` cessazione €0,02; `IT-vatgroup` €0,02; `IT-splitpayment` €0,05.
Smithery: presente "Nordic Data – EU Business Data" (VAT/KYB), prezzo non verificato.
Lettura: un pacchetto "PA + checksum (+ VIES)" oggi da noi costa $0,005; il comparabile openapi singolo ente PA è €0,02. C'è spazio per alzare il prezzo del bundle senza uscire dal mercato, ma la domanda reale è sconosciuta (5 pagamenti da 0,005 USDC fino al 24/10, pagatori non confermati come clienti).

## 4. Opzioni di prezzo per Yeison (decide lui)
- A) $0,005 come oggi: stessa cifra di `lookup_italian_pa`, il bundle diventa il tool principale.
- B) $0,01: ancora metà del prezzo base openapi `IT-pa` (€0,02).
- C) $0,02 con VIES incluso (solo dopo parere legale): allineato a `IT-pa`/`EU-vies` base openapi.
Nessuna di queste è una raccomandazione basata su domanda misurata: non abbiamo dati di domanda.

## 5. Pacchetti prepagati Stripe (per chi non usa crypto)
Commissione Stripe Italia carte EEA standard: 1,5% + €0,25 (premium EEA 2,8% + €0,25; internazionali 3,15% + €0,25). Fonte: https://stripe.com/en-it/pricing
Peso della commissione sul pacchetto (carta EEA standard): €5 → €0,325 (6,5%); €10 → €0,40 (4%); €25 → €0,625 (2,5%); €50 → €1,00 (2%).
Esempio con prezzo €0,01/chiamata: €10 = 1.000 chiamate, netto €9,60. Pacchetto minimo sensato: €10 (sotto i €10 l'incidenza supera il 4%).
Flusso: Payment Link → webhook `checkout.session.completed` → API key in Cloudflare KV con saldo crediti → Worker accetta `Authorization: Bearer` in alternativa a x402. Prima in test mode. IVA/fisco: serve commercialista.

## 6. Domande aperte per Yeison
1. Prezzo del bundle: A, B o C?
2. PEC imprese: va bene limitarsi alle PEC della PA (IndicePA) per ora? Oppure valutare un rivenditore a costo per chiamata (es. openapi `IT-pec` da €0,015) – che però renderebbe il nostro prezzo almeno ≥ €0,02?
3. Richiedere l'Authorization ID dei Web Service IndicePA (gratuito, richiede compilare un modulo a nome suo) per aggiungere gli uffici di fatturazione elettronica?
4. Parere legale VIES: chi e quando?
5. Pacchetti Stripe: ok a test mode con pacchetto minimo €10?

## 7. Implementazione (20/11/2026, branch feat/verifica-controparte, NON in produzione)
Task Notion: ItalyCheck "verifica controparte" a $0,01/chiamata. Specifica PM 20/11: prezzo B ($0,01), fonte IndicePA open data "Unità organizzative che ricevono fatture elettroniche" (CC BY 4.0) con la stessa API CKAN, niente Authorization ID, VIES spento, niente PEC imprese, `lookup_italian_pa` resta $0,005.
- HTTP: `GET /v1/counterparty?id=<11 cifre, prefisso IT opzionale>`, x402 v2 exact, USDC poi EURC su Base, amount `10000`. Fast 402 a dati statici (src/fast-paths.js), uguale byte per byte alla libreria (test).
- MCP: tool `verify_italian_counterparty` (argomento `id`) in tools/list (anche nel fast path) e tools/call pagato con @x402/mcp.
- Risposta: `verdict` (`pa_verificata` | `formato_valido_non_verificato` | `formato_non_valido`), `format.checksumOk`, `pa.entities` (dataset Enti, come lookup_italian_pa), `pa_einvoice.offices[]` (codiceUnivocoUfficio, nome ufficio, codiceIPA, codiceFiscaleSfe, einvoiceSince, peppol, indirizzo, PEC dell'ufficio PA), `total`/`truncated` (max 200 uffici), `vies: disabled`, `sources[]` con data, `attribution` CC BY 4.0, `disclaimer`.
- Dataset: resource 57bd2be0-4d3d-41cd-bdb8-2f0a60d6f490 (pacchetto unita-organizzative-che-ricevono-fatture-elettroniche, licenza CC-BY-4.0), filtro `Codice_fiscale_ente`, `fields=` per ridurre payload e CPU. Le due query IndicePA partono in parallelo.

Assunzioni prudenti (decisioni aperte non ancora prese da Yeison):
1. Prezzo: B ($0,01), come da specifica PM. Configurabile con `PRICE_COUNTERPARTY` ma senza toccare wrangler.toml (default nel codice).
2. PEC: solo PEC della PA presenti in IndicePA (enti e uffici di fatturazione). Nessuna PEC di imprese, nessun INI-PEC, nessun rivenditore.
3. Authorization ID Web Service IndicePA: non richiesto; si usa solo l'open data.
4. VIES: spento (`vies.status = "disabled"`), anche se ENABLE_VAT venisse acceso.
5. Stripe/pacchetti prepagati: non implementati.
6. Si addebita solo un verdetto con interrogazione del registro: input malformato (400), check digit errato (422, nessuna query) e IndicePA irraggiungibile (502) non vengono addebitati (x402 annulla il settle su status >= 400 e su risultati MCP isError).
7. Un'impresa privata riceve `formato_valido_non_verificato` (esistenza NON confermata) e paga $0,01: lo dice la descrizione del tool e il disclaimer.
8. Il server MCP stdio locale (src/mcp.js) non è cambiato: il nuovo tool è solo sul remoto /mcp e su HTTP.
