import { Router } from "express";
import crypto from "crypto";
import { getDb } from "../config/mongo.js";
import { requireUser } from "../middleware/auth.js";
import { isCourseHeld, blockIfHeld } from "../utils/courseVideos.js";
import { formdataHash } from "../utils/text.js";
import { brandEmail, sendEmail, safePublicUrl } from "../utils/email.js";
import { nowIstStr } from "../utils/dates.js";

const router = Router();

async function blockedResponse(db, uid, courseTitle, res) {
  const blocked = await blockIfHeld(db, uid, courseTitle);
  if (blocked) {
    res.status(blocked.status).json({ error: blocked.error });
    return true;
  }
  return false;
}

router.post("/course/state/get", requireUser, async (req, res) => {
  const data = req.body || {};
  let courseTitle = (data.courseTitle || "").trim();

  if (["other domains", "other domain"].includes(courseTitle.toLowerCase()) && data.formData && typeof data.formData === "object" && data.formData.subject) {
    courseTitle = String(data.formData.subject).trim();
  }
  const formData = data.formData;

  if (!courseTitle) return res.status(400).json({ error: "courseTitle required" });

  const db = await getDb();
  if (await blockedResponse(db, req.user.uid, courseTitle, res)) return;

  const q = { uid: req.user.uid, courseTitle };
  if (formData != null) q.formHash = formdataHash(formData);

  let doc = await db.collection("course_states").findOne(q, { sort: { updatedAt: -1 }, projection: { _id: 0 } });
  if (!doc) {
    doc = await db.collection("course_states").findOne({ uid: req.user.uid, courseTitle }, { sort: { updatedAt: -1 }, projection: { _id: 0 } });
  }

  if (!doc) return res.status(200).json({ found: false });
  res.json({ found: true, state: doc });
});

router.post("/course/state/save", requireUser, async (req, res) => {
  const data = req.body || {};
  let courseTitle = (data.courseTitle || "").trim();
  const formData = data.formData || {};
  if (["other domains", "other domain"].includes(courseTitle.toLowerCase()) && formData && typeof formData === "object" && formData.subject) {
    courseTitle = String(formData.subject).trim();
  }
  const roadmap = data.roadmap;
  const videos = data.videos;

  if (!courseTitle || roadmap == null || videos == null) {
    return res.status(400).json({ error: "courseTitle, roadmap, videos required" });
  }

  const db = await getDb();
  if (await blockedResponse(db, req.user.uid, courseTitle, res)) return;

  const now = new Date();
  const h = formdataHash(formData);

  const existingCourse = await db.collection("course_states").findOne({ uid: req.user.uid, courseTitle, formHash: h }, { projection: { _id: 1 } });

  await db.collection("course_states").updateOne(
    { uid: req.user.uid, courseTitle, formHash: h },
    {
      $set: { uid: req.user.uid, courseTitle, formHash: h, formData, roadmap, videos, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );

  if (!existingCourse) {
    try {
      const toEmail = req.user.email || "";
      const courseId = crypto.createHash("sha1").update(`${req.user.uid}|${courseTitle}|${h}`, "utf-8").digest("hex").slice(0, 12);
      const body = `
            <p style="margin:0 0 10px 0;">Hi <b>${req.user.name || "there"}</b>,</p>
            <p style="margin:0 0 10px 0;">
              You're enrolled in a new course on <b>Zenith Learning</b>.
              Your roadmap and videos are ready.
            </p>
            <ul style="margin:10px 0 10px 20px;">
              <li><b>Course:</b> ${courseTitle}</li>
              <li><b>Course ID:</b> ${courseId}</li>
              <li><b>Quiz Result Time (IST):</b> ${nowIstStr()}</li>
            </ul>
            <p style="margin:10px 0 0 0;">Open the course to continue:</p>
            `;
      const openUrl = safePublicUrl(`/course/${courseTitle}/form`, req);
      const html = brandEmail({
        title: "Course enrolled — your roadmap is ready",
        preheader: `You enrolled in ${courseTitle}. Open your roadmap and start learning.`,
        bodyHtml: body,
        primaryCta: { label: "Open course", url: openUrl },
        secondaryCta: { label: "View My Courses", url: safePublicUrl("/my-courses", req) },
        kind: "courses",
        req,
      });
      sendEmail(toEmail, `Zenith Learning — Enrolled: ${courseTitle}`, html, "", { kind: "courses", req });
    } catch {
      // best-effort
    }
  }

  res.json({ ok: true });
});

router.post("/course/state/delete", requireUser, async (req, res) => {
  const payload = req.body || {};
  const courseTitle = (payload.courseTitle || "").trim();
  if (!courseTitle) return res.status(400).json({ error: "courseTitle missing" });

  const uid = req.user.uid;

  try {
    const toEmail = (req.user.email || "").trim();
    const uname = req.user.name || "there";
    const whenIst = nowIstStr();
    const body = `
        <p style="margin:0 0 10px 0;">Hi <b>${uname}</b>,</p>
        <p style="margin:0 0 10px 0;">
          You have discontinued (unenrolled) from the course below on <b>Zenith Learning</b>.
        </p>
        <ul style="margin:10px 0 10px 20px;">
          <li><b>Course:</b> ${courseTitle}</li>
          <li><b>Unenrolled at:</b> ${whenIst}</li>
        </ul>
        <p style="margin:10px 0 0 0;">
          You can enroll again anytime from <b>My Courses</b>.
        </p>
        `;
    const html = brandEmail({
      title: "Course discontinued (Unenrolled)",
      preheader: "You have been unenrolled from a course on Zenith Learning.",
      bodyHtml: body,
      primaryCta: { label: "View My Courses", url: safePublicUrl("/my-courses", req) },
      secondaryCta: { label: "Contact support", url: safePublicUrl("/contact", req) },
      kind: "courses",
      req,
    });
    sendEmail(toEmail, `Zenith Learning — Unenrolled: ${courseTitle}`, html, "", { kind: "courses", req });
  } catch {
    // best-effort
  }

  const db = await getDb();
  await db.collection("course_states").deleteMany({ uid, courseTitle });
  await db.collection("progress").deleteMany({ uid, courseTitle });
  await db.collection("quiz_progress").deleteMany({ uid, courseTitle });
  await db.collection("quizzes").deleteMany({ uid, courseTitle });
  await db.collection("course_holds").deleteMany({ uid, courseTitle });
  await db.collection("course_progress").deleteMany({ uid, courseTitle });
  await db.collection("quiz_attempts").deleteMany({ uid, courseTitle });
  await db.collection("chat_sessions").deleteMany({ uid, courseTitle });
  await db.collection("notes").deleteMany({ uid, courseTitle });
  await db.collection("course_completion_mails").deleteMany({ uid, courseTitle });

  res.json({ ok: true });
});

function countVideos(obj) {
  if (obj == null) return 0;
  if (Array.isArray(obj)) return obj.reduce((sum, it) => sum + countVideos(it), 0);
  if (typeof obj === "object") {
    if (Array.isArray(obj.videos)) return obj.videos.length;
    if ("video" in obj && ("topic" in obj || "title" in obj)) return 1;
    return Object.values(obj).reduce((sum, v) => {
      if (Array.isArray(v)) return sum + v.length;
      if (v && typeof v === "object") return sum + countVideos(v);
      return sum;
    }, 0);
  }
  return 0;
}

router.get("/courses/list", requireUser, async (req, res) => {
  const db = await getDb();
  const uid = req.user.uid;

  const states = await db
    .collection("course_states")
    .find({ uid }, { projection: { _id: 0, courseTitle: 1, formData: 1, videos: 1, updatedAt: 1, createdAt: 1 } })
    .toArray();

  const progressDocs = await db
    .collection("progress")
    .find({ uid }, { projection: { _id: 0, courseTitle: 1, progressByVideo: 1, updatedAt: 1 } })
    .toArray();
  const progressByCourse = Object.fromEntries(progressDocs.map((d) => [d.courseTitle, d]));

  const courseProgressDocs = await db
    .collection("course_progress")
    .find(
      { uid },
      { projection: { _id: 0, courseTitle: 1, quizPassedMap: 1, quizCompletedMap: 1, currentGlobalId: 1, highestUnlockedId: 1, updatedAt: 1 } }
    )
    .toArray();
  const courseProgressByCourse = Object.fromEntries(courseProgressDocs.map((d) => [d.courseTitle, d]));

  const countTrue = (dct) => (dct && typeof dct === "object" ? Object.values(dct).filter(Boolean).length : 0);

  const items = [];
  for (const st of states) {
    const title = st.courseTitle;
    const videos = st.videos || [];
    const total = countVideos(videos);

    const pd = progressByCourse[title] || {};
    const pmap = pd.progressByVideo || {};

    const cp = courseProgressByCourse[title] || {};
    const qpMap = cp.quizPassedMap || {};
    const qcMap = cp.quizCompletedMap || {};

    const passedQuizzes = countTrue(qpMap);
    const completedQuizzes = countTrue(qcMap);

    let completed = 0;
    let started = false;
    let bestResume = null;
    for (const [vurl, p] of Object.entries(pmap)) {
      if (!p || typeof p !== "object") continue;
      const percent = parseFloat(p.percent || 0);
      const current = parseFloat(p.current || 0);
      if (percent > 0 || current > 0) started = true;
      const isCompleted = !!p.completed || percent >= 98;
      if (isCompleted) {
        completed += 1;
      } else {
        const score = [percent, current];
        if (!bestResume || score[0] > bestResume.score[0] || (score[0] === bestResume.score[0] && score[1] > bestResume.score[1])) {
          bestResume = { score, url: vurl };
        }
      }
    }

    let status;
    if (total > 0 && (completed >= total || passedQuizzes >= total)) status = "Completed";
    else if (started || completed > 0 || passedQuizzes > 0 || completedQuizzes > 0) status = "Doing";
    else status = "Not Started";

    const held = await isCourseHeld(db, uid, title);

    items.push({
      courseTitle: title,
      displayTitle: ["other domains", "other domain"].includes(String(title).trim().toLowerCase()) ? (st.formData || {}).subject : title,
      totalVideos: total,
      completedVideos: completed,
      totalQuizzes: total,
      passedQuizzes,
      completedQuizzes,
      resumeGlobalId: parseInt(cp.currentGlobalId || 1, 10),
      highestUnlockedId: parseInt(cp.highestUnlockedId || 1, 10),
      status,
      held,
      resumeVideoUrl: bestResume ? bestResume.url : null,
      updatedAt: st.updatedAt || st.createdAt || pd.updatedAt,
    });
  }

  const ts = (item) => {
    const d = item.updatedAt;
    if (!d) return 0;
    try {
      return new Date(d).getTime() / 1000;
    } catch {
      return 0;
    }
  };
  items.sort((a, b) => ts(b) - ts(a));

  res.json({ items });
});

router.get("/progress/get", requireUser, async (req, res) => {
  const courseTitle = (req.query.courseTitle || "").trim();
  if (!courseTitle) return res.status(400).json({ error: "courseTitle required" });

  const db = await getDb();
  if (await blockedResponse(db, req.user.uid, courseTitle, res)) return;

  const doc = await db.collection("progress").findOne({ uid: req.user.uid, courseTitle }, { projection: { _id: 0 } });
  if (!doc) return res.json({ progressByVideo: {} });
  res.json({ progressByVideo: doc.progressByVideo || {} });
});

router.post("/progress/upsert", requireUser, async (req, res) => {
  const data = req.body || {};
  const courseTitle = (data.courseTitle || "").trim();
  const videoUrl = (data.videoUrl || "").trim();
  const progress = data.progress || {};

  if (!courseTitle || !videoUrl) return res.status(400).json({ error: "courseTitle and videoUrl required" });

  const db = await getDb();
  if (await blockedResponse(db, req.user.uid, courseTitle, res)) return;

  const now = new Date();
  await db.collection("progress").updateOne(
    { uid: req.user.uid, courseTitle },
    {
      $set: { [`progressByVideo.${videoUrl}`]: progress, updatedAt: now },
      $setOnInsert: { createdAt: now, uid: req.user.uid, courseTitle },
    },
    { upsert: true }
  );

  res.json({ ok: true });
});

router.post("/course/progress/get", requireUser, async (req, res) => {
  const data = req.body || {};
  const courseTitle = (data.courseTitle || "").trim();
  if (!courseTitle) return res.status(400).json({ error: "courseTitle required" });

  const db = await getDb();
  if (await blockedResponse(db, req.user.uid, courseTitle, res)) return;

  const doc = await db.collection("course_progress").findOne({ uid: req.user.uid, courseTitle }, { projection: { _id: 0 } });
  if (!doc) return res.status(200).json({ found: false, progress: null });

  const progress = {
    currentGlobalId: parseInt(doc.currentGlobalId || 1, 10),
    highestUnlockedId: parseInt(doc.highestUnlockedId || 1, 10),
    quizPassedMap: doc.quizPassedMap || {},
    quizSubmittedMap: doc.quizSubmittedMap || {},
    quizCompletedMap: doc.quizCompletedMap || {},
    updatedAt: doc.updatedAt,
  };
  res.status(200).json({ found: true, progress });
});

router.post("/course/progress/save", requireUser, async (req, res) => {
  const data = req.body || {};
  const courseTitle = (data.courseTitle || "").trim();
  const progress = data.progress || {};

  if (!courseTitle) return res.status(400).json({ error: "courseTitle required" });

  const db = await getDb();
  if (await blockedResponse(db, req.user.uid, courseTitle, res)) return;

  const asObj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});

  const currentGlobalId = parseInt(progress.currentGlobalId || 1, 10);
  const highestUnlockedId = parseInt(progress.highestUnlockedId || 1, 10);
  const quizPassedMap = asObj(progress.quizPassedMap);
  const quizSubmittedMap = asObj(progress.quizSubmittedMap);
  const quizCompletedMap = asObj(progress.quizCompletedMap);

  const now = new Date();

  await db.collection("course_progress").updateOne(
    { uid: req.user.uid, courseTitle },
    {
      $set: {
        uid: req.user.uid,
        courseTitle,
        currentGlobalId,
        highestUnlockedId,
        quizPassedMap,
        quizSubmittedMap,
        quizCompletedMap,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );

  try {
    const cs = (await db.collection("course_states").findOne({ uid: req.user.uid, courseTitle }, { projection: { _id: 0, videos: 1 } })) || {};
    const totalVideos = countVideos(cs.videos);
    const passedCount = Object.values(quizPassedMap || {}).filter(Boolean).length;
    const completedCount = Object.values(quizCompletedMap || {}).filter(Boolean).length;

    const isComplete = totalVideos > 0 && (passedCount >= totalVideos || completedCount >= totalVideos);
    if (isComplete) {
      const courseKey = crypto.createHash("sha1").update(`${req.user.uid}|${courseTitle}`, "utf-8").digest("hex");
      const already = await db.collection("course_completion_mails").findOne({ courseKey }, { projection: { _id: 1 } });
      if (!already) {
        await db.collection("course_completion_mails").insertOne({ courseKey, uid: req.user.uid, courseTitle, createdAt: now });
        const toEmail = req.user.email || "";
        const body = `
                <p style="margin:0 0 10px 0;">Hi <b>${req.user.name || "there"}</b>,</p>
                <p style="margin:0 0 10px 0;">
                  Congratulations — you have completed the course <b>${courseTitle}</b> on Zenith Learning 🎉
                </p>
                <ul style="margin:10px 0 10px 20px;">
                  <li><b>Total videos:</b> ${totalVideos}</li>
                  <li><b>Quizzes passed:</b> ${passedCount}</li>
                  <li><b>Completed items:</b> ${completedCount}</li>
                </ul>
                <p style="margin:10px 0 10px 0;">
                  Next steps:
                </p>
                <ul style="margin:10px 0 10px 20px;">
                  <li>Review your notes and revise weak areas</li>
                  <li>Try a new roadmap with a higher difficulty or faster pace</li>
                  <li>Share feedback through the Contact page</li>
                </ul>
                `;
        const html = brandEmail({
          title: "Course completed ✅",
          preheader: `You completed ${courseTitle}. Keep the momentum going.`,
          bodyHtml: body,
          primaryCta: { label: "View My Courses", url: safePublicUrl("/my-courses", req) },
          secondaryCta: { label: "Start a new course", url: safePublicUrl("/", req) },
          kind: "courses",
          req,
        });
        sendEmail(toEmail, `Zenith Learning — Course Completed: ${courseTitle}`, html, "", { kind: "courses", req });
      }
    }
  } catch {
    // best-effort
  }

  res.json({ ok: true });
});

export default router;
