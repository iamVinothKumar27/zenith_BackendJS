const IST_OFFSET_MIN = 5 * 60 + 30;

export function utcIso() {
  return new Date().toISOString();
}

export function ensureIsoTz(dtStr) {
  if (!dtStr || typeof dtStr !== "string") return dtStr;
  const t = dtStr.trim();
  if (/(Z|[+-]\d{2}:\d{2})$/.test(t)) return t;
  return t + "+00:00";
}

export function fmtIst(dt) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return "";
  const istMs = dt.getTime() + IST_OFFSET_MIN * 60000;
  const ist = new Date(istMs);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  let hh = ist.getUTCHours();
  const min = String(ist.getUTCMinutes()).padStart(2, "0");
  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${yyyy}-${mm}-${dd} ${String(hh).padStart(2, "0")}:${min} ${ampm} IST`;
}

export function nowIstStr() {
  return fmtIst(new Date());
}

export function toUtcAware(dt) {
  return dt; // JS Date objects from the mongodb driver are already UTC-based.
}
