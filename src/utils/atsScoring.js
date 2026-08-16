import axios from "axios";
import { getGeminiResponse } from "./gemini.js";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "to", "of", "in", "on", "a", "an", "as", "is", "are", "was", "were",
  "be", "by", "or", "at", "it", "we", "you", "your", "our", "their", "they", "he", "she", "them", "his", "her", "will",
  "can", "may", "should", "must", "have", "has", "had", "do", "does", "did", "not", "but", "if", "then", "than", "into",
  "about", "over", "under", "within", "across", "using", "use", "used", "also", "etc", "per", "via",
]);

const SECTION_ALIASES = {
  summary: ["summary", "professional summary", "objective", "profile"],
  skills: ["skills", "technical skills", "skill set", "toolbox", "technologies"],
  experience: ["experience", "work experience", "professional experience", "employment", "internships", "internship"],
  projects: ["projects", "project", "academic projects", "personal projects"],
  education: ["education", "academics", "academic background", "qualifications"],
  certifications: ["certifications", "certificates", "courses", "training"],
};

const SKILL_LEXICON = [
  "python", "java", "javascript", "typescript", "c", "c++", "c#", "go", "rust", "kotlin", "swift", "sql", "r", "matlab", "bash",
  "react", "angular", "vue", "node.js", "node", "express", "next.js", "flask", "django", "spring", "spring boot", "rest", "graphql",
  "html", "css", "tailwind", "bootstrap",
  "pandas", "numpy", "scikit-learn", "sklearn", "tensorflow", "pytorch", "keras", "xgboost", "lightgbm",
  "nlp", "llm", "generative ai", "prompt engineering", "rag", "embeddings",
  "data analysis", "data analytics", "statistics", "hypothesis testing", "a/b testing", "experimentation",
  "power bi", "tableau", "excel", "spreadsheets", "spss", "sas",
  "aws", "gcp", "azure", "docker", "kubernetes", "git", "github", "ci/cd", "linux",
  "mysql", "postgresql", "postgres", "mongodb", "firebase", "redis", "sqlite", "oracle",
  "unit testing", "integration testing", "jest", "pytest", "selenium",
  "flutter", "dart", "android", "ios",
  "microservices", "system design", "oauth", "jwt", "api", "agile", "scrum",
];

export function canonSkill(s) {
  let out = (s || "").trim().toLowerCase();
  out = out.replace("nodejs", "node.js");
  out = out.replace("sklearn", "scikit-learn");
  out = out.replace(/\s+/g, " ");
  return out;
}

const SKILL_CANON = new Map(SKILL_LEXICON.map((x) => [canonSkill(x), x]));

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const PHONE_RE = /(\+?\d[\d\s\-()]{7,}\d)/g;

export function affindaConfig() {
  return {
    apiKey: (process.env.AFFINDA_API_KEY || "").trim(),
    workspace: (process.env.AFFINDA_WORKSPACE || "").trim(),
    doctypeResume: (process.env.AFFINDA_DOCTYPE_RESUME || "").trim(),
    baseUrl: (process.env.AFFINDA_BASE_URL || "https://api.affinda.com").trim().replace(/\/$/, ""),
  };
}

/** Best-effort Affinda resume parse. Returns {ok, skills, raw} or {ok:false, error}. */
export async function affindaParseResume(fileBytes, filename = "resume.pdf") {
  const cfg = affindaConfig();
  if (!cfg.apiKey) return { ok: false, error: "AFFINDA_API_KEY not set" };

  const url = `${cfg.baseUrl}/v2/resumes`;
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("file", fileBytes, filename || "resume.pdf");
  if (cfg.workspace) form.append("workspace", cfg.workspace);
  if (cfg.doctypeResume) form.append("document_type", cfg.doctypeResume);

  const authHeaders = [`Bearer ${cfg.apiKey}`, `Token ${cfg.apiKey}`];
  let last = null;
  for (const authHeader of authHeaders) {
    try {
      const resp = await axios.post(url, form, {
        headers: { ...form.getHeaders(), Authorization: authHeader },
        timeout: 45000,
        validateStatus: () => true,
      });
      last = resp;
      if (resp.status === 401 || resp.status === 403) continue;
      if (resp.status >= 400) break;
      const j = resp.data;
      let skills = [];
      try {
        const dataObj = j.data || {};
        const rawSk = dataObj.skills || [];
        for (const s of rawSk) {
          if (typeof s === "string") skills.push(s);
          else if (s && typeof s === "object") {
            const nm = s.name || s.skill || s.value;
            if (nm) skills.push(String(nm));
          }
        }
        skills = [...new Set(skills.map((x) => String(x).trim()).filter(Boolean))].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      } catch {
        skills = [];
      }
      return { ok: true, skills, raw: j };
    } catch (e) {
      last = e;
    }
  }
  if (last && last.status) {
    return { ok: false, error: `Affinda error: HTTP ${last.status} ${JSON.stringify(last.data).slice(0, 300)}` };
  }
  return { ok: false, error: `Affinda error: ${last?.message || last}` };
}

export function mergeResumeStructWithAffinda(resumeStruct, aff) {
  resumeStruct = resumeStruct && typeof resumeStruct === "object" ? resumeStruct : {};
  if (aff && aff.ok && Array.isArray(aff.skills)) {
    const merged = new Set(resumeStruct.skills || []);
    for (const s of aff.skills || []) {
      const ss = String(s).trim();
      if (ss) merged.add(ss);
    }
    resumeStruct.skills = [...merged].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    resumeStruct.affinda_used = true;
  } else {
    resumeStruct.affinda_used = false;
  }
  return resumeStruct;
}

export function pickWeakSections(resumeSections, atsStruct, missingRequirements) {
  resumeSections = resumeSections || {};
  const missingSkills = (atsStruct || {}).missing_skills || [];
  const out = [];

  if (missingSkills.length) out.push("skills");

  if ((resumeSections.experience || "").trim()) out.push("experience");
  else if ((resumeSections.projects || "").trim()) out.push("projects");

  try {
    for (const r of missingRequirements || []) {
      const typ = r && typeof r === "object" ? (r.type || "").toLowerCase() : "";
      if (typ.includes("education") && (resumeSections.education || "").trim()) {
        out.push("education");
        break;
      }
    }
  } catch {
    // ignore
  }

  const uniq = [];
  for (const k of out) {
    if (!uniq.includes(k) && (resumeSections[k] || "").trim()) uniq.push(k);
  }
  return uniq.slice(0, 3);
}

/** Mirrors Python's _gemini_json: lenient Gemini JSON call that returns {} on any failure. */
export async function geminiJsonLenient(prompt) {
  let raw;
  try {
    raw = ((await getGeminiResponse(prompt)) || "").trim();
  } catch {
    return {};
  }
  if (!raw) return {};

  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(json)?/i, "").trim();
    raw = raw.replace(/^`+|`+$/g, "").trim();
  }

  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    return JSON.parse(raw);
  } catch {
    // fall through
  }

  try {
    return extractJsonObj(raw) || {};
  } catch {
    return {};
  }
}

export function extractJsonObj(text) {
  if (!text) return null;
  let raw = String(text).trim();
  raw = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export async function geminiAtsSectionRewrites(jdText, resumeSections, missingSkillsPriority, weakSections) {
  const secPayload = {};
  for (const k of weakSections || []) {
    secPayload[k] = (resumeSections[k] || "").slice(0, 6000);
  }

  const schema = {
    improvements: [
      "Example: Projects section: add REST API + MongoDB keywords where relevant; your current bullets mention Flask but not API design.",
    ],
    tailored_diff: [
      {
        section: "skills|experience|projects|education",
        replace_instruction: "Tell the user which section to replace.",
        old_content: "Exact old section text from RESUME_SECTIONS.",
        new_content: "Rewritten ATS-friendly content (copy/paste).",
      },
    ],
  };
  const schemaJson = JSON.stringify(schema, null, 2);

  const prompt = [
    "You are an ATS resume optimizer. Your output MUST be grounded in the provided resume text.",
    "",
    "INPUTS:",
    "1) JOB DESCRIPTION (JD)",
    "2) RESUME_SECTIONS (ONLY weak sections; exact text)",
    "3) MISSING_SKILLS_PRIORITY (top missing JD keywords)",
    "",
    "STRICT RULES:",
    "- Output VALID JSON ONLY. No markdown, no extra text.",
    "- Do NOT invent companies, degrees, certifications, job titles, years, metrics or achievements not present.",
    "- You MAY add missing keywords ONLY as 'familiarity' / 'worked with' style language, unless the resume already shows usage.",
    "- Preserve the user's tone and structure (bullets/lines).",
    "- NEW content must be meaningfully different from OLD (not copy-paste).",
    "",
    "TASK A (Improvements):",
    "- Provide 8–12 resume-specific improvements.",
    "- Each improvement MUST include a section name (Skills/Experience/Projects/Education) and mention at least one missing keyword from MISSING_SKILLS_PRIORITY.",
    "- Each improvement MUST reference what is currently written (quote a short phrase from OLD content if possible).",
    "",
    "TASK B (Tailored rewrites):",
    "- For EACH weak section in RESUME_SECTIONS, return an OLD→NEW rewrite the user can copy-paste.",
    "- Naturally incorporate up to 3–6 of the most relevant missing keywords for that section.",
    "- If a section is empty, generate a compact ATS-friendly version consistent with the resume context.",
    "",
    "Respond as JSON with EXACT schema:",
    schemaJson,
    "",
    "JD:",
    (jdText || "").slice(0, 14000),
    "",
    "MISSING_SKILLS_PRIORITY:",
    JSON.stringify((missingSkillsPriority || []).slice(0, 22)),
    "",
    "RESUME_SECTIONS:",
    JSON.stringify(secPayload),
  ].join("\n");

  return (await geminiJsonLenient(prompt)) || {};
}

export function cleanTextBasic(text) {
  let t = text || "";
  t = t.replace(EMAIL_RE, " ");
  t = t.replace(URL_RE, " ");
  t = t.replace(PHONE_RE, " ");
  t = t.replace(/\x00/g, " ");
  return t;
}

export function tokenize(text) {
  let t = (text || "").toLowerCase().replace(/[^a-z0-9+#.\s]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return [];
  return t.split(" ");
}

export function extractSkillMentions(text) {
  const t = cleanTextBasic(text).toLowerCase();
  const found = new Set();
  for (const [canon, pretty] of SKILL_CANON.entries()) {
    if (canon.includes(" ") && t.includes(canon)) found.add(pretty);
  }
  const toks = new Set(tokenize(t));
  for (const [canon, pretty] of SKILL_CANON.entries()) {
    if (canon.includes(" ")) continue;
    if (toks.has(canon)) found.add(pretty);
  }
  if (toks.has("node") && SKILL_CANON.has("node.js")) found.add(SKILL_CANON.get("node.js"));
  return [...found].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export function splitIntoSections(text) {
  const raw = cleanTextBasic(text);
  const lines = raw.split("\n").map((ln) => ln.replace(/\s+$/, ""));

  const headingToKey = {};
  for (const [key, aliases] of Object.entries(SECTION_ALIASES)) {
    for (const a of aliases) headingToKey[a.toLowerCase()] = key;
  }

  const sections = {};
  let curKey = "other";
  let buf = [];

  const flush = () => {
    const s = buf.join("\n").trim();
    if (s) sections[curKey] = ((sections[curKey] || "") + "\n" + s).trim();
    buf = [];
  };

  for (const ln of lines) {
    const norm = ln.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    if (norm.length >= 1 && norm.length <= 35 && headingToKey[norm]) {
      flush();
      curKey = headingToKey[norm];
      continue;
    }
    if (ln.trim() && ln.trim() === ln.trim().toUpperCase() && /[A-Z]/.test(ln)) {
      const norm2 = ln.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      if (headingToKey[norm2]) {
        flush();
        curKey = headingToKey[norm2];
        continue;
      }
    }
    buf.push(ln);
  }
  flush();
  return sections;
}

export function estimateExperienceYears(expText) {
  const t = cleanTextBasic(expText);
  const currentYear = new Date().getUTCFullYear();
  let years = [...t.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => parseInt(m[1], 10));
  years = years.filter((y) => y >= 1980 && y <= currentYear + 1);
  years = [...new Set(years)].sort((a, b) => a - b);
  if (years.length >= 2) {
    return Math.max(0.0, years[years.length - 1] - years[0]);
  }
  const internMentions = (t.match(/\bintern\b|\binternship\b/gi) || []).length;
  if (internMentions) return 0.5 * internMentions;
  return 0.0;
}

export function extractEducationLines(eduText) {
  const out = [];
  for (const ln of (eduText || "").split("\n")) {
    const s = ln.trim();
    if (!s) continue;
    if (/\b(b\.?e|b\.?tech|bachelor|m\.?s|m\.?tech|master|ph\.?d|university|college)\b/i.test(s)) out.push(s);
  }
  return out.slice(0, 12);
}

export function extractProjectSummaries(projText) {
  const t = (projText || "").trim();
  if (!t) return [];
  const chunks = t.split(/\n\s*\n+/);
  const out = [];
  for (const ch of chunks) {
    const s = ch.trim();
    if (!s) continue;
    const skills = extractSkillMentions(s);
    const firstLine = s.split("\n")[0].trim();
    const title = firstLine.slice(0, 120);
    out.push({ title, skills: skills.slice(0, 12), snippet: s.slice(0, 600) });
    if (out.length >= 6) break;
  }
  return out;
}

export function parseResumeStructured(resumeText) {
  const sections = splitIntoSections(resumeText);
  const skills = new Set(extractSkillMentions((sections.skills || "") + "\n" + resumeText));
  const eduLines = extractEducationLines(sections.education || "");
  const projects = extractProjectSummaries(sections.projects || "");
  const expYears = estimateExperienceYears(sections.experience || "");
  return {
    skills: [...skills].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    experience_years_est: Math.round(expYears * 100) / 100,
    education_lines: eduLines,
    projects,
    sections_present: Object.entries(sections)
      .filter(([, v]) => (v || "").trim())
      .map(([k]) => k)
      .sort(),
  };
}

export function parseJdStructured(jdText) {
  const skills = new Set(extractSkillMentions(jdText));
  const t = cleanTextBasic(jdText).toLowerCase();
  const phrases = new Set();
  for (const m of t.matchAll(/\b([a-z][a-z0-9]+(?:\s+[a-z][a-z0-9]+){1,2})\b/g)) {
    const ph = m[1].trim();
    if (ph.split(" ").some((w) => STOPWORDS.has(w))) continue;
    if (ph.length < 6 || ph.length > 35) continue;
    if (EMAIL_RE.test(ph) || URL_RE.test(ph) || PHONE_RE.test(ph)) continue;
    EMAIL_RE.lastIndex = 0;
    URL_RE.lastIndex = 0;
    PHONE_RE.lastIndex = 0;
    if (/\b(analysis|analytics|testing|engineering|reporting|visualization|database|cloud|api|automation|ml|ai|data)\b/.test(ph)) {
      phrases.add(ph);
    }
  }
  return {
    skills: [...skills].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    skill_phrases: [...phrases].sort().slice(0, 60),
  };
}

export function extractJdRequirements(jdText) {
  const t = cleanTextBasic(jdText || "");
  const low = t.toLowerCase();

  const edu = new Set();
  const eduPatterns = [
    /\b(bachelor(?:'s)?|b\.?\s*e\.?|b\.?\s*tech|btech|b\.\s*sc|bsc)\b/gi,
    /\b(master(?:'s)?|m\.?\s*e\.?|m\.?\s*tech|mtech|m\.\s*sc|msc|mba)\b/gi,
    /\b(ph\.?d|doctorate)\b/gi,
    /\b(computer science|information technology|electronics|electrical|statistics|mathematics|data science)\b/gi,
  ];
  for (const pat of eduPatterns) {
    for (const m of low.matchAll(pat)) edu.add(m[0].trim());
  }

  let yearsMin = null;
  for (const m of low.matchAll(/\b(\d{1,2})\s*\+?\s*(?:years|yrs)\b/g)) {
    const y = parseInt(m[1], 10);
    yearsMin = yearsMin === null ? y : Math.min(yearsMin, y);
  }

  const certs = new Set();
  for (const m of low.matchAll(/\b(aws|azure|gcp)\s+(certified|certification)\b/g)) certs.add(m[0].trim());
  for (const m of low.matchAll(/\b(certification|certified)\b[^\n.]{0,60}/g)) {
    const frag = m[0].trim();
    if (frag.length >= 10) certs.add(frag);
  }

  const achievements = new Set();
  const achPatterns = [
    /\b(award|awarded|recognition|accomplishment|achievement)\b/,
    /\b(publication|published|patent)\b/,
    /\b(hackathon|winner|winning)\b/,
    /\b(leadership|led|mentored|managed)\b/,
  ];
  for (const pat of achPatterns) {
    const m = low.match(pat);
    if (m) achievements.add(m[0]);
  }

  const nonSkill = new Set();
  for (const m of low.matchAll(/\b(communication|collaboration|stakeholder|ownership|leadership|mentoring)\b/g)) {
    nonSkill.add(m[0]);
  }

  return {
    education_tokens: [...edu].sort(),
    min_years_experience: yearsMin,
    certification_hints: [...certs].sort().slice(0, 15),
    achievement_hints: [...achievements].sort(),
    non_skill_requirements: [...nonSkill].sort(),
  };
}

export function computeMissingRequirements(jdReq, resumeStruct) {
  const out = [];

  const eduLines = resumeStruct.education_lines || [];
  if ((jdReq.education_tokens || []).length && !eduLines.length) {
    out.push({
      type: "education",
      requirement: "Education details mentioned in JD, but resume has no Education section detected.",
      details: (jdReq.education_tokens || []).slice(0, 10),
    });
  }

  const minYears = jdReq.min_years_experience;
  const resumeYears = parseFloat(resumeStruct.experience_years_est || 0) || 0;
  if (Number.isInteger(minYears) && minYears > 0 && resumeYears + 0.49 < minYears) {
    out.push({
      type: "work_experience",
      requirement: `JD mentions ~${minYears}+ years experience.`,
      details: { resume_years_est: Math.round(resumeYears * 100) / 100, jd_min_years: minYears },
    });
  }

  const sectionsPresent = new Set(resumeStruct.sections_present || []);
  const hasCerts = sectionsPresent.has("certifications");
  if ((jdReq.certification_hints || []).length && !hasCerts) {
    out.push({
      type: "certifications",
      requirement: "JD references certifications; resume has no Certifications section detected.",
      details: (jdReq.certification_hints || []).slice(0, 10),
    });
  }

  if ((jdReq.achievement_hints || []).length) {
    const raw = eduLines.map(String).join(" ") + " " + (resumeStruct.projects || []).map(String).join(" ");
    const low = raw.toLowerCase();
    if (!/\b(award|awarded|winner|publication|patent|achievement|accomplishment)\b/.test(low)) {
      out.push({
        type: "achievements",
        requirement: "JD implies measurable achievements/recognitions; resume doesn't clearly highlight them.",
        details: (jdReq.achievement_hints || []).slice(0, 10),
      });
    }
  }

  return out;
}

export function computeAtsScoreStructured(jd, resume) {
  const jdSkills = new Set((jd.skills || []).map(canonSkill));
  const resSkills = new Set((resume.skills || []).map(canonSkill));

  const matched = [...jdSkills].filter((s) => resSkills.has(s)).sort();
  const missing = [...jdSkills].filter((s) => !resSkills.has(s)).sort();

  const coverage = jdSkills.size ? matched.length / Math.max(1, jdSkills.size) : 0.0;
  const skillsScore = Math.round(60.0 * Math.min(1.0, coverage) * 10) / 10;

  const expYears = parseFloat(resume.experience_years_est || 0) || 0;
  let expScore = 0.0;
  if (expYears >= 3) expScore = 20.0;
  else if (expYears >= 2) expScore = 14.0;
  else if (expYears >= 1) expScore = 8.0;

  const projCount = (resume.projects || []).length;
  const projScore = Math.min(10.0, 3.0 * projCount);
  const eduScore = (resume.education_lines || []).length ? 10.0 : 5.0;

  const total = skillsScore + expScore + projScore + eduScore;
  const score = Math.round(Math.min(100.0, total));

  return {
    score,
    coverage: Math.round(coverage * 1000) / 10,
    matched_skills: matched.slice(0, 40),
    missing_skills: missing.slice(0, 40),
    score_breakdown: {
      skills: skillsScore,
      experience: expScore,
      projects: Math.round(projScore * 10) / 10,
      education: Math.round(eduScore * 10) / 10,
    },
  };
}

const CATEGORY_BUCKETS = {
  Programming: ["python", "java", "javascript", "typescript", "c", "c++", "c#", "go", "rust", "kotlin", "swift", "sql", "r", "matlab", "bash"],
  Web: ["react", "angular", "vue", "node.js", "node", "express", "next.js", "flask", "django", "spring", "spring boot", "rest", "graphql", "html", "css", "tailwind", "bootstrap"],
  "Data/ML": ["pandas", "numpy", "scikit-learn", "tensorflow", "pytorch", "keras", "xgboost", "lightgbm", "nlp", "llm", "generative ai", "rag", "embeddings", "data analysis", "data analytics", "statistics", "hypothesis testing", "a/b testing", "experimentation", "power bi", "tableau", "excel"],
  "Cloud/DevOps": ["aws", "gcp", "azure", "docker", "kubernetes", "git", "github", "ci/cd", "linux", "microservices", "system design", "oauth", "jwt"],
  Databases: ["mysql", "postgresql", "postgres", "mongodb", "firebase", "redis", "sqlite", "oracle"],
  "Testing/QA": ["unit testing", "integration testing", "jest", "pytest", "selenium"],
  Mobile: ["flutter", "dart", "android", "ios"],
};

export function computeAtsAnalytics(jdText, jdStruct, resumeStruct, atsStruct) {
  const jdTextL = cleanTextBasic(jdText || "").toLowerCase();

  const jdSkills = (jdStruct.skills || []).map((x) => canonSkill(x) || "");
  const resSkills = new Set((resumeStruct.skills || []).map(canonSkill));

  const inv = {};
  for (const [cat, lst] of Object.entries(CATEGORY_BUCKETS)) {
    for (const s of lst) inv[canonSkill(s)] = cat;
  }

  const total = Object.fromEntries(Object.keys(CATEGORY_BUCKETS).map((k) => [k, 0]));
  const matched = Object.fromEntries(Object.keys(CATEGORY_BUCKETS).map((k) => [k, 0]));

  for (const s of jdSkills) {
    const cat = inv[s];
    if (!cat) continue;
    total[cat] += 1;
    if (resSkills.has(s)) matched[cat] += 1;
  }

  const categoryBreakdown = [];
  for (const cat of Object.keys(CATEGORY_BUCKETS)) {
    if (total[cat] <= 0) continue;
    const mp = Math.round(((100.0 * matched[cat]) / Math.max(1, total[cat])) * 10) / 10;
    categoryBreakdown.push({
      category: cat,
      jd_count: total[cat],
      matched_count: matched[cat],
      missing_count: Math.max(0, total[cat] - matched[cat]),
      match_pct: mp,
    });
  }

  const missingSkills = atsStruct.missing_skills || [];
  const weights = [];
  for (const sk of missingSkills) {
    const canon = canonSkill(sk);
    if (!canon) continue;
    let w;
    if (canon.includes(" ") || canon.includes(".") || canon.includes("+") || canon.includes("#")) {
      w = jdTextL.split(canon).length - 1;
    } else {
      w = (jdTextL.match(new RegExp(`\\b${canon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g")) || []).length;
    }
    if (w <= 0) w = 1;
    weights.push({ skill: sk, weight: w });
  }
  weights.sort((a, b) => b.weight - a.weight || a.skill.toLowerCase().localeCompare(b.skill.toLowerCase()));

  const matchedN = (atsStruct.matched_skills || []).length;
  const missingN = missingSkills.length;
  const denom = Math.max(1, matchedN + missingN);
  const matchPct = Math.round(((100.0 * matchedN) / denom) * 10) / 10;

  return {
    match_pct: matchPct,
    matched_count: matchedN,
    missing_count: missingN,
    category_breakdown: categoryBreakdown,
    top_missing_weighted: weights.slice(0, 12),
  };
}

export async function geminiCodeAnalysis(problemText, sourceCode, language) {
  try {
    const pt = (problemText || "").trim();
    const sc = (sourceCode || "").trim();
    if (!sc) return {};
    const prompt = `You are a code reviewer.

Given:
- Problem statement (may be partial): ${pt.slice(0, 4000)}
- Language: ${language}
- Candidate solution code:
${sc.slice(0, 12000)}

Task:
Estimate the asymptotic time and space complexity in Big-O and give a SHORT reason (1-2 lines).

Return STRICT JSON only:
{
  "timeComplexity": "O(...)",
  "spaceComplexity": "O(...)",
  "reason": "short reasoning"
}
`;
    const obj = (await geminiJsonLenient(prompt)) || {};
    const out = {
      timeComplexity: (obj.timeComplexity || obj.time_complexity || "").trim(),
      spaceComplexity: (obj.spaceComplexity || obj.space_complexity || "").trim(),
      reason: (obj.reason || obj.explanation || "").trim(),
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
  } catch {
    return {};
  }
}

export function resumeSectionsForGemini(resumeText) {
  const sections = splitIntoSections(resumeText || "");
  return {
    education_text: (sections.education || "").trim(),
    experience_text: (sections.experience || "").trim(),
    achievements_text: (sections.achievements || "").trim(),
    certifications_text: (sections.certifications || "").trim(),
    projects_text: (sections.projects || "").trim(),
    skills_text: (sections.skills || "").trim(),
    full_text: (resumeText || "").trim().slice(0, 20000),
  };
}

export async function geminiRequirementsAndImprovements(jdText, resumeSections) {
  const prompt = `You are an ATS evaluator.

Goal:
1) Extract non-skill requirements from the Job Description (JD)
2) Compare them with the resume sections SEMANTICALLY (not keyword match)
3) Return missing requirements and actionable improvements

IMPORTANT RULES:
- Do NOT do keyword-only matching.
- Consider equivalent formats: "B.Tech" == "Bachelor of Technology", "BE" == "B.E."
- If resume has the requirement but in a different format, mark as PRESENT.
- If something is unclear, mark it as "uncertain" with a note.

Return STRICT JSON ONLY. No markdown.

JSON schema:
{
  "missing_requirements": [
    {
      "type": "education|work_experience|certification|achievement|other",
      "requirement": "string (what JD asks)",
      "status": "missing|present|uncertain",
      "evidence_resume": "string (quote/summary from resume if present else empty)",
      "evidence_jd": "string (quote/summary from JD)",
      "fix_suggestion": "string (what to add/change in resume)"
    }
  ],
  "improvements": [
    "string actionable bullet",
    "..."
  ]
}

RESUME EDUCATION SECTION:
${(resumeSections || {}).education_text || ""}

RESUME EXPERIENCE SECTION:
${(resumeSections || {}).experience_text || ""}

RESUME ACHIEVEMENTS SECTION:
${(resumeSections || {}).achievements_text || ""}

RESUME CERTIFICATIONS SECTION:
${(resumeSections || {}).certifications_text || ""}

RESUME PROJECTS SECTION:
${(resumeSections || {}).projects_text || ""}

RESUME SKILLS SECTION:
${(resumeSections || {}).skills_text || ""}

FULL RESUME (optional):
${(resumeSections || {}).full_text || ""}

JOB DESCRIPTION:
${(jdText || "").slice(0, 12000)}`.trim();

  let raw = "";
  try {
    raw = ((await getGeminiResponse(prompt)) || "").trim();
  } catch {
    raw = "";
  }

  const data = extractJsonObj(raw) || {};

  const mr = data.missing_requirements || [];
  const filtered = [];
  for (const r of mr) {
    if (!r || typeof r !== "object") continue;
    const st = String(r.status || "").toLowerCase().trim();
    if (st === "missing" || st === "uncertain") {
      filtered.push({
        type: r.type || "other",
        requirement: r.requirement || "",
        status: st || "missing",
        evidence_resume: r.evidence_resume || "",
        evidence_jd: r.evidence_jd || "",
        fix_suggestion: r.fix_suggestion || "",
      });
    }
  }

  const improvements = (data.improvements || []).map((x) => String(x).trim()).filter(Boolean);

  return { missing_requirements: filtered, improvements };
}

export function normalizeKeyword(k) {
  let kk = (k || "").trim().toLowerCase();
  kk = kk.replace(/[^a-z0-9+#.\- ]+/g, " ");
  kk = kk.replace(/\s+/g, " ").trim();
  return kk;
}

export function filterUnwantedKeywords(keys) {
  const out = [];
  const seen = new Set();
  for (const k of keys || []) {
    const kk = normalizeKeyword(k);
    if (!kk) continue;
    if (kk.length <= 2) continue;
    if (/^\d{3,}$/.test(kk)) continue;
    if (kk.includes("@") || kk.includes("http") || kk.includes("www")) continue;
    if (/\b(gmail|yahoo|outlook|linkedin|github)\b/.test(kk)) continue;
    if (["vinoth", "kumar", "t s", "ts"].includes(kk)) continue;
    if (seen.has(kk)) continue;
    seen.add(kk);
    out.push(k.trim());
  }
  return out;
}
