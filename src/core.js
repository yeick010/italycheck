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
export async function ipaLookup(cf, { fetchImpl = fetch } = {}) {
  const code = String(cf || "").replace(/\D/g, "");
  const base = { input: cf, source: "IndicePA open data (AgID), CC BY 4.0", checkedAt: new Date().toISOString() };
  if (!/^\d{11}$/.test(code)) return { ...base, status: "error", error: "expected_11_digit_codice_fiscale" };
  const url = `${IPA_URL}?resource_id=${IPA_ENTI}&filters=${encodeURIComponent(JSON.stringify({ Codice_fiscale_ente: code }))}`;
  let j;
  try { j = await (await fetchImpl(url, { headers: { "User-Agent": "italycheck/0.1" } })).json(); } catch { return { ...base, status: "error", error: "ipa_unreachable" }; }
  const recs = j?.result?.records || [];
  if (!recs.length) return { ...base, status: "not_found", isPublicAdministration: false, note: "Not in IndicePA (not a PA / public service operator, or not registered)." };
  return { ...base, status: "found", isPublicAdministration: true, entities: recs.map(e => ({
    codiceIPA: e.Codice_IPA, name: e.Denominazione_ente, category: e.Tipologia, ateco: e.Codice_ateco,
    address: [e.Indirizzo, e.CAP].filter(Boolean).join(" "), website: e.Sito_istituzionale, updated: e.Data_aggiornamento,
    pec: [1,2,3,4,5].filter(i => e[`Tipo_Mail${i}`] === "Pec").map(i => e[`Mail${i}`]),
  })) };
}
