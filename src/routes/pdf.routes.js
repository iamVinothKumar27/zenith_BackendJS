import { Router } from "express";
import crypto from "crypto";
import { getDb } from "../config/mongo.js";
import { requireUser } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { generateContent, isQuotaError } from "../utils/gemini.js";
import { extractPdfTextBytes } from "../utils/pdfDocx.js";
import { PDF_STORE, pdfCachePut, pdfGet, chunkText, simpleRetrieve, trimHistory, deletePairFromHistory, MAX_PDF_CHARS } from "../utils/chatRag.js";

const router = Router();

router.post("/pdf/upload", requireUser, upload.single("file"), async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: "No file provided (field name: file)" });

  const courseTitle = (req.body.courseTitle || req.body.course || "").trim() || "Course";
  const filename = (f.originalname || "").trim() || "document.pdf";
  if (!filename.toLowerCase().endsWith(".pdf")) {
    return res.status(400).json({ error: "Only PDF files are supported" });
  }

  try {
    let text = await extractPdfTextBytes(f.buffer, MAX_PDF_CHARS);
    text = (text || "").trim();
    if (!text) {
      return res.status(400).json({ error: "Could not extract text from this PDF (it may be scanned). Try a text-based PDF." });
    }
    if (text.length > MAX_PDF_CHARS) text = text.slice(0, MAX_PDF_CHARS);

    const chunks = chunkText(text);
    const pdfId = crypto.randomUUID();
    const now = new Date();
    const doc = {
      pdf_id: pdfId,
      uid: req.user.uid,
      courseTitle,
      filename,
      text,
      chunks,
      createdAt: now,
      updatedAt: now,
    };

    pdfCachePut({ ...doc, created_at: now.toISOString() });
    const db = await getDb();
    if (db) await db.collection("pdf_store").insertOne(doc);

    res.json({ pdf_id: pdfId, filename, chunks: chunks.length, courseTitle });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.get("/pdf/list", requireUser, async (req, res) => {
  const courseTitle = (req.query.courseTitle || req.query.course || "").trim() || "Course";

  const db = await getDb();
  const pdfs = [];
  if (db) {
    const cur = db
      .collection("pdf_store")
      .find({ uid: req.user.uid, courseTitle }, { projection: { _id: 0, pdf_id: 1, filename: 1, createdAt: 1 } })
      .sort({ createdAt: -1 });
    for await (const d of cur) {
      const pid = d.pdf_id;
      if (!pid) continue;
      pdfs.push({ id: pid, name: d.filename || "document.pdf" });
    }
  }

  res.json({ courseTitle, pdfs });
});

router.post("/pdf/chat", requireUser, async (req, res) => {
  const data = req.body || {};
  const pdfId = (data.pdf_id || "").trim();
  const question = (data.question || "").trim();
  const conversationId = (data.conversation_id || "").trim();
  const courseTitle = (data.courseTitle || data.course || "").trim() || "Course";

  if (!pdfId || !question) return res.status(400).json({ error: "pdf_id and question are required" });
  if (!conversationId) return res.status(400).json({ error: "conversation_id is required" });

  const db = await getDb();
  const obj = await pdfGet(db, req.user.uid, pdfId, courseTitle);
  if (!obj || obj.uid !== req.user.uid) return res.status(404).json({ error: "PDF not found (upload again)" });

  if ((obj.courseTitle || "Course") !== (courseTitle || "Course")) {
    return res.status(400).json({ error: "PDF does not belong to this course" });
  }

  const chunks = obj.chunks || [];
  const best = simpleRetrieve(chunks, question, 6);
  const context = best.join("\n\n---\n\n");

  const systemPrompt = `
You are a helpful assistant.
You must answer ONLY using the provided PDF excerpts.
If the answer is not in the excerpts, reply exactly: Not found in the document
Rules:
1) Keep response clear like ChatGPT.
2) Use numbered points only (1., 2., 3.).
3) If code is needed, put it in a separate fenced code block using triple backticks with language.
4) Do NOT use stars (*) or dash bullets (-).
`;

  const prompt = `${systemPrompt}

PDF filename: ${obj.filename}

PDF excerpts:
${context}

User question:
${question}
`;

  const sessionKey = `${req.user.uid}::${courseTitle}::${pdfId}::${conversationId}`;
  let history = [];
  if (db) {
    const doc =
      (await db
        .collection("pdf_chat_sessions")
        .findOne({ uid: req.user.uid, courseTitle, pdf_id: pdfId, conversation_id: conversationId }, { projection: { _id: 0, history: 1 } })) || {};
    history = doc.history || [];
  }
  history.push({ role: "user", content: question });
  history = trimHistory(history);

  try {
    const response = await generateContent(prompt);
    const replyText = (response?.text?.() || "").trim();

    history.push({ role: "assistant", content: replyText });
    history = trimHistory(history);
    if (db) {
      const now = new Date();
      await db.collection("pdf_chat_sessions").updateOne(
        { uid: req.user.uid, courseTitle, pdf_id: pdfId, conversation_id: conversationId },
        { $set: { history, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true }
      );
    }

    res.json({ reply: replyText, pdf_id: pdfId, courseTitle, conversation_id: conversationId, history_size: history.length });
  } catch (e) {
    if (isQuotaError(e)) return res.status(429).json({ error: "We've hit today's AI usage limit. Please try again in a little while.", code: "quota_exceeded" });
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.get("/pdf/chat/history", requireUser, async (req, res) => {
  const pdfId = (req.query.pdf_id || "").trim();
  const conversationId = (req.query.conversation_id || "").trim();
  const courseTitle = (req.query.courseTitle || req.query.course || "").trim() || "Course";
  if (!pdfId || !conversationId) return res.status(400).json({ error: "pdf_id and conversation_id are required" });

  const db = await getDb();
  let history = [];
  if (db) {
    const doc =
      (await db
        .collection("pdf_chat_sessions")
        .findOne({ uid: req.user.uid, courseTitle, pdf_id: pdfId, conversation_id: conversationId }, { projection: { _id: 0, history: 1 } })) || {};
    history = doc.history || [];
  }

  res.json({ pdf_id: pdfId, courseTitle, conversation_id: conversationId, history: history || [] });
});

router.delete("/pdf/chat/history/pair", requireUser, async (req, res) => {
  const data = req.body || {};
  const pdfId = (data.pdf_id || "").trim();
  const courseTitle = (data.courseTitle || data.course || "").trim() || "Course";
  const conversationId = (data.conversation_id || "").trim();
  const pairIndex = data.pair_index;

  if (!pdfId || !conversationId || pairIndex == null) {
    return res.status(400).json({ error: "pdf_id, conversation_id, and pair_index are required" });
  }

  const db = await getDb();
  let history = [];
  if (db) {
    const doc =
      (await db
        .collection("pdf_chat_sessions")
        .findOne({ uid: req.user.uid, courseTitle, pdf_id: pdfId, conversation_id: conversationId }, { projection: { _id: 0, history: 1 } })) || {};
    history = doc.history || [];
  }

  history = deletePairFromHistory(history || [], pairIndex);

  if (db) {
    const now = new Date();
    await db.collection("pdf_chat_sessions").updateOne(
      { uid: req.user.uid, courseTitle, pdf_id: pdfId, conversation_id: conversationId },
      { $set: { history, updatedAt: now } },
      { upsert: true }
    );
  }

  res.json({ pdf_id: pdfId, courseTitle, conversation_id: conversationId, history });
});

router.post("/pdf/delete", requireUser, async (req, res) => {
  const data = req.body || {};
  const pdfId = (data.pdf_id || "").trim();
  const courseTitle = (data.courseTitle || data.course || "").trim() || "Course";

  if (!pdfId) return res.status(400).json({ error: "pdf_id is required" });

  const db = await getDb();
  if (!db) return res.status(500).json({ error: "Database not available" });

  const q = { uid: req.user.uid, courseTitle, pdf_id: pdfId };

  const rStore = await db.collection("pdf_store").deleteOne(q);
  const rSessions = await db.collection("pdf_chat_sessions").deleteMany(q);

  let deletedPdfChats = 0;
  try {
    const rLegacy = await db.collection("pdf_chats").deleteMany(q);
    deletedPdfChats = rLegacy.deletedCount || 0;
  } catch {
    // legacy collection may not exist
  }

  PDF_STORE.delete(pdfId);

  res.json({
    ok: true,
    pdf_id: pdfId,
    courseTitle,
    deleted: {
      pdf_store: rStore.deletedCount || 0,
      pdf_chat_sessions: rSessions.deletedCount || 0,
      pdf_chats: deletedPdfChats,
    },
  });
});

export default router;
