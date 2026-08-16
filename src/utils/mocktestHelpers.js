import { ensureIsoTz } from "./dates.js";
import { proctoringPublic } from "./text.js";

// Process-global in-memory dedupe caches (mirrors Python's collections.deque(maxlen=N)).
// NOTE: like the original, this state is per-process and does not survive restarts or
// scale across multiple server instances. RECENT_MCQ_HASHES is also referenced by the
// video-quiz generator (content.routes.js) in the Python code; since each route module
// here keeps its own array, the dedupe window is mocktest-local only (minor UX-only deviation).
export const RECENT_CODING_TITLES = [];
export const RECENT_MCQ_HASHES = [];

const CODING_TITLES_MAXLEN = 200;
const MCQ_HASHES_MAXLEN = 400;

export function pushCapped(arr, value, maxLen) {
  arr.push(value);
  while (arr.length > maxLen) arr.shift();
}

export function pushRecentCodingTitle(title) {
  pushCapped(RECENT_CODING_TITLES, title, CODING_TITLES_MAXLEN);
}

export function pushRecentMcqHash(hash) {
  pushCapped(RECENT_MCQ_HASHES, hash, MCQ_HASHES_MAXLEN);
}

export function mocktestSessionsCol(db) {
  return db.collection("mocktest_sessions");
}

export function mocktestPublicSession(doc) {
  if (!doc) return null;
  return {
    session_id: String(doc.session_id || doc._id || ""),
    title: doc.title || "Mock Test",
    mode: doc.mode || "all",
    difficulty: doc.difficulty || "mixed",
    kind: doc.kind || "mock",
    pattern: doc.pattern || {},
    proctoring: proctoringPublic(doc.proctoring || {}),
    created_at: ensureIsoTz(doc.created_at),
    updated_at: ensureIsoTz(doc.updated_at),
    status: doc.status || "draft",
    scores: doc.scores || {},
    total_score: doc.total_score,
    total_marks: doc.total_marks,
    analysis: doc.analysis || null,
    analysis_unavailable_reason: doc.analysis_unavailable_reason || null,
    coding_details: doc.coding_details || {},
    general_questions: doc.general_questions || [],
    tech_questions: doc.tech_questions || [],
    coding_problems: (doc.coding_problems || [])
      .filter((p) => p && typeof p === "object")
      .map((p) => {
        const { referencePython, referenceJudge0, ...rest } = p;
        const hiddenTestCount =
          (p.hiddenTests || []).length ||
          ((p.sql_meta || {}).hidden_datasets || []).length ||
          (p.samples || []).length;
        return { ...rest, hiddenTestCount, total_marks: p.total_marks };
      }),
  };
}

export function caseToPublicDict(caseObj, hideIo = false) {
  const c = caseObj || {};
  const d = {
    id: c.id,
    hidden: !!c.hidden,
    passed: !!c.passed,
    time_ms: c.time_ms,
    memory_kb: c.memory_kb,
  };
  if (hideIo) {
    d.stdin = "";
    d.expected = "";
    d.stdout = "";
    d.stderr = c.stderr || "";
    d.expected_columns = [];
    d.expected_rows = [];
    d.actual_columns = [];
    d.actual_rows = [];
  } else {
    d.stdin = c.stdin || "";
    d.expected = c.expected || "";
    d.stdout = c.stdout || "";
    d.stderr = c.stderr || "";
    d.expected_columns = c.expected_columns || [];
    d.expected_rows = c.expected_rows || [];
    d.actual_columns = c.actual_columns || [];
    d.actual_rows = c.actual_rows || [];
  }
  d.is_sql = !!c.is_sql;
  return d;
}
