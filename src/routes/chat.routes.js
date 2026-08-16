import { Router } from "express";
import { getDb } from "../config/mongo.js";
import { requireUser } from "../middleware/auth.js";
import { generateContent, isQuotaError } from "../utils/gemini.js";
import { CHAT_SESSIONS, trimHistory, deletePairFromHistory } from "../utils/chatRag.js";

const router = Router();

router.post("/chat", requireUser, async (req, res) => {
  const data = req.body || {};
  const subject = (data.subject || "").trim();
  const userInput = (data.message || "").trim();
  const conversationId = (data.conversation_id || "").trim();
  let courseTitle = (data.courseTitle || data.course || subject || "").trim();

  if (!subject || !userInput) return res.status(400).json({ error: "Both 'subject' and 'message' are required" });
  if (!conversationId) return res.status(400).json({ error: "conversation_id is required" });
  if (!courseTitle) courseTitle = subject;

  const db = await getDb();
  const sessionKey = `${req.user.uid}::${courseTitle}::${conversationId}`;

  let history = CHAT_SESSIONS.get(sessionKey);
  if (history == null) {
    history = [];
    if (db) {
      const doc = await db
        .collection("chat_sessions")
        .findOne({ uid: req.user.uid, courseTitle, conversation_id: conversationId }, { sort: { updatedAt: -1 }, projection: { _id: 0, history: 1 } });
      history = doc?.history || [];
    }
  }

  history.push({ role: "user", content: userInput });
  history = trimHistory(history);

  const systemPrompt = `
You are a helpful tutor specializing in ${subject}.
Rules:
1) If the question is NOT related to ${subject}, reply exactly: Out of scope
2) Keep response clear like ChatGPT.
3) Use numbered points for explanations.
4) If code is needed, put it in a separate fenced code block using triple backticks with language.
5) Do NOT use stars (*) or dash bullets (-). Use only numbers (1., 2., 3.)
6) Be concise but helpful.
`;

  let convoText = "";
  for (const msg of history) {
    convoText += msg.role === "user" ? `User: ${msg.content}\n` : `Assistant: ${msg.content}\n`;
  }

  const prompt = `${systemPrompt}

Conversation so far:
${convoText}

Now respond to the latest user message only.
`;

  try {
    const response = await generateContent(prompt);
    const replyText = (response?.text?.() || "").trim();

    history.push({ role: "assistant", content: replyText });
    history = trimHistory(history);

    CHAT_SESSIONS.set(sessionKey, history);
    if (db) {
      const now = new Date();
      await db.collection("chat_sessions").updateOne(
        { uid: req.user.uid, courseTitle, conversation_id: conversationId },
        { $set: { history, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true }
      );
    }

    res.json({ conversation_id: conversationId, courseTitle, reply: replyText, history_size: history.length });
  } catch (e) {
    if (isQuotaError(e)) return res.status(429).json({ error: "We've hit today's AI usage limit. Please try again in a little while.", code: "quota_exceeded" });
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.get("/chat/history", requireUser, async (req, res) => {
  const courseTitle = (req.query.courseTitle || req.query.course || "").trim();
  const conversationId = (req.query.conversation_id || "").trim();
  if (!courseTitle || !conversationId) return res.status(400).json({ error: "courseTitle and conversation_id are required" });

  const sessionKey = `${req.user.uid}::${courseTitle}::${conversationId}`;
  let history = CHAT_SESSIONS.get(sessionKey);

  const db = await getDb();
  if (history == null && db) {
    const doc =
      (await db.collection("chat_sessions").findOne({ uid: req.user.uid, courseTitle, conversation_id: conversationId }, { projection: { _id: 0, history: 1 } })) || {};
    history = doc.history || [];
    CHAT_SESSIONS.set(sessionKey, history);
  }

  res.json({ courseTitle, conversation_id: conversationId, history: history || [] });
});

router.delete("/chat/history/pair", requireUser, async (req, res) => {
  const data = req.body || {};
  const courseTitle = (data.courseTitle || data.course || "").trim();
  const conversationId = (data.conversation_id || "").trim();
  const pairIndex = data.pair_index;

  if (!courseTitle || !conversationId || pairIndex == null) {
    return res.status(400).json({ error: "courseTitle, conversation_id, and pair_index are required" });
  }

  const sessionKey = `${req.user.uid}::${courseTitle}::${conversationId}`;
  const db = await getDb();

  let history = CHAT_SESSIONS.get(sessionKey);
  if (history == null && db) {
    const doc =
      (await db.collection("chat_sessions").findOne({ uid: req.user.uid, courseTitle, conversation_id: conversationId }, { projection: { _id: 0, history: 1 } })) || {};
    history = doc.history || [];
  }

  history = deletePairFromHistory(history || [], pairIndex);
  CHAT_SESSIONS.set(sessionKey, history);

  if (db) {
    const now = new Date();
    await db.collection("chat_sessions").updateOne(
      { uid: req.user.uid, courseTitle, conversation_id: conversationId },
      { $set: { history, updatedAt: now } },
      { upsert: true }
    );
  }

  res.json({ courseTitle, conversation_id: conversationId, history });
});

export default router;
