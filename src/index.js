import app from "./app.js";
import { config } from "./config/env.js";

// Last-resort safety net: log instead of crashing the whole process on an error that
// somehow escapes app.js's per-request handling (e.g. code outside the request/response
// cycle, like a fire-and-forget background task). A single failed request should never
// take the entire server down for every user.
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

app.listen(config.port, () => {
  console.log(`Zenith backend listening on port ${config.port}`);
  const mailOverride = (config.mailProvider || "").trim();
  const smtpReady = !!(config.smtpHost && config.smtpPort && config.smtpUser && config.smtpPass);
  const mailgunReady = !!(config.mailgunApiKey && config.mailgunDomain);
  console.log(
    `[MAIL] provider override=${mailOverride || "(none, auto-detected per request)"} | smtpReady=${smtpReady} | mailgunReady=${mailgunReady} | sendgridReady=${!!config.sendgridApiKey}`
  );
});
