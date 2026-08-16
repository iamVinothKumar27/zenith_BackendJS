import crypto from "crypto";
import { getGeminiResponse, isQuotaError } from "./gemini.js";
import { sanitizeTopic, topicMatches } from "./text.js";
import { codeRun } from "./codeExec.js";
import { executeSqlQuery, sqlRowsToText, buildSqlPandasSchema, sqlStarterQuery } from "./sqlSandbox.js";
import { RECENT_CODING_TITLES, RECENT_MCQ_HASHES, pushRecentCodingTitle, pushRecentMcqHash } from "./mocktestHelpers.js";

/** Best-effort: call Gemini and coerce output into a JSON object, returning {} on any failure (mirrors _gemini_json).
 * Quota/rate-limit errors are re-thrown rather than swallowed — callers need to be able to tell "AI usage
 * limit hit" (retrying won't help and shouldn't burn more of the scarce quota) apart from "model returned
 * something we couldn't parse" (retrying is reasonable). Silently swallowing quota errors here meant callers
 * saw a generic "please regenerate" failure with no indication that regenerating would immediately fail again.
 */
export async function geminiJsonSafe(prompt, { maxOutputTokens } = {}) {
  let raw;
  try {
    raw = (await getGeminiResponse(prompt, { maxOutputTokens })) || "";
    raw = raw.trim();
  } catch (e) {
    if (isQuotaError(e)) throw e;
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
    // fall through to regex extraction
  }

  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) {
      // We got real text back but couldn't find a JSON object in it at all — most likely the
      // response was cut off mid-generation (see getGeminiResponse's note on "thinking" token
      // overhead) before it even reached the opening brace. Log enough to tell truncation apart
      // from "the model just didn't follow instructions" next time this happens.
      console.log(`[geminiJsonSafe] no JSON object found in ${raw.length}-char response. head=${JSON.stringify(raw.slice(0, 200))} tail=${JSON.stringify(raw.slice(-200))}`);
      return {};
    }
    return JSON.parse(m[0]);
  } catch (e) {
    console.log(`[geminiJsonSafe] matched a { ... } span but JSON.parse failed (${e.message}) — likely truncated mid-object. length=${raw.length} tail=${JSON.stringify(raw.slice(-200))}`);
    return {};
  }
}

/** Return {timeComplexity, spaceComplexity, reason} using Gemini (best-effort, mirrors _gemini_code_analysis). */
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
    const obj = (await geminiJsonSafe(prompt)) || {};
    const out = {
      timeComplexity: (obj.timeComplexity || obj.time_complexity || "").trim?.() ?? "",
      spaceComplexity: (obj.spaceComplexity || obj.space_complexity || "").trim?.() ?? "",
      reason: (obj.reason || obj.explanation || "").trim?.() ?? "",
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
  } catch {
    return {};
  }
}

const APTI_TOPIC_BANK = {
  dbms: [
    { subsection: "DBMS", topic: "DBMS", question: "Which normal form removes partial dependency?", options: ["1NF", "2NF", "3NF", "BCNF"], correctIndex: 1, explanation: "2NF removes partial dependency." },
    { subsection: "DBMS", topic: "DBMS", question: "Which SQL clause is used to filter groups after aggregation?", options: ["WHERE", "ORDER BY", "HAVING", "DISTINCT"], correctIndex: 2, explanation: "HAVING filters grouped results." },
    { subsection: "DBMS", topic: "DBMS", question: "A foreign key is used to:", options: ["Enforce referential integrity", "Sort rows", "Encrypt data", "Create indexes automatically"], correctIndex: 0, explanation: "Foreign keys maintain referential integrity between tables." },
    { subsection: "DBMS", topic: "DBMS", question: "Which join returns only matching rows from both tables?", options: ["LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "INNER JOIN"], correctIndex: 3, explanation: "INNER JOIN keeps only matching rows." },
    { subsection: "DBMS", topic: "DBMS", question: "Which property of a transaction ensures that either all operations occur or none occur?", options: ["Consistency", "Isolation", "Atomicity", "Durability"], correctIndex: 2, explanation: "Atomicity means all-or-nothing execution." },
  ],
  oop: [
    { subsection: "OOP", topic: "OOP", question: "Which OOP concept allows the same interface to represent different implementations?", options: ["Encapsulation", "Polymorphism", "Inheritance", "Composition"], correctIndex: 1, explanation: "Polymorphism enables one interface, many forms." },
    { subsection: "OOP", topic: "OOP", question: "Bundling data and methods together inside a class is called:", options: ["Abstraction", "Inheritance", "Encapsulation", "Overloading"], correctIndex: 2, explanation: "Encapsulation wraps state and behavior together." },
  ],
  "operating systems": [
    { subsection: "OS", topic: "Operating Systems", question: "Which scheduling algorithm may cause starvation for long jobs?", options: ["FCFS", "Round Robin", "SJF", "FIFO"], correctIndex: 2, explanation: "Shortest Job First can starve long processes." },
    { subsection: "OS", topic: "Operating Systems", question: "Threads of the same process share:", options: ["Program counter only", "Address space", "Stack only", "Process ID only"], correctIndex: 1, explanation: "Threads in a process share the same address space." },
  ],
  "computer networks": [
    { subsection: "CN", topic: "Computer Networks", question: "Which protocol is connection-oriented?", options: ["UDP", "IP", "TCP", "ICMP"], correctIndex: 2, explanation: "TCP is connection-oriented." },
    { subsection: "CN", topic: "Computer Networks", question: "Which device primarily operates at the network layer?", options: ["Hub", "Switch", "Router", "Repeater"], correctIndex: 2, explanation: "Routers forward packets using network-layer addressing." },
  ],
};

const GENERAL_BANK = [
  { subsection: "Quant", topic: "Percentages", question: "If the price of an item increases by 20% and then decreases by 20%, what is the net change?", options: ["0%", "4% decrease", "4% increase", "20% decrease"], correctIndex: 1, explanation: "Take 100 → 120 → 96, net 4% decrease." },
  { subsection: "Quant", topic: "Time & Work", question: "A can do a job in 10 days and B can do it in 15 days. In how many days can they finish together?", options: ["5", "6", "7", "8"], correctIndex: 1, explanation: "Rate = 1/10 + 1/15 = 1/6." },
  { subsection: "Logical", topic: "Syllogism", question: "Statements: All pens are blue. Some blue are costly. Conclusions: (1) Some pens are costly. (2) All costly are pens.\nWhich conclusion follows?", options: ["Only 1", "Only 2", "Both", "Neither"], correctIndex: 3, explanation: "No guarantee costly intersects pens; costly→pens not given." },
  { subsection: "Verbal", topic: "Error spotting", question: "Choose the correct sentence:", options: ["He don't like coffee.", "He doesn't likes coffee.", "He doesn't like coffee.", "He didn't likes coffee."], correctIndex: 2, explanation: "With does/doesn't use base verb form." },
  { subsection: "Logical", topic: "Calendar", question: "If today is Wednesday, what day will it be after 10 days?", options: ["Saturday", "Sunday", "Monday", "Tuesday"], correctIndex: 0, explanation: "10 mod 7 = 3; Wed + 3 = Saturday." },
];

const TECH_BANK = [
  { subsection: "DSA", topic: "Big-O", question: "What is the time complexity of binary search on a sorted array of size n?", options: ["O(n)", "O(log n)", "O(n log n)", "O(1)"], correctIndex: 1, explanation: "Each step halves the search space." },
  { subsection: "OOP", topic: "Polymorphism", question: "Which OOP concept allows the same interface to represent different underlying forms?", options: ["Encapsulation", "Abstraction", "Inheritance", "Polymorphism"], correctIndex: 3, explanation: "Polymorphism enables one interface, many implementations." },
  { subsection: "OS", topic: "Processes", question: "Which is true about a process vs a thread?", options: ["Threads have separate address spaces", "Processes share the same address space", "Threads share a process address space", "Processes cannot have multiple threads"], correctIndex: 2, explanation: "Threads within a process share address space/resources." },
  { subsection: "CN", topic: "TCP/UDP", question: "Which protocol is connection-oriented?", options: ["UDP", "TCP", "IP", "ICMP"], correctIndex: 1, explanation: "TCP establishes a connection (3-way handshake)." },
  { subsection: "DBMS", topic: "Normalization", question: "Which normal form removes partial dependency?", options: ["1NF", "2NF", "3NF", "BCNF"], correctIndex: 1, explanation: "2NF removes partial dependency on a candidate key." },
];

/** Generate aptitude questions using Gemini and self-verify with Gemini (mirrors _mocktest_generate_apti_questions). */
export async function mocktestGenerateAptiQuestions(section, n, difficulty = "mixed", topic = "") {
  n = parseInt(n || 0, 10);
  if (n <= 0) return [];

  section = (section || "").trim().toLowerCase();
  if (!["general", "tech"].includes(section)) section = "general";

  let focus, subsections, topics;
  if (section === "general") {
    focus = "General Aptitude (company screening)";
    subsections = ["Quant", "Logical", "Verbal"];
    topics = "Percentages, Ratios, Time & Work, Time & Distance, Profit & Loss, Probability basics, Puzzles, Syllogisms, Reading comprehension short, Error spotting";
  } else {
    focus = "Technical Aptitude (company screening)";
    subsections = ["DSA", "OOP", "OS", "CN", "DBMS"];
    topics = "Big-O, arrays/strings, stacks/queues, hashing, trees basics, OOP principles, threading basics, OS processes vs threads, deadlock, TCP/UDP, HTTP basics, normalization, indexing";
  }

  topic = sanitizeTopic(topic);
  const topicHint = topic
    ? `FOCUS TOPIC (STRICT): ${topic}. Generate ALL questions only from this topic. Do NOT include other topics.`
    : `Suggested topics: ${topics}.`;

  const recentQs = RECENT_MCQ_HASHES.slice(-60);
  const prompt = `
You are generating aptitude multiple-choice questions for a mock test.

Return STRICT JSON only (no markdown), schema:
{
  "questions": [
    {
      "id": "Q1",
      "section": "${section}",
      "subsection": "${subsections[0]}",
      "difficulty": "${difficulty}",
      "topic": "...",
      "question": "...",
      "options": ["A ...","B ...","C ...","D ..."],
      "correctIndex": 0,
      "answerText": "A ...",
      "explanation": "1-2 lines"
    }
  ]
}

Rules:
- Avoid repeating any of these recent questions (do NOT reuse wording/hardly similar): ${JSON.stringify(recentQs)}
- Generate exactly ${n} questions.
- Each question must have 4 options only.
- correctIndex must be 0-3 and must match answerText.
- subsection must be one of: ${JSON.stringify(subsections)}.
- Avoid ambiguous questions. Use precise numerical values.
- 1 mark per question.
- ${topicHint}
- Topic coverage: ${topics}.
`;

  // geminiJsonSafe re-throws quota/rate-limit errors (see its own comment) so callers with no
  // fallback can report them accurately. This function DOES have a fallback question bank below,
  // so a quota error here should fall through to it — same graceful-degradation behavior as any
  // other "Gemini returned nothing usable" case — rather than failing the whole request.
  let qs = [];
  try {
    const obj = (await geminiJsonSafe(prompt)) || {};
    qs = Array.isArray(obj.questions) ? obj.questions : [];

    if (qs.length) {
      const verifyPrompt = `
You will be given aptitude MCQ questions as JSON.
Verify each question has exactly 4 options, correctIndex 0-3, and answerText matches the option at correctIndex.
If any is wrong, fix it.
Return STRICT JSON with the same schema: { "questions": [ ... ] } only.

INPUT JSON:
${JSON.stringify({ questions: qs })}
`;
      const verified = (await geminiJsonSafe(verifyPrompt)) || {};
      const vqs = Array.isArray(verified.questions) ? verified.questions : null;
      if (vqs && vqs.length === qs.length) qs = vqs;
    }
  } catch {
    qs = [];
  }

  // --- Fallback bank ---
  if (!qs.length) {
    const bank = section === "general" ? GENERAL_BANK : TECH_BANK;
    qs = [];
    for (let i = 0; i < n; i++) {
      const b = { ...bank[i % bank.length] };
      b.id = `${section.toUpperCase()}-${i + 1}`;
      b.section = section;
      b.difficulty = difficulty;
      b.answerText = b.options[parseInt(b.correctIndex || 0, 10)];
      qs.push(b);
    }
  }

  if (topic) {
    let filtered = qs.filter((q) => {
      if (!q || typeof q !== "object") return false;
      const hay = [q.topic || "", q.subsection || "", q.question || "", (q.options || []).join(" ")].join(" ");
      return topicMatches(hay, topic);
    });
    qs = filtered;

    if (qs.length < n) {
      const key = (topic || "").trim().toLowerCase();
      const bank = APTI_TOPIC_BANK[key] || [];
      let i = 0;
      while (qs.length < n && bank.length) {
        const b = { ...bank[i % bank.length] };
        b.id = `${section.toUpperCase()}-T${qs.length + 1}`;
        b.section = section;
        b.difficulty = difficulty;
        b.answerText = b.options[parseInt(b.correctIndex || 0, 10)];
        qs.push(b);
        i += 1;
      }
    }
  }

  const out = [];
  qs.forEach((q, idx) => {
    const i = idx + 1;
    if (!q || typeof q !== "object") return;
    const opts = q.options || [];
    if (!Array.isArray(opts) || opts.length !== 4) return;
    let ci = parseInt(q.correctIndex, 10);
    if (Number.isNaN(ci)) ci = 0;
    if (ci < 0 || ci > 3) ci = 0;
    const questionText = q.question || "";
    out.push({
      id: q.id || `${section.toUpperCase()}-${i}`,
      section,
      subsection: q.subsection || "",
      difficulty: q.difficulty || difficulty,
      topic: q.topic || "",
      question: questionText,
      options: opts,
      correctIndex: ci,
      answerText: q.answerText || opts[ci],
      explanation: q.explanation || "",
      marks: 1,
    });
    // Record what actually went out so the *next* generation's "avoid repeating" prompt hint
    // (built from RECENT_MCQ_HASHES above) has something real to avoid — this was previously
    // read from but never written to, so it stayed permanently empty and every generation had
    // nothing to avoid repeating.
    if (questionText.trim()) pushRecentMcqHash(questionText.trim().slice(0, 200));
  });
  return out;
}

export function defaultStarterCode() {
  return {
    python:
      "import sys\n\ndef solve():\n    data = sys.stdin.read().strip().split()\n    # TODO: parse input and implement\n    # print(result)\n    return\n\nif __name__ == '__main__':\n    solve()\n",
    java:
      "import java.io.*;\nimport java.util.*;\n\npublic class Main {\n  static void solve(FastScanner fs, StringBuilder out) throws Exception {\n    // TODO: implement\n  }\n\n  public static void main(String[] args) throws Exception {\n    FastScanner fs = new FastScanner(System.in);\n    StringBuilder out = new StringBuilder();\n    solve(fs, out);\n    System.out.print(out.toString());\n  }\n\n  static class FastScanner {\n    private final InputStream in;\n    private final byte[] buffer = new byte[1 << 16];\n    private int ptr = 0, len = 0;\n    FastScanner(InputStream is){ in=is; }\n    private int read() throws IOException {\n      if (ptr >= len) {\n        len = in.read(buffer);\n        ptr = 0;\n        if (len <= 0) return -1;\n      }\n      return buffer[ptr++];\n    }\n    String next() throws IOException {\n      StringBuilder sb = new StringBuilder();\n      int c;\n      while ((c = read()) != -1 && c <= ' ') {}\n      if (c == -1) return null;\n      do { sb.append((char)c); } while ((c = read()) != -1 && c > ' ');\n      return sb.toString();\n    }\n    Integer nextInt() throws IOException {\n      String s = next();\n      return s == null ? null : Integer.parseInt(s);\n    }\n  }\n}\n",
    c:
      "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n\nint main(void) {\n    // TODO: read input from stdin and implement\n    // printf(\"%d\\n\", ans);\n    return 0;\n}\n",
    cpp:
      "#include <bits/stdc++.h>\nusing namespace std;\n\nint main(){\n  ios::sync_with_stdio(false);\n  cin.tie(nullptr);\n\n  // TODO: parse input and implement\n\n  return 0;\n}\n",
  };
}

/** Merge model-provided starterCode with defaults. UI expects keys: python, java, c, cpp. */
export function mergeStarterCode(modelValue) {
  const defaults = defaultStarterCode();
  if (!modelValue) return defaults;
  if (typeof modelValue === "string") {
    const s = modelValue.trim();
    if (s) defaults.python = s;
    return defaults;
  }
  if (typeof modelValue !== "object" || Array.isArray(modelValue)) return defaults;

  const norm = {};
  for (let [k, v] of Object.entries(modelValue)) {
    if (typeof v !== "string" || !v.trim()) continue;
    let kk = String(k).trim().toLowerCase();
    if (["py", "python3"].includes(kk)) kk = "python";
    if (["c++", "cpp17", "c++17", "cplusplus", "cxx"].includes(kk)) kk = "cpp";
    if (["c", "java", "python", "cpp"].includes(kk)) norm[kk] = v;
  }
  return { ...defaults, ...norm };
}

/** Ensure starter templates include a runnable entrypoint. */
export function ensureMainInStarter(code, lang) {
  if (typeof code !== "string") code = "";
  let c = code.replace(/^\n+|\n+$/g, "");
  const l = (lang || "python").trim().toLowerCase();

  if (l === "sql") {
    return typeof code === "string" && code.trim() ? code : sqlStarterQuery();
  }

  if (["py", "python", "python3"].includes(l)) {
    if (c.includes("if __name__")) return code;
    if (!c.includes("def solve")) {
      c = ("def solve(inp: str) -> str:\n    # TODO: implement\n    return \"\"\n\n" + c).replace(/^\n+|\n+$/g, "");
    }
    return c + "\n\nif __name__ == '__main__':\n    import sys\n    data = sys.stdin.read()\n    out = solve(data)\n    if out is None: out = ''\n    sys.stdout.write(str(out))\n";
  }

  if (l === "java") {
    if (c.includes("public static void main")) return code;
    return (
      "import java.io.*;\nimport java.util.*;\n\n" +
      "public class Main {\n" +
      "    // TODO: implement solve(String)\n" +
      "    static String solve(String inp) {\n" +
      "        return \"\";\n" +
      "    }\n\n" +
      "    public static void main(String[] args) throws Exception {\n" +
      "        StringBuilder sb = new StringBuilder();\n" +
      "        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));\n" +
      "        String line;\n" +
      "        while ((line = br.readLine()) != null) sb.append(line).append('\\n');\n" +
      "        String out = solve(sb.toString());\n" +
      "        if (out == null) out = \"\";\n" +
      "        System.out.print(out);\n" +
      "    }\n" +
      "}\n" +
      (c ? "\n\n" + c : "")
    );
  }

  if (["cpp", "c++", "cpp17", "c++17"].includes(l)) {
    if (c.includes("int main")) return code;
    return (
      "#include <bits/stdc++.h>\nusing namespace std;\n\n" +
      "// TODO: implement solve(string)\n" +
      "string solve(const string& inp){\n" +
      "    return \"\";\n" +
      "}\n\n" +
      "int main(){\n" +
      "    ios::sync_with_stdio(false);\n" +
      "    cin.tie(nullptr);\n" +
      "    std::ostringstream ss;\n" +
      "    ss << cin.rdbuf();\n" +
      "    cout << solve(ss.str());\n" +
      "    return 0;\n" +
      "}\n" +
      (c ? "\n\n" + c : "")
    );
  }

  if (l === "c") {
    if (c.includes("int main")) return code;
    return (
      "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n\n" +
      "// TODO: implement solve(const char*)\n" +
      "char* solve(const char* inp){\n" +
      "    char* out = (char*)malloc(1);\n" +
      "    out[0] = '\\0';\n" +
      "    return out;\n" +
      "}\n\n" +
      "int main(){\n" +
      "    fseek(stdin, 0, SEEK_END);\n" +
      "    long n = ftell(stdin);\n" +
      "    fseek(stdin, 0, SEEK_SET);\n" +
      "    if (n < 0) n = 0;\n" +
      "    char* buf = (char*)malloc((size_t)n + 1);\n" +
      "    size_t r = fread(buf, 1, (size_t)n, stdin);\n" +
      "    buf[r] = '\\0';\n" +
      "    char* out = solve(buf);\n" +
      "    if (out) { printf(\"%s\", out); free(out); }\n" +
      "    free(buf);\n" +
      "    return 0;\n" +
      "}\n" +
      (c ? "\n\n" + c : "")
    );
  }

  return code;
}

/** Pick best starter code for this problem and language. */
export function starterCodeForProblem(problem, lang) {
  const l = String((problem || {}).type || "").trim().toLowerCase() === "sql" ? "sql" : (lang || "python").trim().toLowerCase();
  const sc = (problem || {}).starterCode || (problem || {}).starter_code || {};
  if (sc && typeof sc === "object") {
    let cand = sc[l];
    if (typeof cand === "string" && cand.trim()) return ensureMainInStarter(cand, l);
    cand = sc.sql || sc.python || sc.java || sc.cpp || sc.c;
    if (typeof cand === "string" && cand.trim()) return ensureMainInStarter(cand, l);
  }
  const defaults = defaultStarterCode();
  return ensureMainInStarter(defaults[l] || defaults.python, l);
}

function tcValid(tc) {
  if (!tc || typeof tc !== "object") return false;
  const s = String(tc.stdin ?? "").trim();
  return s.length > 0;
}

function normTc(tc) {
  if (!tc || typeof tc !== "object") return { stdin: "", expected: "" };
  return { stdin: String(tc.stdin ?? ""), expected: String(tc.expected ?? "") };
}

function tcKey(tc) {
  try {
    const rawIn = String((tc || {}).stdin || "");
    const s = rawIn.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return s.trim().split(/\s+/).join(" ");
  } catch {
    return "";
  }
}

function codingFullMarks(diff) {
  const d = (diff || "").trim().toLowerCase();
  if (d === "easy") return 15;
  if (d === "medium") return 20;
  if (["hard", "difficult"].includes(d)) return 25;
  return 20;
}

/** Generate DSA coding problems + hidden tests + python reference solution, validated via the code runner. */
export async function mocktestGenerateCodingProblems(n, difficulty = "mixed", topic = "") {
  n = parseInt(n || 0, 10);
  if (n <= 0) return [];

  difficulty = (difficulty || "mixed").trim().toLowerCase();
  if (!["easy", "mixed", "medium", "hard"].includes(difficulty)) difficulty = "mixed";

  const avoidTitles = RECENT_CODING_TITLES.slice(-50);
  topic = (topic || "").trim();
  const topicHint = topic ? `Focus topic: ${topic}.` : "Topic: Mix common DSA topics.";

  const prompt =
    `You are generating coding problems for a mock test platform.\n${topicHint}\n` +
    "Return STRICT JSON ONLY. No markdown.\n\n" +
    "Return JSON with key 'problems' (array). Each problem must include: id/slug, title, difficulty (easy|medium|hard), topics (array), statement, inputFormat, outputFormat, constraints (array), starterCode (python/java/cpp) [UNSOLVED TEMPLATE ONLY - no working solution; include only skeleton + input reading + TODO comments], solutionHint, tests.\n\n" +
    "COMPLEXITY: Also include 'timeComplexity' and 'spaceComplexity' as Big-O strings (e.g., \"O(n log n)\", \"O(1)\").\n" +
    "TESTS: Provide EXACTLY 20 tests per problem in 'tests'. You MUST provide 5 sample tests (isSample=true) and the remaining 15 tests must be hidden (isSample=false). Total tests must be 20 (5 sample + 15 hidden).\n" +
    "CRITICAL: All testcases must be UNIQUE. Do NOT repeat the same input (even with different spacing/newlines). Hidden tests MUST NOT duplicate any sample test. If you are struggling, create new edge-case variations, but never repeat an input.\n" +
    "Each test item: {stdin, expected, isSample}.\n" +
    "expected must match exact output. Include edge cases.\n\n" +
    (avoidTitles.length ? `Avoid repeating any of these titles (do NOT reuse): ${JSON.stringify(avoidTitles)}.\n` : "") +
    `Generate ${n} problems.\n`;

  let probs = [];
  let lastErr = null;
  console.log(`[coding-gen] requesting ${n} problem(s), difficulty=${difficulty}${topic ? `, topic=${topic}` : ""}`);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const t0 = Date.now();
    try {
      // This prompt asks for a lot of structured output (20 testcases + 3-language starter
      // code per problem) — give it a generous explicit budget so "thinking" tokens can't
      // silently starve the actual JSON output (see getGeminiResponse's note on this model's
      // thinking-token overhead).
      const obj = (await geminiJsonSafe(prompt, { maxOutputTokens: 32768 })) || {};
      probs = Array.isArray(obj.problems) ? obj.problems : [];
      console.log(`[coding-gen] attempt=${attempt}/4 got ${probs.length} problem(s) in ${Date.now() - t0}ms`);
      if (!probs.length) {
        // geminiJsonSafe successfully parsed *something* (otherwise it would have logged its own
        // "couldn't find/parse JSON" diagnostic) — so this is the model returning valid JSON that
        // just doesn't have a non-empty "problems" array. Show what it actually sent so this isn't
        // another dead end.
        console.log(`[coding-gen] attempt=${attempt}/4 parsed object had no usable "problems" array. Keys: ${JSON.stringify(Object.keys(obj))}. Preview: ${JSON.stringify(obj).slice(0, 500)}`);
      }
      if (probs.length) {
        lastErr = null;
        break;
      }
    } catch (e) {
      lastErr = e;
      probs = [];
      console.log(`[coding-gen] attempt=${attempt}/4 FAILED in ${Date.now() - t0}ms: ${e.message || e}`);
      // A quota/rate-limit error will fail identically on every retry — retrying just burns
      // more of the (often very limited, e.g. free-tier) daily quota for no benefit.
      if (isQuotaError(e)) {
        console.log("[coding-gen] quota/rate-limit error detected — stopping retries early");
        break;
      }
    }
  }

  if (!probs.length) {
    console.log(`[coding-gen] FAILED after all attempts. lastErr=${lastErr ? lastErr.message || lastErr : "(none — model returned no problems)"}`);
    if (lastErr && isQuotaError(lastErr)) throw lastErr;
    throw new Error(`Gemini failed to generate coding problems. Please regenerate.${lastErr ? ` Details: ${lastErr.message || lastErr}` : ""}`);
  }

  console.log(`[coding-gen] validating ${probs.length} problem(s) via the code runner (executing testcases)...`);

  const out = [];
  for (let idx = 0; idx < probs.length; idx++) {
    const i = idx + 1;
    const p = probs[idx];
    if (!p || typeof p !== "object") continue;

    let tests = p.tests || p.testcases || [];
    let samples = [];
    let hid = [];

    if (Array.isArray(tests) && tests.length) {
      const taggedSamples = tests.filter((t) => t && typeof t === "object" && t.isSample === true);
      const taggedHidden = tests.filter((t) => t && typeof t === "object" && t.isSample === false);
      if (taggedSamples.length || taggedHidden.length) {
        samples = taggedSamples.slice(0, 4);
        hid = taggedHidden;
      } else {
        samples = tests.slice(0, 4).filter((t) => t && typeof t === "object");
        hid = tests.slice(4, 8).filter((t) => t && typeof t === "object");
      }
    } else {
      samples = p.samples || [];
      hid = p.hiddenTests || [];
    }
    if (!Array.isArray(samples)) samples = [];
    if (!Array.isArray(hid)) hid = [];

    if (samples.length > 4) {
      hid = [...hid, ...samples.slice(4)];
      samples = samples.slice(0, 4);
    }
    samples = samples.slice(0, 4);

    samples = samples.filter(tcValid);
    hid = hid.filter(tcValid);

    if (samples.length === 0) {
      if (hid.length > 0) {
        samples = [hid.shift()];
      } else {
        samples = [{ stdin: "1\n", expected: "" }];
      }
    }

    samples = samples.map(normTc);
    hid = hid.map(normTc);

    const wantSamples = 4;
    const totalTestsMap = { easy: 8, medium: 15, hard: 20, mixed: 15 };
    const wantTotal = totalTestsMap[difficulty] ?? 8;

    let problemText;
    try {
      const cons = Array.isArray(p.constraints) ? p.constraints : [];
      problemText =
        `${p.title || ""}\n${p.statement || ""}\n\n` +
        `Input Format:\n${p.inputFormat || ""}\n\n` +
        `Output Format:\n${p.outputFormat || ""}\n\n` +
        `Constraints:\n` +
        cons.map((x) => String(x)).join("\n");
    } catch {
      problemText = p.statement || "";
    }
    let wantHidden = Math.max(0, wantTotal - wantSamples);

    while (samples.length < wantSamples && hid.length > 0) samples.push(hid.shift());
    while (samples.length < wantSamples) samples.push({ ...samples[0] });
    samples = samples.slice(0, wantSamples);

    const seenInputs = new Set();
    const uniqSamples = [];
    for (const tc of samples) {
      if (!tc || typeof tc !== "object") continue;
      const k = tcKey(tc);
      if (!k || seenInputs.has(k)) continue;
      seenInputs.add(k);
      uniqSamples.push(tc);
    }
    samples = uniqSamples.slice(0, wantSamples);

    const uniqHid = [];
    for (const tc of hid) {
      if (!tc || typeof tc !== "object") continue;
      const k = tcKey(tc);
      if (!k || seenInputs.has(k)) continue;
      seenInputs.add(k);
      uniqHid.push(tc);
    }
    hid = uniqHid;

    let needHidden = Math.max(0, wantHidden - hid.length);
    let regenAttempts = 0;
    while (needHidden > 0 && regenAttempts < 3) {
      regenAttempts += 1;
      const avoidList = [...seenInputs].filter(Boolean).slice(0, 80);
      const regenPrompt = `You are generating additional HIDDEN testcases for this coding problem.

Problem:
${(problemText || "").trim().slice(0, 2500)}

Generate EXACTLY ${needHidden} NEW hidden testcases.
Rules:
- Each testcase must be valid for the problem.
- Inputs MUST be different from all inputs in this avoid list (compare after whitespace normalization): ${JSON.stringify(avoidList)}
- Return STRICT JSON only:
{ "hidden": [ { "stdin": "....", "expected": "...." } ] }
`;
      const extra = (await geminiJsonSafe(regenPrompt)) || {};
      const extraHid = extra.hidden || extra.testcases || [];
      let added = 0;
      for (const tc of extraHid) {
        if (!tc || typeof tc !== "object") continue;
        const k = tcKey(tc);
        if (!k || seenInputs.has(k)) continue;
        seenInputs.add(k);
        hid.push(normTc(tc));
        added += 1;
        if (hid.length >= wantHidden) break;
      }
      if (added === 0) break;
      needHidden = Math.max(0, wantHidden - hid.length);
    }

    hid = hid.slice(0, wantHidden);

    const ref = (p.referencePython || "").trim();
    let refOk = true;
    if (ref) {
      for (const t of hid.slice(0, 6)) {
        if (!t || typeof t !== "object") {
          refOk = false;
          break;
        }
        try {
          const jr = await codeRun(ref, t.stdin || "", "python", { expected: t.expected || "" });
          if (!jr.passed) {
            refOk = false;
            break;
          }
        } catch {
          refOk = false;
          break;
        }
      }
    }

    out.push({
      id: p.id || p.slug || `CODING-${i}`,
      slug: p.slug || "",
      difficulty: p.difficulty || difficulty,
      topic: p.topic || "",
      topics: Array.isArray(p.topics) ? p.topics : [],
      title: p.title || `Coding Problem ${i}`,
      statement: p.statement || "",
      inputFormat: p.inputFormat || "",
      outputFormat: p.outputFormat || "",
      constraints: Array.isArray(p.constraints) ? p.constraints : [],
      samples,
      hiddenTests: hid,
      total_marks: samples.length + hid.length,
      starterCode: mergeStarterCode(p.starterCode),
      solutionHint: p.solutionHint || "",
      timeComplexity: p.timeComplexity || "",
      spaceComplexity: p.spaceComplexity || "",
      meta: {
        referencePythonProvided: !!ref,
        referencePythonValidated: !!(ref && refOk),
        sampleCount: samples.length,
        hiddenCount: hid.length,
      },
    });
  }

  if (out.length === 0) {
    throw new Error("Gemini did not return any valid coding problems. Please regenerate.");
  }

  for (const pr of out) {
    const tt = (pr.title || pr.slug || "").trim();
    if (tt) pushRecentCodingTitle(tt);
  }

  return out;
}

const SQL_TESTCASE_PLAN = {
  easy: { samples: 2, hidden: 1, marks: 15 },
  medium: { samples: 2, hidden: 3, marks: 20 },
  hard: { samples: 3, hidden: 3, marks: 25 },
  mixed: { samples: 2, hidden: 3, marks: 20 },
};

/** Generate SQL practice problems with sample/hidden datasets validated against the SQL sandbox. */
export async function mocktestGenerateSqlProblems(n, difficulty = "mixed", topic = "") {
  n = Math.max(1, Math.min(40, parseInt(n || 1, 10)));
  difficulty = (difficulty || "mixed").trim().toLowerCase();
  const topicHint = sanitizeTopic(topic);

  const plan = SQL_TESTCASE_PLAN[difficulty] || SQL_TESTCASE_PLAN.mixed;
  const sampleNeed = plan.samples;
  const hiddenNeed = plan.hidden;

  // Shares the coding-problem title dedupe pool — same idea (avoid regenerating the same
  // problem across sessions), no need for a separate list.
  const avoidTitles = RECENT_CODING_TITLES.slice(-50);

  const prompt =
    "You are generating SQL practice problems for a mock/practice test platform.\n" +
    "Return STRICT JSON only with key 'problems' (array).\n" +
    `Generate exactly ${n} SQL problems. Difficulty: ${difficulty}.\n` +
    (topicHint ? `Focus topic: ${topicHint}.\n` : "") +
    "Generate SQL problems only. Do NOT generate Python/Java/C++ coding problems.\n" +
    "Each problem must include these keys: id, title, difficulty, topic, statement, schema_sql, sample_data_sqls, hidden_data_sqls, reference_sql.\n" +
    "Rules:\n" +
    "- Use SQLite-compatible SQL only.\n" +
    "- schema_sql must contain CREATE TABLE statements only.\n" +
    `- sample_data_sqls must be an array of exactly ${sampleNeed} INSERT-only SQL scripts for visible sample datasets.\n` +
    `- hidden_data_sqls must be an array of exactly ${hiddenNeed} INSERT-only SQL scripts for hidden datasets.\n` +
    "- reference_sql must be a single SELECT query that solves the problem.\n" +
    "- Keep schemas small: 1 to 3 tables max.\n" +
    "- Make result sets deterministic using explicit ORDER BY in reference_sql.\n" +
    (avoidTitles.length ? `- Avoid repeating any of these titles (do NOT reuse): ${JSON.stringify(avoidTitles)}.\n` : "");

  // Same reasoning as the coding-problem generator: schema + multiple sample/hidden dataset SQL
  // scripts per problem is a lot of structured output — give it room to avoid truncation.
  console.log(`[sql-gen] requesting ${n} problem(s), difficulty=${difficulty}${topicHint ? `, topic=${topicHint}` : ""}`);

  let arr = [];
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    try {
      const raw = (await geminiJsonSafe(prompt, { maxOutputTokens: 16384 })) || {};
      arr = Array.isArray(raw.problems) ? raw.problems : [];
      console.log(`[sql-gen] attempt=${attempt}/3 got ${arr.length} candidate problem(s) in ${Date.now() - t0}ms`);
      if (arr.length) {
        lastErr = null;
        break;
      }
    } catch (e) {
      lastErr = e;
      arr = [];
      console.log(`[sql-gen] attempt=${attempt}/3 FAILED in ${Date.now() - t0}ms: ${e.message || e}`);
      if (isQuotaError(e)) {
        console.log("[sql-gen] quota/rate-limit error detected — stopping retries early");
        break;
      }
    }
  }
  if (lastErr && isQuotaError(lastErr)) throw lastErr;

  const out = [];

  arr.forEach((p, idx) => {
    const i = idx + 1;
    const tag = `[sql-gen] problem ${i}/${arr.length}`;
    if (!p || typeof p !== "object") {
      console.log(`${tag} rejected: not an object`);
      return;
    }
    const schemaSql = String(p.schema_sql || "").trim();
    let sampleArr = Array.isArray(p.sample_data_sqls) ? p.sample_data_sqls : [];
    sampleArr = sampleArr.map((x) => String(x || "").trim()).filter(Boolean);
    if (!sampleArr.length) {
      const legacySample = String(p.sample_data_sql || "").trim();
      if (legacySample) sampleArr = [legacySample];
    }
    let hiddenArr = Array.isArray(p.hidden_data_sqls) ? p.hidden_data_sqls : [];
    hiddenArr = hiddenArr.map((x) => String(x || "").trim()).filter(Boolean);
    const refSql = String(p.reference_sql || "").trim();
    if (!schemaSql || !sampleArr.length || !hiddenArr.length || !refSql) {
      console.log(
        `${tag} rejected: missing required field(s) — schema_sql=${!!schemaSql} sample_data_sqls=${sampleArr.length} hidden_data_sqls=${hiddenArr.length} reference_sql=${!!refSql}`
      );
      return;
    }

    if (sampleArr.length < sampleNeed) {
      const repeated = [];
      while (repeated.length < sampleNeed) repeated.push(...sampleArr);
      sampleArr = repeated.slice(0, sampleNeed);
    } else {
      sampleArr = sampleArr.slice(0, sampleNeed);
    }
    if (hiddenArr.length < hiddenNeed) {
      const repeated = [];
      while (repeated.length < hiddenNeed) repeated.push(...hiddenArr);
      hiddenArr = repeated.slice(0, hiddenNeed);
    } else {
      hiddenArr = hiddenArr.slice(0, hiddenNeed);
    }

    const datasets = [];
    const samplePreviews = [];
    const pandasSeedSql = sampleArr[0] || "";
    try {
      sampleArr.forEach((ssql, sidx) => {
        const sampleRes = executeSqlQuery(schemaSql + "\n" + ssql, refSql);
        datasets.push({
          label: `Sample dataset ${sidx + 1}`,
          setup_sql: ssql,
          expected_columns: sampleRes.columns || [],
          expected_rows: sampleRes.rows || [],
          hidden: false,
        });
        samplePreviews.push({ stdin: ssql, expected: sqlRowsToText(sampleRes.rows || [], sampleRes.columns || []) });
      });
      hiddenArr.forEach((hsql, hidx) => {
        const hiddenRes = executeSqlQuery(schemaSql + "\n" + hsql, refSql);
        datasets.push({
          label: `Hidden dataset ${hidx + 1}`,
          setup_sql: hsql,
          expected_columns: hiddenRes.columns || [],
          expected_rows: hiddenRes.rows || [],
          hidden: true,
        });
      });
    } catch (e) {
      // This is the SQL the model itself wrote, executed against a real (better-sqlite3) engine
      // to build the expected outputs — the model's SQL not actually running (schema mismatch,
      // SQLite dialect slip, reference_sql referencing a column that doesn't exist, etc.) is a
      // completely plausible and previously invisible way for every candidate to get silently
      // dropped, ending in "no valid SQL problems" with zero indication why.
      console.log(`${tag} rejected: SQL execution failed — ${e.message || e}`);
      return;
    }

    const pid = String(p.id || `sql_${i}_${crypto.randomUUID().slice(0, 8)}`);
    const title = String(p.title || `SQL Problem ${i}`).trim() || `SQL Problem ${i}`;
    pushRecentCodingTitle(title);
    const ptopic = sanitizeTopic(String(p.topic || topicHint || "SQL")) || "SQL";
    let fullStatement = String(p.statement || "").trim();
    fullStatement += "\n\nReturn the final result as a SELECT query only.";
    const pdiff = String(p.difficulty || difficulty || "medium").trim().toLowerCase() || "medium";
    const plan2 = SQL_TESTCASE_PLAN[pdiff] || plan;

    out.push({
      id: pid,
      title,
      difficulty: pdiff,
      topic: ptopic,
      topics: [ptopic, "SQL"],
      type: "sql",
      statement: fullStatement,
      inputFormat: "The SQLite database is already prepared using the schema and dataset shown in the prompt.",
      constraints: ["Write one SELECT query only", "Use SQLite-compatible syntax", "Use ORDER BY when needed for deterministic output"],
      samples: samplePreviews,
      hiddenTests: [],
      starterCode: { sql: sqlStarterQuery() },
      solutionHint: "Think about joins, filtering, grouping, or subqueries based on the requirement.",
      timeComplexity: "SQL dependent",
      spaceComplexity: "SQL dependent",
      total_marks: plan2.marks,
      sql_meta: {
        schema_sql: schemaSql,
        pandas_schema: buildSqlPandasSchema(schemaSql, pandasSeedSql),
        sample_datasets: datasets.filter((d) => !d.hidden),
        hidden_datasets: datasets.filter((d) => d.hidden),
        reference_sql: refSql,
      },
    });
  });

  if (!out.length) {
    console.log(`[sql-gen] FAILED: ${arr.length} candidate(s) from Gemini, 0 survived validation (see rejection reasons above)`);
    throw new Error("Gemini did not return any valid SQL problems. Please regenerate.");
  }
  console.log(`[sql-gen] succeeded: ${out.length}/${n} problem(s) validated`);
  return out;
}

export { codingFullMarks };
