import { Router } from "express";
import { config } from "../config/env.js";
import { brandEmail, sendEmail, safePublicUrl } from "../utils/email.js";

const router = Router();

router.post("/contact", async (req, res) => {
  const data = req.body || {};
  const name = (data.name || "").trim();
  const email = (data.email || "").trim();
  const subject = (data.subject || "Contact request").trim();
  const message = (data.message || "").trim();

  if (!name || !email || !message) {
    return res.status(400).json({ error: "name, email and message are required" });
  }

  const adminSubject = `[Zenith Contact] ${subject}`;
  const bodyAdmin = `
    <p style="margin:0 0 10px 0;">You received a new message from the Zenith Contact form.</p>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 10px;border:1px solid #e5e7eb;"><b>Name</b></td><td style="padding:6px 10px;border:1px solid #e5e7eb;">${name}</td></tr>
      <tr><td style="padding:6px 10px;border:1px solid #e5e7eb;"><b>Email</b></td><td style="padding:6px 10px;border:1px solid #e5e7eb;">${email}</td></tr>
      <tr><td style="padding:6px 10px;border:1px solid #e5e7eb;"><b>Subject</b></td><td style="padding:6px 10px;border:1px solid #e5e7eb;">${subject}</td></tr>
    </table>
    <p style="margin:12px 0 6px 0;"><b>Message:</b></p>
    <div style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:12px;">${message}</div>
    `;
  const htmlAdmin = brandEmail({
    title: "New Contact Form Message",
    preheader: "A user submitted a message via the Contact page.",
    bodyHtml: bodyAdmin,
    primaryCta: { label: "Open Zenith", url: safePublicUrl("/", req) },
    kind: "contact",
    req,
  });
  sendEmail(config.contactInbox || "contact@zenithlearning.site", adminSubject, htmlAdmin, "", { kind: "contact", replyTo: email, req });

  const bodyUser = `
    <p style="margin:0 0 10px 0;">Hi <b>${name}</b>,</p>
    <p style="margin:0 0 10px 0;">
      Thanks for reaching out to <b>Zenith Learning</b>. We've received your message and our team will respond as soon as possible.
    </p>
    `;
  const htmlUser = brandEmail({
    title: "We received your message",
    preheader: "Thanks for contacting Zenith Learning — we'll reply soon.",
    bodyHtml: bodyUser,
    primaryCta: { label: "Back to Zenith", url: safePublicUrl("/", req) },
    kind: "contact",
    req,
  });
  sendEmail(email, "Zenith Learning — We received your message", htmlUser, "", { kind: "contact", req });

  res.json({ ok: true });
});

export default router;
