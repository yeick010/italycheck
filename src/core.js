// Core lookups: free official sources only. No storage, no republication (VIES pass-through).
const VIES_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";
const IPA_URL = "https://indicepa.gov.it/ipa-dati/api/3/action/datastore_search";
const IPA_ENTI = "d09adf99-dc10-4349-8c53-27b1e5aa97b6"; // dataset "Enti", CC-BY 4.0 (AgID)
export const EU = ["AT","BE","BG","CY","CZ","DE","DK","EE","EL","ES","FI","FR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","XI"];

export function parseVat(input, defaultCountry = "IT") {
  const s = String(input || "").toUpperCase().replace(/[\s.\-]/g, "");
  let cc = defaultCountry, num = s;
  if (/^[A-Z]{2}/.test(s)) { cc = s.slice(0, 2); num = s.slice(2); }
  if (cc === "GR") cc = "EL";
  return { countryCode: cc, vatNumber: num };
}

// Official Italian partita IVA check digit (Luhn-like), offline, free.
export function itChecksum(piva) {
  if (!/^\d{11}$/.test(piva)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let d = +piva[i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === +piva[10];
}

const clean = v => (v && v !== "---" ? String(v).replace(/\s*\n\s*/g, ", ").replace(/,\s*$/, "").trim() : null);

export async function viesCheck(input, { fetchImpl = fetch } = {}) {
  const { countryCode, vatNumber } = parseVat(input);
  const base = { input, countryCode, vatNumber, source: "EU VIES (European Commission)", checkedAt: new Date().toISOString() };
  if (!EU.includes(countryCode)) return { ...base, status: "error", error: "unsupported_country", hint: "Only EU member states + XI (Northern Ireland)." };
  if (countryCode === "IT" && !itChecksum(vatNumber))
    return { ...base, status: "invalid", valid: false, reason: "italian_checksum_failed", note: "Rejected offline; VIES not queried." };
  let r;
  try {
    r = await fetchImpl(VIES_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ countryCode, vatNumber }) });
  } catch (e) { return { ...base, status: "error", error: "vies_unreachable" }; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errorWrappers || j.actionSucceed === false)
    return { ...base, status: "error", error: (j.errorWrappers?.[0]?.error) || `vies_http_${r.status}`, hint: "Member-state service may be down (MS_UNAVAILABLE). Retry later; do not treat as invalid." };
  return { ...base, status: j.valid ? "valid" : "invalid", valid: !!j.valid, name: clean(j.name), address: clean(j.address), requestDate: j.requestDate,
    disclaimer: "VIES confirms VAT registration for intra-EU supplies only; it is evidence, not a guarantee. Not legal/tax advice." };
}

// Italian public administrations (IndicePA): name, PEC, address by codice fiscale. CC-BY 4.0, attribution required.
const ipaQuery = (resource, filters, extra = "") =>
  `${IPA_URL}?resource_id=${resource}&filters=${encodeURIComponent(JSON.stringify(filters))}${extra}`;
const ipaGet = async (url, fetchImpl) => (await fetchImpl(url, { headers: { "User-Agent": "italycheck/0.1" } })).json();
const pecOf = (e, n) => Array.from({ length: n }, (_, i) => i + 1).filter(i => e[`Tipo_Mail${i}`] === "Pec").map(i => e[`Mail${i}`]);
const enteOf = e => ({
  codiceIPA: e.Codice_IPA, name: e.Denominazione_ente, category: e.Tipologia, ateco: e.Codice_ateco,
  address: [e.Indirizzo, e.CAP].filter(Boolean).join(" "), website: e.Sito_istituzionale, updated: e.Data_aggiornamento,
  pec: pecOf(e, 5),
});

export async function ipaLookup(cf, { fetchImpl = fetch } = {}) {
  const code = String(cf || "").replace(/\D/g, "");
  const base = { input: cf, source: "IndicePA open data (AgID), CC BY 4.0", checkedAt: new Date().toISOString() };
  if (!/^\d{11}$/.test(code)) return { ...base, status: "error", error: "expected_11_digit_codice_fiscale" };
  let j;
  try { j = await ipaGet(ipaQuery(IPA_ENTI, { Codice_fiscale_ente: code }), fetchImpl); } catch { return { ...base, status: "error", error: "ipa_unreachable" }; }
  const recs = j?.result?.records || [];
  if (j?.success === false || !Array.isArray(j?.result?.records)) return { ...base, status: "error", error: "ipa_unreachable" }; // CKAN error answer
  if (!recs.length) return { ...base, status: "not_found", isPublicAdministration: false, note: "Not in IndicePA (not a PA / public service operator, or not registered)." };
  return { ...base, status: "found", isPublicAdministration: true, entities: recs.map(enteOf) };
}

// Paid /v1/pa and MCP lookup_italian_pa answer 200 for every ipaLookup result (found, not_found, status "error" for a
// malformed cf or IndicePA unreachable), so every paid lookup is settled. Yeison 24/11/2026 12:09 ("fali pagare, perché per noi
// comunque è un costo") reverted the 11:52 no-charge rule (commit 7bb1b15) back to this pre-7bb1b15 behavior.

// ── Verifica controparte (design/verifica-controparte.md) ──
// One call: offline checksum + IndicePA "Enti" + IndicePA "Unità organizzative che ricevono fatture elettroniche"
// (codice univoco ufficio for SDI e-invoicing). Public-administration data only: VIES stays off, no company PEC.
export const IPA_UO_SFE = "57bd2be0-4d3d-41cd-bdb8-2f0a60d6f490"; // dataset "Unità Organizzative che ricevono fatture elettroniche", CC-BY 4.0 (AgID)
export const UO_SFE_LIMIT = 200; // largest PAs have hundreds of offices; the response says when it is truncated
const UO_FIELDS = "Codice_IPA,Codice_uni_uo,Descrizione_uo,Codice_fiscale_sfe,Data_avvio_sfe,Cod_peppol,Indirizzo,CAP,Mail1,Tipo_Mail1,Mail2,Tipo_Mail2,Mail3,Tipo_Mail3,Data_aggiornamento";
export const COUNTERPARTY_SOURCES = [
  { name: "IndicePA - Enti", publisher: "AgID - Agenzia per l'Italia Digitale", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    url: "https://indicepa.gov.it/ipa-dati/dataset/enti" },
  { name: "IndicePA - Unità Organizzative che ricevono fatture elettroniche", publisher: "AgID - Agenzia per l'Italia Digitale", license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/", url: "https://indicepa.gov.it/ipa-dati/dataset/unita-organizzative-che-ricevono-fatture-elettroniche" },
];
export const COUNTERPARTY_ATTRIBUTION = "Data © AgID - IndicePA, CC BY 4.0. Retrieved in real time; not modified except for field selection/renaming. ItalyCheck is not affiliated with or endorsed by AgID.";
const COUNTERPARTY_DISCLAIMER = "Checks Italian public-administration registries only (IndicePA). A private company is reported as formato_valido_non_verificato: format is valid but registration is NOT confirmed (VIES and company registers are not queried). Evidence, not a guarantee; not legal/tax advice.";
const uoOf = e => ({
  codiceUnivocoUfficio: e.Codice_uni_uo, name: e.Descrizione_uo, codiceIPA: e.Codice_IPA, codiceFiscaleSfe: e.Codice_fiscale_sfe,
  einvoiceSince: e.Data_avvio_sfe, peppol: e.Cod_peppol || null, address: [e.Indirizzo, e.CAP].filter(Boolean).join(" "),
  pec: pecOf(e, 3), updated: e.Data_aggiornamento || null,
});

// Normalized 11-digit id ("IT 00743110157" -> "00743110157") or null.
export function counterpartyId(input) {
  const s = String(input ?? "").toUpperCase().replace(/[\s.\-]/g, "").replace(/^IT/, "");
  return /^\d{11}$/.test(s) ? s : null;
}

// Result with httpStatus: 200 = billable verdict; 400/422/502 = not billable (x402 cancels settlement on >= 400,
// and on MCP isError results).
export async function counterpartyCheck(input, { fetchImpl = fetch } = {}) {
  const checkedAt = new Date().toISOString();
  const id = counterpartyId(input);
  const base = { input: input ?? null, id, checkedAt };
  if (!id) return { ...base, httpStatus: 400, status: "error", error: "expected_11_digit_partita_iva_or_codice_fiscale",
    hint: "Pass an Italian partita IVA or numeric codice fiscale (11 digits, optional IT prefix). Not charged." };
  const format = { checksumOk: itChecksum(id) };
  if (!format.checksumOk) return { ...base, httpStatus: 422, status: "ok", verdict: "formato_non_valido", format,
    note: "Check digit is wrong: no registry was queried. Not charged." };
  let enti, uo;
  try {
    [enti, uo] = await Promise.all([
      ipaGet(ipaQuery(IPA_ENTI, { Codice_fiscale_ente: id }), fetchImpl),
      ipaGet(ipaQuery(IPA_UO_SFE, { Codice_fiscale_ente: id }, `&limit=${UO_SFE_LIMIT}&fields=${UO_FIELDS}`), fetchImpl),
    ]);
    if (!enti?.success || !uo?.success) throw new Error("ipa_error");
  } catch { return { ...base, httpStatus: 502, status: "error", error: "ipa_unreachable", hint: "IndicePA did not answer; retry later. Not charged." }; }
  const entities = (enti.result?.records || []).map(enteOf);
  const offices = (uo.result?.records || []).map(uoOf);
  const total = Number.isInteger(uo.result?.total) ? uo.result.total : offices.length;
  const isPA = entities.length > 0 || offices.length > 0;
  return { ...base, httpStatus: 200, status: "ok",
    verdict: isPA ? "pa_verificata" : "formato_valido_non_verificato",
    format,
    pa: { isPublicAdministration: isPA, entities },
    pa_einvoice: { offices, total, truncated: total > offices.length },
    vies: { status: "disabled", note: "EU VIES is not queried by this service." },
    sources: COUNTERPARTY_SOURCES.map(s => ({ ...s, retrievedAt: checkedAt })),
    attribution: COUNTERPARTY_ATTRIBUTION,
    disclaimer: COUNTERPARTY_DISCLAIMER,
  };
}
