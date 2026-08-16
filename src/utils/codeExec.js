import axios from "axios";
import { config } from "../config/env.js";

const JUDGE0_BASE_URL = (config.judge0BaseUrl || "https://ce.judge0.com").replace(/\/$/, "");
const JUDGE0_RAPIDAPI_KEY = (config.judge0RapidapiKey || "").trim();
const JUDGE0_RAPIDAPI_HOST = (config.judge0RapidapiHost || "").trim();

const JUDGE0_LANG_IDS = {
  c: 50,
  cpp: 54,
  "c++": 54,
  java: 62,
  python: 71,
  python3: 71,
};

function judge0Headers() {
  const h = { "Content-Type": "application/json" };
  if (JUDGE0_RAPIDAPI_KEY) h["X-RapidAPI-Key"] = JUDGE0_RAPIDAPI_KEY;
  if (JUDGE0_RAPIDAPI_HOST) h["X-RapidAPI-Host"] = JUDGE0_RAPIDAPI_HOST;
  return h;
}

/** Run code on Judge0 and return dict with stdout/stderr/status. If expected provided, include pass bool. */
export async function judge0Run(sourceCode, stdin, language, { expected, timeLimit } = {}) {
  const langKey = (language || "").trim().toLowerCase();
  const langId = JUDGE0_LANG_IDS[langKey];
  if (!langId) throw new Error(`Unsupported language: ${language}. Allowed: Java, C, C++, Python`);

  const payload = {
    language_id: langId,
    source_code: sourceCode || "",
    stdin: stdin || "",
    redirect_stderr_to_stdout: false,
  };
  if (timeLimit != null) payload.cpu_time_limit = parseFloat(timeLimit);

  const url = `${JUDGE0_BASE_URL}/submissions?base64_encoded=false&wait=true`;
  const r = await axios.post(url, payload, { headers: judge0Headers(), timeout: 60000 });
  const out = r.data || {};

  const stdout = (out.stdout || "").trim();
  const stderr = (out.stderr || "").trim();
  const compileOut = (out.compile_output || "").trim();
  const status = out.status || {};
  const statusId = status.id;
  const statusDesc = status.description;

  const res = {
    stdout,
    stderr,
    compile_output: compileOut,
    status_id: statusId,
    status: statusDesc,
    time: out.time,
    memory: out.memory,
  };
  if (expected != null) {
    const exp = (expected || "").trim();
    res.expected = exp;
    res.passed = stdout.trim() === exp.trim() && !stderr && !compileOut && statusId === 3; // 3 = Accepted
  }
  return res;
}

const PISTON_BASE_URL = (config.pistonBaseUrl || "http://127.0.0.1:2000/api/v2").replace(/\/$/, "");
const PISTON_AUTH = (config.pistonAuth || "").trim();

const PISTON_LANG = {
  python: "python",
  python3: "python",
  java: "java",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
};

function pistonHeaders() {
  const h = {};
  if (PISTON_AUTH) h["Authorization"] = PISTON_AUTH;
  return h;
}

export async function pistonRun(sourceCode, stdin, language, { expected } = {}) {
  const langKey = (language || "").trim().toLowerCase();
  const lang = PISTON_LANG[langKey];
  if (!lang) throw new Error(`Unsupported language: ${language}. Allowed: Java, C, C++, Python`);

  const url = `${PISTON_BASE_URL}/execute`;
  const payload = {
    language: lang,
    version: "*",
    files: [{ content: sourceCode || "" }],
    stdin: stdin || "",
  };
  const r = await axios.post(url, payload, { headers: pistonHeaders(), timeout: 60000, validateStatus: () => true });
  if (r.status === 401) {
    throw new Error(
      "Piston returned 401 Unauthorized. If you're using the public emkc.org Piston, it now requires an auth token. " +
        "Set PISTON_AUTH (e.g., 'Bearer <token>') and PISTON_BASE_URL accordingly, or use your self-hosted Piston (recommended)."
    );
  }
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`Piston request failed with status ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const out = r.data || {};

  const run = out.run || {};
  const stdout = (run.stdout || "").trim();
  const stderr = (run.stderr || "").trim();

  const res = {
    stdout,
    stderr,
    compile_output: "",
    status_id: !stderr ? 3 : 11,
    status: !stderr ? "Accepted" : "Runtime Error",
    time: run.time,
    memory: run.memory,
  };
  if (expected != null) {
    const exp = (expected || "").trim();
    res.expected = exp;
    res.passed = stdout.trim() === exp.trim() && !stderr;
  }
  return res;
}

const SPHERE_ENGINE_ENDPOINT = (config.sphereEngineEndpoint || "").replace(/\/$/, "");
const SPHERE_ENGINE_TOKEN = (config.sphereEngineToken || "").trim();

const SPHERE_LANG = {
  python: "python",
  python3: "python",
  java: "java",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
};

export async function sphereEngineRun(sourceCode, stdin, language) {
  if (!SPHERE_ENGINE_ENDPOINT || !SPHERE_ENGINE_TOKEN) throw new Error("Sphere Engine is not configured");

  const langKey = (language || "").trim().toLowerCase();
  const lang = SPHERE_LANG[langKey];
  if (!lang) throw new Error(`Unsupported language: ${language}. Allowed: Java, C, C++, Python`);

  throw new Error("Sphere Engine integration placeholder: configure compiler IDs for your account");
}

/** Very lightweight complexity estimator (heuristic). Users can override with an inline O(...) comment. */
export function estimateComplexity(sourceCode, language) {
  const code = sourceCode || "";

  const lines40 = code.split("\n").slice(0, 40);
  for (const line of lines40) {
    if (line.includes("O(")) {
      const parts = line.match(/O\([^)]*\)/g);
      if (parts && parts.length >= 2) {
        return { estimated_time: parts[0], estimated_space: parts[1], notes: "From inline hint in code comments." };
      }
      if (parts && parts.length === 1) {
        return { estimated_time: parts[0], estimated_space: "O(1)", notes: "From inline hint in code comments." };
      }
    }
  }

  const lower = code.toLowerCase();

  let nest = 0;
  let cur = 0;
  for (const raw of code.split("\n")) {
    const line = raw.trim().toLowerCase();
    if (line.startsWith("for ") || line.startsWith("while ")) {
      cur += 1;
      nest = Math.max(nest, cur);
    }
    if (line === "}" || line.startsWith("return")) {
      cur = Math.max(0, cur - 1);
    }
  }

  const hasSort = lower.includes("sort") || lower.includes("sorted(");
  const usesHash = ["dict", "hashmap", "unordered_map", "set<", "hashset", "map<"].some((k) => lower.includes(k));
  const usesHeap = lower.includes("heapq") || lower.includes("priorityqueue") || lower.includes("priority_queue");

  let t;
  if (nest >= 2) t = "O(n^2)";
  else if (nest === 1 && hasSort) t = "O(n log n)";
  else if (nest === 1) t = "O(n)";
  else t = !hasSort ? "O(1)" : "O(n log n)";

  const s = usesHash || usesHeap ? "O(n)" : "O(1)";
  return { estimated_time: t, estimated_space: s, notes: "Heuristic estimate. Add an 'O(...)' comment to override." };
}

/** Robust code runner: try Judge0 first, then Piston as fallback. */
export async function codeRun(sourceCode, stdin, language, { expected, timeLimit } = {}) {
  let last = null;
  try {
    return await judge0Run(sourceCode, stdin, language, { expected, timeLimit });
  } catch (e) {
    last = e;
  }

  try {
    return await pistonRun(sourceCode, stdin, language, { expected, timeLimit });
  } catch (e) {
    last = e;
  }

  throw last || new Error("Code runner failed");
}
