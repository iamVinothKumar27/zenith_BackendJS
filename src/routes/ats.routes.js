import { Router } from "express";
import crypto from "crypto";
import { getDb } from "../config/mongo.js";
import { config } from "../config/env.js";
import { requireUser } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { extractPdfTextBytes, extractResumeText } from "../utils/pdfDocx.js";
import { getBucket } from "../utils/gridfs.js";
import { brandEmail, sendEmail } from "../utils/email.js";
import { buildTailoredResumeDocx } from "../utils/docxBuilder.js";
import {
  affindaParseResume,
  mergeResumeStructWithAffinda,
  pickWeakSections,
  geminiAtsSectionRewrites,
  cleanTextBasic,
  splitIntoSections,
  parseResumeStructured,
  parseJdStructured,
  computeMissingRequirements,
  computeAtsScoreStructured,
  computeAtsAnalytics,
  extractJdRequirements,
  resumeSectionsForGemini,
  geminiRequirementsAndImprovements,
  filterUnwantedKeywords,
  geminiJsonLenient,
} from "../utils/atsScoring.js";

const router = Router();

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function atsSessionsCol(db) {
  return db.collection("ats_sessions");
}

function atsSessionPublic(doc) {
  if (!doc) return null;
  return {
    session_id: doc.session_id,
    created_at: (doc.created_at || new Date()).toISOString(),
    updated_at: (doc.updated_at || doc.created_at || new Date()).toISOString(),
    company: doc.company || "",
    role: doc.role || "",
    title: doc.title || "",
    resume_filename: doc.resume_filename || "",
    jd_source: doc.jd_source || "",
    has_tailored: !!doc.tailored_sections,
    ats: doc.ats || {},
    analytics: doc.analytics || {},
  };
}

function buildGeminiTailorPrompt(jdText, resumeText, jdStruct, resumeStruct, atsStruct) {
  return `You are an ATS scoring engine + resume tailoring assistant.

You will be given:
- Job Description (JD) text
- Resume text
- Parsed structured signals (skills/projects/experience/education)
- A deterministic ATS score + matched/missing skills computed by our parser

TASKS:
1) Use the structured signals to produce an ATS score from 0-100 (can be same as deterministic score, or adjust slightly if justified).
2) Explain score briefly (2-4 lines).
3) Provide 10-12 prioritized improvements (bullet list).
4) Provide a tailored resume draft (TEXT) that the candidate can copy-paste:
   - Professional Summary (3-4 lines)
   - Skills (grouped)
   - Experience bullets (rewrite 6-10 bullets max, STAR + metrics placeholders)
   - Projects bullets (rewrite 4-6 bullets max)
   - Keep it truthful: DO NOT invent companies, degrees, or years not in the resume text.
   - You may rephrase existing work/projects and add missing keywords ONLY if they are reasonable to claim as "familiarity" (not years of experience).
Return ONLY JSON with keys:
ats_score, reasoning_summary, improvements, missing_skills_priority, tailored_resume_text

Deterministic signals (JSON):
JD_STRUCT=${JSON.stringify(jdStruct).slice(0, 12000)}
RESUME_STRUCT=${JSON.stringify(resumeStruct).slice(0, 12000)}
ATS_STRUCT=${JSON.stringify(atsStruct).slice(0, 12000)}

JD_TEXT:
${(jdText || "").slice(0, 12000)}

RESUME_TEXT:
${(resumeText || "").slice(0, 20000)}`;
}

router.post(
  "/ats/analyze",
  requireUser,
  upload.fields([{ name: "resume_file", maxCount: 1 }, { name: "jd_file", maxCount: 1 }]),
  async (req, res) => {
    const uid = req.user.uid;

    let resumeFile = null;
    let resumeRaw = null;
    let resumeKind = "text";
    let resumeText = "";
    let jdText = "";
    let jdFile = null;
    let company = "";
    let role = "";

    if (req.is("application/json")) {
      const payload = req.body || {};
      resumeText = (payload.resume_text || payload.resume || "").trim();
      jdText = (payload.jd_text || payload.jd || "").trim();
      company = (payload.company || "").trim();
      role = (payload.role || "").trim();

      if (!resumeText) return res.status(400).json({ error: "resume_text is required" });
      if (!jdText) return res.status(400).json({ error: "jd_text is required" });
    } else {
      resumeFile = req.files?.resume_file?.[0];
      if (!resumeFile) return res.status(400).json({ error: "resume_file is required" });
      const extracted = await extractResumeText(resumeFile);
      resumeText = extracted.text;
      resumeKind = extracted.kind;
      resumeRaw = extracted.data;
      if (!resumeText) return res.status(400).json({ error: "Could not extract text from resume PDF" });

      jdText = (req.body.jd_text || "").trim();
      jdFile = req.files?.jd_file?.[0];
      if (!jdText && jdFile) {
        jdText = await extractPdfTextBytes(jdFile.buffer || Buffer.alloc(0));
      }
      if (!jdText) return res.status(400).json({ error: "Provide jd_text or jd_file (PDF)" });

      company = (req.body.company || "").trim();
      role = (req.body.role || "").trim();
    }
    const title = company || role ? `${company}-${role}`.replace(/^-+|-+$/g, "").trim() || "ATS Session" : "ATS Session";

    let jdSource = "text";
    if (jdFile && jdFile.originalname) jdSource = `file:${jdFile.originalname}`;

    let resumeStruct = parseResumeStructured(resumeText);

    let aff = { ok: false };
    try {
      if (resumeRaw) aff = await affindaParseResume(resumeRaw, resumeFile?.originalname || "resume.pdf");
    } catch {
      aff = { ok: false };
    }
    resumeStruct = mergeResumeStructWithAffinda(resumeStruct, aff);

    const jdStruct = parseJdStructured(jdText);
    const atsStruct = computeAtsScoreStructured(jdStruct, resumeStruct);
    const analytics = computeAtsAnalytics(jdText, jdStruct, resumeStruct, atsStruct);

    const resumeSections = splitIntoSections(resumeText);
    const reqEval = await geminiRequirementsAndImprovements(jdText, resumeSectionsForGemini(resumeText));
    const missingRequirements = reqEval.missing_requirements || [];
    const reqImprovements = reqEval.improvements || [];

    let missingSkillsPriority = [];
    try {
      const msw = (analytics || {}).missing_skill_weights || [];
      if (msw.length) {
        const msw2 = msw
          .filter((it) => it && typeof it === "object")
          .map((it) => {
            const sk = it.skill || it.name || it.key;
            const wt = it.weight || it.freq || 1;
            return sk ? [String(sk), typeof wt === "number" ? wt : 1.0] : null;
          })
          .filter(Boolean);
        msw2.sort((a, b) => b[1] - a[1]);
        missingSkillsPriority = msw2.slice(0, 25).map((x) => x[0]);
      }
    } catch {
      missingSkillsPriority = [];
    }
    if (!missingSkillsPriority.length) {
      missingSkillsPriority = (atsStruct.missing_skills || []).slice(0, 25);
    }

    const weakSectionKeys = pickWeakSections(resumeSections, atsStruct, missingRequirements);

    const gem = (await geminiAtsSectionRewrites(jdText, resumeSections, missingSkillsPriority, weakSectionKeys)) || {};

    const tips = {};
    tips.missing_skills_priority = missingSkillsPriority;
    tips.missing_requirements = missingRequirements;
    tips.weak_sections = weakSectionKeys;

    tips.improvements = [];
    if (gem && Array.isArray(gem.improvements)) {
      tips.improvements = gem.improvements.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
    }
    if (!tips.improvements.length) {
      tips.improvements = (reqImprovements || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
    }
    if (!tips.improvements.length) {
      tips.improvements = [
        "Add missing JD keywords naturally inside your existing bullets (avoid keyword stuffing).",
        "Quantify impact in 2–4 key bullets (use concrete numbers: [X%], [N users], [latency], etc.).",
        "Strengthen the Skills section by grouping tools by category and including the top missing skills you can honestly claim as familiarity.",
      ];
    }

    tips.tailored_diff = [];
    if (gem && Array.isArray(gem.tailored_diff)) {
      const keyToTitle = { skills: "Skills", experience: "Experience", projects: "Projects", education: "Education" };
      const td = [];
      for (const b of gem.tailored_diff || []) {
        if (!b || typeof b !== "object") continue;
        const sec = (b.section || "").trim();
        const secNorm = sec.toLowerCase().trim();
        const secTitle = keyToTitle[secNorm] || sec || "Section";
        const oldc = (b.old_content || resumeSections[secNorm] || "").trim();
        const newc = (b.new_content || "").trim();
        if (!newc) continue;
        td.push({
          section: secTitle,
          replace_instruction: b.replace_instruction || `Replace your '${secTitle}' section with the NEW content below.`,
          old_content: oldc,
          new_content: newc,
        });
      }
      tips.tailored_diff = td;
    }

    if (!tips.tailored_diff.length) {
      const td = [];
      if (weakSectionKeys.includes("skills") && (resumeSections.skills || "").trim()) {
        const oldc = (resumeSections.skills || "").trim();
        const add = missingSkillsPriority.slice(0, 10).join(", ");
        let newc = oldc;
        if (add && !oldc.toLowerCase().includes(add.toLowerCase())) {
          newc = (oldc + "\n\nAdditional keywords to consider (only if truthful): " + add).trim();
        }
        td.push({
          section: "Skills",
          replace_instruction: "Update your Skills section by adding the NEW content below (only include what you can honestly claim).",
          old_content: oldc,
          new_content: newc,
        });
      }
      tips.tailored_diff = td;
    }

    const jdRequirements = [];
    const tailoredSections = tips.tailored_sections || {};

    const db = await getDb();
    const bucket = getBucket(db);
    let templateFileId = null;
    try {
      const templateBytes = resumeKind === "docx" ? resumeRaw : null;
      if (templateBytes) {
        templateFileId = await new Promise((resolve, reject) => {
          const uploadStream = bucket.openUploadStream(`template_${uid}_${Date.now()}.docx`, {
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          });
          uploadStream.on("error", reject);
          uploadStream.on("finish", () => resolve(uploadStream.id));
          uploadStream.end(templateBytes);
        });
      }
    } catch {
      templateFileId = null;
    }

    let sessionId = crypto.randomUUID();
    const now = new Date();
    const doc = {
      session_id: sessionId,
      uid,
      created_at: now,
      updated_at: now,
      company,
      role,
      title,
      resume_filename: resumeFile?.originalname || "",
      resume_kind: resumeKind,
      resume_text: resumeText.slice(0, 80_000),
      jd_text: jdText.slice(0, 80_000),
      jd_source: jdSource,
      parsed_resume: resumeStruct,
      parsed_jd: jdStruct,
      ats: atsStruct,
      analytics,
      tips,
      jd_requirements: jdRequirements,
      missing_requirements: missingRequirements,
      tailored_sections: tailoredSections,
      template_file_id: templateFileId,
    };
    try {
      await atsSessionsCol(db).insertOne(doc);
    } catch {
      sessionId = "";
    }

    try {
      let toEmail = (req.user.email || "").trim();
      if (!toEmail) {
        try {
          const udoc = uid ? await db.collection("users").findOne({ uid }) : null;
          toEmail = ((udoc || {}).email || "").trim();
        } catch {
          toEmail = "";
        }
      }

      if (toEmail) {
        const score = (atsStruct || {}).score;
        const coverage = (atsStruct || {}).coverage;
        const matched = (atsStruct || {}).matched_skills || [];
        const missing = (atsStruct || {}).missing_skills || [];
        const missReq = missingRequirements || [];

        const li = (items) => {
          const out = [];
          for (const x of items || []) {
            try {
              if (x && typeof x === "object") {
                let parts = [];
                for (const k of ["name", "skill", "requirement", "text", "title"]) {
                  if (x[k]) {
                    parts.push(String(x[k]));
                    break;
                  }
                }
                if (!parts.length) {
                  const kv = [];
                  for (const [k, v] of Object.entries(x).slice(0, 6)) {
                    if (v == null || v === "") continue;
                    kv.push(`${k}: ${v}`);
                  }
                  parts.push(kv.length ? kv.join("; ") : "—");
                }
                out.push(`<li>${escapeHtml(parts.join(" ").trim())}</li>`);
              } else {
                out.push(`<li>${escapeHtml(String(x))}</li>`);
              }
            } catch {
              out.push("<li>—</li>");
            }
          }
          return out.join("") || "<li>—</li>";
        };

        const liMissingRequirements = (items) => {
          const out = [];
          for (const x of items || []) {
            try {
              if (x && typeof x === "object") {
                const req_ = (x.requirement || x.text || x.title || "Requirement").trim() || "Requirement";
                const status = (x.status || "").trim();
                const sugg = (x.fix_suggestion || x.suggestion || "").trim();
                let line = `<strong>${escapeHtml(req_)}</strong>`;
                if (status) {
                  const st = status.toLowerCase();
                  const color = st.includes("miss") ? "#dc2626" : st.includes("met") || st.includes("pass") ? "#16a34a" : "#6b7280";
                  line += ` <span style="color:${color};font-weight:600;">(${escapeHtml(status)})</span>`;
                }
                if (sugg) {
                  line += `<div style="margin-top:4px;color:#374151;font-size:12px;line-height:1.35;">${escapeHtml(sugg)}</div>`;
                }
                out.push(`<li style="margin-bottom:10px;">${line}</li>`);
              } else {
                out.push(`<li>${escapeHtml(String(x))}</li>`);
              }
            } catch {
              out.push("<li>—</li>");
            }
          }
          return out.join("") || "<li>—</li>";
        };

        const cr = [company?.trim(), role?.trim()].filter(Boolean).join(" — ").trim();
        const mailTitle = "Zenith ATS Intelligence Report" + (cr ? ` — ${cr}` : "");
        const mailSubtitle =
          (company || role ? `Company: ${escapeHtml(company)} • Role: ${escapeHtml(role)}<br/>` : "") +
          `ATS Score: ${score != null ? score : "—"}/100 • Match: ${coverage != null ? coverage : "—"}%`;
        const mailSubject = "Zenith ATS Intelligence — " + (cr || "Your ATS Score & Match %");

        const bodyHtml = `
              <p style="margin:0 0 10px 0;">Here is your ATS evaluation summary.</p>
              <div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 16px 0;">
                <div style="padding:10px 12px;border:1px solid #e5e7eb;border-radius:14px;background:#ffffff;">
                  <div style="font-size:12px;color:#6b7280;">ATS Score</div>
                  <div style="font-size:18px;font-weight:700;color:#111827;">${score != null ? score : "—"}/100</div>
                </div>
                <div style="padding:10px 12px;border:1px solid #e5e7eb;border-radius:14px;background:#ffffff;">
                  <div style="font-size:12px;color:#6b7280;">Match</div>
                  <div style="font-size:18px;font-weight:700;color:#111827;">${coverage != null ? coverage : "—"}%</div>
                </div>
              </div>

              <h3 style="margin:14px 0 6px 0;font-size:14px;">Matched skills</h3>
              <ul style="margin:0 0 10px 18px;color:#111827;">${li(matched.slice(0, 30))}</ul>

              <h3 style="margin:14px 0 6px 0;font-size:14px;">Missing skills</h3>
              <ul style="margin:0 0 10px 18px;color:#111827;">${li(missing.slice(0, 30))}</ul>

              <h3 style="margin:14px 0 6px 0;font-size:14px;">Missing requirements (from JD)</h3>
              <ul style="margin:0 0 10px 18px;color:#111827;">${liMissingRequirements(missReq.slice(0, 20))}</ul>

              <p style="margin:14px 0 0 0;color:#6b7280;font-size:12px;">
                Tip: Add missing keywords naturally in your projects/experience bullets and keep the resume concise (1–2 pages).
              </p>
            `;

        const html = brandEmail({ title: mailTitle, subtitle: mailSubtitle, bodyHtml, ctaUrl: "/ats-intelligence", ctaText: "Open ATS Intelligence", req });

        sendEmail(toEmail, mailSubject, html, "", { kind: "ats", replyTo: config.contactInbox || config.adminEmail, req });
      }
    } catch (e) {
      console.log("[email] ATS report send failed:", e);
    }

    res.json({
      ok: true,
      session: sessionId ? atsSessionPublic(doc) : null,
      session_id: sessionId,
      ats: atsStruct,
      analytics,
      parsed_resume: resumeStruct,
      parsed_jd: jdStruct,
      tips,
      jd_requirements: jdRequirements,
      missing_requirements: missingRequirements,
    });
  }
);

router.get("/ats/sessions", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const db = await getDb();
  const col = atsSessionsCol(db);
  const items = await col.find({ uid }).sort({ created_at: -1 }).limit(100).toArray();
  res.json({ ok: true, sessions: items.map(atsSessionPublic) });
});

router.get("/ats/sessions/:sessionId", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const db = await getDb();
  const col = atsSessionsCol(db);
  const doc = await col.findOne({ uid, session_id: req.params.sessionId });
  if (!doc) return res.status(404).json({ error: "Session not found" });
  res.json({
    ok: true,
    session: atsSessionPublic(doc),
    parsed_resume: doc.parsed_resume || {},
    parsed_jd: doc.parsed_jd || {},
    ats: doc.ats || {},
    analytics: doc.analytics || {},
    tips: doc.tips || {},
  });
});

router.delete("/ats/sessions/:sessionId", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const db = await getDb();
  const col = atsSessionsCol(db);
  const doc = await col.findOne({ uid, session_id: req.params.sessionId });
  if (!doc) return res.status(404).json({ error: "Session not found" });

  try {
    const fid = doc.template_file_id;
    if (fid) {
      const bucket = getBucket(db);
      await bucket.delete(fid);
    }
  } catch {
    // ignore
  }

  await col.deleteOne({ uid, session_id: req.params.sessionId });
  res.json({ ok: true });
});

router.get("/ats/sessions/:sessionId/tailored_docx", requireUser, async (req, res) => {
  const uid = req.user.uid;
  const db = await getDb();
  const col = atsSessionsCol(db);
  const doc = await col.findOne({ uid, session_id: req.params.sessionId });
  if (!doc) return res.status(404).json({ error: "Session not found" });

  // Deviation: Python preserves the uploaded DOCX template in place (_docx_replace_section).
  // We always generate a fresh DOCX from the stored tailored_sections (see docxBuilder.js).
  const tailored = doc.tailored_sections || {};
  const safeTitle = (doc.title || "tailored_resume").trim().replace(/\//g, "-").replace(/\\/g, "-");
  const fname = `${safeTitle || "tailored_resume"}.docx`;

  const buffer = await buildTailoredResumeDocx(tailored, "TAILORED RESUME");
  res.set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.set("Content-Disposition", `attachment; filename="${fname}"`);
  res.send(buffer);
});

router.post(
  "/ats/tailor_docx",
  requireUser,
  upload.fields([{ name: "resume_file", maxCount: 1 }, { name: "jd_file", maxCount: 1 }]),
  async (req, res) => {
    const resumeFile = req.files?.resume_file?.[0];
    if (!resumeFile) return res.status(400).json({ error: "resume_file is required" });

    const jdFile = req.files?.jd_file?.[0];
    let jdText = (req.body.jd_text || "").trim();

    if (jdFile && !jdText) {
      jdText = await extractPdfTextBytes(jdFile.buffer || Buffer.alloc(0));
    }
    if (!jdText) return res.status(400).json({ error: "Provide jd_text or jd_file" });

    const { text: resumeText } = await extractResumeText(resumeFile);
    if (!resumeText) return res.status(400).json({ error: "Could not read resume. Upload a PDF or DOCX." });

    // NOTE: the Python route called undefined helpers here (_extract_jd_struct/_extract_resume_struct/
    // _compute_ats), which would raise a NameError at runtime — effectively dead/broken code upstream.
    // We use the equivalent working helpers (parseJdStructured/parseResumeStructured/computeAtsScoreStructured)
    // so this endpoint actually functions.
    const jdStruct = parseJdStructured(jdText);
    const resumeStruct = parseResumeStructured(resumeText);
    const atsStruct = computeAtsScoreStructured(jdStruct, resumeStruct);
    atsStruct.matched_skills = filterUnwantedKeywords(atsStruct.matched_skills || []);
    atsStruct.missing_skills = filterUnwantedKeywords(atsStruct.missing_skills || []);

    const prompt = buildGeminiTailorPrompt(jdText, resumeText, jdStruct, resumeStruct, atsStruct);
    const tips = await geminiJsonLenient(prompt);

    const tailored = (tips || {}).tailored_sections || {};

    const buffer = await buildTailoredResumeDocx(tailored, "TAILORED RESUME");
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.set("Content-Disposition", 'attachment; filename="tailored_resume.docx"');
    res.send(buffer);
  }
);

export default router;
