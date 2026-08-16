import dotenv from "dotenv";
dotenv.config();

const env = (key, fallback = "") => (process.env[key] ?? fallback).toString().trim();

export const config = {
  port: parseInt(env("PORT", "5000"), 10),

  mongodbUri: env("MONGODB_URI"),
  mongodbDb: env("MONGODB_DB", "zenith"),

  firebaseServiceAccountPath: env("FIREBASE_SERVICE_ACCOUNT_PATH"),
  firebaseServiceAccountJson: env("FIREBASE_SERVICE_ACCOUNT_JSON"),

  googleApiKey: env("GOOGLE_API_KEY"),
  geminiMindmapModel: env("GEMINI_MINDMAP_MODEL", "gemini-3.5-flash"),
  youtubeApiKey: env("YOUTUBE_API_KEY"),
  supadataKey: env("SUPADATA_KEY"),

  passwordPepper: env("PASSWORD_PEPPER"),

  smtpHost: env("SMTP_HOST"),
  smtpPort: parseInt(env("SMTP_PORT", "587"), 10),
  smtpUser: env("SMTP_USER"),
  smtpPass: env("SMTP_PASS"),
  smtpTimeout: parseInt(env("SMTP_TIMEOUT", "20"), 10),

  mailFromDefault: env("MAIL_FROM_DEFAULT") || env("MAIL_FROM") || env("SMTP_FROM") || env("SMTP_USER"),
  mailFromAuth: env("MAIL_FROM_AUTH") || "authentication@zenithlearning.site",
  mailFromCourses: env("MAIL_FROM_COURSES") || "courses@zenithlearning.site",
  mailFromProfile: env("MAIL_FROM_PROFILE") || "profile@zenithlearning.site",
  mailFromAdmin: env("MAIL_FROM_ADMIN") || "admin@zenithlearning.site",
  mailFromContact: env("MAIL_FROM_CONTACT") || "contact@zenithlearning.site",
  mailFromMocktest: env("MAIL_FROM_MOCKTEST") || env("MAIL_FROM_TESTS") || "zenith-tests@zenithlearning.site",
  mailFromAts: env("MAIL_FROM_ATS") || env("MAIL_FROM_ATS_INTELLIGENCE") || "ats-intelligence@zenithlearning.site",

  sendgridApiKey: env("SENDGRID_API_KEY"),
  sendgridFrom: env("SENDGRID_FROM"),

  mailgunApiKey: env("MAILGUN_API_KEY"),
  mailgunDomain: env("MAILGUN_DOMAIN"),
  mailgunBaseUrl: env("MAILGUN_BASE_URL", "https://api.mailgun.net/v3"),
  mailgunFrom: env("MAILGUN_FROM"),
  useMailgun: env("USE_MAILGUN"),
  mailProvider: env("MAIL_PROVIDER"),

  frontendBaseUrl: (env("FRONTEND_BASE_URL") || env("FRONTEND_URL")).replace(/\/$/, ""),
  publicBaseUrl: env("PUBLIC_BASE_URL"),

  adminEmail: env("ADMIN_EMAIL", "admin@zenithlearning.site"),
  adminEmails: env("ADMIN_EMAILS"),
  contactInbox: env("CONTACT_INBOX"),

  appEnv: env("APP_ENV"),
  flaskEnv: env("FLASK_ENV"),
  isRender: !!env("RENDER"),
  renderExternalUrl: env("RENDER_EXTERNAL_URL"),
  renderServiceId: env("RENDER_SERVICE_ID"),
  renderInstanceId: env("RENDER_INSTANCE_ID"),
  isVercel: !!env("VERCEL"),
  railwayStaticUrl: env("RAILWAY_STATIC_URL"),
  flyAppName: env("FLY_APP_NAME"),

  judge0BaseUrl: env("JUDGE0_BASE_URL", "https://ce.judge0.com").replace(/\/$/, ""),
  judge0RapidapiKey: env("JUDGE0_RAPIDAPI_KEY"),
  judge0RapidapiHost: env("JUDGE0_RAPIDAPI_HOST"),

  pistonBaseUrl: env("PISTON_BASE_URL"),
  pistonAuth: env("PISTON_AUTH"),

  sphereEngineEndpoint: env("SPHERE_ENGINE_ENDPOINT"),
  sphereEngineToken: env("SPHERE_ENGINE_TOKEN"),
};

export default config;
