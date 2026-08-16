import express from "express";
import cors from "cors";

import { wrapRouterAsync } from "./utils/wrapAsync.js";
import { isQuotaError, extractRetryAfterSeconds } from "./utils/gemini.js";
import authRoutes from "./routes/auth.routes.js";
import contactRoutes from "./routes/contact.routes.js";
import profileRoutes from "./routes/profile.routes.js";
import coursesRoutes from "./routes/courses.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import contentRoutes from "./routes/content.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import pdfRoutes from "./routes/pdf.routes.js";
import interviewRoutes from "./routes/interview.routes.js";
import atsRoutes from "./routes/ats.routes.js";
import mocktestRoutes from "./routes/mocktest.routes.js";

const ALLOWED_ORIGINS = [
  "https://zenith.vinothkumarts.in",
  "https://zenith-frontend-red.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://www.zenithlearning.site",
  "https://zenith-frontend-js.vercel.app",
];

const app = express();

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  })
);

app.use(express.json({ limit: "10mb" }));

// Log every incoming request and how it was handled — method, path, uid (once auth middleware
// has set req.user), status code, and duration. Mirrors the original Flask app's verbose
// console output so what's happening server-side is visible without attaching a debugger.
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const uid = req.user?.uid ? ` uid=${req.user.uid}` : "";
    console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(0)}ms)${uid}`);
  });
  next();
});

const routers = [
  authRoutes,
  contactRoutes,
  profileRoutes,
  coursesRoutes,
  adminRoutes,
  contentRoutes,
  chatRoutes,
  pdfRoutes,
  interviewRoutes,
  atsRoutes,
  mocktestRoutes,
];
for (const router of routers) {
  app.use(wrapRouterAsync(router));
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "zenith-backend" });
});

// Catch-all error handler: any rejected promise/thrown error from a route handler ends up
// here as a response instead of crashing the process (see wrapRouterAsync above).
//
// This is also the last-resort safety net for API quota/rate-limit errors (Gemini, YouTube,
// Supadata, etc.) from any route that doesn't already have its own bespoke handling — routes
// that call isQuotaError() themselves and respond directly never reach this point, so this
// only fires for spots that would otherwise leak a raw SDK error message (e.g. a scary
// "[GoogleGenerativeAI Error]: ... 429 Too Many Requests ..." string) straight to the UI.
app.use((err, req, res, next) => {
  console.error("[REQUEST ERROR]", err);
  if (res.headersSent) return next(err);

  if (isQuotaError(err)) {
    const payload = {
      error: "The AI service has hit its usage limit for now. Please try again in a little while.",
      code: "quota_exceeded",
    };
    const retryAfter = extractRetryAfterSeconds(err?.message || String(err));
    if (retryAfter !== null) payload.retry_after = retryAfter;
    return res.status(429).json(payload);
  }

  res.status(500).json({ error: err?.message || String(err) });
});

export default app;
