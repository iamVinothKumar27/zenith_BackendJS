import admin, { initFirebaseAdmin } from "../config/firebase.js";
import { config } from "../config/env.js";

function adminEmailSet() {
  const s = new Set();
  if (config.adminEmail) s.add(config.adminEmail.trim().toLowerCase());
  if (config.adminEmails) {
    for (const e of config.adminEmails.split(",")) {
      const ee = e.trim().toLowerCase();
      if (ee) s.add(ee);
    }
  }
  return s;
}

/** Verify Firebase ID token from Authorization: Bearer <token>. Returns {user, error}. */
export async function verifyUser(req) {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, error: { message: "Missing Authorization Bearer token", status: 401 } };
  }
  const token = authHeader.slice(7).trim();
  try {
    initFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
    return { user: decoded, error: null };
  } catch (e) {
    return { user: null, error: { message: `Invalid token: ${e.message || e}`, status: 401 } };
  }
}

/** Express middleware: requires a valid Firebase user, sets req.user. */
export async function requireUser(req, res, next) {
  const { user, error } = await verifyUser(req);
  if (error) return res.status(error.status).json({ error: error.message });
  req.user = user;
  next();
}

/** Express middleware: requires a valid Firebase user whose email is in the admin allowlist. */
export async function requireAdmin(req, res, next) {
  const { user, error } = await verifyUser(req);
  if (error) return res.status(error.status).json({ error: error.message });
  try {
    const email = (user.email || "").trim().toLowerCase();
    if (!email || !adminEmailSet().has(email)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(500).json({ error: `Admin check failed: ${e.message || e}` });
  }
}
