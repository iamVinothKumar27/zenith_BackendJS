import { Router } from "express";
import crypto from "crypto";
import admin, { initFirebaseAdmin } from "../config/firebase.js";
import { getDb } from "../config/mongo.js";
import { requireUser } from "../middleware/auth.js";
import { brandEmail, sendEmail, safePublicUrl } from "../utils/email.js";
import { pwHash } from "../utils/text.js";
import { toUtcAware } from "../utils/dates.js";

const router = Router();

function newToken() {
  return crypto.randomBytes(32).toString("hex"); // 64 chars
}

router.post("/auth/firebase", requireUser, async (req, res) => {
  const user = req.user;
  const payload = req.body || {};
  const uid = payload.uid || user.uid;
  const email = payload.email || user.email;
  const name = payload.name || user.name || "";
  const photoURL = payload.photoURL || "";
  const providerId = payload.providerId || "firebase";

  if (!uid) return res.status(400).json({ error: "uid missing" });

  const db = await getDb();
  const now = new Date();

  const emailNorm = (email || "").trim().toLowerCase();
  const lookup = emailNorm ? { email: emailNorm } : { uid };
  const existingUser = (await db.collection("users").findOne(lookup, { projection: { _id: 0, avatarFileId: 1, photoLocalURL: 1, photoURL: 1 } })) || {};

  const setDoc = { uid, email: emailNorm, name, providerId, updatedAt: now };
  if (existingUser.avatarFileId) {
    setDoc.photoURL = existingUser.photoURL || photoURL;
  } else {
    setDoc.photoLocalURL = "";
    setDoc.avatarFileId = "";
    setDoc.photoURL = photoURL;
  }

  const result = await db.collection("users").updateOne(lookup, { $set: setDoc, $setOnInsert: { createdAt: now } }, { upsert: true });

  try {
    const isNew = !!result.upsertedId;
    if (isNew && (providerId || "").toLowerCase().startsWith("google")) {
      const udoc = (await db.collection("users").findOne(emailNorm ? { email: emailNorm } : { uid }, { projection: { _id: 0, welcomeSsoSent: 1, name: 1 } })) || {};
      if (!udoc.welcomeSsoSent) {
        const homeUrl = safePublicUrl("/", req);
        const body = `
                <p style="margin:0 0 10px 0;">Hi <b>${name || "there"}</b>,</p>
                <p style="margin:0 0 10px 0;">
                  Welcome to <b>Zenith Learning</b>! Your Google sign-in is set up and you're ready to start learning.
                </p>
                <p style="margin:0 0 10px 0;">Here are a few quick tips to get the best experience:</p>
                <ul style="margin:10px 0 10px 20px;">
                  <li>Create a roadmap to structure your learning in weeks</li>
                  <li>Complete quizzes after each video to unlock the next content</li>
                  <li>Track progress in <b>My Courses</b> and continue anytime</li>
                </ul>
                `;
        const html = brandEmail({
          title: "Welcome to Zenith Learning \u{1F389}",
          preheader: "Your Google sign-in is ready — begin your roadmap today.",
          bodyHtml: body,
          primaryCta: { label: "Start learning", url: homeUrl },
          secondaryCta: { label: "Contact support", url: safePublicUrl("/contact", req) },
          kind: "auth",
          req,
        });
        sendEmail(email, "Welcome to Zenith Learning", html, "", { kind: "auth", req });
        await db.collection("users").updateOne(emailNorm ? { email: emailNorm } : { uid }, { $set: { welcomeSsoSent: true, updatedAt: now } });
      }
    }
  } catch {
    // best-effort welcome email
  }

  const userDoc = await db.collection("users").findOne(emailNorm ? { email: emailNorm } : { uid }, { projection: { _id: 0 } });
  res.json({ ok: true, user: userDoc });
});

router.post("/auth/send-verification", requireUser, async (req, res) => {
  const user = req.user;
  const email = user.email || "";
  const uid = user.uid || "";
  if (!email || !uid) return res.status(400).json({ error: "email/uid missing" });

  const db = await getDb();
  const now = new Date();

  try {
    const emailNorm = (email || "").trim().toLowerCase();
    const filt = emailNorm ? { email: emailNorm } : { uid };
    await db.collection("users").updateOne(
      filt,
      {
        $set: { uid, email: emailNorm, name: user.name || "", photoURL: user.picture || user.photoURL || "", providerId: "password", updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
  } catch (e) {
    console.log(`[WARN] Mongo upsert during send-verification failed: ${e.message || e}`);
  }

  try {
    initFirebaseAdmin();
    const u = await admin.auth().getUser(uid);
    if (u.emailVerified) return res.json({ ok: true, alreadyVerified: true });
  } catch {
    // ignore
  }

  const token = newToken();
  await db.collection("email_verifications").insertOne({
    token,
    uid,
    email,
    used: false,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
  });

  const verifyUrl = safePublicUrl(`/verify-email?token=${token}`, req);
  const body = `
    <p style="margin:0 0 10px 0;">Hi <b>${user.name || "there"}</b>,</p>
    <p style="margin:0 0 10px 0;">
      Thanks for signing up for <b>Zenith Learning</b>. To activate your account and start saving courses and progress,
      please verify your email address.
    </p>
    <ul style="margin:10px 0 10px 20px;">
      <li>This verification link is valid for <b>24 hours</b>.</li>
      <li>If you didn't create this account, you can safely ignore this email.</li>
    </ul>
    <p style="margin:10px 0 0 0;">Click the button below to continue.</p>
    `;
  const html = brandEmail({
    title: "Verify your email to activate your Zenith account",
    preheader: "One quick step to activate your account and start learning.",
    bodyHtml: body,
    primaryCta: { label: "Open verification page", url: verifyUrl },
    kind: "auth",
    req,
  });
  sendEmail(email, "Verify your Zenith Learning email", html, "", { kind: "auth", req });
  res.json({ ok: true });
});

router.post("/auth/verify-email", async (req, res) => {
  const data = req.body || {};
  const token = (data.token || "").trim();
  if (!token) return res.status(400).json({ error: "token required" });

  const db = await getDb();
  const now = new Date();

  const rec = await db.collection("email_verifications").findOne({ token });
  if (!rec) return res.status(400).json({ error: "Invalid or expired token" });
  if (rec.used) return res.json({ ok: true, alreadyUsed: true });
  const exp = toUtcAware(rec.expiresAt);
  if (exp && exp < now) return res.status(400).json({ error: "Token expired" });

  const uid = rec.uid;
  const email = rec.email;

  await db.collection("users").updateOne(
    { uid },
    { $set: { uid, email, updatedAt: now }, $setOnInsert: { createdAt: now, providerId: "password" } },
    { upsert: true }
  );

  try {
    initFirebaseAdmin();
    await admin.auth().updateUser(uid, { emailVerified: true });
  } catch (e) {
    return res.status(500).json({ error: `Firebase update failed: ${e.message || e}` });
  }

  await db.collection("email_verifications").updateOne({ token }, { $set: { used: true, usedAt: now } });

  const emailNorm = (email || "").trim().toLowerCase();
  const userDoc = (await db.collection("users").findOne(emailNorm ? { email: emailNorm } : { uid }, { projection: { _id: 0 } })) || {};
  if (!userDoc.welcomeManualSent) {
    const homeUrl = safePublicUrl("/", req);
    const body = `
        <p style="margin:0 0 10px 0;">Hi <b>${userDoc.name || "there"}</b>,</p>
        <p style="margin:0 0 10px 0;">
          Your email is verified ✅. Welcome to <b>Zenith Learning</b>!
        </p>
        <p style="margin:0 0 10px 0;">
          Here's what you can do next:
        </p>
        <ul style="margin:10px 0 10px 20px;">
          <li>Create a personalized learning roadmap</li>
          <li>Track video progress and quiz performance</li>
          <li>Resume anytime from <b>My Courses</b></li>
          <li>Use Notes to save important points</li>
        </ul>
        <p style="margin:10px 0 0 0;">Ready to continue?</p>
        `;
    const html = brandEmail({
      title: "Welcome to Zenith Learning \u{1F389}",
      preheader: "Your account is active. Let's start learning.",
      bodyHtml: body,
      primaryCta: { label: "Go to Zenith", url: homeUrl },
      secondaryCta: { label: "Contact support", url: safePublicUrl("/contact", req) },
      kind: "auth",
      req,
    });
    sendEmail(email, "Welcome to Zenith Learning", html, "", { kind: "auth", req });
    await db
      .collection("users")
      .updateOne(emailNorm ? { email: emailNorm } : { uid }, { $set: { welcomeManualSent: true, updatedAt: now } }, { upsert: true });
  }

  res.json({ ok: true });
});

router.post("/auth/password-reset/request", async (req, res) => {
  const data = req.body || {};
  const email = (data.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email required" });

  const db = await getDb();
  const now = new Date();
  const token = newToken();

  let uid;
  try {
    initFirebaseAdmin();
    const u = await admin.auth().getUserByEmail(email);
    uid = u.uid;
  } catch {
    return res.json({ ok: true });
  }

  await db.collection("password_resets").insertOne({
    token,
    uid,
    email,
    used: false,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 3600 * 1000),
  });

  const resetUrl = safePublicUrl(`/reset-password?token=${token}`, req);
  const body = `
    <p style="margin:0 0 10px 0;">Hi,</p>
    <p style="margin:0 0 10px 0;">
      We received a request to reset the password for your Zenith Learning account (<b>${email}</b>).
    </p>
    <p style="margin:0 0 10px 0;">
      If you initiated this request, click the button below to set a new password.
      This link is valid for <b>1 hour</b>.
    </p>
    <ul style="margin:10px 0 10px 20px;">
      <li>If you did not request a reset, you can ignore this email.</li>
      <li>For security, never share your password with anyone.</li>
    </ul>
    `;
  const html = brandEmail({
    title: "Reset your Zenith Learning password",
    preheader: "Use the button below to set a new password (valid for 1 hour).",
    bodyHtml: body,
    primaryCta: { label: "Reset password", url: resetUrl },
    kind: "auth",
    req,
  });
  sendEmail(email, "Reset your Zenith Learning password", html, "", { kind: "auth", req });
  res.json({ ok: true });
});

router.post("/auth/password-reset/confirm", async (req, res) => {
  const data = req.body || {};
  const token = (data.token || "").trim();
  const newPassword = (data.newPassword || "").trim();
  if (!token || !newPassword) return res.status(400).json({ error: "token and newPassword required" });
  if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const db = await getDb();
  const now = new Date();

  const rec = await db.collection("password_resets").findOne({ token });
  if (!rec) return res.status(400).json({ error: "Invalid or expired token" });
  if (rec.used) return res.status(400).json({ error: "Token already used" });
  const exp = toUtcAware(rec.expiresAt);
  if (exp && exp < now) return res.status(400).json({ error: "Token expired" });

  const uid = (rec.uid || "").trim();
  const email = (rec.email || "").trim().toLowerCase();
  if (!uid) return res.status(400).json({ error: "Invalid reset record (uid missing)" });

  await db.collection("users").updateOne(
    { uid },
    { $set: { uid, email, updatedAt: now }, $setOnInsert: { createdAt: now, providerId: "password" } },
    { upsert: true }
  );

  try {
    const userDoc = (await db.collection("users").findOne({ uid }, { projection: { _id: 0, passwordHash: 1 } })) || {};
    const oldHash = (userDoc.passwordHash || "").trim();
    const newHash = pwHash(uid, newPassword);
    if (oldHash && oldHash === newHash) {
      return res.status(400).json({ error: "New password cannot be the same as your old password. Please choose a different password." });
    }
  } catch {
    // don't fail reset if hash check fails unexpectedly
  }

  try {
    initFirebaseAdmin();
    await admin.auth().updateUser(uid, { password: newPassword });
  } catch (e) {
    return res.status(500).json({ error: `Password update failed: ${e.message || e}` });
  }

  await db.collection("password_resets").updateOne({ token }, { $set: { used: true, usedAt: now } });

  try {
    await db.collection("users").updateOne({ uid }, { $set: { passwordHash: pwHash(uid, newPassword), updatedAt: now } }, { upsert: true });
  } catch {
    // best-effort
  }

  const body = `
    <p style="margin:0 0 10px 0;">Hi,</p>
    <p style="margin:0 0 10px 0;">
      Your Zenith Learning password has been successfully updated for <b>${email}</b>.
    </p>
    <p style="margin:0 0 10px 0;">
      If you didn't make this change, please reset your password again immediately and contact support.
    </p>
    `;
  const html = brandEmail({
    title: "Your password was updated",
    preheader: "Your password reset is complete.",
    bodyHtml: body,
    primaryCta: { label: "Login to Zenith", url: safePublicUrl("/login", req) },
    secondaryCta: { label: "Contact support", url: safePublicUrl("/contact", req) },
    kind: "auth",
    req,
  });
  sendEmail(email, "Zenith Learning — Password updated", html, "", { kind: "auth", req });
  res.json({ ok: true });
});

export default router;
