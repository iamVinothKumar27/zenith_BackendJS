import { Router } from "express";
import path from "path";
import { ObjectId } from "mongodb";
import { getDb } from "../config/mongo.js";
import { requireUser } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { brandEmail, sendEmail, safePublicUrl } from "../utils/email.js";
import { nowIstStr } from "../utils/dates.js";
import { getBucket } from "../utils/gridfs.js";

const router = Router();

const PROFILE_FIELD_LABELS = {
  name: "Name",
  dob: "Date of Birth",
  education: "Education",
  college: "College",
  degree: "Degree",
  department: "Department",
  yearBatch: "Batch / Year",
  year: "Year",
  phone: "Phone",
  location: "Location",
  bio: "Bio",
  photoURL: "Profile Photo (URL)",
  photoLocalURL: "Profile Photo",
};

const ALLOWED_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function normProfileVal(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  return String(v).trim();
}

function profileChangeRows(before, afterPartial) {
  const rows = [];
  before = before || {};
  for (const [k, newV] of Object.entries(afterPartial || {})) {
    if (k === "updatedAt") continue;
    const oldV = normProfileVal(before[k] ?? "");
    const newVn = normProfileVal(newV);
    if (oldV === newVn) continue;

    let change;
    if (oldV && !newVn) change = "Deleted";
    else if (!oldV && newVn) change = "Added";
    else change = "Updated";

    rows.push({ field: k, label: PROFILE_FIELD_LABELS[k] || k, change, old: oldV, new: newVn });
  }
  return rows;
}

function sendProfileUpdateEmail({ toEmail, name, rows, whenIst, ctaUrl = "", req }) {
  if (!toEmail || !rows.length) return;

  let trHtml = "";
  for (const r of rows) {
    let newDisp = r.change !== "Deleted" ? r.new : "—";
    if (r.field === "bio" && newDisp.length > 140) {
      newDisp = newDisp.slice(0, 140).trimEnd() + "…";
    }
    if (r.field === "photoLocalURL" || r.field === "photoURL") {
      newDisp = r.change === "Deleted" ? "Removed" : "Updated";
    }
    trHtml += `
        <tr>
          <td style="padding:8px 10px;border:1px solid #e5e7eb;"><b>${r.label}</b></td>
          <td style="padding:8px 10px;border:1px solid #e5e7eb;">${r.change}</td>
          <td style="padding:8px 10px;border:1px solid #e5e7eb;word-break:break-word;">${newDisp}</td>
        </tr>
        `;
  }

  const body = `
    <p style="margin:0 0 10px 0;">Hi <b>${(name || "there").trim()}</b>,</p>
    <p style="margin:0 0 12px 0;">Your Zenith profile was updated on <b>${whenIst}</b>. Here's what changed:</p>

    <table style="border-collapse:collapse;font-size:14px;width:100%;max-width:560px;">
      <tr>
        <td style="padding:8px 10px;border:1px solid #e5e7eb;background:#f9fafb;"><b>Field</b></td>
        <td style="padding:8px 10px;border:1px solid #e5e7eb;background:#f9fafb;"><b>Change</b></td>
        <td style="padding:8px 10px;border:1px solid #e5e7eb;background:#f9fafb;"><b>New value</b></td>
      </tr>
      ${trHtml}
    </table>

    <p style="margin:14px 0 0 0;color:#6b7280;font-size:13px;">
      If you didn't make this change, please reset your password and contact support.
    </p>
    `;

  const html = brandEmail({
    title: "Profile updated",
    preheader: "Your Zenith profile details were updated.",
    bodyHtml: body,
    primaryCta: { label: "Open Profile", url: ctaUrl || safePublicUrl("/profile", req) },
    kind: "profile",
    req,
  });
  sendEmail(toEmail, "Zenith Learning — Profile updated", html, "", { kind: "profile", req });
}

router.get("/profile/me", requireUser, async (req, res) => {
  const db = await getDb();
  const doc = (await db.collection("users").findOne({ uid: req.user.uid }, { projection: { _id: 0 } })) || {};

  const authPhotoUrl = (req.user.picture || req.user.photoURL || "").trim();
  const avatarFileId = String(doc.avatarFileId || "").trim();
  if (!avatarFileId) {
    doc.photoLocalURL = "";
    if (authPhotoUrl) doc.photoURL = (doc.photoURL || authPhotoUrl).trim();
  }
  doc.authPhotoURL = authPhotoUrl;
  res.json({ ok: true, user: doc });
});

router.post("/profile/me", requireUser, async (req, res) => {
  const data = req.body || {};
  const allowed = ["name", "dob", "education", "college", "degree", "department", "yearBatch", "year", "phone", "location", "bio", "photoURL", "photoLocalURL"];
  const update = {};
  for (const k of allowed) {
    if (k in data) update[k] = data[k] ?? "";
  }
  for (const k of Object.keys(update)) {
    if (typeof update[k] === "string") update[k] = update[k].trim();
  }
  if (update.year && !update.yearBatch) update.yearBatch = update.year;
  update.name = (update.name || "").trim();

  const db = await getDb();
  const uid = req.user.uid;

  const before = (await db.collection("users").findOne({ uid }, { projection: { _id: 0 } })) || {};
  const rows = profileChangeRows(before, update);

  const now = new Date();
  update.updatedAt = now;

  await db.collection("users").updateOne({ uid }, { $set: update }, { upsert: true });
  const doc = await db.collection("users").findOne({ uid }, { projection: { _id: 0 } });

  try {
    const toEmail = (req.user.email || doc?.email || before.email || "").trim();
    const displayName = doc?.name || update.name || before.name || "";
    if (toEmail && rows.length) {
      sendProfileUpdateEmail({ toEmail, name: displayName, rows, whenIst: nowIstStr(), ctaUrl: safePublicUrl("/profile", req), req });
    }
  } catch (e) {
    console.log("[MAIL] profile update email failed:", e.message || e);
  }

  res.json({ ok: true, user: doc });
});

function profileAvatarUrl(req, uid) {
  const host = `${req.protocol}://${req.get("host")}`;
  return `${host}/profile/photo/${uid}`;
}

router.get("/profile/photo/:uid", async (req, res) => {
  const db = await getDb();
  const bucket = getBucket(db);
  const uid = req.params.uid;

  const userDoc = (await db.collection("users").findOne({ uid }, { projection: { _id: 0, avatarFileId: 1 } })) || {};
  const fid = userDoc.avatarFileId;
  if (fid) {
    try {
      const files = await bucket.find({ _id: new ObjectId(fid) }).toArray();
      if (files.length) {
        const ct = files[0].contentType || "application/octet-stream";
        res.set("Content-Type", ct);
        res.set("Cache-Control", "no-store");
        bucket.openDownloadStream(new ObjectId(fid)).pipe(res);
        return;
      }
    } catch {
      // fall through
    }
  }

  return res.status(404).json({ error: "photo not found" });
});

router.post("/profile/photo", requireUser, upload.single("photo"), async (req, res) => {
  const f = req.file;
  if (!f || !f.originalname) return res.status(400).json({ error: "photo file missing" });

  const db = await getDb();
  const bucket = getBucket(db);
  const uid = req.user.uid;

  let ext = path.extname(f.originalname).toLowerCase();
  if (!ext) {
    const mt = (f.mimetype || "").toLowerCase();
    if (mt.includes("jpeg") || mt.includes("jpg")) ext = ".jpg";
    else if (mt.includes("png")) ext = ".png";
    else if (mt.includes("webp")) ext = ".webp";
  }
  if (!ALLOWED_IMAGE_EXTS.has(ext)) return res.status(400).json({ error: "Only JPG / PNG / WEBP allowed" });

  const current = (await db.collection("users").findOne({ uid }, { projection: { _id: 0, avatarFileId: 1, photoLocalURL: 1, email: 1, name: 1 } })) || {};

  const oldFid = current.avatarFileId;
  if (oldFid) {
    try {
      await bucket.delete(new ObjectId(oldFid));
    } catch {
      // ignore
    }
  }

  const contentType = (f.mimetype || "").trim() || "application/octet-stream";
  const fileId = await new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(`avatar_${uid}${ext}`, { contentType });
    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(uploadStream.id));
    uploadStream.end(f.buffer);
  });
  const publicUrl = profileAvatarUrl(req, uid);

  const now = new Date();
  await db.collection("users").updateOne(
    { uid },
    { $set: { avatarFileId: String(fileId), photoLocalURL: publicUrl, photoURL: "", updatedAt: now } },
    { upsert: true }
  );

  const doc = (await db.collection("users").findOne({ uid }, { projection: { _id: 0 } })) || {};

  try {
    const rows = profileChangeRows(current, { photoLocalURL: publicUrl });
    const toEmail = (req.user.email || doc.email || current.email || "").trim();
    const displayName = (doc.name || current.name || req.user.name || "").trim();
    if (toEmail && rows.length) {
      sendProfileUpdateEmail({ toEmail, name: displayName, rows, whenIst: nowIstStr(), ctaUrl: safePublicUrl("/profile", req), req });
    }
  } catch (e) {
    console.log("[MAIL] profile photo upload email failed:", e.message || e);
  }

  res.json({ ok: true, user: doc });
});

router.delete("/profile/photo", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const db = await getDb();
  const bucket = getBucket(db);

  const current = (await db.collection("users").findOne({ uid }, { projection: { _id: 0, avatarFileId: 1, photoLocalURL: 1, email: 1, name: 1 } })) || {};

  const oldFid = current.avatarFileId;
  if (oldFid) {
    try {
      await bucket.delete(new ObjectId(oldFid));
    } catch {
      // ignore
    }
  }

  const now = new Date();
  const fallbackPhotoUrl = (req.user.picture || req.user.photoURL || "").trim();
  await db.collection("users").updateOne(
    { uid },
    { $set: { photoLocalURL: "", photoURL: fallbackPhotoUrl, avatarFileId: "", updatedAt: now } },
    { upsert: true }
  );

  const doc = (await db.collection("users").findOne({ uid }, { projection: { _id: 0 } })) || {};

  try {
    const rows = profileChangeRows(current, { photoLocalURL: "" });
    const toEmail = (req.user.email || doc.email || current.email || "").trim();
    const displayName = (doc.name || current.name || req.user.name || "").trim();
    if (toEmail && rows.length) {
      sendProfileUpdateEmail({ toEmail, name: displayName, rows, whenIst: nowIstStr(), ctaUrl: safePublicUrl("/profile", req), req });
    }
  } catch (e) {
    console.log("[MAIL] profile photo delete email failed:", e.message || e);
  }

  res.json({ ok: true, user: doc });
});

export default router;
