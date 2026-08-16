import { Router } from "express";
import crypto from "crypto";
import { getDb } from "../config/mongo.js";
import { config } from "../config/env.js";
import { requireUser } from "../middleware/auth.js";
import { isQuotaError } from "../utils/gemini.js";
import { sanitizeTopic, defaultProctoring, proctoringPublic } from "../utils/text.js";
import { fmtIst, utcIso } from "../utils/dates.js";
import { brandEmail, sendEmail, proctoringDetailsHtml, proctoringDetailsText, sanitizeTestNameForEmail } from "../utils/email.js";
import { codeRun } from "../utils/codeExec.js";
import { executeSqlQuery, sqlRowsToText, compareSqlResults } from "../utils/sqlSandbox.js";
import {
  mocktestGenerateAptiQuestions,
  mocktestGenerateCodingProblems,
  mocktestGenerateSqlProblems,
  starterCodeForProblem,
  geminiJsonSafe,
  geminiCodeAnalysis,
  codingFullMarks,
} from "../utils/questionGen.js";
import { mocktestSessionsCol, mocktestPublicSession, caseToPublicDict } from "../utils/mocktestHelpers.js";

const router = Router();

function htmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

router.post("/mocktest/session/create", requireUser, async (req, res) => {
  const user = req.user;
  const payload = req.body || {};
  let mode = (payload.mode || "all").trim().toLowerCase();
  const difficulty = (payload.difficulty || "mixed").trim().toLowerCase();
  const pattern = payload.pattern || {};
  let genN = Math.max(0, Math.min(40, parseInt(pattern.general || 0, 10)));
  let techN = Math.max(0, Math.min(40, parseInt(pattern.tech || 0, 10)));
  let codingN = Math.max(0, Math.min(20, parseInt(pattern.coding || 0, 10)));
  let sqlN = Math.max(0, Math.min(20, parseInt(pattern.sql || 0, 10)));

  if (mode === "general") {
    techN = 0;
    codingN = 0;
    sqlN = 0;
  } else if (mode === "tech") {
    genN = 0;
    codingN = 0;
    sqlN = 0;
  } else if (mode === "coding") {
    genN = 0;
    techN = 0;
    sqlN = 0;
  } else if (mode === "sql") {
    genN = 0;
    techN = 0;
  } else {
    mode = "all";
  }

  if (genN + techN + codingN + sqlN <= 0) {
    return res.status(400).json({ error: "Pattern must include at least one question/problem count." });
  }

  console.log(`[mocktest create] uid=${user.uid} mode=${mode} difficulty=${difficulty} pattern=general:${genN},tech:${techN},coding:${codingN},sql:${sqlN}`);

  let generalQs, techQs, codingProbs;
  try {
    if (genN) console.log(`[mocktest create] generating ${genN} general aptitude question(s)...`);
    generalQs = genN ? await mocktestGenerateAptiQuestions("general", genN, difficulty) : [];
    if (genN) console.log(`[mocktest create] general aptitude: got ${generalQs.length}/${genN}`);

    if (techN) console.log(`[mocktest create] generating ${techN} tech aptitude question(s)...`);
    techQs = techN ? await mocktestGenerateAptiQuestions("tech", techN, difficulty) : [];
    if (techN) console.log(`[mocktest create] tech aptitude: got ${techQs.length}/${techN}`);

    const requestedDsaN = ["all", "coding"].includes(mode) ? codingN : 0;
    const requestedSqlN = mode === "all" ? sqlN : mode === "sql" ? codingN : 0;
    if (requestedDsaN) console.log(`[mocktest create] generating ${requestedDsaN} DSA/coding problem(s) — this validates testcases via the code runner and can take a while...`);
    const dsaProbs = requestedDsaN ? await mocktestGenerateCodingProblems(requestedDsaN, difficulty) : [];
    if (requestedDsaN) console.log(`[mocktest create] DSA/coding: got ${dsaProbs.length}/${requestedDsaN}`);

    if (requestedSqlN) console.log(`[mocktest create] generating ${requestedSqlN} SQL problem(s)...`);
    const sqlProbs = requestedSqlN ? await mocktestGenerateSqlProblems(requestedSqlN, difficulty, "SQL") : [];
    if (requestedSqlN) console.log(`[mocktest create] SQL: got ${sqlProbs.length}/${requestedSqlN}`);

    codingProbs = [...(dsaProbs || []), ...(sqlProbs || [])];
    console.log(`[mocktest create] generation complete: general=${generalQs.length} tech=${techQs.length} coding=${codingProbs.length}`);
  } catch (e) {
    console.log("[session create] question/problem generation failed:", e.message || e);
    if (isQuotaError(e)) {
      return res.status(429).json({ error: "We've hit today's AI usage limit. Please try again in a little while.", code: "quota_exceeded" });
    }
    return res.status(503).json({ error: e.message || "Gemini generation failed. Please regenerate.", code: "GEMINI_GENERATION_FAILED" });
  }

  const totalMarks = generalQs.length + techQs.length + codingProbs.reduce((s, p) => s + parseInt(p.total_marks || 0, 10), 0);

  const codingAnswers = {};
  for (const p of codingProbs || []) {
    if (!p || typeof p !== "object") continue;
    const pid = p.id || p.slug;
    if (!pid) continue;
    const initLang = String(p.type || "").trim().toLowerCase() === "sql" ? "sql" : "python";
    codingAnswers[String(pid)] = { language: initLang, code: starterCodeForProblem(p, initLang) || "" };
  }

  const now = new Date();
  const doc = {
    uid: user.uid,
    session_id: crypto.randomUUID(),
    title: (payload.title || "Mock Test").trim() || "Mock Test",
    mode,
    pattern: {
      general: genN,
      tech: techN,
      coding: ["all", "coding"].includes(mode) ? codingN : 0,
      sql: mode === "all" ? sqlN : mode === "sql" ? codingN : 0,
    },
    difficulty,
    kind: "mock",
    status: "ready",
    general_questions: generalQs,
    tech_questions: techQs,
    coding_problems: codingProbs,
    answers: { general: {}, tech: {}, coding: codingAnswers },
    scores: {},
    total_score: null,
    total_marks: totalMarks,
    analysis: null,
    proctoring: defaultProctoring(3),
    created_at: now,
    updated_at: now,
    createdAt: now,
    updatedAt: now,
  };

  const db = await getDb();
  const col = mocktestSessionsCol(db);
  await col.insertOne(doc);
  res.json({ ok: true, session: mocktestPublicSession(doc) });
});

router.post("/practice/session/create", requireUser, async (req, res) => {
  const user = req.user;
  const payload = req.body || {};
  let section = (payload.section || "general").trim().toLowerCase();
  if (!["general", "tech", "dsa", "mixed", "sql"].includes(section)) section = "general";
  let difficulty = (payload.difficulty || "easy").trim().toLowerCase();
  if (!["easy", "mixed", "medium", "hard"].includes(difficulty)) difficulty = "easy";
  let topic = sanitizeTopic(payload.topic || "");
  let count = parseInt(payload.count || 0, 10);

  const topics = payload.topics || {};
  const counts = payload.counts || {};

  let gcount, tcount, ccount, scount;
  if (section === "mixed") {
    gcount = Math.max(0, Math.min(40, parseInt(counts.general || 0, 10)));
    tcount = Math.max(0, Math.min(40, parseInt(counts.tech || 0, 10)));
    ccount = Math.max(0, Math.min(20, parseInt(counts.coding || 0, 10)));
    scount = Math.max(0, Math.min(20, parseInt(counts.sql || 0, 10)));
    if (gcount + tcount + ccount + scount <= 0) {
      return res.status(400).json({ error: "Please enter at least one question/problem count." });
    }
  } else if (section === "dsa") {
    count = Math.max(1, Math.min(20, count || 1));
  } else if (section === "sql") {
    count = Math.max(1, Math.min(20, count || 1));
  } else {
    count = Math.max(1, Math.min(40, count || 1));
  }

  console.log(`[practice create] uid=${user.uid} section=${section} difficulty=${difficulty} count=${count} topic=${JSON.stringify(topic)}`);

  let generalQs, techQs, codingProbs, pattern, mode;
  try {
    if (section === "mixed") {
      const gtopic = sanitizeTopic(String(topics.general || ""));
      const ttopic = sanitizeTopic(String(topics.tech || ""));
      const ctopic = sanitizeTopic(String(topics.coding || ""));
      const stopic = sanitizeTopic(String(topics.sql || ""));
      generalQs = gcount ? await mocktestGenerateAptiQuestions("general", gcount, difficulty, gtopic) : [];
      techQs = tcount ? await mocktestGenerateAptiQuestions("tech", tcount, difficulty, ttopic) : [];
      if (ccount) console.log(`[practice create] generating ${ccount} DSA/coding problem(s) — validates testcases via the code runner, can take a while...`);
      const dsaProbs = ccount ? await mocktestGenerateCodingProblems(ccount, difficulty, ctopic) : [];
      const sqlProbs = scount ? await mocktestGenerateSqlProblems(scount, difficulty, stopic || "SQL") : [];
      codingProbs = [...(dsaProbs || []), ...(sqlProbs || [])];
      pattern = { general: gcount, tech: tcount, coding: ccount, sql: scount };
      mode = "all";
      topic = { general: gtopic, tech: ttopic, coding: ctopic, sql: stopic };
    } else if (["general", "tech"].includes(section)) {
      const generatedQs = count ? await mocktestGenerateAptiQuestions(section, count, difficulty, topic) : [];
      generalQs = section === "general" ? generatedQs : [];
      techQs = section === "tech" ? generatedQs : [];
      codingProbs = [];
      pattern = { general: section === "general" ? count : 0, tech: section === "tech" ? count : 0, coding: 0, sql: 0 };
      mode = section;
    } else if (section === "dsa") {
      generalQs = [];
      techQs = [];
      console.log(`[practice create] generating ${count} DSA/coding problem(s) — validates testcases via the code runner, can take a while...`);
      codingProbs = count ? await mocktestGenerateCodingProblems(count, difficulty, topic) : [];
      pattern = { general: 0, tech: 0, coding: count, sql: 0 };
      mode = "coding";
    } else {
      generalQs = [];
      techQs = [];
      codingProbs = count ? await mocktestGenerateSqlProblems(count, difficulty, topic || "SQL") : [];
      pattern = { general: 0, tech: 0, coding: 0, sql: count };
      mode = "sql";
    }
    console.log(`[practice create] generation complete: general=${generalQs.length} tech=${techQs.length} coding=${codingProbs.length}`);
  } catch (e) {
    console.log("[session create] question/problem generation failed:", e.message || e);
    if (isQuotaError(e)) {
      return res.status(429).json({ error: "We've hit today's AI usage limit. Please try again in a little while.", code: "quota_exceeded" });
    }
    return res.status(503).json({ error: e.message || "Gemini generation failed. Please regenerate.", code: "GEMINI_GENERATION_FAILED" });
  }

  const totalMarks = generalQs.length + techQs.length + codingProbs.reduce((s, p) => s + parseInt(p.total_marks || 0, 10), 0);

  const codingAnswers = {};
  for (const p of codingProbs || []) {
    if (!p || typeof p !== "object") continue;
    const pid = p.id || p.slug;
    if (!pid) continue;
    const lang = String(p.type || "").trim().toLowerCase() === "sql" ? "sql" : "python";
    codingAnswers[String(pid)] = { language: lang, code: starterCodeForProblem(p, lang) || "" };
  }

  const doc = {
    uid: user.uid,
    session_id: crypto.randomUUID(),
    title: (payload.title || "Practice Test").trim() || "Practice Test",
    mode,
    pattern,
    difficulty,
    kind: "practice",
    topic,
    status: "ready",
    general_questions: generalQs,
    tech_questions: techQs,
    coding_problems: codingProbs,
    answers: { general: {}, tech: {}, coding: codingAnswers },
    attempts: [],
    analysis: null,
    proctoring: { enabled: false },
    total_score: null,
    total_marks: totalMarks,
    created_at: utcIso(),
    updated_at: utcIso(),
  };

  const db = await getDb();
  const col = mocktestSessionsCol(db);
  await col.insertOne(doc);

  res.json({ ok: true, session: { session_id: doc.session_id } });
});

router.get("/mocktest/sessions", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const kind = (req.query.kind || "").trim().toLowerCase();

  const q = { uid };
  if (kind === "practice") {
    q.kind = "practice";
  } else if (kind === "mock") {
    q.$or = [{ kind: "mock" }, { kind: { $exists: false } }, { kind: null }, { kind: "" }];
  }

  const db = await getDb();
  const col = mocktestSessionsCol(db);
  const items = await col.find(q).sort({ created_at: -1 }).limit(200).toArray();

  const out = items.map((d) => ({
    session_id: String(d.session_id || d._id || ""),
    title: d.title || "Mock Test",
    mode: d.mode || "all",
    kind: d.kind || "mock",
    topic: d.topic || "",
    pattern: d.pattern || {},
    status: d.status || "",
    created_at: d.created_at,
    updated_at: d.updated_at,
    total_score: d.total_score,
    total_marks: d.total_marks,
    scores: d.scores || {},
    analysis: d.analysis || null,
  }));
  res.json({ ok: true, sessions: out });
});

router.get("/mocktest/sessions/:sessionId", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const db = await getDb();
  const col = mocktestSessionsCol(db);
  const doc = await col.findOne({ uid, session_id: req.params.sessionId });
  if (!doc) return res.status(404).json({ error: "Not found" });

  res.json({ ok: true, session: mocktestPublicSession(doc), answers: doc.answers || {} });
});

router.post("/mocktest/sessions/:sessionId/save", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const sessionId = req.params.sessionId;
  const payload = req.body || {};
  const answers = payload.answers || {};
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return res.status(400).json({ error: "Invalid answers" });
  }

  const db = await getDb();
  const col = mocktestSessionsCol(db);
  const doc = await col.findOne({ uid, session_id: sessionId });
  if (!doc) return res.status(404).json({ error: "Not found" });
  if (doc.submittedAt) return res.status(400).json({ error: "Already submitted" });

  const cur = doc.answers || {};
  const merged = { ...cur };
  for (const [k, v] of Object.entries(answers)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      merged[k] = { ...(cur[k] || {}), ...v };
    } else {
      merged[k] = v;
    }
  }

  await col.updateOne({ uid, session_id: sessionId }, { $set: { answers: merged, updated_at: utcIso() } });
  res.json({ ok: true });
});

router.post("/mocktest/code/run", async (req, res) => {
  const payload = req.body || {};
  const t0 = Date.now();
  const language = (payload.language || "python").trim().toLowerCase();
  const sourceCode = payload.source_code || "";
  const tests = payload.tests || [];
  if (!Array.isArray(tests) || !tests.length) return res.status(400).json({ error: "No tests provided" });

  const isSql = (payload.problem_type || "").trim().toLowerCase() === "sql" || language === "sql";
  const results = [];

  if (isSql) {
    for (const t of tests.slice(0, 4)) {
      if (!t || typeof t !== "object") continue;
      const schemaSql = String(payload.schema_sql || t.schema_sql || "");
      const setupSql = String(t.setup_sql || "");
      const expected = { columns: t.expected_columns || [], rows: t.expected_rows || [] };
      let r;
      try {
        const actual = executeSqlQuery((schemaSql + "\n" + setupSql).trim(), sourceCode);
        const passed = compareSqlResults(actual, expected);
        r = {
          stdout: sqlRowsToText(actual.rows || [], actual.columns || []),
          stderr: "",
          compile_output: "",
          status: passed ? "Accepted" : "Wrong Answer",
          status_id: passed ? 3 : 4,
          expected: sqlRowsToText(expected.rows || [], expected.columns || []),
          expected_columns: expected.columns || [],
          expected_rows: expected.rows || [],
          actual_columns: actual.columns || [],
          actual_rows: actual.rows || [],
          is_sql: true,
          passed,
        };
      } catch (e) {
        r = {
          stdout: "",
          stderr: String(e.message || e),
          compile_output: "",
          status: "Error",
          status_id: 13,
          expected: sqlRowsToText(expected.rows || [], expected.columns || []),
          expected_columns: expected.columns || [],
          expected_rows: expected.rows || [],
          actual_columns: [],
          actual_rows: [],
          is_sql: true,
          passed: false,
        };
      }
      r.stdin = schemaSql ? (schemaSql + "\n" + setupSql).trim() : setupSql;
      results.push(r);
    }
  } else {
    for (const t of tests.slice(0, 4)) {
      if (!t || typeof t !== "object") continue;
      const stdin = t.stdin || "";
      const expected = t.expected;
      let r;
      try {
        r = await codeRun(sourceCode, stdin, language, { expected });
      } catch (e) {
        r = {
          stdout: "",
          stderr: String(e.message || e),
          compile_output: "",
          status: "Error",
          status_id: 13,
          expected: expected != null ? (expected || "").trim() : "",
          passed: false,
        };
      }
      r.stdin = t.stdin || "";
      results.push(r);
    }
  }

  const wallMs = Date.now() - t0;
  const analysis = isSql ? {} : await geminiCodeAnalysis(payload.problem_text || payload.problem || "", sourceCode, language);

  const testcases = [];
  let passedCount = 0;
  results.forEach((r, i) => {
    const ok = !!r.passed;
    if (ok) passedCount += 1;
    testcases.push({
      id: i + 1,
      hidden: false,
      passed: ok,
      stdin: r.stdin || "",
      expected: r.expected || "",
      stdout: r.stdout || "",
      stderr: r.stderr || "",
      time_ms: r.time_ms,
      memory_kb: r.memory_kb,
      expected_columns: r.expected_columns || [],
      expected_rows: r.expected_rows || [],
      actual_columns: r.actual_columns || [],
      actual_rows: r.actual_rows || [],
      is_sql: !!r.is_sql,
    });
  });

  res.status(200).json({
    ok: true,
    results,
    testcases,
    total_tests: testcases.length,
    passed_tests: passedCount,
    sample_total: testcases.length,
    sample_passed: passedCount,
    hidden_total: 0,
    hidden_passed: 0,
    hidden_failed: 0,
    wall_time_ms: wallMs,
    timeComplexity: analysis.timeComplexity,
    spaceComplexity: analysis.spaceComplexity,
    analysisReason: analysis.reason,
  });
});

router.post("/mocktest/sessions/:sessionId/coding/:pid/submit", requireUser, async (req, res) => {
  const { sessionId, pid } = req.params;
  const payload = req.body || {};
  const language = (payload.language || "python").trim().toLowerCase();
  const sourceCode = payload.source_code || "";

  if (!String(sourceCode).trim()) return res.status(400).json({ error: "source_code is required" });

  const db = await getDb();
  const col = mocktestSessionsCol(db);
  const doc = await col.findOne({ uid: req.user.uid, session_id: String(sessionId) });
  if (!doc) return res.status(404).json({ error: "Session not found" });
  if ((doc.status || "").toLowerCase() === "submitted") return res.status(400).json({ error: "Session already submitted" });

  const prob = (doc.coding_problems || []).find((p) => p && typeof p === "object" && String(p.id) === String(pid));
  if (!prob) return res.status(404).json({ error: "Problem not found" });

  const isSqlProblem = String((prob || {}).type || "").trim().toLowerCase() === "sql";
  const testsSamplesRaw = isSqlProblem ? (prob.sql_meta || {}).sample_datasets || [] : prob.samples || [];
  const testsHiddenRaw = isSqlProblem ? (prob.sql_meta || {}).hidden_datasets || [] : prob.hiddenTests || [];

  function normTests(arr) {
    const out = [];
    for (const tt of arr || []) {
      if (!tt || typeof tt !== "object") continue;
      const stdin = tt.stdin != null ? tt.stdin : tt.input;
      const expected = tt.expected != null ? tt.expected : tt.output;
      if (stdin == null || expected == null) continue;
      out.push({ stdin: String(stdin), expected: String(expected) });
    }
    return out;
  }

  const testsSamplesN = isSqlProblem ? testsSamplesRaw : normTests(testsSamplesRaw);
  const testsHiddenN = isSqlProblem ? testsHiddenRaw : normTests(testsHiddenRaw);

  const tests = [
    ...(testsSamplesN || []).map((t) => ({ ...t, hidden: false })),
    ...(testsHiddenN || []).map((t) => ({ ...t, hidden: true })),
  ];

  if (!tests.length) return res.status(400).json({ error: "No tests configured for this problem" });

  const t0 = Date.now();
  const results = [];
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    let stdin = t.stdin || "";
    let expected = t.expected;
    const hidden = !!t.hidden;
    const isSample = !hidden;
    let expectedObj = null;
    let r;

    try {
      if (isSqlProblem) {
        const setupSql = t.setup_sql || "";
        expectedObj = { columns: t.expected_columns || [], rows: t.expected_rows || [] };
        const actual = executeSqlQuery(((prob.sql_meta || {}).schema_sql || "") + "\n" + setupSql, sourceCode);
        const passedSql = compareSqlResults(actual, expectedObj);
        r = {
          stdout: sqlRowsToText(actual.rows || [], actual.columns || []),
          stderr: "",
          compile_output: "",
          status: passedSql ? "Accepted" : "Wrong Answer",
          status_id: passedSql ? 3 : 4,
          expected: sqlRowsToText(expectedObj.rows || [], expectedObj.columns || []),
          expected_columns: expectedObj.columns || [],
          expected_rows: expectedObj.rows || [],
          actual_columns: actual.columns || [],
          actual_rows: actual.rows || [],
          is_sql: true,
          passed: passedSql,
        };
        stdin = setupSql;
        expected = r.expected;
      } else {
        r = await codeRun(sourceCode, stdin, language, { expected });
      }
    } catch (e) {
      r = {
        stdout: "",
        stderr: String(e.message || e),
        compile_output: "",
        status: "Error",
        status_id: 13,
        expected: expected != null ? (expected || "").trim() : "",
        passed: false,
      };
      if (isSqlProblem) {
        r.expected_columns = expectedObj ? expectedObj.columns || [] : [];
        r.expected_rows = expectedObj ? expectedObj.rows || [] : [];
        r.actual_columns = [];
        r.actual_rows = [];
        r.is_sql = true;
      }
    }

    r.id = i + 1;
    r.is_sample = isSample;
    r.hidden = hidden;
    r.stdin = stdin;
    r.expected = expected != null ? expected : "";
    results.push(r);
  }

  const passed = results.filter((r) => r.passed).length;
  const total = tests.length;
  const sampleTotal = testsSamplesN.length;
  const hiddenTotal = testsHiddenN.length;
  const samplePassed = results.slice(0, sampleTotal).filter((r) => r.passed).length;
  const hiddenPassed = results.slice(sampleTotal).filter((r) => r.passed).length;

  const firstFail = results.find((r) => !r.passed);
  let status = passed === total ? "Accepted" : "Wrong Answer";
  if (firstFail && (firstFail.compile_output || "").trim()) status = "Compilation Error";
  else if (firstFail && (firstFail.stderr || "").trim()) status = "Runtime Error";

  let fullMarks = parseInt(prob.total_marks || 0, 10);
  if (fullMarks <= 0) fullMarks = codingFullMarks(prob.difficulty);

  const marksAwarded = passed === total && total > 0 ? fullMarks : Math.round(fullMarks * (passed / Math.max(1, total)) || 0);

  const testcases = results.map((c) => caseToPublicDict(c, false));

  let tcAnalysis = null;
  if (!isSqlProblem) {
    try {
      if (!(prob.timeComplexity || prob.time_complexity || prob.spaceComplexity || prob.space_complexity)) {
        const ptxt =
          `${prob.title || ""}\n${prob.statement || ""}\n\n` +
          `Input Format:\n${prob.inputFormat || ""}\n\n` +
          `Output Format:\n${prob.outputFormat || ""}\n\n` +
          `Constraints:\n` +
          (prob.constraints || []).map((x) => String(x)).join("\n");
        tcAnalysis = (await geminiCodeAnalysis(ptxt, sourceCode, language)) || null;
      }
    } catch {
      tcAnalysis = null;
    }
  }

  const summary = {
    passed,
    total,
    passed_all: passed === total,
    status,
    sample_passed: samplePassed,
    sample_total: sampleTotal,
    hidden_passed: hiddenPassed,
    hidden_total: hiddenTotal,
    marks_awarded: marksAwarded,
    full_marks: fullMarks,
    at: utcIso() + "Z",
    wall_time_ms: Date.now() - t0,
    timeComplexity: isSqlProblem ? null : prob.timeComplexity || prob.time_complexity || (tcAnalysis && tcAnalysis.timeComplexity) || null,
    spaceComplexity: isSqlProblem ? null : prob.spaceComplexity || prob.space_complexity || (tcAnalysis && tcAnalysis.spaceComplexity) || null,
    analysis: isSqlProblem ? null : (tcAnalysis && tcAnalysis.analysis) || null,
  };

  try {
    await col.updateOne(
      { _id: doc._id },
      {
        $set: {
          [`answers.coding.${pid}.language`]: language,
          [`answers.coding.${pid}.code`]: sourceCode,
          [`answers.coding.${pid}.lastSubmit`]: summary,
          updated_at: new Date(),
        },
      }
    );
  } catch {
    // best-effort
  }

  try {
    const updated = (await col.findOne({ _id: doc._id })) || {};
    const answers = updated.answers || {};
    const coding = (answers && typeof answers === "object" && answers.coding) || {};
    let cScore = 0;
    let cTotalMarks = 0;
    for (const c of Object.values(coding)) {
      const ls = c && typeof c === "object" ? c.lastSubmit : null;
      if (ls && typeof ls === "object") {
        cScore += parseInt(ls.marks_awarded || 0, 10);
        cTotalMarks += parseInt(ls.full_marks || 0, 10);
      }
    }
    const scores = (updated.scores && typeof updated.scores === "object" ? updated.scores : {}) || {};
    scores.coding = cScore;

    const mode2 = (updated.mode || "").toLowerCase();
    const baseQ = parseInt((updated.pattern || {}).general || 0, 10) + parseInt((updated.pattern || {}).tech || 0, 10);
    const totalMarks = ["coding", "sql"].includes(mode2) ? cTotalMarks : baseQ + cTotalMarks;
    const totalScore = parseInt(scores.general || 0, 10) + parseInt(scores.tech || 0, 10) + parseInt(scores.coding || 0, 10);

    await col.updateOne({ _id: updated._id }, { $set: { scores, total_score: totalScore, total_marks: totalMarks, updated_at: new Date() } });
  } catch {
    // best-effort
  }

  res.json({ ...summary, testcases });
});

const VIOLATION_MESSAGES = {
  "tab-hidden": "Tab or window switch detected",
  "tab-switch": "Tab switching detected",
  "window-blur": "Window focus lost (possible tab switch)",
  "fullscreen-exit": "Exited fullscreen mode",
  "camera-off": "Camera disconnected or turned off",
  "copy-paste": "Copy / paste attempt blocked",
  "right-click": "Right-click attempt blocked",
  "keyboard-shortcut": "Blocked keyboard shortcut attempt",
  "screen-switch": "Screen switching detected",
};

router.post("/mocktest/sessions/:sessionId/proctoring/violation", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const sessionId = req.params.sessionId;
  const payload = req.body || {};
  const eventType = (payload.type || payload.event || "screen-switch").trim() || "screen-switch";

  const db = await getDb();
  const col = mocktestSessionsCol(db);
  const doc = await col.findOne({ uid, session_id: sessionId });
  if (!doc) return res.status(404).json({ error: "Not found" });

  const kind = (doc.kind || "mock").trim().toLowerCase();
  if (kind === "practice") return res.status(400).json({ error: "Proctoring is enabled only for mock tests." });

  const current = doc.proctoring || defaultProctoring(3);
  const limit = parseInt(current.violation_limit || 3, 10);

  if ((doc.status || "").toLowerCase() === "submitted") {
    return res.json({ ok: true, proctoring: proctoringPublic(current), auto_submitted: !!current.auto_submitted });
  }

  const nowDt = new Date();
  const nowIso = nowDt.toISOString();
  const newCount = parseInt(current.violations || 0, 10) + 1;

  const violationDesc = VIOLATION_MESSAGES[eventType] || `Proctoring violation (${eventType})`;
  const warning = { message: `Warning ${newCount}/${limit}: ${violationDesc}.`, at: nowIso, at_ist: fmtIst(nowDt) };
  const event = { type: eventType, description: violationDesc, at: nowIso, at_ist: fmtIst(nowDt) };
  const warnings = [...(current.warnings || []), warning];
  const events = [...(current.events || []), event];
  const autoSubmitted = newCount >= limit;

  const proctoring = {
    ...defaultProctoring(limit),
    ...current,
    enabled: true,
    violation_limit: limit,
    violations: newCount,
    warnings,
    events,
    last_violation_at: nowIso,
    auto_submitted: autoSubmitted,
    auto_submit_reason: autoSubmitted ? "Auto-submitted due to proctoring violation" : current.auto_submit_reason || "",
  };

  const setFields = { proctoring, updated_at: new Date(), updatedAt: new Date() };

  if (autoSubmitted) {
    const totalMarks = parseInt(doc.total_marks || 0, 10);
    const zeroScores = {
      general: 0,
      general_total: parseInt((doc.pattern || {}).general || (doc.general_questions || []).length, 10),
      tech: 0,
      tech_total: parseInt((doc.pattern || {}).tech || (doc.tech_questions || []).length, 10),
      coding: 0,
      coding_total: (doc.coding_problems || []).filter((p) => p && typeof p === "object").reduce((s, p) => s + parseInt(p.total_marks || 0, 10), 0),
    };
    Object.assign(setFields, {
      status: "submitted",
      submittedAt: nowIso,
      submitted_at: nowIso,
      scores: zeroScores,
      total_score: 0,
      total_marks: totalMarks,
      analysis: {
        summary: "This mock test was auto-submitted because proctoring detected screen switching 3/3 times.",
        overall_feedback: "Score forced to 0 due to proctoring violation.",
        strong_sections: [],
        improve_knowledge: [
          {
            section: "general",
            action_plan: "Retake the mock test and remain on the Zenith test screen throughout the attempt.",
            topics: ["Exam discipline", "Proctoring compliance"],
            resources_suggestion: "Stay on the same tab/window until the mock test is submitted.",
          },
        ],
      },
    });
  }

  await col.updateOne({ _id: doc._id }, { $set: setFields });

  if (autoSubmitted) {
    try {
      const toEmail = (req.user.email || "").trim();
      if (toEmail) {
        const subj = "Zenith Mock Test Auto-Submitted Due to Proctoring Violation";
        const html = brandEmail({
          title: "Mock test auto-submitted",
          subtitle: "Proctoring violation detected",
          bodyHtml:
            `<p>Your mock test <b>${htmlEscape(doc.title || "Mock Test")}</b> was auto-submitted with <b>0 marks</b>.</p>` +
            `<p><b>Violation count:</b> ${newCount}/${limit}</p>` +
            `<p><b>Last violation time:</b> ${htmlEscape(fmtIst(nowDt))}</p>` +
            `<p>Please stay on the Zenith mock test screen during future attempts.</p>` +
            proctoringDetailsHtml(proctoring),
          ctaUrl: "/my-tests?tab=mock",
          ctaText: "Open Mock Test History",
          kind: "mocktest",
          req,
        });
        sendEmail(
          toEmail,
          subj,
          html,
          `Your mock test '${doc.title || "Mock Test"}' was auto-submitted with 0 marks due to proctoring violations.\n` +
            `Violation count: ${newCount}/${limit}\n` +
            `Last violation time: ${fmtIst(nowDt)}\n` +
            proctoringDetailsText(proctoring),
          { kind: "mocktest", replyTo: config.contactInbox || config.adminEmail, req }
        );
      }
    } catch (e) {
      console.log("[email] proctoring violation send failed:", e);
    }
  }

  res.json({
    ok: true,
    proctoring: proctoringPublic(proctoring),
    auto_submitted: autoSubmitted,
    submitted: autoSubmitted,
    total_score: autoSubmitted ? 0 : null,
    total_marks: parseInt(doc.total_marks || 0, 10),
  });
});

router.post("/mocktest/sessions/:sessionId/submit", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const sessionId = req.params.sessionId;
  const payload = req.body || {};
  const answers = payload.answers || {};
  const codingSubmissions = answers.coding || {};
  const genAns = answers.general && typeof answers.general === "object" ? answers.general : {};
  const techAns = answers.tech && typeof answers.tech === "object" ? answers.tech : {};

  const db = await getDb();
  const col = mocktestSessionsCol(db);
  const doc = await col.findOne({ uid, session_id: sessionId });
  if (!doc) return res.status(404).json({ error: "Not found" });

  const genQs = doc.general_questions || [];
  const techQs = doc.tech_questions || [];

  function scoreMcq(qs, ansMap) {
    let s = 0;
    for (const q of qs) {
      const qid = q.id;
      let sel = null;
      try {
        sel = ansMap[qid] != null ? parseInt(ansMap[qid], 10) : null;
      } catch {
        sel = null;
      }
      if (sel != null && sel === parseInt(q.correctIndex || 0, 10)) s += parseInt(q.marks || 1, 10);
    }
    return s;
  }

  const genScore = scoreMcq(genQs, genAns);
  const techScore = scoreMcq(techQs, techAns);

  let codingScore = 0;
  let codingTotalMarks = 0;
  const codingDetails = {};
  const problems = doc.coding_problems || [];

  for (const p of problems) {
    if (!p || typeof p !== "object") continue;
    const pid = p.id;
    const sub = (codingSubmissions && typeof codingSubmissions === "object" && codingSubmissions[pid]) || {};
    const dbSub = ((doc.answers || {}).coding || {})[pid] || {};
    const lang = (sub.language || dbSub.language || "").trim().toLowerCase();
    let code = sub.code || dbSub.code || "";

    if (!String(code).trim()) code = starterCodeForProblem(p, lang || "python") || "";

    const declaredMarks = parseInt(p.total_marks || 0, 10);
    const fullMarks = declaredMarks > 0 ? declaredMarks : codingFullMarks(p.difficulty);
    codingTotalMarks += fullMarks;

    const isSqlProblem = String((p || {}).type || "").trim().toLowerCase() === "sql";
    const samples = isSqlProblem ? (p.sql_meta || {}).sample_datasets || [] : p.samples || [];
    const hidden = isSqlProblem ? (p.sql_meta || {}).hidden_datasets || [] : p.hiddenTests || [];
    const tests = [...samples, ...hidden].filter((t) => t && typeof t === "object");

    const per = [];
    let passed = 0;
    const total = tests.length;

    if ((!code || !lang) && dbSub && typeof dbSub === "object") {
      const lastSubmit = dbSub.lastSubmit || {};
      if (lastSubmit && typeof lastSubmit === "object" && Object.keys(lastSubmit).length) {
        const marksAwarded = parseInt(lastSubmit.marks_awarded || 0, 10);
        const passedCached = parseInt(lastSubmit.passed || lastSubmit.passed_count || 0, 10);
        const totalCached = parseInt(lastSubmit.total || total, 10);
        codingScore += Math.max(0, marksAwarded);
        codingDetails[pid] = {
          passed: passedCached,
          total: totalCached,
          marks_awarded: marksAwarded,
          full_marks: parseInt(lastSubmit.full_marks || fullMarks, 10),
          results: lastSubmit.results || [],
          source: "cached",
        };
        continue;
      }
    }

    if (!code || !lang) {
      codingDetails[pid] = { passed: 0, total, marks_awarded: 0, full_marks: fullMarks, results: [] };
      continue;
    }

    for (let idx = 0; idx < tests.length; idx++) {
      const t = tests[idx];
      let jr;
      try {
        if (isSqlProblem) {
          const actual = executeSqlQuery(((p.sql_meta || {}).schema_sql || "") + "\n" + (t.setup_sql || ""), code);
          const expectedObj = { columns: t.expected_columns || [], rows: t.expected_rows || [] };
          const okSql = compareSqlResults(actual, expectedObj);
          jr = {
            passed: okSql,
            stdout: sqlRowsToText(actual.rows || [], actual.columns || []),
            expected: sqlRowsToText(expectedObj.rows || [], expectedObj.columns || []),
            status: okSql ? "Accepted" : "Wrong Answer",
          };
        } else {
          jr = await codeRun(code, t.stdin || "", lang, { expected: t.expected || "" });
        }
      } catch (e) {
        jr = { passed: false, error: String(e.message || e) };
      }
      const item = {};
      for (const k of ["passed", "stdout", "expected", "stderr", "compile_output", "status", "time", "memory"]) {
        if (k in jr) item[k] = jr[k];
      }
      item.isSample = idx < samples.length;
      per.push(item);
      if (jr.passed) passed += 1;
    }

    const marksAwarded = passed === total && total > 0 ? fullMarks : Math.round((fullMarks * (passed / Math.max(1, total))) || 0);
    codingScore += marksAwarded;
    codingDetails[pid] = { passed, total, marks_awarded: marksAwarded, full_marks: fullMarks, results: per };
  }

  const totalScore = genScore + techScore + codingScore;
  const totalMarks = genQs.length + techQs.length + codingTotalMarks;

  function topicStats(qs, ansMap) {
    const stats = {};
    for (const q of qs) {
      const topic = (q.topic || "general").trim();
      const qid = q.id;
      let sel = null;
      try {
        sel = ansMap[qid] != null ? parseInt(ansMap[qid], 10) : null;
      } catch {
        sel = null;
      }
      const correct = sel != null && sel === parseInt(q.correctIndex || 0, 10);
      const s = stats[topic] || { correct: 0, total: 0 };
      s.total += 1;
      if (correct) s.correct += 1;
      stats[topic] = s;
    }
    const strong = [];
    const weak = [];
    for (const [t, s] of Object.entries(stats)) {
      if (s.total <= 0) continue;
      const acc = s.correct / Math.max(1, s.total);
      if (s.total >= 2 && acc >= 0.7) strong.push({ topic: t, acc: Math.round(acc * 100) / 100, total: s.total });
      if (s.total >= 1 && acc < 0.5) weak.push({ topic: t, acc: Math.round(acc * 100) / 100, total: s.total });
    }
    return { stats, strong: strong.slice(0, 5), weak: weak.slice(0, 5) };
  }

  const genTopics = topicStats(genQs, genAns);
  const techTopics = topicStats(techQs, techAns);

  const codingTopicSummary = {};
  for (const p of problems) {
    const topic = (p.topic || "coding").trim();
    const pid = p.id;
    const det = codingDetails[pid] || {};
    const totalT = parseInt(det.total || 0, 10);
    const passT = parseInt(det.passed || 0, 10);
    const s = codingTopicSummary[topic] || { passed: 0, total: 0, problems: 0 };
    s.passed += passT;
    s.total += totalT;
    s.problems += 1;
    codingTopicSummary[topic] = s;
  }

  let analysis = null;
  let analysisUnavailableReason = null;
  try {
    const hiddenTestsSum = problems.reduce((s, p) => s + ((p.hiddenTests || []).length || 0), 0);
    const analysisPrompt = `
You are an interview coach analyzing a user's mock test performance.
Return STRICT JSON only:
{
  "strong_sections": ["general|tech|coding"],
  "weak_sections": ["general|tech|coding"],
  "strong_topics": {
    "general": ["..."],
    "tech": ["..."],
    "coding": ["..."]
  },
  "weak_topics": {
    "general": ["..."],
    "tech": ["..."],
    "coding": ["..."]
  },
  "summary": "2-4 lines",
  "overall_feedback": "2-4 lines",
  "improve_knowledge": [
     {"section":"general|tech|coding","topics":["...","..."],"action_plan":"short bullet plan","resources_suggestion":"short"}
  ]
}

User scores:
- General Aptitude: ${genScore}/${genQs.length}
- Tech Aptitude: ${techScore}/${techQs.length}
- Coding (testcases passed): ${codingScore}/${hiddenTestsSum}

Topic-level performance (use this to identify EXACT weak/strong topics; do NOT return generic lists):
General strong candidates: ${JSON.stringify(genTopics.strong)}
General weak candidates: ${JSON.stringify(genTopics.weak)}
Tech strong candidates: ${JSON.stringify(techTopics.strong)}
Tech weak candidates: ${JSON.stringify(techTopics.weak)}
Coding topic summary: ${JSON.stringify(codingTopicSummary)}

Guidelines:
- Choose strong_topics / weak_topics based on the provided accuracy summaries.
- "Improve knowledge" should focus on weak topics first and be specific (what to study + practice type).
- Keep it concise and practical.
- Do NOT mention Gemini.
`;
    analysis = (await geminiJsonSafe(analysisPrompt)) || null;
    if (analysis && !Object.keys(analysis).length) analysis = null;
  } catch (e) {
    // The score itself still saves and is returned below even when this fails — analysis is a
    // "nice to have" on top of the real report, not a prerequisite for it. This used to fail
    // completely silently (bare `catch {}`), which made a real, repeatable failure (e.g. hitting
    // the Gemini API's daily quota) indistinguishable from "everything's fine, analysis is just
    // null" — logging it here is the difference between being able to diagnose that and not.
    analysis = null;
    analysisUnavailableReason = isQuotaError(e) ? "quota_exceeded" : "generation_failed";
    console.log("[mocktest submit] analysis generation failed:", analysisUnavailableReason, "-", e.message || e);
  }

  const now = new Date();
  await col.updateOne(
    { uid, session_id: sessionId },
    {
      $set: {
        answers: { general: genAns, tech: techAns, coding: codingSubmissions && typeof codingSubmissions === "object" ? codingSubmissions : {} },
        scores: { general: genScore, tech: techScore, coding: codingScore },
        coding_details: codingDetails,
        coding_total_marks: codingTotalMarks,
        total_score: totalScore,
        total_marks: totalMarks,
        analysis,
        analysis_unavailable_reason: analysisUnavailableReason,
        status: "submitted",
        updated_at: now,
        updatedAt: now,
        submittedAt: now,
      },
    }
  );

  let emailSent = false;
  try {
    const toEmail = (req.user.email || "").trim();
    if (toEmail) {
      const isPractice = (doc.kind || "mock").trim().toLowerCase() === "practice";
      let testName = (doc.test_name || doc.title || doc.name || "Zenith Mock Test").trim();
      const testDifficulty = (doc.difficulty || doc.level || doc.selected_difficulty || "").trim();
      testName = sanitizeTestNameForEmail(testName, { isPractice });
      const testNameDisplay = testDifficulty ? `${testName} (${testDifficulty[0].toUpperCase()}${testDifficulty.slice(1)})` : testName;

      const IST_OFFSET_MS = (5 * 60 + 30) * 60000;
      let createdStr = "N/A";
      if (doc.created_at instanceof Date) {
        createdStr = fmtIst(doc.created_at);
      } else if (typeof doc.created_at === "string") {
        const d = new Date(doc.created_at);
        if (!Number.isNaN(d.getTime())) createdStr = fmtIst(d);
      }
      const submittedDt = now;
      const submittedStr = fmtIst(submittedDt);

      const subj = `${testNameDisplay} • Report • Score ${totalScore}/${totalMarks}`;

      const scoreItems = [`<li><b>🏆 Total Score:</b> ${totalScore}/${totalMarks}</li>`];
      if (genQs.length > 0) scoreItems.push(`<li><b>🧠 General Aptitude:</b> ${genScore}/${genQs.length}</li>`);
      if (techQs.length > 0) scoreItems.push(`<li><b>💻 Technical Aptitude:</b> ${techScore}/${techQs.length}</li>`);
      if ((codingTotalMarks || 0) > 0) scoreItems.push(`<li><b>👨‍💻 Coding:</b> ${codingScore}/${codingTotalMarks}</li>`);

      let geminiBlock = "";
      let summ = "";
      if (analysis && typeof analysis === "object") {
        summ = analysis.summary;
        const overallFb = analysis.overall_feedback;
        const strongSecs = analysis.strong_sections || [];
        const weakSecs = analysis.weak_sections || [];
        const strongTopics = analysis.strong_topics || {};
        const weakTopics = analysis.weak_topics || {};
        const improve = analysis.improve_knowledge || [];

        const secLabel = (s) => {
          s = (s || "").trim().toLowerCase();
          return { general: "General Aptitude", tech: "Technical Aptitude", coding: "Coding" }[s] || (s ? s[0].toUpperCase() + s.slice(1) : "Section");
        };

        const parts = [];
        parts.push(`<p><b>📝 Test Name:</b> ${htmlEscape(testNameDisplay)}</p>`);
        parts.push(`<p><b>🗓️ Test Created:</b> ${htmlEscape(createdStr)}<br/><b>⏰ Submitted:</b> ${htmlEscape(submittedStr)}</p>`);
        parts.push("<hr/>");
        if (summ) parts.push(`<p><b>🧾 Summary:</b> ${htmlEscape(String(summ))}</p>`);
        if (overallFb) parts.push(`<p><b>💬 Feedback:</b> ${htmlEscape(String(overallFb))}</p>`);
        if (strongSecs.length) parts.push(`<p><b>✅ Strong:</b> ${strongSecs.map((x) => htmlEscape(secLabel(x))).join(", ")}</p>`);
        if (weakSecs.length) parts.push(`<p><b>⚠️ Needs work:</b> ${weakSecs.map((x) => htmlEscape(secLabel(x))).join(", ")}</p>`);

        const topicsHtml = (title, tmap) => {
          const blocks = [];
          for (const secKey of ["general", "tech", "coding"]) {
            if (secKey === "general" && genQs.length === 0) continue;
            if (secKey === "tech" && techQs.length === 0) continue;
            if (secKey === "coding" && parseInt(codingTotalMarks || 0, 10) <= 0) continue;
            let arr = tmap[secKey] || [];
            arr = arr.map((x) => String(x)).filter((x) => x.trim());
            if (!arr.length) continue;
            blocks.push(`<li><b>${htmlEscape(secLabel(secKey))}:</b> ${arr.slice(0, 8).map((x) => htmlEscape(x)).join(", ")}</li>`);
          }
          if (!blocks.length) return "";
          return `<p><b>${title}</b></p><ul>${blocks.join("")}</ul>`;
        };
        parts.push(topicsHtml("💪 Strong Topics", strongTopics) || "");
        parts.push(topicsHtml("🛠️ Focus Topics", weakTopics) || "");

        if (Array.isArray(improve) && improve.length) {
          const planItems = [];
          for (const item of improve.slice(0, 4)) {
            if (!item || typeof item !== "object") continue;
            const sec = secLabel(item.section);
            const topics = (item.topics || []).map((x) => String(x)).filter((x) => x.trim());
            const ap = (item.action_plan || "").trim();
            const resr = (item.resources_suggestion || "").trim();
            let li = `<li><b>🎯 ${htmlEscape(sec)}</b>`;
            if (topics.length) li += `<br/><span>📌 Topics: ${topics.slice(0, 8).map((x) => htmlEscape(x)).join(", ")}</span>`;
            if (ap) li += `<br/><span>✅ Plan: ${htmlEscape(ap)}</span>`;
            if (resr) li += `<br/><span>📚 Resources: ${htmlEscape(resr)}</span>`;
            li += "</li>";
            planItems.push(li);
          }
          if (planItems.length) parts.push(`<p><b>📈 Improvement Plan</b></p><ul>${planItems.join("")}</ul>`);
        }

        geminiBlock = parts.filter(Boolean).join("");
      }

      const reportTitle = isPractice ? "Zenith Practice Test Report" : "Zenith Mock Test Report";
      const ctaText = isPractice ? "View Practice Test History" : "View Mock Test History";
      const ctaUrl = isPractice ? "/my-tests?tab=practice" : "/my-tests?tab=mock";

      const proctoringBlockHtml = isPractice ? "" : proctoringDetailsHtml(doc.proctoring || {});
      const proctoringBlockText = isPractice ? "" : proctoringDetailsText(doc.proctoring || {});

      const bodyHtml =
        (isPractice ? "<p>Your practice test has been evaluated and your report is ready ✅</p>" : "<p>Your mock test has been evaluated and your report is ready ✅</p>") +
        `<ul>${scoreItems.join("")}</ul>` +
        (geminiBlock ||
          `<p><b>📝 Test Name:</b> ${htmlEscape(testNameDisplay)}</p><p><b>🗓️ Test Created:</b> ${htmlEscape(createdStr)}<br/><b>⏰ Submitted:</b> ${htmlEscape(submittedStr)}</p><hr/>`) +
        proctoringBlockHtml +
        "<p style='margin-top:12px'>Open Zenith to review your detailed analysis, mistakes, and recommendations.</p>";

      const html = brandEmail({
        title: reportTitle,
        subtitle: `Score: ${totalScore}/${totalMarks}`,
        bodyHtml,
        ctaUrl,
        ctaText,
        kind: isPractice ? "practicetest" : "mocktest",
        req,
      });

      emailSent = !!sendEmail(
        toEmail,
        subj,
        html,
        `Test Name: ${testNameDisplay}\n` +
          `Created: ${createdStr}\n` +
          `Submitted: ${submittedStr}\n\n` +
          `Total: ${totalScore}/${totalMarks}\n` +
          (genQs.length > 0 ? `General: ${genScore}/${genQs.length}\n` : "") +
          (techQs.length > 0 ? `Technical: ${techScore}/${techQs.length}\n` : "") +
          ((codingTotalMarks || 0) > 0 ? `Coding: ${codingScore}/${codingTotalMarks}\n` : "") +
          (summ ? `\nSummary: ${summ}\n` : "") +
          proctoringBlockText,
        { kind: isPractice ? "practicetest" : "mocktest", replyTo: config.contactInbox || config.adminEmail, req }
      );
    }
  } catch (e) {
    console.log("[email] mock test report send failed:", e);
  }

  res.json({
    ok: true,
    email_sent: emailSent,
    scores: { general: genScore, tech: techScore, coding: codingScore },
    total_score: totalScore,
    total_marks: totalMarks,
    analysis,
    analysis_unavailable_reason: analysisUnavailableReason,
    coding_details: codingDetails,
    coding_total_marks: codingTotalMarks,
  });
});

router.delete("/mocktest/sessions/:sessionId", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const sessionId = req.params.sessionId;
  const db = await getDb();
  const col = mocktestSessionsCol(db);
  const result = await col.deleteOne({ uid, session_id: sessionId });
  res.json({ ok: true, deleted: parseInt(result.deletedCount || 0, 10) });
});

export default router;
