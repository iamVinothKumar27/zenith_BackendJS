import crypto from "crypto";
import { config } from "../config/env.js";
import { ensureIsoTz } from "./dates.js";

export function sanitizeTopic(topic) {
  const t = (topic || "").trim();
  if (!t) return "";
  if (["all", "all topics", "all_topic", "any", "mixed", "everything"].includes(t.toLowerCase())) return "";
  return t;
}

export function defaultProctoring(limit = 3) {
  let n = parseInt(limit, 10);
  if (Number.isNaN(n) || n <= 0) n = 3;
  return {
    enabled: false,
    violation_limit: n,
    violations: 0,
    warnings: [],
    events: [],
    last_violation_at: null,
    auto_submitted: false,
    auto_submit_reason: "",
  };
}

const TOPIC_ALIAS_MAP = {
  dbms: ["dbms", "database", "databases", "normalization", "sql", "indexing", "joins", "transactions"],
  oop: ["oop", "oops", "object oriented programming", "encapsulation", "inheritance", "polymorphism", "abstraction"],
  "operating systems": ["operating systems", "operating system", "os", "process", "processes", "thread", "threads", "deadlock", "scheduling"],
  "computer networks": ["computer networks", "computer network", "cn", "networking", "tcp", "udp", "http", "ip", "osi"],
  "dsa basics": ["dsa", "dsa basics", "arrays", "strings", "hashing", "stack", "queue", "tree", "graph", "binary search", "big o"],
  "logical reasoning": ["logical reasoning", "reasoning", "puzzles", "syllogism"],
  "verbal ability": ["verbal ability", "verbal", "grammar", "error spotting", "reading comprehension"],
  "time, speed & distance": ["time, speed & distance", "time speed distance", "time and distance"],
  "simple & compound interest": ["simple & compound interest", "simple and compound interest", "interest"],
  "ratio & proportion": ["ratio & proportion", "ratio and proportion", "ratio", "proportion"],
  "profit & loss": ["profit & loss", "profit and loss", "profit", "loss"],
  "clocks & calendars": ["clocks & calendars", "clocks and calendars", "clock", "calendar"],
  sql: ["sql", "queries", "joins", "group by", "having"],
};

export function topicAliases(topic) {
  const base = (topic || "").trim().toLowerCase();
  if (!base) return new Set();
  const aliases = new Set([base]);
  for (const [key, vals] of Object.entries(TOPIC_ALIAS_MAP)) {
    if (base === key || vals.includes(base)) {
      vals.forEach((v) => aliases.add(v));
      aliases.add(key);
    }
  }
  return new Set([...aliases].filter(Boolean).map((a) => a.toLowerCase()));
}

export function topicMatches(value, topic) {
  const aliases = topicAliases(topic);
  if (aliases.size === 0) return true;
  const hay = (Array.isArray(value) ? value.map((v) => String(v || "")).join(" ") : String(value || "")).toLowerCase();
  return [...aliases].some((a) => hay.includes(a));
}

export function proctoringPublic(data) {
  const base = defaultProctoring();
  const src = data && typeof data === "object" ? data : {};
  const out = { ...base, ...src };

  out.violations = parseInt(src.violations, 10) || 0;
  out.violation_limit = parseInt(src.violation_limit, 10) || base.violation_limit;

  let warnings = src.warnings;
  if (!Array.isArray(warnings)) warnings = [];
  out.warnings = warnings.filter((w) => w && typeof w === "object");

  let events = src.events;
  if (!Array.isArray(events)) events = [];
  out.events = events
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      type: e.type || "warning",
      description: e.description || "",
      at: typeof e.at === "string" ? ensureIsoTz(e.at) : e.at,
      at_ist: e.at_ist || "",
    }));
  out.enabled = !!src.enabled;
  out.auto_submitted = !!src.auto_submitted;
  out.auto_submit_reason = String(src.auto_submit_reason || "");
  const lva = src.last_violation_at;
  out.last_violation_at = typeof lva === "string" ? ensureIsoTz(lva) : lva ?? null;
  return out;
}

export function pwHash(uid, password) {
  const u = (uid || "").trim();
  const p = (password || "").trim();
  const raw = `${u}|${config.passwordPepper}|${p}`;
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
}

export function ytId(url) {
  if (!url) return "";
  const m = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : "";
}

function getUrlFromEntry(obj) {
  if (obj == null) return "";
  if (typeof obj === "string") return obj.trim();
  if (typeof obj === "object") {
    return (obj.videoUrl || obj.video_url || obj.url || obj.video || "").trim();
  }
  return String(obj).trim();
}

function getTitleFromEntry(obj) {
  if (obj == null) return "";
  if (typeof obj === "object" && !Array.isArray(obj)) {
    return (obj.title || obj.topic || obj.name || obj.videoTitle || obj.heading || "").trim();
  }
  return "";
}

export function flattenVideoUrls(node) {
  const out = [];
  if (node == null) return out;
  if (typeof node === "string") {
    const u = node.trim();
    if (u) out.push(u);
    return out;
  }
  if (Array.isArray(node)) {
    for (const it of node) out.push(...flattenVideoUrls(it));
    return out;
  }
  if (typeof node === "object") {
    if (Array.isArray(node.videos)) {
      for (const v of node.videos) {
        const u = getUrlFromEntry(v);
        if (u) out.push(u);
        else out.push(...flattenVideoUrls(v));
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          const u = getUrlFromEntry(item);
          if (u) out.push(u);
          else out.push(...flattenVideoUrls(item));
        }
      } else {
        out.push(...flattenVideoUrls(v));
      }
    }
    return out;
  }
  return out;
}

export function flattenCourseVideosWithTitles(videosRoot) {
  const out = [];
  const push = (url, title) => {
    const u = (url || "").trim();
    if (!u) return;
    out.push({ url: u, title: (title || "").trim() });
  };

  const walk = (node, inheritedTitle = "") => {
    if (node == null) return;
    if (typeof node === "string") {
      push(node, inheritedTitle);
      return;
    }
    if (Array.isArray(node)) {
      for (const it of node) walk(it, inheritedTitle);
      return;
    }
    if (typeof node === "object") {
      const u = getUrlFromEntry(node);
      const t = getTitleFromEntry(node) || inheritedTitle;
      if (u) {
        push(u, t);
        return;
      }
      if (Array.isArray(node.videos)) {
        for (const v of node.videos) walk(v, getTitleFromEntry(v) || inheritedTitle);
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        if (Array.isArray(v)) {
          for (const item of v) walk(item, getTitleFromEntry(item) || inheritedTitle);
        } else {
          walk(v, inheritedTitle);
        }
      }
    }
  };

  walk(videosRoot, "");
  out.forEach((ent, i) => {
    if (!ent.title) ent.title = `Video ${i + 1}`;
  });
  return out;
}

export function formdataHash(obj) {
  let raw;
  try {
    raw = JSON.stringify(sortKeysDeep(obj || {}));
  } catch {
    raw = String(obj);
  }
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeysDeep(value[k]);
        return acc;
      }, {});
  }
  return value;
}
