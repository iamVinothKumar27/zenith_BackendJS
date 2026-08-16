import fs from "fs";
import admin from "firebase-admin";
import { config } from "./env.js";

export function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const saPath = config.firebaseServiceAccountPath;
  const saJson = config.firebaseServiceAccountJson;

  if (saPath) {
    const cert = JSON.parse(fs.readFileSync(saPath, "utf-8"));
    admin.initializeApp({ credential: admin.credential.cert(cert) });
    return;
  }
  if (saJson) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)) });
    return;
  }
  throw new Error("Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON");
}

export default admin;
