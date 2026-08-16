export const MAX_TURNS = 20; // keep last N turns to control token usage
export const MAX_PDF_CHARS = 250_000; // safety cap for extracted text

// Process-local caches (mirrors the Python in-memory dicts kept alongside Mongo persistence).
export const CHAT_SESSIONS = new Map(); // session_key -> history[]
export const PDF_STORE = new Map(); // pdf_id -> pdf doc

export function pdfCachePut(obj) {
  try {
    const pdfId = obj?.pdf_id || obj?.id;
    if (pdfId) PDF_STORE.set(pdfId, obj);
  } catch {
    // ignore
  }
}

/** Fetch PDF from in-memory cache first, then MongoDB. */
export async function pdfGet(db, uid, pdfId, courseTitle = null) {
  if (!pdfId) return null;

  const cached = PDF_STORE.get(pdfId);
  if (cached && cached.uid === uid) return cached;

  if (!db) return null;
  const q = { pdf_id: pdfId, uid };
  if (courseTitle) q.courseTitle = courseTitle;
  const doc = await db.collection("pdf_store").findOne(q, { projection: { _id: 0 } });
  if (doc) pdfCachePut(doc);
  return doc;
}

export function chunkText(s, chunkSize = 1200, overlap = 200) {
  s = (s || "").trim();
  if (!s) return [];
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const j = Math.min(n, i + chunkSize);
    out.push(s.slice(i, j));
    if (j === n) break;
    i = Math.max(0, j - overlap);
  }
  return out;
}

export function simpleRetrieve(chunks, query, k = 6) {
  const q = (query || "").toLowerCase();
  const toks = (q.match(/[a-z0-9]{3,}/g) || []).slice(0, 30);
  if (!toks.length) return chunks.slice(0, k);

  const scored = [];
  for (const c of chunks) {
    const cl = c.toLowerCase();
    const score = toks.reduce((sum, t) => sum + cl.split(t).length - 1, 0);
    if (score > 0) scored.push([score, c]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const best = scored.slice(0, k).map(([, c]) => c);
  if (best.length < k) {
    for (const c of chunks) {
      if (!best.includes(c)) best.push(c);
      if (best.length >= k) break;
    }
  }
  return best;
}

export function trimHistory(history, maxTurns = MAX_TURNS) {
  if (history.length > maxTurns * 2) return history.slice(-maxTurns * 2);
  return history;
}

/** Treat one Q+A as a pair (user then assistant). Delete by pair index (0-based). */
export function deletePairFromHistory(history, pairIndex) {
  if (!Array.isArray(history)) return [];
  const pi = parseInt(pairIndex, 10);
  if (Number.isNaN(pi) || pi < 0) return history;

  const i = pi * 2;
  if (i >= history.length) return history;

  const newHist = [...history];
  newHist.splice(i, 2);
  return newHist;
}
