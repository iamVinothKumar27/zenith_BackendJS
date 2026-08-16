import { Router } from "express";
import admin, { initFirebaseAdmin } from "../config/firebase.js";
import { getDb } from "../config/mongo.js";
import { config } from "../config/env.js";
import { requireAdmin } from "../middleware/auth.js";
import { isCourseHeld } from "../utils/courseVideos.js";
import { brandEmail, sendEmail, safePublicUrl } from "../utils/email.js";
import { nowIstStr } from "../utils/dates.js";
import { proctoringPublic } from "../utils/text.js";

const router = Router();

function countVideos(obj) {
  if (obj == null) return 0;
  if (Array.isArray(obj)) return obj.reduce((sum, it) => sum + countVideos(it), 0);
  if (typeof obj === "object") {
    if (Array.isArray(obj.videos)) return obj.videos.length;
    if ("video" in obj && ("topic" in obj || "title" in obj)) return 1;
    let total = 0;
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) total += v.length;
      else if (v && typeof v === "object") total += countVideos(v);
    }
    return total;
  }
  return 0;
}

function countTrue(dct) {
  if (!dct || typeof dct !== "object") return 0;
  return Object.values(dct).filter(Boolean).length;
}

router.get("/admin/users", requireAdmin, async (req, res) => {
  const db = await getDb();
  const adminEmailLc = (config.adminEmail || "").trim().toLowerCase();

  const usersOut = [];
  const allUsers = await db.collection("users").find({}, { projection: { _id: 0, uid: 1, email: 1, name: 1 } }).toArray();

  for (const u of allUsers) {
    const uid = u.uid;
    const email = (u.email || "").trim();
    const isAdmin = email.toLowerCase() === adminEmailLc;

    if (isAdmin) {
      usersOut.push({ uid, email, name: u.name, isAdmin: true, courses: [], overallPercent: 0, heldCourses: [] });
      continue;
    }

    const states = await db.collection("course_states").find({ uid }, { projection: { _id: 0, courseTitle: 1, videos: 1 } }).toArray();
    const holds = await db.collection("course_holds").find({ uid, held: true }, { projection: { _id: 0, courseTitle: 1 } }).toArray();
    const heldSet = new Set(holds.map((h) => h.courseTitle).filter(Boolean));

    const courses = [];
    const percents = [];
    for (const st of states) {
      const title = st.courseTitle;
      const total = countVideos(st.videos);
      const cp = (await db.collection("course_progress").findOne({ uid, courseTitle: title }, { projection: { _id: 0, quizPassedMap: 1 } })) || {};
      const passed = countTrue(cp.quizPassedMap || {});
      let percent = 0;
      if (total > 0) {
        percent = (passed / total) * 100;
        percents.push(percent);
      }
      courses.push({
        courseKey: title,
        courseTitle: title,
        totalQuizzes: total,
        passedQuizzes: passed,
        percent: Math.round(percent * 100) / 100,
        held: heldSet.has(title),
      });
    }

    const overall = percents.length ? Math.round((percents.reduce((a, b) => a + b, 0) / percents.length) * 100) / 100 : 0;
    usersOut.push({ uid, email, name: u.name, isAdmin: false, courses, overallPercent: overall, heldCourses: [...heldSet].sort() });
  }

  usersOut.sort((a, b) => {
    const ai = a.isAdmin ? 0 : 1;
    const bi = b.isAdmin ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return (a.email || "").localeCompare(b.email || "");
  });

  res.json({ ok: true, adminEmail: config.adminEmail, users: usersOut });
});

router.post("/admin/promote", requireAdmin, async (req, res) => {
  res.status(410).json({ error: "Role management removed. Admin is fixed to ADMIN_EMAIL." });
});

router.post("/admin/demote", requireAdmin, async (req, res) => {
  res.status(410).json({ error: "Role management removed. Admin is fixed to ADMIN_EMAIL." });
});

router.post("/admin/delete-user", requireAdmin, async (req, res) => {
  const adminUser = req.user;
  const data = req.body || {};
  const targetUid = (data.uid || "").trim();
  if (!targetUid) return res.status(400).json({ error: "uid required" });
  if (adminUser.uid === targetUid) return res.status(400).json({ error: "You cannot delete your own account." });

  const db = await getDb();

  const targetDoc = (await db.collection("users").findOne({ uid: targetUid }, { projection: { _id: 0, email: 1, name: 1 } })) || {};
  const targetEmail = (targetDoc.email || "").trim();
  const targetName = targetDoc.name || "there";

  await db.collection("users").deleteOne({ uid: targetUid });
  if (targetEmail) await db.collection("users").deleteOne({ email: targetEmail.trim().toLowerCase() });
  await db.collection("course_states").deleteMany({ uid: targetUid });
  await db.collection("course_progress").deleteMany({ uid: targetUid });
  await db.collection("progress").deleteMany({ uid: targetUid });
  await db.collection("quizzes").deleteMany({ uid: targetUid });
  await db.collection("transcripts").deleteMany({ uid: targetUid });
  await db.collection("summaries").deleteMany({ uid: targetUid });
  await db.collection("course_holds").deleteMany({ uid: targetUid });

  try {
    initFirebaseAdmin();
    try {
      await admin.auth().deleteUser(targetUid);
    } catch {
      if (targetEmail) {
        const u = await admin.auth().getUserByEmail(targetEmail);
        await admin.auth().deleteUser(u.uid);
      }
    }
  } catch (e) {
    console.log(`[WARN] Firebase delete failed for ${targetUid}: ${e.message || e}`);
  }

  try {
    const whenIst = nowIstStr();
    const body = `
        <p style="margin:0 0 10px 0;">Hi <b>${targetName}</b>,</p>
        <p style="margin:0 0 10px 0;">
          Your <b>Zenith Learning</b> account has been removed by the administrator.
        </p>
        <ul style="margin:10px 0 10px 20px;">
          <li><b>Removed at:</b> ${whenIst}</li>
        </ul>
        <p style="margin:10px 0 0 0;">
          If you believe this was a mistake, please contact support.
        </p>
        `;
    const html = brandEmail({
      title: "Your Zenith account has been removed",
      preheader: "Your account was removed by the administrator.",
      bodyHtml: body,
      primaryCta: { label: "Contact support", url: safePublicUrl("/contact", req) },
      secondaryCta: { label: "Open Zenith", url: safePublicUrl("/", req) },
      kind: "mocktest",
      req,
    });
    sendEmail(targetEmail, "Zenith Learning — Account removed", html, "", { kind: "mocktest", req });
  } catch {
    // best-effort
  }

  res.json({ ok: true, uid: targetUid });
});

router.post("/admin/course-hold", requireAdmin, async (req, res) => {
  const data = req.body || {};
  const uid = (data.uid || "").trim();
  const courseTitle = (data.courseTitle || "").trim();
  const held = !!data.held;

  if (!uid || !courseTitle) return res.status(400).json({ error: "uid and courseTitle required" });

  const db = await getDb();
  const now = new Date();

  await db.collection("course_holds").updateOne(
    { uid, courseTitle },
    { $set: { uid, courseTitle, held, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );

  try {
    const udoc = (await db.collection("users").findOne({ uid }, { projection: { _id: 0, email: 1, name: 1 } })) || {};
    const toEmail = (udoc.email || "").trim();
    if (toEmail) {
      const uname = udoc.name || "there";
      const status = held ? "ON HOLD" : "ACTIVE";
      const body = `
            <p style="margin:0 0 10px 0;">Hi <b>${uname}</b>,</p>
            <p style="margin:0 0 10px 0;">
              Your course access has been updated by the admin on <b>Zenith Learning</b>.
            </p>
            <ul style="margin:10px 0 10px 20px;">
              <li><b>Course:</b> ${courseTitle}</li>
              <li><b>Status:</b> <b>${status}</b></li>
              <li><b>Updated at (IST):</b> ${nowIstStr()}</li>
            </ul>
            <p style="margin:10px 0 0 0;">If you think this is a mistake, contact support.</p>
            `;
      const html = brandEmail({
        title: `Course status updated — ${status}`,
        preheader: `Course: ${courseTitle} • Status: ${status}`,
        bodyHtml: body,
        primaryCta: { label: "Open My Courses", url: safePublicUrl("/my-courses", req) },
        secondaryCta: { label: "Contact support", url: safePublicUrl("/contact", req) },
        kind: "mocktest",
        req,
      });
      sendEmail(toEmail, `Zenith Learning — Course ${status}: ${courseTitle}`, html, "", { kind: "mocktest", req });
    }
  } catch {
    // best-effort
  }

  res.json({ ok: true, uid, courseTitle, held });
});

router.get("/admin/courses-studying", requireAdmin, async (req, res) => {
  const db = await getDb();
  const pipeline = [
    { $group: { _id: { uid: "$uid", courseTitle: "$courseTitle" } } },
    { $group: { _id: "$_id.courseTitle", users: { $sum: 1 } } },
    { $sort: { users: -1 } },
  ];
  const rows = await db.collection("course_states").aggregate(pipeline).toArray();

  const holds = await db.collection("course_holds").find({ held: true }, { projection: { _id: 0, uid: 1, courseTitle: 1 } }).toArray();
  const holdCounts = {};
  for (const h of holds) {
    if (!h.courseTitle) continue;
    holdCounts[h.courseTitle] = (holdCounts[h.courseTitle] || 0) + 1;
  }

  const out = rows.map((r) => ({
    courseTitle: r._id,
    usersStudying: parseInt(r.users || 0, 10),
    usersOnHold: parseInt(holdCounts[r._id] || 0, 10),
  }));
  res.json({ ok: true, courses: out });
});

router.get("/admin/course-progress", requireAdmin, async (req, res) => {
  const db = await getDb();

  const totals = {};
  const allStates = await db.collection("course_states").find({}, { projection: { _id: 0, courseTitle: 1, videos: 1 } }).toArray();
  for (const st of allStates) {
    const ct = st.courseTitle;
    if (!ct) continue;
    totals[ct] = Math.max(totals[ct] || 0, countVideos(st.videos));
  }

  const usersArr = await db.collection("users").find({}, { projection: { _id: 0, uid: 1, email: 1, name: 1 } }).toArray();
  const users = Object.fromEntries(usersArr.map((u) => [u.uid, u]));

  const adminEmailLc = (config.adminEmail || "").trim().toLowerCase();
  const rows = [];
  const allCp = await db.collection("course_progress").find({}, { projection: { _id: 0, uid: 1, courseTitle: 1, quizPassedMap: 1, updatedAt: 1 } }).toArray();
  for (const cp of allCp) {
    const uid = cp.uid;
    const ct = cp.courseTitle;
    const u = users[uid] || {};
    const emailLc = (u.email || "").trim().toLowerCase();
    if (emailLc === adminEmailLc) continue;

    const total = parseInt(totals[ct] || 0, 10);
    const passed = countTrue(cp.quizPassedMap || {});
    const pct = total ? Math.round((passed / total) * 100) : 0;

    rows.push({
      uid,
      name: u.name,
      email: u.email,
      courseTitle: ct,
      totalQuizzes: total,
      passedQuizzes: passed,
      percent: pct,
      held: await isCourseHeld(db, uid, ct),
      updatedAt: cp.updatedAt,
    });
  }

  rows.sort((a, b) => {
    const ah = a.held === false ? 1 : 0;
    const bh = b.held === false ? 1 : 0;
    if (ah !== bh) return bh - ah;
    return (b.percent || 0) - (a.percent || 0);
  });

  res.json({ ok: true, rows });
});

router.get("/admin/quiz-performance", requireAdmin, async (req, res) => {
  const db = await getDb();

  const totals = {};
  const allStates = await db.collection("course_states").find({}, { projection: { _id: 0, courseTitle: 1, videos: 1 } }).toArray();
  for (const st of allStates) {
    const ct = st.courseTitle;
    if (!ct) continue;
    totals[ct] = Math.max(totals[ct] || 0, countVideos(st.videos));
  }

  const agg = {};
  const allCp = await db.collection("course_progress").find({}, { projection: { _id: 0, courseTitle: 1, quizPassedMap: 1 } }).toArray();
  for (const cp of allCp) {
    const ct = cp.courseTitle;
    if (!ct) continue;
    agg[ct] = (agg[ct] || 0) + countTrue(cp.quizPassedMap || {});
  }

  const courses = [];
  for (const [ct, total] of Object.entries(totals)) {
    const passedTotal = parseInt(agg[ct] || 0, 10);
    const usersStudyingRows = await db
      .collection("course_states")
      .aggregate([{ $match: { courseTitle: ct } }, { $group: { _id: "$uid" } }])
      .toArray();
    const usersStudying = usersStudyingRows.length;
    const denom = usersStudying * parseInt(total, 10);
    const passRate = denom ? Math.round((passedTotal / denom) * 10000) / 100 : 0;
    courses.push({
      courseTitle: ct,
      totalQuizzesPerUser: parseInt(total, 10),
      usersStudying,
      passedQuizzesTotal: passedTotal,
      passRatePercent: passRate,
    });
  }
  courses.sort((a, b) => (b.passRatePercent || 0) - (a.passRatePercent || 0));

  res.json({ ok: true, courses });
});

function dayKey(dt) {
  try {
    if (typeof dt === "string") return dt.slice(0, 10);
    if (dt instanceof Date) return dt.toISOString().slice(0, 10);
    return null;
  } catch {
    return null;
  }
}

function mocktestSessionsCol(db) {
  return db.collection("mocktest_sessions");
}

async function aggregateSessionAnalytics(db, matchQuery, limit, modeDefault) {
  const docs = await mocktestSessionsCol(db).find(matchQuery).sort({ created_at: -1 }).limit(limit).toArray();

  const totalSessions = docs.length;
  const userIds = new Set();
  let submitted = 0;
  let passed = 0;
  let totalScoreSum = 0;
  let totalMarksSum = 0;
  const modeCounts = {};
  const dayCounts = {};

  for (const d of docs) {
    if (d.uid) userIds.add(d.uid);

    const mode = d.mode || modeDefault;
    modeCounts[mode] = (modeCounts[mode] || 0) + 1;

    const dk = dayKey(d.created_at || d.createdAt);
    if (dk) dayCounts[dk] = (dayCounts[dk] || 0) + 1;

    const ts = d.total_score;
    const tm = d.total_marks;
    const status = (d.status || "").toLowerCase();

    if (ts != null && tm != null && (parseInt(tm, 10) || 0) > 0) {
      submitted += 1;
      const tsI = parseInt(ts, 10) || 0;
      const tmI = parseInt(tm, 10) || 0;
      totalScoreSum += tsI;
      totalMarksSum += tmI;
      if (tmI > 0 && tsI / tmI >= 0.6) passed += 1;
    } else if (["submitted", "completed"].includes(status)) {
      submitted += 1;
    }
  }

  const avgScorePct = totalMarksSum ? Math.round((totalScoreSum / totalMarksSum) * 10000) / 100 : 0.0;
  const passRate = submitted ? Math.round((passed / submitted) * 10000) / 100 : 0.0;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const timeline = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    timeline.push({ day, count: parseInt(dayCounts[day] || 0, 10) });
  }

  const modeBreakdown = Object.entries(modeCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([mode, count]) => ({ mode, count: parseInt(count, 10) }));

  return {
    totalSessions,
    uniqueUsers: userIds.size,
    submittedSessions: submitted,
    passedSessions: passed,
    avgScorePercent: avgScorePct,
    passRate,
    modeBreakdown,
    timeline,
  };
}

router.get("/admin/mocktest-analytics", requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const matchQuery = { $or: [{ kind: "mock" }, { kind: { $exists: false } }, { kind: null }, { kind: "" }] };
    const stats = await aggregateSessionAnalytics(db, matchQuery, 2000, "all");
    res.json({ ok: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.get("/admin/practicetest-analytics", requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const stats = await aggregateSessionAnalytics(db, { kind: "practice" }, 2000, "practice");
    res.json({ ok: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

async function aggregateSessionAnalyticsUsers(db, matchQuery, limit, modeDefault) {
  const docs = await mocktestSessionsCol(db).find(matchQuery).sort({ created_at: -1 }).limit(limit).toArray();

  const allUsers = await db.collection("users").find({}, { projection: { _id: 0, uid: 1, email: 1, name: 1, photoURL: 1, photoLocalURL: 1 } }).toArray();
  const users = Object.fromEntries(allUsers.map((u) => [u.uid, u]));

  const agg = {};
  for (const d of docs) {
    const uid = d.uid;
    if (!uid) continue;
    if (!agg[uid]) {
      agg[uid] = { uid, sessions: 0, submitted: 0, passed: 0, scoreSum: 0, marksSum: 0, modeCounts: {}, lastAttempt: null };
    }
    const a = agg[uid];
    a.sessions += 1;

    const mode = d.mode || modeDefault;
    a.modeCounts[mode] = (a.modeCounts[mode] || 0) + 1;

    const created = d.created_at || d.createdAt;
    if (a.lastAttempt === null) {
      a.lastAttempt = created;
    } else if (typeof created === "string" && typeof a.lastAttempt === "string" && created > a.lastAttempt) {
      a.lastAttempt = created;
    }

    const ts = d.total_score;
    const tm = d.total_marks;
    const status = (d.status || "").toLowerCase();
    if (ts != null && tm != null && (parseInt(tm, 10) || 0) > 0) {
      a.submitted += 1;
      const tsI = parseInt(ts, 10) || 0;
      const tmI = parseInt(tm, 10) || 0;
      a.scoreSum += tsI;
      a.marksSum += tmI;
      if (tmI > 0 && tsI / tmI >= 0.6) a.passed += 1;
    } else if (["submitted", "completed"].includes(status)) {
      a.submitted += 1;
    }
  }

  const adminEmailLc = (config.adminEmail || "").trim().toLowerCase();
  const rows = [];
  for (const [uid, a] of Object.entries(agg)) {
    const u = users[uid] || {};
    const emailLc = (u.email || "").trim().toLowerCase();
    if (emailLc === adminEmailLc) continue;

    const avgScorePct = a.marksSum ? Math.round((a.scoreSum / a.marksSum) * 10000) / 100 : 0.0;
    const passRate = a.submitted ? Math.round((a.passed / a.submitted) * 10000) / 100 : 0.0;
    rows.push({
      uid,
      name: u.name,
      email: u.email,
      photoURL: u.photoURL,
      photoLocalURL: u.photoLocalURL,
      sessions: parseInt(a.sessions, 10),
      submitted: parseInt(a.submitted, 10),
      passed: parseInt(a.passed, 10),
      avgScorePercent: avgScorePct,
      passRate,
      modeBreakdown: Object.entries(a.modeCounts)
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([mode, count]) => ({ mode, count: parseInt(count, 10) })),
      lastAttempt: a.lastAttempt,
    });
  }

  rows.sort((a, b) => (b.passRate || 0) - (a.passRate || 0) || (b.avgScorePercent || 0) - (a.avgScorePercent || 0) || (b.sessions || 0) - (a.sessions || 0));
  return rows;
}

router.get("/admin/mocktest-analytics/users", requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const matchQuery = { $or: [{ kind: "mock" }, { kind: { $exists: false } }, { kind: null }, { kind: "" }] };
    const rows = await aggregateSessionAnalyticsUsers(db, matchQuery, 5000, "all");
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.get("/admin/practicetest-analytics/users", requireAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const rows = await aggregateSessionAnalyticsUsers(db, { kind: "practice" }, 5000, "practice");
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.get("/admin/quiz-analytics/users", requireAdmin, async (req, res) => {
  try {
    const db = await getDb();

    const totals = {};
    const allStates = await db.collection("course_states").find({}, { projection: { _id: 0, courseTitle: 1, videos: 1 } }).toArray();
    for (const st of allStates) {
      const ct = st.courseTitle;
      if (!ct) continue;
      totals[ct] = Math.max(totals[ct] || 0, countVideos(st.videos));
    }

    const allUsers = await db.collection("users").find({}, { projection: { _id: 0, uid: 1, email: 1, name: 1, photoURL: 1, photoLocalURL: 1 } }).toArray();
    const users = Object.fromEntries(allUsers.map((u) => [u.uid, u]));

    const agg = {};
    const allCp = await db
      .collection("course_progress")
      .find({}, { projection: { _id: 0, uid: 1, courseTitle: 1, quizPassedMap: 1, updatedAt: 1 } })
      .toArray();
    for (const cp of allCp) {
      const uid = cp.uid;
      const ct = cp.courseTitle;
      if (!uid || !ct) continue;
      const total = parseInt(totals[ct] || 0, 10);
      const passed = countTrue(cp.quizPassedMap || {});
      if (!agg[uid]) agg[uid] = { uid, courses: 0, totalQuizzes: 0, passedQuizzes: 0, lastUpdated: null };
      const a = agg[uid];
      a.courses += 1;
      a.totalQuizzes += total;
      a.passedQuizzes += Math.min(passed, total);
      const lu = cp.updatedAt;
      if (a.lastUpdated === null) {
        a.lastUpdated = lu;
      } else if (typeof lu === "string" && typeof a.lastUpdated === "string" && lu > a.lastUpdated) {
        a.lastUpdated = lu;
      }
    }

    const adminEmailLc = (config.adminEmail || "").trim().toLowerCase();
    const rows = [];
    for (const [uid, a] of Object.entries(agg)) {
      const u = users[uid] || {};
      const emailLc = (u.email || "").trim().toLowerCase();
      if (emailLc === adminEmailLc) continue;

      const total = parseInt(a.totalQuizzes || 0, 10);
      const passed = parseInt(a.passedQuizzes || 0, 10);
      const avgPercent = total ? Math.round((passed / total) * 10000) / 100 : 0.0;

      rows.push({
        uid,
        name: u.name,
        email: u.email,
        photoURL: u.photoURL,
        photoLocalURL: u.photoLocalURL,
        courses: parseInt(a.courses || 0, 10),
        totalQuizzes: total,
        passedQuizzes: passed,
        avgPercent,
        lastUpdated: a.lastUpdated,
      });
    }

    rows.sort((a, b) => (b.avgPercent || 0) - (a.avgPercent || 0) || (b.passedQuizzes || 0) - (a.passedQuizzes || 0));
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

router.get("/admin/user/:uid/summary", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const db = await getDb();
  const u = (await db.collection("users").findOne({ uid }, { projection: { _id: 0 } })) || {};
  if (!Object.keys(u).length) return res.status(404).json({ ok: false, error: "User not found" });

  const studyingDocs = await db.collection("course_states").find({ uid }, { projection: { _id: 0, courseTitle: 1 } }).toArray();
  const studying = [...new Set(studyingDocs.map((x) => (x.courseTitle || "").trim()).filter(Boolean))].sort();

  const holdsDocs = await db.collection("course_holds").find({ uid, held: true }, { projection: { _id: 0, courseTitle: 1 } }).toArray();
  const holds = [...new Set(holdsDocs.map((x) => (x.courseTitle || "").trim()).filter(Boolean))].sort();

  const mtTotal = await mocktestSessionsCol(db).countDocuments({ uid });
  const mtSubmitted = await mocktestSessionsCol(db).countDocuments({ uid, submittedAt: { $exists: true } });

  const cpDocs = await db.collection("course_progress").find({ uid }, { projection: { _id: 0, courseTitle: 1, quizPassedMap: 1, updatedAt: 1 } }).toArray();

  res.json({
    ok: true,
    user: { uid: u.uid, name: u.name, email: u.email, photoURL: u.photoURL, isAdmin: !!u.isAdmin },
    studyingCourses: studying,
    heldCourses: holds,
    mocktests: { total: parseInt(mtTotal, 10), submitted: parseInt(mtSubmitted, 10) },
    courseProgressCount: cpDocs.length,
  });
});

router.get("/admin/user/:uid/courses-studying", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const db = await getDb();
  const titles = {};
  const states = await db.collection("course_states").find({ uid }, { projection: { _id: 0, courseTitle: 1, updatedAt: 1 } }).toArray();
  for (const st of states) {
    const ct = (st.courseTitle || "").trim();
    if (!ct) continue;
    const prev = titles[ct];
    if (!prev || (st.updatedAt && st.updatedAt > (prev.updatedAt || 0))) {
      titles[ct] = { courseTitle: ct, updatedAt: st.updatedAt };
    }
  }

  const out = [];
  for (const [ct, info] of Object.entries(titles)) {
    out.push({ courseTitle: ct, held: await isCourseHeld(db, uid, ct), updatedAt: info.updatedAt });
  }
  out.sort((a, b) => {
    const ah = a.held === false ? 1 : 0;
    const bh = b.held === false ? 1 : 0;
    if (ah !== bh) return bh - ah;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });

  res.json({ ok: true, courses: out });
});

router.get("/admin/user/:uid/course-progress", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const db = await getDb();

  const totals = {};
  const allStates = await db.collection("course_states").find({}, { projection: { _id: 0, courseTitle: 1, videos: 1 } }).toArray();
  for (const st of allStates) {
    const ct = st.courseTitle;
    if (!ct) continue;
    totals[ct] = Math.max(totals[ct] || 0, countVideos(st.videos));
  }

  const rows = [];
  const cpDocs = await db.collection("course_progress").find({ uid }, { projection: { _id: 0, courseTitle: 1, quizPassedMap: 1, updatedAt: 1 } }).toArray();
  for (const cp of cpDocs) {
    const ct = cp.courseTitle;
    const total = parseInt(totals[ct] || 0, 10);
    const passed = countTrue(cp.quizPassedMap || {});
    const pct = total ? Math.round((passed / total) * 100) : 0;
    rows.push({
      courseTitle: ct,
      totalQuizzes: total,
      passedQuizzes: passed,
      percent: pct,
      held: await isCourseHeld(db, uid, ct),
      updatedAt: cp.updatedAt,
    });
  }

  rows.sort((a, b) => {
    const ah = a.held === false ? 1 : 0;
    const bh = b.held === false ? 1 : 0;
    if (ah !== bh) return bh - ah;
    return (b.percent || 0) - (a.percent || 0);
  });

  res.json({ ok: true, rows });
});

function getUrlFromNode(obj) {
  if (obj == null) return "";
  if (typeof obj === "string") return obj.trim();
  if (typeof obj === "object") return (obj.videoUrl || obj.video_url || obj.url || obj.video || "").trim();
  return String(obj).trim();
}

function flattenVideoUrlsLocal(node) {
  const out = [];
  if (node == null) return out;
  if (typeof node === "string") {
    const u = node.trim();
    if (u) out.push(u);
    return out;
  }
  if (Array.isArray(node)) {
    for (const it of node) out.push(...flattenVideoUrlsLocal(it));
    return out;
  }
  if (typeof node === "object") {
    if (Array.isArray(node.videos)) {
      for (const it of node.videos) {
        const u = getUrlFromNode(it);
        if (u) out.push(u);
      }
      return out;
    }
    for (const v of Object.values(node)) out.push(...flattenVideoUrlsLocal(v));
    return out;
  }
  return out;
}

function flattenVideoEntries(node) {
  const out = [];
  const push = (title, url) => {
    const u = (url || "").trim();
    if (!u) return;
    const t = (title || "").trim() || null;
    out.push({ title: t, url: u });
  };

  const walk = (n) => {
    if (n == null) return;
    if (typeof n === "string") {
      push(null, n);
      return;
    }
    if (Array.isArray(n)) {
      for (const it of n) walk(it);
      return;
    }
    if (typeof n === "object") {
      const u = n.url || n.video_url || n.videoUrl || n.link || n.video;
      const t = n.title || n.video_title || n.name || n.label || n.topic;
      if (u) {
        push(t, u);
      }
      for (const k of ["videos", "items", "lessons", "playlist", "week", "weeks", "modules"]) {
        if (k in n) walk(n[k]);
      }
      if (!u) {
        for (const v of Object.values(n)) {
          if (v && typeof v === "object") walk(v);
        }
      }
    }
  };

  walk(node);
  const seen = new Set();
  const dedup = [];
  for (const it of out) {
    if (!it.url || seen.has(it.url)) continue;
    seen.add(it.url);
    dedup.push(it);
  }
  return dedup;
}

router.get("/admin/user/:uid/course/:courseTitle/quiz-results", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const db = await getDb();
  const courseTitle = (req.params.courseTitle || "").trim();
  const ctRe = new RegExp(`^\\s*${courseTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");

  const docs = await db
    .collection("quiz_attempts")
    .find({ uid, courseTitle: ctRe }, { projection: { _id: 0 } })
    .sort({ updatedAt: -1, createdAt: -1 })
    .toArray();

  const byVideoNo = {};
  const attemptsCount = {};
  let totalVideos = null;
  for (const d of docs) {
    if (d.totalVideos) totalVideos = parseInt(d.totalVideos, 10);

    let vn = d.videoNo ?? d.video_no ?? d.videoIndex ?? d.video_index ?? d.video;
    vn = vn != null ? parseInt(vn, 10) : null;
    if (!vn || Number.isNaN(vn)) continue;
    attemptsCount[vn] = (attemptsCount[vn] || 0) + 1;
    if (!(vn in byVideoNo)) byVideoNo[vn] = d;
  }

  const cs = (await db.collection("course_states").findOne({ uid, courseTitle: ctRe }, { projection: { _id: 0, videos: 1 } })) || {};
  let videoList = flattenVideoEntries(cs.videos);
  if (!videoList.length) {
    try {
      const cdoc = (await db.collection("courses").findOne({ courseTitle: ctRe }, { projection: { _id: 0, videos: 1 } })) || {};
      videoList = flattenVideoEntries(cdoc.videos) || videoList;
    } catch {
      // ignore
    }
  }
  const videoUrls = videoList.filter((it) => it && typeof it.url === "string").map((it) => it.url);

  const cp =
    (await db
      .collection("course_progress")
      .findOne({ uid, courseTitle: ctRe }, { projection: { _id: 0, quizPassedMap: 1, quizSubmittedMap: 1, quizCompletedMap: 1, highestUnlockedId: 1 } })) || {};
  const passedMap = cp.quizPassedMap || {};

  let highestUnlocked = cp.highestUnlockedId;
  highestUnlocked = highestUnlocked != null ? parseInt(highestUnlocked, 10) : null;
  if (Number.isNaN(highestUnlocked)) highestUnlocked = null;

  let pmMax = 0;
  for (const k of Object.keys(passedMap || {})) {
    const n = parseInt(k, 10);
    if (!Number.isNaN(n)) pmMax = Math.max(pmMax, n);
  }
  const attemptsKeys = Object.keys(byVideoNo).map(Number);
  const attemptsMax = attemptsKeys.length ? Math.max(...attemptsKeys) : 0;

  if (videoList.length) {
    totalVideos = videoList.length;
  } else {
    totalVideos = Math.max(pmMax, attemptsMax, videoUrls.length, parseInt(totalVideos || 0, 10));
  }

  const rows = [];
  const N = totalVideos ? parseInt(totalVideos, 10) : videoUrls.length;
  for (let i = 1; i <= (N > 0 ? N : 0); i++) {
    const d = byVideoNo[i];
    const link = videoUrls.length && i - 1 < videoUrls.length ? videoUrls[i - 1] : null;
    let title = null;
    if (videoList.length && i - 1 < videoList.length) title = (videoList[i - 1] || {}).title;

    let legacyInferred = false;
    let attempted = false;
    let passed = null;
    if (d != null && "passed" in d) {
      passed = !!d.passed;
      attempted = true;
    }
    if (passed === null) {
      const key = String(i);
      attempted = key in (passedMap || {});
      if (attempted) {
        passed = !!(passedMap || {})[key];
      } else if (highestUnlocked !== null && i < highestUnlocked) {
        attempted = true;
        passed = true;
        legacyInferred = true;
      } else {
        passed = false;
        legacyInferred = false;
      }
    }

    let attemptsUsed = d ? d.attemptsUsed ?? d.attempts ?? d.attemptCount : null;
    if (attemptsUsed == null) attemptsUsed = attemptsCount[i];
    if (attemptsUsed == null) {
      const key = String(i);
      const submittedMap = cp.quizSubmittedMap || {};
      const completedMap = cp.quizCompletedMap || {};
      if (key in submittedMap || key in completedMap) attemptsUsed = 1;
      else if (highestUnlocked !== null && i < highestUnlocked) attemptsUsed = 1;
      else attemptsUsed = 0;
    }

    const hasScore = d != null && d.lastScore != null && d.totalQuestions != null;

    rows.push({
      uid,
      courseTitle,
      videoNo: i,
      totalVideos,
      videoTitle: title || (d && d.videoTitle) || `Video ${i}`,
      video_url: (d && d.video_url) || link,
      quiz_id: d ? d.quiz_id : null,
      bestScore: d ? d.bestScore ?? d.best ?? d.best_score ?? d.score ?? d.marks ?? d.lastScore : null,
      lastScore: d ? d.lastScore ?? d.last ?? d.last_score ?? d.score ?? d.marks : null,
      totalQuestions: d ? d.totalQuestions ?? d.total ?? d.max ?? d.totalQ : null,
      required: d ? d.required : null,
      passed: !!passed,
      attempted: !!attempted,
      attemptsUsed: parseInt(attemptsUsed || 0, 10),
      hasScore: !!hasScore,
      legacyInferred: !!legacyInferred,
      lastAttemptAt: d ? d.lastAttemptAt || d.updatedAt : null,
      updatedAt: d ? d.updatedAt : null,
    });
  }

  res.json({ ok: true, rows, meta: { uid, courseTitle, totalVideos } });
});

function scorePercentOf(d) {
  const totalScore = d.total_score;
  const totalMarks = d.total_marks;
  if (totalScore != null && totalMarks) {
    try {
      return (parseFloat(totalScore) / parseFloat(totalMarks)) * 100.0;
    } catch {
      return null;
    }
  }
  return null;
}

router.get("/admin/user/:uid/mocktests", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const db = await getDb();
  const col = mocktestSessionsCol(db);

  const docs = await col
    .find({ uid, $or: [{ kind: "mock" }, { kind: { $exists: false } }, { kind: null }, { kind: "" }] }, { projection: { _id: 0 } })
    .sort({ created_at: -1 })
    .limit(200)
    .toArray();

  const out = docs.map((d) => {
    const scorePercent = scorePercentOf(d);
    let submittedAt = d.submittedAt || d.submitted_at;
    const status = (d.status || "").toLowerCase();
    if (submittedAt == null && status === "submitted") submittedAt = d.updated_at;
    const passed = scorePercent != null ? scorePercent >= 60.0 : null;
    return {
      sessionId: d.session_id || d.sessionId || d._id,
      mode: d.mode || "unknown",
      createdAt: d.created_at || d.createdAt,
      submittedAt,
      scorePercent,
      passed: passed != null ? !!passed : false,
    };
  });

  res.json({ ok: true, rows: out });
});

router.get("/admin/user/:uid/mocktests/:sessionId", requireAdmin, async (req, res) => {
  const { uid, sessionId } = req.params;
  const db = await getDb();
  const col = mocktestSessionsCol(db);

  let doc = await col.findOne({ uid, session_id: sessionId }, { projection: { _id: 0 } });
  if (!doc) doc = await col.findOne({ uid, sessionId }, { projection: { _id: 0 } });
  if (!doc) return res.status(404).json({ ok: false, error: "Not found" });

  const out = {
    sessionId: doc.session_id || doc.sessionId || sessionId,
    title: doc.title || "Mock Test",
    mode: doc.mode || "unknown",
    pattern: doc.pattern || {},
    status: doc.status || "",
    createdAt: doc.created_at || doc.createdAt,
    submittedAt: doc.submittedAt || doc.submitted_at,
    scores: doc.scores || {},
    total_score: doc.total_score,
    total_marks: doc.total_marks,
    coding_total_marks: doc.coding_total_marks,
    coding_details: doc.coding_details || {},
    analysis: doc.analysis,
    analysis_unavailable_reason: doc.analysis_unavailable_reason || null,
    proctoring: proctoringPublic(doc.proctoring || {}),
    updatedAt: doc.updated_at || doc.updatedAt,
  };

  res.json({ ok: true, session: out });
});

router.get("/admin/user/:uid/practicetests", requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const db = await getDb();
  const col = mocktestSessionsCol(db);

  const docs = await col.find({ uid, kind: "practice" }, { projection: { _id: 0 } }).sort({ created_at: -1 }).limit(200).toArray();

  const out = docs.map((d) => {
    const scorePercent = scorePercentOf(d);
    let submittedAt = d.submittedAt || d.submitted_at;
    const status = (d.status || "").toLowerCase();
    if (submittedAt == null && status === "submitted") submittedAt = d.updated_at;
    const passed = scorePercent != null ? scorePercent >= 60.0 : null;
    return {
      sessionId: d.session_id || d.sessionId || d._id,
      mode: d.mode || "practice",
      topic: d.topic || "",
      createdAt: d.created_at || d.createdAt,
      submittedAt,
      scorePercent,
      passed: passed != null ? !!passed : false,
    };
  });

  res.json({ ok: true, rows: out });
});

router.get("/admin/user/:uid/practicetests/:sessionId", requireAdmin, async (req, res) => {
  const { uid, sessionId } = req.params;
  const db = await getDb();
  const col = mocktestSessionsCol(db);

  let doc = await col.findOne({ uid, session_id: sessionId, kind: "practice" }, { projection: { _id: 0 } });
  if (!doc) doc = await col.findOne({ uid, sessionId, kind: "practice" }, { projection: { _id: 0 } });
  if (!doc) return res.status(404).json({ ok: false, error: "Not found" });

  const out = {
    sessionId: doc.session_id || doc.sessionId || sessionId,
    title: doc.title || "Practice Test",
    mode: doc.mode || "practice",
    topic: doc.topic || "",
    pattern: doc.pattern || {},
    status: doc.status || "",
    createdAt: doc.created_at || doc.createdAt,
    submittedAt: doc.submittedAt || doc.submitted_at,
    scores: doc.scores || {},
    total_score: doc.total_score,
    total_marks: doc.total_marks,
    coding_details: doc.coding_details || {},
    analysis: doc.analysis,
    analysis_unavailable_reason: doc.analysis_unavailable_reason || null,
    updatedAt: doc.updated_at || doc.updatedAt,
  };

  res.json({ ok: true, session: out });
});

router.get("/admin/course/:courseTitle/summary", requireAdmin, async (req, res) => {
  const db = await getDb();
  const ct = (req.params.courseTitle || "").trim();
  if (!ct) return res.status(400).json({ ok: false, error: "Missing courseTitle" });

  const studyingUids = await db.collection("course_states").aggregate([{ $match: { courseTitle: ct } }, { $group: { _id: "$uid" } }]).toArray();
  const usersStudying = studyingUids.length;

  const usersOnHold = await db.collection("course_holds").countDocuments({ courseTitle: ct, held: true });

  const cps = await db.collection("course_progress").find({ courseTitle: ct }, { projection: { _id: 0, quizPassedMap: 1 } }).toArray();
  const passedTotal = cps.reduce((sum, x) => sum + countTrue(x.quizPassedMap || {}), 0);

  res.json({
    ok: true,
    courseTitle: ct,
    usersStudying: parseInt(usersStudying, 10),
    usersOnHold: parseInt(usersOnHold, 10),
    progressDocs: cps.length,
    passedQuizCount: parseInt(passedTotal, 10),
  });
});

router.get("/admin/course/:courseTitle/progress", requireAdmin, async (req, res) => {
  const db = await getDb();
  const ct = (req.params.courseTitle || "").trim();
  if (!ct) return res.status(400).json({ ok: false, error: "Missing courseTitle" });

  let total = 0;
  const states = await db.collection("course_states").find({ courseTitle: ct }, { projection: { _id: 0, videos: 1 } }).toArray();
  for (const st of states) total = Math.max(total, countVideos(st.videos));

  const allUsers = await db.collection("users").find({}, { projection: { _id: 0, uid: 1, email: 1, name: 1 } }).toArray();
  const users = Object.fromEntries(allUsers.map((u) => [u.uid, u]));

  const rows = [];
  const cpDocs = await db.collection("course_progress").find({ courseTitle: ct }, { projection: { _id: 0, uid: 1, quizPassedMap: 1, updatedAt: 1 } }).toArray();
  for (const cp of cpDocs) {
    const uid = cp.uid;
    const u = users[uid] || {};
    const passed = countTrue(cp.quizPassedMap || {});
    const pct = total ? Math.round((passed / total) * 100) : 0;
    rows.push({
      uid,
      name: u.name,
      email: u.email,
      courseTitle: ct,
      totalQuizzes: parseInt(total, 10),
      passedQuizzes: parseInt(passed, 10),
      percent: pct,
      held: await isCourseHeld(db, uid, ct),
      updatedAt: cp.updatedAt,
    });
  }

  rows.sort((a, b) => {
    const ah = a.held === false ? 1 : 0;
    const bh = b.held === false ? 1 : 0;
    if (ah !== bh) return bh - ah;
    return (b.percent || 0) - (a.percent || 0);
  });

  res.json({ ok: true, rows });
});

router.get("/admin/course/:courseTitle/quiz-attempts", requireAdmin, async (req, res) => {
  const ct = (req.params.courseTitle || "").trim();
  if (!ct) return res.status(400).json({ ok: false, error: "Missing courseTitle" });

  const db = await getDb();
  const docs = await db
    .collection("quiz_attempts")
    .find({ courseTitle: ct }, { projection: { _id: 0 } })
    .sort({ videoNo: 1, lastAttemptAt: -1 })
    .limit(5000)
    .toArray();

  const uids = [...new Set(docs.map((d) => d.uid).filter(Boolean))].sort();
  const users = {};
  if (uids.length) {
    const foundUsers = await db.collection("users").find({ uid: { $in: uids } }, { projection: { _id: 0, uid: 1, name: 1, email: 1 } }).toArray();
    for (const u of foundUsers) users[u.uid] = { name: u.name, email: u.email };
  }

  const rows = docs.map((d) => {
    const u = users[d.uid] || {};
    return {
      uid: d.uid,
      name: u.name,
      email: u.email,
      courseTitle: d.courseTitle,
      videoNo: d.videoNo,
      totalVideos: d.totalVideos,
      lastScore: d.lastScore,
      bestScore: d.bestScore,
      totalQuestions: d.totalQuestions,
      required: d.required,
      passed: !!d.passed,
      attemptsUsed: d.attemptsUsed,
      lastAttemptAt: d.lastAttemptAt || d.updatedAt,
      video_url: d.video_url,
    };
  });

  res.json({ ok: true, rows });
});

export default router;
export { countVideos, countTrue, mocktestSessionsCol };
