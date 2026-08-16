import nodemailer from "nodemailer";
import axios from "axios";
import { config } from "../config/env.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function smtpReady() {
  return !!(config.smtpHost && config.smtpPort && config.smtpUser && config.smtpPass);
}

function mailgunReady() {
  return !!(config.mailgunApiKey && config.mailgunDomain);
}

export function pickFrom(kind = "") {
  const k = (kind || "").trim().toLowerCase();
  if (["auth", "authentication", "login"].includes(k)) return config.mailFromAuth || config.mailFromDefault;
  if (["courses", "course", "quiz"].includes(k)) return config.mailFromCourses || config.mailFromDefault;
  if (["profile"].includes(k)) return config.mailFromProfile || config.mailFromDefault;
  if (["admin"].includes(k)) return config.mailFromAdmin || config.mailFromDefault;
  if (["contact"].includes(k)) return config.mailFromContact || config.mailFromDefault;
  if (["mocktest", "mock-tests", "tests", "mock_test", "practicetest", "practice_test"].includes(k))
    return config.mailFromMocktest || config.mailFromDefault;
  if (["ats", "ats-intelligence", "ats_intelligence"].includes(k)) return config.mailFromAts || config.mailFromDefault;
  return config.mailFromDefault || config.smtpUser;
}

export function pickSenderName(kind = "") {
  const k = (kind || "").trim().toLowerCase();
  if (["auth", "authentication", "login"].includes(k)) return "zenith-authentication";
  if (["courses", "course", "quiz"].includes(k)) return "zenith-courses";
  if (["profile"].includes(k)) return "zenith-profile";
  if (["admin"].includes(k)) return "zenith-admin";
  if (["contact"].includes(k)) return "zenith-contact";
  if (["mocktest", "mock-tests", "tests", "mock_test", "practicetest", "practice_test"].includes(k)) return "zenith-tests";
  if (["ats", "ats-intelligence", "ats_intelligence"].includes(k)) return "zenith-ats";
  return "zenith-learning";
}

export function sanitizeTestNameForEmail(name, { isPractice = false } = {}) {
  let raw = String(name || "").trim();
  if (!raw) return isPractice ? "Practice Test" : "Mock Test";
  if (isPractice) {
    raw = raw.replace(/\bproctoring\b/gi, "");
    raw = raw.replace(/\s{2,}/g, " ").trim();
    raw = raw.replace(/^[\s\-•_]+|[\s\-•_]+$/g, "");
    return raw || "Practice Test";
  }
  return raw;
}

function formatProctoringWarningItem(item) {
  if (item && typeof item === "object") {
    const msg = String(item.message || item.warning || item.type || "Warning recorded").trim();
    const at = String(item.at_ist || item.at || item.time || "").trim();
    return at ? `${msg} (${at})` : msg;
  }
  return String(item ?? "").trim();
}

function formatProctoringEventItem(item) {
  if (item && typeof item === "object") {
    const msg = String(item.message || item.warning || item.type || "Violation recorded").trim();
    const at = String(item.at_ist || item.at || item.time || "").trim();
    return [msg, at];
  }
  return [String(item ?? "").trim(), ""];
}

export function proctoringDetailsHtml(proctoring) {
  const p = proctoring && typeof proctoring === "object" ? proctoring : {};
  if (!p || !p.enabled) return "";

  const violations = parseInt(p.violations, 10) || 0;
  const limit = parseInt(p.violation_limit, 10) || 0;
  const warnings = (p.warnings || []).map(formatProctoringWarningItem).filter(Boolean);
  const events = p.events || [];
  const reason = String(p.auto_submit_reason || "").trim();

  const eventLines = [];
  for (const ev of events.slice(-5)) {
    const [msg, at] = formatProctoringEventItem(ev);
    if (!msg) continue;
    let line = escapeHtml(msg);
    if (at) line += ` <span style='color:#6b7280;'>(at ${escapeHtml(at)})</span>`;
    eventLines.push(`<li>${line}</li>`);
  }

  const parts = [
    "<hr/>",
    "<p><b>\u{1F6E1}️ Proctoring Details</b></p>",
    `<ul><li><b>Violations:</b> ${violations}/${limit || 3}</li>` +
      (p.auto_submitted ? `<li><b>Status:</b> Auto-submitted</li>` : "<li><b>Status:</b> Completed without auto-submit</li>") +
      (reason ? `<li><b>Reason:</b> ${escapeHtml(reason)}</li>` : "") +
      "</ul>",
  ];
  if (warnings.length) {
    parts.push("<p><b>Warnings</b></p><ul>" + warnings.slice(-5).map((w) => `<li>${escapeHtml(w)}</li>`).join("") + "</ul>");
  }
  if (eventLines.length) {
    parts.push("<p><b>Recent Proctoring Events</b></p><ul>" + eventLines.join("") + "</ul>");
  }
  return parts.join("");
}

export function proctoringDetailsText(proctoring) {
  const p = proctoring && typeof proctoring === "object" ? proctoring : {};
  if (!p || !p.enabled) return "";
  const violations = parseInt(p.violations, 10) || 0;
  const limit = parseInt(p.violation_limit, 10) || 0;
  const warnings = (p.warnings || []).map(formatProctoringWarningItem).filter(Boolean);
  const events = p.events || [];
  const reason = String(p.auto_submit_reason || "").trim();
  const lines = [
    "",
    "Proctoring Details:",
    `Violations: ${violations}/${limit || 3}`,
    `Status: ${p.auto_submitted ? "Auto-submitted" : "Completed without auto-submit"}`,
  ];
  if (reason) lines.push(`Reason: ${reason}`);
  if (warnings.length) {
    lines.push("Warnings:");
    lines.push(...warnings.slice(-5).map((w) => `- ${w}`));
  }
  if (events.length) {
    lines.push("Recent Proctoring Events:");
    for (const ev of events.slice(-5)) {
      const [msg, at] = formatProctoringEventItem(ev);
      if (!msg) continue;
      lines.push(`- ${msg}` + (at ? ` (at ${at})` : ""));
    }
  }
  return lines.join("\n");
}

function isLocalDev(req) {
  try {
    const host = (req?.headers?.host || "").toLowerCase();
    if (host.startsWith("127.0.0.1") || host.startsWith("localhost")) return true;
  } catch {}
  const env = (config.appEnv || config.flaskEnv || "").toLowerCase();
  if (["dev", "development", "local"].includes(env)) return true;
  const web = (config.frontendBaseUrl || config.publicBaseUrl || "").toLowerCase();
  if (web.includes("localhost") || web.includes("127.0.0.1")) return true;
  if (config.isRender || config.isVercel || config.railwayStaticUrl || config.flyAppName) return false;
  return false;
}

function isRenderEnv() {
  return !!(config.isRender || config.renderServiceId || config.renderExternalUrl || config.renderInstanceId);
}

function preferredMailProvider(req) {
  const override = (config.mailProvider || "").toLowerCase();
  if (["smtp", "mailgun", "sendgrid"].includes(override)) return override;
  if (["1", "true", "yes"].includes((config.useMailgun || "").toLowerCase())) {
    return mailgunReady() ? "mailgun" : "smtp";
  }
  if (isLocalDev(req)) return "smtp";
  if (mailgunReady()) return "mailgun";
  if (config.sendgridApiKey) return "sendgrid";
  return "smtp";
}

async function sendEmailSyncSmtp(toEmail, subject, htmlBody, textBody = "", { kind = "", fromEmail, replyTo } = {}) {
  if (!toEmail) return false;
  if (!smtpReady()) {
    console.log("[MAIL] SMTP not configured. Skipping send to:", toEmail, "subject:", subject);
    return false;
  }
  const sender = (fromEmail || config.mailFromDefault || config.smtpUser).trim();

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    connectionTimeout: (config.smtpTimeout || 8) * 1000,
  });

  try {
    await transporter.sendMail({
      from: `"${pickSenderName(kind)}" <${sender}>`,
      to: toEmail,
      subject,
      text: textBody || undefined,
      html: htmlBody,
      replyTo: replyTo || undefined,
    });
    console.log("[MAIL] SMTP Sent:", subject, "->", toEmail, "| from:", sender);
    return true;
  } catch (e) {
    console.log("[MAIL] SMTP Send failed:", e.message || e);
    return false;
  }
}

async function sendEmailSyncSendgrid(toEmail, subject, htmlBody, textBody = "", { kind = "" } = {}) {
  const apiKey = config.sendgridApiKey;
  if (!apiKey) return false;
  const fromEmail = config.sendgridFrom || config.mailFromDefault;
  if (!fromEmail) return false;

  const payload = {
    personalizations: [{ to: [{ email: toEmail }], subject }],
    from: { email: fromEmail, name: pickSenderName(kind) },
    content: [
      { type: "text/plain", value: textBody || " " },
      { type: "text/html", value: htmlBody },
    ],
  };
  try {
    const r = await axios.post("https://api.sendgrid.com/v3/mail/send", payload, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (r.status >= 200 && r.status < 300) {
      console.log("[MAIL] SendGrid accepted:", subject, "->", toEmail);
      return true;
    }
    console.log("[MAIL] SendGrid failed:", r.status, r.data);
    return false;
  } catch (e) {
    console.log("[MAIL] SendGrid send failed:", e.message || e);
    return false;
  }
}

async function sendEmailSyncMailgun(toEmail, subject, htmlBody, textBody = "", { kind = "", fromEmail, replyTo } = {}) {
  const apiKey = config.mailgunApiKey;
  const domain = config.mailgunDomain;
  if (!apiKey || !domain) return false;

  const baseUrl = (config.mailgunBaseUrl || "https://api.mailgun.net").replace(/\/$/, "");
  const endpoint = baseUrl.endsWith("/v3") ? `${baseUrl}/${domain}/messages` : `${baseUrl}/v3/${domain}/messages`;

  const from = (fromEmail || config.mailgunFrom || config.mailFromDefault || config.smtpUser || "").trim();
  if (!from) return false;

  const params = new URLSearchParams();
  params.append("from", `${pickSenderName(kind)} <${from}>`);
  params.append("to", toEmail);
  params.append("subject", subject);
  params.append("text", textBody || " ");
  params.append("html", htmlBody);
  if (replyTo) params.append("h:Reply-To", replyTo);

  try {
    const r = await axios.post(endpoint, params, {
      auth: { username: "api", password: apiKey },
      timeout: 10000,
      validateStatus: () => true,
    });
    if (r.status >= 200 && r.status < 300) {
      console.log("[MAIL] Mailgun accepted:", subject, "->", toEmail);
      return true;
    }
    console.log("[MAIL] Mailgun failed:", r.status, r.data);
    return false;
  } catch (e) {
    console.log("[MAIL] Mailgun send failed:", e.message || e);
    return false;
  }
}

/** Fire-and-forget email send (SMTP/Mailgun/SendGrid, mirrors Python provider fallback chain). */
export function sendEmail(toEmail, subject, htmlBody, textBody = "", { kind = "", fromEmail, replyTo, req } = {}) {
  if (!toEmail) return false;
  const from = fromEmail || pickFrom(kind);

  (async () => {
    let provider = preferredMailProvider(req);

    if (provider === "sendgrid") {
      if (await sendEmailSyncSendgrid(toEmail, subject, htmlBody, textBody, { kind })) return;
      provider = mailgunReady() ? "mailgun" : "smtp";
    }
    if (provider === "mailgun") {
      if (await sendEmailSyncMailgun(toEmail, subject, htmlBody, textBody, { kind, fromEmail: from, replyTo })) return;
      provider = "smtp";
    }
    await sendEmailSyncSmtp(toEmail, subject, htmlBody, textBody, { kind, fromEmail: from, replyTo });
  })().catch((e) => console.log("[MAIL] send job failed:", e.message || e));

  return true;
}

export function safePublicUrl(path, req) {
  let base = (config.frontendBaseUrl || "").trim();
  if (!base) {
    try {
      const origin = (req?.headers?.origin || "").trim().replace(/\/$/, "");
      if (origin) base = origin;
    } catch {}
  }
  const p = path.startsWith("/") ? path : "/" + path;
  return base ? base + p : p;
}

export function brandEmail({
  title,
  preheader = "",
  bodyHtml = "",
  primaryCta = null,
  secondaryCta = null,
  subtitle = "",
  ctaUrl = "",
  ctaText = "",
  cta2Url = "",
  cta2Text = "",
  kind = "",
  req,
} = {}) {
  try {
    if (!primaryCta && ctaUrl && ctaText) {
      let u = (ctaUrl || "").trim();
      if (u.startsWith("/")) u = safePublicUrl(u, req);
      primaryCta = { url: u, label: ctaText };
    }
    if (!secondaryCta && cta2Url && cta2Text) {
      let u2 = (cta2Url || "").trim();
      if (u2.startsWith("/")) u2 = safePublicUrl(u2, req);
      secondaryCta = { url: u2, label: cta2Text };
    }
  } catch {}

  const visibleSubtitle = (subtitle || preheader || "").trim();
  const hiddenPreheader = (preheader || subtitle || "").trim();
  const logoText = pickSenderName(kind);
  const year = new Date().getFullYear();

  let primaryBtn = "";
  if (primaryCta?.url && primaryCta?.label) {
    primaryBtn = `
        <a href="${primaryCta.url}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:700;font-size:14px;">
          ${primaryCta.label}
        </a>`;
  }
  let secondaryBtn = "";
  if (secondaryCta?.url && secondaryCta?.label) {
    secondaryBtn = `
        <a href="${secondaryCta.url}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:700;font-size:14px;">
          ${secondaryCta.label}
        </a>`;
  }

  let ctaRow = "";
  if (primaryBtn || secondaryBtn) {
    ctaRow = `<tr><td style='padding:12px 24px 22px 24px;'>${primaryBtn} &nbsp; ${secondaryBtn}</td></tr>`;
  }

  const primaryUrl = primaryCta?.url || "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f7fb;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${hiddenPreheader}</div>

    <table width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7fb;padding:28px 10px;">
      <tr>
        <td align="center">
          <table width="640" cellspacing="0" cellpadding="0" style="background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(17,24,39,0.08);">
            <tr>
              <td style="background:linear-gradient(135deg,#0ea5e9,#2563eb);padding:22px 24px;">
                <div style="font-size:16px;font-weight:800;color:#ffffff;letter-spacing:0.2px;">${logoText}</div>
                <div style="font-size:12px;color:rgba(255,255,255,0.9);margin-top:4px;">Smart learning • Roadmaps • Quizzes • Progress</div>
              </td>
            </tr>

            <tr>
              <td style="padding:26px 24px 6px 24px;">
                <div style="font-size:20px;font-weight:800;line-height:1.25;">${title}</div>
                <div style="font-size:13px;color:#6b7280;margin-top:8px;">${visibleSubtitle}</div>
              </td>
            </tr>

            <tr>
              <td style="padding:10px 24px 6px 24px;font-size:14px;line-height:1.65;color:#111827;">
                ${bodyHtml}
              </td>
            </tr>

            ${ctaRow}

            <tr>
              <td style="padding:0 24px 22px 24px;">
                <div style="border-top:1px solid #e5e7eb;padding-top:14px;font-size:12px;color:#6b7280;line-height:1.6;">
                  Need help? Reply to this email or contact our team from the <b>Contact</b> page in the app.<br/>
                  <span style="color:#9ca3af;">© ${year} ${logoText}. All rights reserved.</span>
                </div>
              </td>
            </tr>
          </table>

          <div style="width:640px;font-size:12px;color:#9ca3af;line-height:1.5;margin-top:10px;text-align:center;">
            If the button doesn't work, copy and paste this link in your browser:<br/>
            <span style="word-break:break-all;">${primaryUrl}</span>
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
