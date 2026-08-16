import { Router } from "express";
import crypto from "crypto";
import fs from "fs/promises";
import { getDb } from "../config/mongo.js";
import { requireUser } from "../middleware/auth.js";
import genAI, { isQuotaError, extractRetryAfterSeconds } from "../utils/gemini.js";
import { getBestVideo, extractTopicKeywords, getVideoDurationSec } from "../utils/youtube.js";
import { ytId } from "../utils/text.js";
import { deriveCourseTitleFromVideo, deriveVideoMetaFromCourse, blockIfHeld } from "../utils/courseVideos.js";
import { brandEmail, sendEmail, safePublicUrl } from "../utils/email.js";
import { nowIstStr } from "../utils/dates.js";
import { generateMindmapTree } from "../utils/mindmap.js";
import supadata from "../utils/supadata.js";

const router = Router();

const PASS_PERCENT = 0.4;

async function generateContentText(prompt, modelName = "gemini-3.5-flash") {
  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(prompt);
  return (result.response?.text?.() || "").trim();
}

async function blockedResponse(db, uid, courseTitle, res) {
  const blocked = await blockIfHeld(db, uid, courseTitle);
  if (blocked) {
    res.status(blocked.status).json({ error: blocked.error });
    return true;
  }
  return false;
}

const SHORT_VIDEO_SECONDS = 180; // 3 minutes
const MIN_TRANSCRIPT_CHARS = 300;

/**
 * Quiz/mindmap generation needs real study material. When the transcript is missing, too short,
 * or not in English — or the video itself runs under 3 minutes — fall back to generating content
 * from the video's topic (from the saved course roadmap) instead of the transcript.
 */
async function resolveGenerationSource({ db, uid, videoUrl, courseTitle, transcript, transcriptLanguage }) {
  let useTopic = !transcript || transcript.trim().length < MIN_TRANSCRIPT_CHARS;
  if (!useTopic && transcriptLanguage && !transcriptLanguage.toLowerCase().startsWith("en")) useTopic = true;
  if (!useTopic) {
    const durationSec = await getVideoDurationSec(videoUrl).catch(() => 0);
    if (durationSec && durationSec < SHORT_VIDEO_SECONDS) useTopic = true;
  }

  if (!useTopic) return { mode: "transcript", transcript };

  let topic = "";
  if (courseTitle) {
    const [, , derivedTitle] = await deriveVideoMetaFromCourse(db, uid, courseTitle, videoUrl);
    topic = derivedTitle || "";
  }
  return { mode: "topic", topic: topic || courseTitle || "this video's topic" };
}

// ---------------- SUMMARY ----------------
const SUMMARY_FORMAT_INSTRUCTIONS = {
  paragraph: "Write the summary as 2-4 flowing prose paragraphs. Do NOT use bullet points, numbered lists, or headings — write in complete, well-connected sentences.",
  bulletins: 'Write the summary as a concise bulleted list. Start every line with "- " for each key point. Do NOT write prose paragraphs.',
  essay: "Write the summary as a structured essay: a short introduction paragraph, 2-4 body paragraphs that explore the main ideas in depth, and a concluding paragraph. Use complete, well-developed prose — no bullet points or headings.",
};

router.post("/summarize", requireUser, async (req, res) => {
  const user = req.user;
  try {
    const data = req.body || {};
    const transcript = (data.transcript || "").trim();
    let summaryType = (data.type || "").trim().toLowerCase();
    const videoUrl = (data.video_url || "").trim();

    if (!transcript) return res.status(400).json({ error: "Transcript not provided" });
    if (!SUMMARY_FORMAT_INSTRUCTIONS[summaryType]) summaryType = "paragraph";

    const db = await getDb();

    const cacheQ = { uid: user.uid, summaryType };
    if (videoUrl) cacheQ.video_url = videoUrl;
    const cached = await db.collection("summaries").findOne(cacheQ, { sort: { updatedAt: -1 }, projection: { _id: 0 } });
    if (cached && cached.summary) {
      return res.json({ summary: cached.summary, cached: true });
    }

    const prompt = `Summarize the following transcript for a student studying this topic.

FORMAT REQUIREMENT: ${SUMMARY_FORMAT_INSTRUCTIONS[summaryType]}

Keep it accurate and easy to study.

TRANSCRIPT:
${transcript}
`;

    const summary = await generateContentText(prompt);

    const now = new Date();
    const doc = { uid: user.uid, video_url: videoUrl || null, summaryType, summary, updatedAt: now, createdAt: now };
    await db.collection("summaries").insertOne(doc);

    res.json({ summary, cached: false });
  } catch (e) {
    if (isQuotaError(e)) {
      return res.status(429).json({ error: "We've hit today's AI usage limit. Please try again in a little while.", code: "quota_exceeded" });
    }
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------- ROADMAP GENERATION ----------------
async function generateRoadmap(formData) {
  const prompt = `You are an expert curriculum designer and YouTube SEO specialist.

Create a personalized learning roadmap for a student with the following details:
- Age: ${formData.age}
- Subject: ${formData.subject}
- Current level: ${formData.level}
- Prior experience: ${formData.experience}
- Learning pace: ${formData.pace}
- Goal: ${formData.goal}
- Duration: ${formData.duration} months

IMPORTANT INSTRUCTIONS (STRICT):
1. Every topic MUST explicitly include the subject name "${formData.subject}".
2. Topics must be written as precise YouTube search queries.
3. Avoid generic terms like "Introduction", "Basics", "Overview" alone.
4. Use phrases that a learner would type into YouTube.
5. Topics must be beginner-to-goal progressive and practical.
6. Do NOT include explanations, descriptions, or extra text.
7. Do NOT include commas inside a topic — each bullet must be ONE clean search query.
8. Do NOT reference any other programming language.

FORMAT:
Week 1:
- <YouTube search query>
- <YouTube search query>

Week 2:
- <YouTube search query>
- <YouTube search query>

Now generate the roadmap.
`;
  return generateContentText(prompt);
}

function parseRoadmap(roadmap) {
  const weeks = {};
  let currentWeek = null;
  for (let line of roadmap.split("\n")) {
    line = line.trim();
    if (line.toLowerCase().startsWith("week")) {
      currentWeek = line.split(":")[0].trim();
      weeks[currentWeek] = [];
    } else if (line.startsWith("-") && currentWeek) {
      const topic = line.slice(1).trim();
      weeks[currentWeek].push(topic);
    }
  }

  console.log("\n================ PARSED ROADMAP ================");
  console.log(JSON.stringify(weeks, null, 2));
  console.log("================================================\n");

  return weeks;
}

async function buildWeeklyJson(roadmap) {
  const weeks = parseRoadmap(roadmap);
  const result = [];

  const usedVideoIds = new Set();
  let coveredKeywords = new Set();

  console.log("\n=========== BUILD WEEKLY JSON START ===========");
  for (const [week, topics] of Object.entries(weeks)) {
    console.log(`\n[WEEK] ${week} topics_count=${topics.length}`);
    const weekData = [];
    for (const [idx, topic] of topics.entries()) {
      const q = topic + " in english";
      console.log(`  -> (${idx + 1}) Topic: ${topic}`);
      console.log(`     Query: ${q}`);
      try {
        const curKw = extractTopicKeywords(topic);
        const blocked = new Set([...coveredKeywords].filter((k) => !curKw.has(k)));

        const best = await getBestVideo(q, usedVideoIds, blocked);

        let url;
        if (best && best.url) {
          url = best.url;
          const vid = best.video_id || ytId(url);
          if (vid) usedVideoIds.add(vid);
        } else {
          url = null;
        }

        weekData.push({ topic, video: url || "No video found" });
        coveredKeywords = new Set([...coveredKeywords, ...curKw]);
      } catch (e) {
        console.log(`[TOPIC VIDEO ERROR] topic=${topic} err=${e.message || e}`);
        weekData.push({ topic, video: "No video found" });
      }
    }
    result.push({ [week]: weekData });
  }
  console.log("\n=========== BUILD WEEKLY JSON END ===========\n");

  return result;
}

router.post("/generate-roadmap", requireUser, async (req, res) => {
  try {
    const formData = req.body || {};
    const roadmap = await generateRoadmap(formData);
    const finalOutput = await buildWeeklyJson(roadmap);

    try {
      await fs.writeFile(new URL("../../videos.json", import.meta.url), JSON.stringify(finalOutput, null, 2), "utf-8");
    } catch {
      // best-effort debug artifact
    }

    res.json({ roadmap, videos: finalOutput });
  } catch (e) {
    if (isQuotaError(e)) {
      return res.status(429).json({ error: "We've hit today's AI usage limit. Please try again in a little while.", code: "quota_exceeded" });
    }
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------- TRANSCRIPT ----------------
router.post("/get-transcript", requireUser, async (req, res) => {
  const user = req.user;
  try {
    const data = req.body || {};
    const url = (data.url || "").trim();
    if (!url) return res.status(400).json({ error: "URL is required" });

    const db = await getDb();

    const cached = await db.collection("transcripts").findOne({ uid: user.uid, url }, { projection: { _id: 0 } });
    if (cached && cached.transcript) {
      return res.json({ url, transcript: cached.transcript, language: cached.language || "en", cached: true });
    }

    const transcript = await supadata.transcript({ url, lang: "en", text: true, mode: "auto" });

    if (transcript && "content" in transcript) {
      const now = new Date();
      await db.collection("transcripts").updateOne(
        { uid: user.uid, url },
        {
          $set: { uid: user.uid, url, transcript: transcript.content, language: transcript.lang || "en", updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true }
      );
      return res.json({ url, transcript: transcript.content, language: transcript.lang, cached: false });
    }
    return res.json({ message: "Transcript is being processed", job_id: transcript?.jobId });
  } catch (e) {
    if (isQuotaError(e)) {
      const payload = { error: "Transcript API quota exceeded. Please retry later or upgrade your plan.", code: "quota_exceeded" };
      const ra = extractRetryAfterSeconds(String(e.message || e));
      if (ra !== null) payload.retry_after = ra;
      return res.status(429).json(payload);
    }
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------- QUIZ ----------------
async function generateMcq(transcript) {
  const prompt = `You are an expert educational consultant.
A student has given a video transcript and wants to create a multiple-choice quiz based on it.

IMPORTANT LANGUAGE RULE:
- The quiz MUST be written in ENGLISH ONLY.
- If the transcript is not in English, translate the content to English first (internally), then generate the quiz.
- Do NOT output any non-English text.

Transcript:
${transcript}

Create a multiple-choice quiz with 10 questions. Each question should have 4 options.

If a question requires a code snippet (because the transcript includes code), include a **short** snippet inline in the question using single backticks, like: \`for i in range(n): ...\`.
Keep the snippet on the SAME LINE as the question (do not use multi-line code blocks).
Format:
Question 1: Question
a) Option 1
b) Option 2
c) Option 3
d) Option 4
Correct Answer: Answer

Only the quiz is required.
`;
  return generateContentText(prompt);
}

/** Same output format as generateMcq, but built from the video's topic instead of a transcript —
 * used when the transcript is missing, too short, or not in English. */
async function generateMcqFromTopic(topic) {
  const prompt = `You are an expert educational consultant.
This video's transcript is unavailable, too short, or not in English, so create a multiple-choice quiz directly from your own knowledge of the topic below.

Topic: ${topic}

IMPORTANT LANGUAGE RULE:
- The quiz MUST be written in ENGLISH ONLY.

Create a multiple-choice quiz with 10 questions covering the key concepts, definitions, and applications of this topic. Each question should have 4 options.

Format:
Question 1: Question
a) Option 1
b) Option 2
c) Option 3
d) Option 4
Correct Answer: Answer

Only the quiz is required.
`;
  return generateContentText(prompt);
}

function normalizeText(s) {
  if (s == null) return "";
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}

function parseToJson(quizText) {
  const quizData = [];
  const blocks = quizText.split(/Question\s*\d+\s*:/i);

  for (let block of blocks) {
    block = block.trim();
    if (!block) continue;

    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;

    const question = lines[0];

    const options = [];
    for (const line of lines.slice(1)) {
      const m = line.match(/^([a-dA-D])[).]\s*(.+)$/);
      if (m) options.push(m[2].trim());
      if (options.length === 4) break;
    }
    if (options.length < 2) continue;

    const answerLine = lines.find((l) => l.toLowerCase().startsWith("correct answer")) || "";
    const raw = answerLine.includes(":") ? answerLine.split(":").slice(1).join(":").trim() : "";
    const rawNorm = normalizeText(raw);

    let correctOption = "";

    let m = rawNorm.match(/^([a-d])\b/);
    if (m && options.length >= 4) {
      const idx = m[1].charCodeAt(0) - "a".charCodeAt(0);
      if (idx >= 0 && idx < options.length) correctOption = options[idx];
    }

    if (!correctOption) {
      const m2 = rawNorm.match(/^([a-d])[).]\s*(.+)$/);
      if (m2 && options.length >= 4) {
        const idx = m2[1].charCodeAt(0) - "a".charCodeAt(0);
        if (idx >= 0 && idx < options.length) correctOption = options[idx];
      }
    }

    if (!correctOption) {
      const canon = (x) => normalizeText(x).replace(/[^a-z0-9 ]+/g, "").trim();
      const rawC = canon(raw);
      for (const opt of options) {
        const oc = canon(opt);
        if (!oc) continue;
        if (oc === rawC || rawC.includes(oc) || oc.includes(rawC)) {
          correctOption = opt;
          break;
        }
      }
    }

    if (correctOption) {
      quizData.push({ question, options, answer: correctOption });
    }
  }

  return quizData;
}

router.post("/generate-mcq", requireUser, async (req, res) => {
  const user = req.user;
  try {
    const data = req.body || {};
    const transcriptIn = (data.transcript || "").trim();
    let transcript = transcriptIn;
    const videoUrl = (data.video_url || "").trim();
    let courseTitle = (data.courseTitle || "").trim();

    if (!videoUrl) return res.status(400).json({ error: "video_url is required" });

    const db = await getDb();

    if (!courseTitle) courseTitle = (await deriveCourseTitleFromVideo(db, user.uid, videoUrl)) || "";
    if (courseTitle) {
      if (await blockedResponse(db, user.uid, courseTitle, res)) return;
    }

    const cached = await db.collection("quizzes").findOne({ uid: user.uid, video_url: videoUrl }, { sort: { updatedAt: -1 }, projection: { _id: 0 } });
    if (cached && cached.quiz_id && cached.questions_only) {
      return res.json({ quiz_id: cached.quiz_id, questions: cached.questions_only, cached: true });
    }

    const tdoc = await db
      .collection("transcripts")
      .findOne({ uid: user.uid, url: videoUrl }, { sort: { updatedAt: -1 }, projection: { _id: 0, transcript: 1, language: 1 } });
    if (!transcript && tdoc && tdoc.transcript) transcript = tdoc.transcript.trim();

    const source = await resolveGenerationSource({
      db,
      uid: user.uid,
      videoUrl,
      courseTitle,
      transcript,
      transcriptLanguage: tdoc?.language,
    });

    const quizText = source.mode === "topic" ? await generateMcqFromTopic(source.topic) : await generateMcq(source.transcript);
    let quizData = parseToJson(quizText);
    quizData = quizData.slice(0, 10);

    if (!quizData.length) return res.status(500).json({ error: "Failed to parse quiz. Try again." });

    const quizId = crypto.randomUUID();
    const questionsOnly = quizData.map((q) => ({ question: q.question, options: q.options }));

    const now = new Date();
    await db.collection("quizzes").insertOne({
      uid: user.uid,
      video_url: videoUrl,
      quiz_id: quizId,
      full_quiz: quizData,
      questions_only: questionsOnly,
      attempts_used: 0,
      createdAt: now,
      updatedAt: now,
    });

    res.json({ quiz_id: quizId, questions: questionsOnly, cached: false });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------- MINDMAP ----------------
router.post("/generate-mindmap", requireUser, async (req, res) => {
  const user = req.user;
  try {
    const data = req.body || {};
    const videoUrl = (data.video_url || "").trim();
    let transcript = (data.transcript || "").trim();
    const title = (data.title || "Mindmap").trim() || "Mindmap";
    let courseTitle = (data.courseTitle || "").trim();
    const force = !!data.force;

    if (!videoUrl) return res.status(400).json({ error: "video_url is required" });

    const db = await getDb();

    if (!courseTitle) courseTitle = (await deriveCourseTitleFromVideo(db, user.uid, videoUrl)) || "";
    if (courseTitle) {
      if (await blockedResponse(db, user.uid, courseTitle, res)) return;
    }

    if (!force) {
      const cached = await db.collection("mindmaps").findOne({ uid: user.uid, video_url: videoUrl }, { sort: { updatedAt: -1 }, projection: { _id: 0, tree: 1 } });
      if (cached && cached.tree) return res.json({ tree: cached.tree, cached: true });
    }

    const tdoc = await db
      .collection("transcripts")
      .findOne({ uid: user.uid, url: videoUrl }, { sort: { updatedAt: -1 }, projection: { _id: 0, transcript: 1, language: 1 } });
    if (!transcript && tdoc && tdoc.transcript) transcript = tdoc.transcript.trim();

    const source = await resolveGenerationSource({
      db,
      uid: user.uid,
      videoUrl,
      courseTitle,
      transcript,
      transcriptLanguage: tdoc?.language,
    });

    const tree =
      source.mode === "topic"
        ? await generateMindmapTree(source.topic, title, { mode: "topic" })
        : await generateMindmapTree(source.transcript, title);
    const now = new Date();
    await db.collection("mindmaps").updateOne(
      { uid: user.uid, video_url: videoUrl },
      { $set: { uid: user.uid, video_url: videoUrl, title, tree, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true }
    );

    res.json({ tree, cached: false });
  } catch (e) {
    if (isQuotaError(e)) {
      const payload = { error: "We've hit today's AI usage limit. Please try again in a little while.", code: "quota_exceeded" };
      const ra = typeof e.retryAfter === "number" ? e.retryAfter : extractRetryAfterSeconds(String(e.message || e));
      if (ra !== null && ra !== undefined) payload.retry_after = ra;
      return res.status(429).json(payload);
    }
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------- NOTES (Mindmap) ----------------
router.get("/notes/list", requireUser, async (req, res) => {
  try {
    const db = await getDb();
    const notes = await db.collection("notes").find({ uid: req.user.uid }, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(200).toArray();
    res.json({ notes });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

router.post("/notes/save-mindmap", requireUser, async (req, res) => {
  try {
    const data = req.body || {};
    const noteType = "mindmap";
    const title = (data.title || "Mindmap").trim().slice(0, 120);
    const courseTitle = (data.courseTitle || "").trim().slice(0, 200);
    const videoUrl = (data.video_url || "").trim();
    const tree = data.tree || {};

    if (!videoUrl) return res.status(400).json({ error: "video_url is required" });
    if (!tree || typeof tree !== "object" || !("name" in tree)) return res.status(400).json({ error: "tree is required" });

    const db = await getDb();
    const now = new Date();
    const noteId = (data.note_id || "").trim() || crypto.randomUUID();

    await db.collection("notes").updateOne(
      { uid: req.user.uid, note_id: noteId },
      {
        $set: {
          uid: req.user.uid,
          note_id: noteId,
          type: noteType,
          title,
          courseTitle,
          video_url: videoUrl,
          tree,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    res.json({ ok: true, note_id: noteId });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

router.post("/notes/delete", requireUser, async (req, res) => {
  try {
    const data = req.body || {};
    const noteId = (data.note_id || "").trim();
    if (!noteId) return res.status(400).json({ error: "note_id is required" });
    const db = await getDb();
    await db.collection("notes").deleteOne({ uid: req.user.uid, note_id: noteId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------- SUBMIT QUIZ ----------------
router.post("/submit-quiz", requireUser, async (req, res) => {
  const user = req.user;
  try {
    const data = req.body || {};
    const quizId = data.quiz_id;
    let courseTitle = (data.courseTitle || "").trim();
    const answers = data.answers;

    if (!quizId) return res.status(400).json({ error: "quiz_id required" });
    if (!Array.isArray(answers)) return res.status(400).json({ error: "answers must be a list" });

    const db = await getDb();

    const quizDoc = await db.collection("quizzes").findOne({ uid: user.uid, quiz_id: quizId });
    if (!quizDoc) return res.status(400).json({ error: "Invalid quiz_id" });

    if (!courseTitle) {
      courseTitle = (await deriveCourseTitleFromVideo(db, user.uid, quizDoc.video_url || "")) || "";
    }

    if (courseTitle) {
      if (await blockedResponse(db, user.uid, courseTitle, res)) return;
    }

    let used = parseInt(quizDoc.attempts_used || 0, 10);
    const fullQuiz = quizDoc.full_quiz || [];

    let score = 0;
    const results = [];
    for (let i = 0; i < fullQuiz.length; i++) {
      const q = fullQuiz[i];
      const userAns = i < answers.length ? answers[i] : "";
      const correct = q.answer || "";
      const ok = normalizeText(userAns) === normalizeText(correct);
      if (ok) score += 1;
      results.push({ question: q.question, selected: userAns, correct, isCorrect: ok });
    }

    used += 1;
    await db.collection("quizzes").updateOne({ uid: user.uid, quiz_id: quizId }, { $set: { attempts_used: used, updatedAt: new Date() } });

    const required = Math.max(1, Math.ceil(fullQuiz.length * PASS_PERCENT));
    const passed = score >= required;

    let videoNo = null;
    let totalVideos = null;
    let videoTitle = null;
    let videoUrl = (quizDoc.video_url || "").trim();

    try {
      let reqVideoNo = data.video_no ?? data.videoNo;
      let reqTotalVideos = data.total_videos ?? data.totalVideos;
      reqVideoNo = reqVideoNo != null ? parseInt(reqVideoNo, 10) : null;
      reqTotalVideos = reqTotalVideos != null ? parseInt(reqTotalVideos, 10) : null;
      if (Number.isNaN(reqVideoNo)) reqVideoNo = null;
      if (Number.isNaN(reqTotalVideos)) reqTotalVideos = null;

      [videoNo, totalVideos, videoTitle] = await deriveVideoMetaFromCourse(db, user.uid, courseTitle, videoUrl);

      if (reqVideoNo) videoNo = reqVideoNo;
      if (reqTotalVideos) totalVideos = reqTotalVideos;

      if (courseTitle && videoNo) {
        const nowUtc = new Date();
        await db.collection("quiz_attempts").updateOne(
          { uid: user.uid, courseTitle, videoNo: parseInt(videoNo, 10) },
          {
            $setOnInsert: {
              uid: user.uid,
              courseTitle,
              videoNo: parseInt(videoNo, 10),
              totalVideos: totalVideos ? parseInt(totalVideos, 10) : null,
              video_url: videoUrl,
              createdAt: nowUtc,
            },
            $set: {
              quiz_id: quizId,
              lastScore: parseInt(score, 10),
              totalQuestions: fullQuiz.length,
              required,
              passed,
              attemptsUsed: used,
              updatedAt: nowUtc,
              lastAttemptAt: nowUtc,
            },
            $max: { bestScore: parseInt(score, 10) },
          },
          { upsert: true }
        );
      }
    } catch {
      // best-effort persistence
    }

    try {
      const toEmail = (user.email || "").trim();
      if (toEmail) {
        const statusLine = passed ? "PASSED ✅" : "NEEDS REATTEMPT ⚠️";

        if (!videoNo) {
          [videoNo, totalVideos, videoTitle] = await deriveVideoMetaFromCourse(db, user.uid, courseTitle, videoUrl);
        }

        const youtubeId = ytId(videoUrl);
        const videoLabel = videoNo ? `#${videoNo}` : youtubeId || "N/A";
        const videoLabelFull = videoNo && totalVideos ? `${videoNo}/${totalVideos}` : videoNo ? String(videoNo) : "N/A";

        const body = `
                <p style="margin:0 0 10px 0;">Hi <b>${user.name || "there"}</b>,</p>
                <p style="margin:0 0 10px 0;">Your quiz has been evaluated and your result is ready.</p>

                <ul style="margin:10px 0 10px 20px;">
                  <li><b>Course:</b> ${courseTitle || "N/A"}</li>
                  <li><b>Status:</b> <b>${statusLine}</b></li>
                  <li><b>Score:</b> ${score}/${fullQuiz.length} (Pass mark: ${required})</li>
                  <li><b>Quiz Result Time (IST):</b> ${nowIstStr()}</li>
                  <li><b>Attempts used:</b> ${used}</li>
                  <li><b>Video No:</b> ${videoLabelFull}</li>
                  <li><b>Video:</b> ${videoLabel}</li>
                  <li><b>Video Link:</b> ${videoUrl || "N/A"}</li>
                </ul>
                `;

        const html = brandEmail({
          title: `Quiz completed — ${statusLine}`,
          preheader: `Course: ${courseTitle || "N/A"} • Score: ${score}/${fullQuiz.length} • Video: ${videoLabel}`,
          bodyHtml: body,
          primaryCta: { label: "View My Courses", url: safePublicUrl("/my-courses", req) },
          secondaryCta: { label: "Open Contact", url: safePublicUrl("/contact", req) },
          kind: "courses",
          req,
        });

        sendEmail(toEmail, `Zenith Learning — Quiz Result (${statusLine})`, html, "", { kind: "courses", req });
      }
    } catch {
      // best-effort
    }

    res.json({ score, total: fullQuiz.length, required, passed, attempts_used: used, results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

export default router;
