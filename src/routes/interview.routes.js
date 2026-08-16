import { Router } from "express";
import crypto from "crypto";
import { getDb } from "../config/mongo.js";
import { requireUser } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { extractPdfTextBytes } from "../utils/pdfDocx.js";
import { getGeminiResponse } from "../utils/gemini.js";
import { utcIso } from "../utils/dates.js";

const router = Router();

function interviewSessionsCol(db) {
  return db.collection("interview_sessions");
}

function interviewSessionPublic(doc) {
  if (!doc) return null;
  const report = doc.report && typeof doc.report === "object" ? doc.report : null;
  let overall = null;
  try {
    overall = report ? parseInt(report.overall_score, 10) : null;
    if (Number.isNaN(overall)) overall = null;
  } catch {
    overall = null;
  }
  return {
    session_id: doc.session_id,
    created_at: (doc.created_at || new Date()).toISOString(),
    updated_at: (doc.updated_at || doc.created_at || new Date()).toISOString(),
    role_target: doc.role_target || "",
    resume_uploaded: !!doc.resume_text,
    message_count: parseInt(doc.message_count || 0, 10),
    resume_filename: doc.resume_filename || "",
    jd_title: doc.jd_title || "",
    jd_source: doc.jd_source || "",
    has_report: !!report,
    overall_score: overall,
  };
}

router.post("/interview/session/start", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const payload = req.body || {};
  const roleTarget = (payload.role_target || "").trim();

  const db = await getDb();
  const col = interviewSessionsCol(db);

  const sessionId = crypto.randomUUID();
  const now = new Date();
  const doc = {
    session_id: sessionId,
    uid,
    created_at: now,
    role_target: roleTarget,
    resume_filename: "",
    resume_text: "",
    chat_history: [],
    message_count: 0,
    updated_at: now,
  };
  await col.insertOne(doc);
  res.json({ ok: true, session: interviewSessionPublic(doc) });
});

router.get("/interview/sessions", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const db = await getDb();
  const col = interviewSessionsCol(db);
  const items = await col.find({ uid }).sort({ created_at: -1 }).limit(50).toArray();
  res.json({ ok: true, sessions: items.map(interviewSessionPublic) });
});

router.get("/interview/sessions/:sessionId/history", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const db = await getDb();
  const col = interviewSessionsCol(db);
  const doc = await col.findOne({ uid, session_id: req.params.sessionId });
  if (!doc) return res.status(404).json({ error: "Session not found" });
  res.json({ ok: true, session: interviewSessionPublic(doc), chat_history: doc.chat_history || [] });
});

router.post("/interview/sessions/:sessionId/reset", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const db = await getDb();
  const col = interviewSessionsCol(db);
  const r = await col.updateOne(
    { uid, session_id: req.params.sessionId },
    { $set: { chat_history: [], message_count: 0, updated_at: new Date() } }
  );
  if (r.matchedCount === 0) return res.status(404).json({ error: "Session not found" });
  res.json({ ok: true });
});

router.delete("/interview/sessions/:sessionId", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const db = await getDb();
  const col = interviewSessionsCol(db);
  const r = await col.deleteOne({ uid, session_id: req.params.sessionId });
  if (r.deletedCount === 0) return res.status(404).json({ error: "Session not found" });
  res.json({ ok: true });
});

router.post("/interview/resume/upload", requireUser, upload.single("file"), async (req, res) => {
  const uid = req.user.uid;
  const file = req.file;
  if (!file) return res.status(400).json({ error: "Missing file" });

  const filename = (file.originalname || "").trim();
  if (!filename.toLowerCase().endsWith(".pdf")) {
    return res.status(400).json({ error: "Only PDF resumes are supported" });
  }

  const sessionId = (req.body.session_id || "").trim() || crypto.randomUUID();
  const roleTarget = (req.body.role_target || "").trim();

  const resumeText = await extractPdfTextBytes(file.buffer || Buffer.alloc(0));
  if (!resumeText) {
    return res.status(400).json({ error: "Could not extract text from this PDF. Try a text-based PDF (not scanned)." });
  }

  const db = await getDb();
  const col = interviewSessionsCol(db);

  const now = new Date();
  let doc = await col.findOne({ uid, session_id: sessionId });
  if (!doc) {
    doc = {
      session_id: sessionId,
      uid,
      created_at: now,
      role_target: roleTarget,
      resume_filename: filename,
      resume_text: resumeText,
      chat_history: [],
      message_count: 0,
      updated_at: now,
    };
    await col.insertOne(doc);
  } else {
    const update = { resume_filename: filename, resume_text: resumeText, updated_at: now };
    if (roleTarget) update.role_target = roleTarget;
    await col.updateOne({ _id: doc._id }, { $set: update });
    Object.assign(doc, update);
  }

  res.json({ ok: true, message: "Resume uploaded and processed", session: interviewSessionPublic(doc), resume_chars: resumeText.length });
});

const INTERVIEW_PREDEFINED_ROLES = [
  { key: "custom", title: "Custom Job Description" },
  { key: "business_analyst", title: "Business Analyst" },
  { key: "product_manager", title: "Product Manager" },
  { key: "software_engineer", title: "Software Engineer" },
  { key: "marketing_specialist", title: "Marketing Specialist" },
  { key: "data_analyst", title: "Data Analyst" },
  { key: "customer_service_rep", title: "Customer Service Representative" },
  { key: "sales_rep", title: "Sales Representative" },
  { key: "hr_specialist", title: "Human Resources Specialist" },
  { key: "ux_ui_designer", title: "UX/UI Designer" },
  { key: "qa_engineer", title: "QA Engineer" },
];

function roleTitleFromKey(k) {
  k = (k || "").trim().toLowerCase();
  const r = INTERVIEW_PREDEFINED_ROLES.find((x) => x.key === k);
  return r ? r.title : "";
}

async function generateJobDescription(roleTitle) {
  roleTitle = (roleTitle || "").trim();
  if (!roleTitle) return "";
  const prompt = `Create a detailed Job Description for the role: ${roleTitle}.
Include:
- Job Title
- Role Summary (2-4 sentences)
- Responsibilities (8-12 bullet points)
- Requirements (8-12 bullet points)
- Nice-to-haves (4-6 bullet points)
Keep it realistic and ATS-friendly. Limit to ~4500 characters.`;
  try {
    return await getGeminiResponse(prompt);
  } catch {
    return "";
  }
}

function buildInterviewPrompt(resumeText, jdText, roleTarget, chatHistory, userMessage) {
  resumeText = (resumeText || "").slice(0, 30_000);
  jdText = (jdText || "").slice(0, 18_000);

  const turns = (chatHistory || []).slice(-14);
  const histLines = [];
  for (const t of turns) {
    const r = (t.role || "").toLowerCase();
    const c = (t.content || "").trim();
    if (!c) continue;
    const label = r === "candidate" ? "Candidate" : "HR";
    histLines.push(`${label}: ${c}`);
  }
  const historyBlock = histLines.join("\n").trim();
  const roleLine = roleTarget ? `Target role: ${roleTarget}\n` : "";

  return `You are an expert HR + technical interviewer.
Your job: conduct a realistic mock interview for the given Job Description (JD), using the candidate's resume.
Rules:
- Ask ONE strong question at a time.
- Mix behavioral + technical + project deep-dives aligned to the JD.
- If the answer is weak/unclear, ask a follow-up.
- Keep responses concise (2-6 sentences). No long essays.
- Do NOT invent resume details; only use what is present in the resume text.
- If the candidate asks for feedback, give actionable feedback and a better sample answer.

${roleLine}
JOB DESCRIPTION (excerpt):
${jdText}

RESUME (excerpt):
${resumeText}

CHAT SO FAR:
${historyBlock}

Candidate's latest message:
${userMessage}

Now respond as HR interviewer.`.trim();
}

async function generateFirstQuestion(resumeText, jdText, roleTarget) {
  const prompt = `You are an interviewer. Based on the Job Description and Resume below, ask the FIRST interview question.
Rules:
- Ask exactly ONE question.
- Prefer a strong opening question referencing either a key JD responsibility or a resume project.
- Keep it under 2 sentences.
Target role (optional): ${roleTarget}

JOB DESCRIPTION:
${(jdText || "").slice(0, 12000)}

RESUME:
${(resumeText || "").slice(0, 20000)}
`;
  try {
    let out = ((await getGeminiResponse(prompt)) || "").trim();
    out = out.replace(/^\s*(\d+\.|[-*])\s*/, "").trim();
    return out || "Tell me about yourself and walk me through the most relevant parts of your resume for this role.";
  } catch {
    return "Tell me about yourself and walk me through the most relevant parts of your resume for this role.";
  }
}

router.get("/interview/jd/templates", (req, res) => {
  res.json({ ok: true, roles: INTERVIEW_PREDEFINED_ROLES });
});

router.post(
  "/interview/session/create",
  requireUser,
  upload.fields([{ name: "resume_file", maxCount: 1 }, { name: "jd_file", maxCount: 1 }]),
  async (req, res) => {
    const uid = req.user.uid;

    const resumeFile = req.files?.resume_file?.[0];
    if (!resumeFile) return res.status(400).json({ error: "resume_file is required (PDF)" });
    const resumeFilename = (resumeFile.originalname || "").trim();
    if (!resumeFilename.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({ error: "Resume must be a PDF" });
    }
    const resumeText = await extractPdfTextBytes(resumeFile.buffer || Buffer.alloc(0));
    if (!resumeText) {
      return res.status(400).json({ error: "Could not extract text from resume PDF. Try a text-based PDF (not scanned)." });
    }

    const jdMode = (req.body.jd_mode || "predefined").trim().toLowerCase();
    const roleKey = (req.body.role_key || "").trim().toLowerCase();
    const roleTarget = (req.body.role_target || "").trim();

    let jdTitle = "";
    let jdSource = "";
    let jdText = "";

    if (jdMode === "custom") {
      jdSource = "custom";
      jdTitle = "Custom Job Description";
      jdText = (req.body.jd_text || "").trim();
      const jdFile = req.files?.jd_file?.[0];
      if (!jdText && jdFile) {
        jdText = await extractPdfTextBytes(jdFile.buffer || Buffer.alloc(0));
      }
      if (!jdText) return res.status(400).json({ error: "Custom JD: provide jd_text or jd_file (PDF)" });
    } else {
      jdSource = "predefined";
      jdTitle = roleTitleFromKey(roleKey) || roleTarget || "Job Description";
      jdText = (req.body.jd_text || "").trim();
      if (!jdText) jdText = await generateJobDescription(jdTitle);
      if (!jdText) return res.status(400).json({ error: "Failed to generate JD. Please try again or use Custom JD." });
    }

    const db = await getDb();
    const col = interviewSessionsCol(db);
    const sessionId = crypto.randomUUID();
    const now = new Date();

    const firstQ = await generateFirstQuestion(resumeText, jdText, roleTarget);

    const doc = {
      session_id: sessionId,
      uid,
      created_at: now,
      updated_at: now,
      role_target: roleTarget || jdTitle,
      resume_filename: resumeFilename,
      resume_text: resumeText,
      jd_title: jdTitle,
      jd_source: jdSource,
      jd_text: jdText,
      chat_history: [{ role: "hr", content: firstQ, ts: now.toISOString() }],
      message_count: 1,
      report: null,
      report_generated_at: null,
    };
    await col.insertOne(doc);

    res.json({ ok: true, session: interviewSessionPublic(doc), first_question: firstQ });
  }
);

function interviewReportPrompt(resumeText, jdText, chatHistory) {
  resumeText = (resumeText || "").slice(0, 20_000);
  jdText = (jdText || "").slice(0, 12_000);
  const turns = (chatHistory || []).slice(-30);
  const convo = [];
  for (const t of turns) {
    const r = (t.role || "").toLowerCase();
    const c = (t.content || "").trim();
    if (!c) continue;
    const label = r === "candidate" ? "Candidate" : "Interviewer";
    convo.push(`${label}: ${c}`);
  }
  const convoText = convo.join("\n");

  return `You are a strict interview evaluator.
Given the Job Description, Resume, and Interview Transcript, produce a JSON report with:
- overall_score (0-100 integer)
- strengths (array of 4-7 bullets)
- gaps (array of 4-7 bullets)
- improvements (array of 6-10 actionable bullets)
- category_scores: object with keys ["communication","technical","problem_solving","project_depth","role_fit"] each 0-100
- summary (2-4 sentences)
- next_steps (array of 3-5 bullets)

Return ONLY valid JSON.

JOB DESCRIPTION:
${jdText}

RESUME:
${resumeText}

INTERVIEW TRANSCRIPT:
${convoText}`.trim();
}

router.get("/interview/sessions/:sessionId/report", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const db = await getDb();
  const col = interviewSessionsCol(db);
  const doc = await col.findOne({ uid, session_id: req.params.sessionId });
  if (!doc) return res.status(404).json({ error: "Session not found" });

  if (doc.report && typeof doc.report === "object") {
    return res.json({ ok: true, session: interviewSessionPublic(doc), report: doc.report });
  }

  if (!doc.chat_history || !doc.chat_history.length) {
    return res.status(400).json({ error: "No interview transcript found for this session" });
  }

  let report;
  try {
    let raw = await getGeminiResponse(interviewReportPrompt(doc.resume_text || "", doc.jd_text || "", doc.chat_history || []));
    raw = (raw || "").trim();
    if (raw.startsWith("```")) {
      raw = raw.replace(/^```(json)?/i, "").trim();
      raw = raw.replace(/^`+|`+$/g, "").trim();
    }
    report = JSON.parse(raw);
  } catch (e) {
    return res.status(500).json({ error: `Failed to generate report: ${e.message || e}` });
  }

  const now = new Date();
  await col.updateOne({ _id: doc._id }, { $set: { report, report_generated_at: now, updated_at: now } });
  doc.report = report;
  doc.report_generated_at = now;
  res.json({ ok: true, session: interviewSessionPublic(doc), report });
});

router.post("/interview/chat", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const payload = req.body || {};
  const sessionId = (payload.session_id || "").trim();
  const message = (payload.message || "").trim();
  if (!sessionId) return res.status(400).json({ error: "session_id is required" });
  if (!message) return res.status(400).json({ error: "message is required" });

  const db = await getDb();
  const col = interviewSessionsCol(db);
  const doc = await col.findOne({ uid, session_id: sessionId });
  if (!doc) return res.status(404).json({ error: "Session not found" });
  if (!doc.resume_text) return res.status(400).json({ error: "Please upload your resume first" });
  if (!doc.jd_text) return res.status(400).json({ error: "Please set a job description (JD) first" });

  const prompt = buildInterviewPrompt(doc.resume_text || "", doc.jd_text || "", doc.role_target || "", doc.chat_history || [], message);

  let reply;
  try {
    reply = await getGeminiResponse(prompt);
  } catch (e) {
    return res.status(500).json({ error: `Gemini error: ${e.message || e}` });
  }

  const nowIso = utcIso();
  const history = doc.chat_history || [];
  history.push({ role: "candidate", content: message, ts: nowIso });
  history.push({ role: "hr", content: reply, ts: nowIso });

  const newCount = parseInt(doc.message_count || 0, 10) + 1;
  await col.updateOne({ _id: doc._id }, { $set: { chat_history: history, message_count: newCount, updated_at: new Date() } });

  res.json({ ok: true, response: reply, session_id: sessionId, message_count: newCount });
});

export default router;
