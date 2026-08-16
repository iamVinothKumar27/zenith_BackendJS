import { config } from "../config/env.js";
import genAI, { isQuotaError, extractRetryAfterSeconds, safeJsonParse, repairJsonWithGemini } from "./gemini.js";

function stripFences(s) {
  s = (s || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "");
  s = s.replace(/\s*```$/, "");
  return s.trim();
}

/** Mirrors Python's _clean_json_text: strip fences, slice to outermost {..}, drop trailing commas. */
function cleanJsonText(s) {
  if (!s) return "";
  let txt = s.trim();
  txt = txt.replace(/^```(?:json)?\s*/i, "");
  txt = txt.replace(/```\s*$/, "");
  const first = txt.indexOf("{");
  const last = txt.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    txt = txt.slice(first, last + 1);
  }
  txt = txt.replace(/,\s*([}\]])/g, "$1");
  return txt.trim();
}

function cleanLabels(node, safeTitle) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return { name: safeTitle, children: [] };
  }
  let name = String(node.name || "").trim();
  const strippedGreeting = name.replace(/^(hello|hi)\b.*$/i, "").trim();
  name = strippedGreeting || name;
  const strippedOutro = name.replace(/\b(thanks for watching|please subscribe|hit the bell)\b.*$/i, "").trim();
  name = strippedOutro || name;
  const words = name.match(/[A-Za-z0-9][A-Za-z0-9-]*/g);
  name = words && words.length ? words.slice(0, 10).join(" ") : node.name || "Item";

  let kids = node.children;
  if (!Array.isArray(kids)) kids = [];
  const cleanedChildren = kids.filter((c) => c && typeof c === "object").map((c) => cleanLabels(c, safeTitle));
  const finalChildren = cleanedChildren.filter((c) => String(c.name || "").trim());
  return { name, children: finalChildren };
}

/** Heuristic fallback mindmap builder (works even without API key / on quota exhaustion). */
export function buildFallbackMindmap(transcript, safeTitle) {
  const sentences = (transcript.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []).map((s) => s.trim()).filter(Boolean);

  const norm = (s) => (s || "").trim().replace(/\s+/g, " ");

  const cleanLabel = (s, maxWords = 8) => {
    s = norm(s);
    s = s.replace(/^(hello|hi)\b.*?\b(tutorial|video)\b[:,\-\s]*/i, "");
    s = s.replace(/\b(please\s+subscribe|thanks\s+for\s+watching|hit\s+the\s+bell)\b.*$/i, "");
    const words = s.match(/[A-Za-z0-9-]+/g);
    if (!words || !words.length) return "Item";
    return words.slice(0, maxWords).join(" ");
  };

  const pickPoints = (keywords, maxItems = 7, maxWords = 7) => {
    const kws = keywords.filter(Boolean).map((k) => k.toLowerCase());
    const out = [];
    const seen = new Set();
    for (const s of sentences) {
      const sl = s.toLowerCase();
      if (kws.some((k) => sl.includes(k))) {
        const lab = cleanLabel(s, maxWords);
        if (seen.has(lab.toLowerCase())) continue;
        seen.add(lab.toLowerCase());
        out.push(lab);
      }
      if (out.length >= maxItems) break;
    }
    return out;
  };

  const branch = (name, points) => ({ name, children: points.map((p) => ({ name: p, children: [] })) });

  const textL = transcript.toLowerCase();
  const hasGd = textL.includes("gradient descent");
  const hasCost = textL.includes("cost function");
  const hasLr = textL.includes("learning rate");
  const hasNn = textL.includes("neural network") || textL.includes("weights") || textL.includes("bias");

  const children = [];

  const overview = pickPoints(["in this video", "you will learn", "let's", "we will", "today"], 4, 8);
  const purpose = pickPoints(["used to", "purpose", "optimiz", "train", "minimiz", "improve accuracy"], 5, 7);
  if (overview.length) children.push(branch("Overview", overview));
  if (purpose.length) children.push(branch("Definition and Purpose", purpose));

  let corePoints = [];
  if (hasGd) corePoints.push("Optimization algorithm", "Move downhill (minimize loss)");
  if (hasCost) corePoints.push("Cost function (prediction error)");
  if (hasLr) corePoints.push("Learning rate (step size)");
  if (hasNn) corePoints.push("Weights and biases", "Training on labeled data");
  corePoints = corePoints.concat(pickPoints(["cost function", "learning rate", "weights", "biases", "minimize", "reduce the cost"], 6, 7));
  const corePointsDedup = [];
  const seenCore = new Set();
  for (const p of corePoints) {
    const pl = p.toLowerCase();
    if (seenCore.has(pl)) continue;
    seenCore.add(pl);
    corePointsDedup.push(p);
  }
  if (corePointsDedup.length) children.push(branch("Key Concepts", corePointsDedup.slice(0, 10)));

  const howPoints = pickPoints(["take small steps", "direction", "downhill", "gradient", "update", "adjust", "repeat"], 8, 8);
  if (howPoints.length) children.push(branch("How it works", howPoints));

  const examplePoints = pickPoints(["example", "let's consider", "house", "sold for", "squiggle", "number", "mountain", "maze"], 7, 8);
  if (examplePoints.length) children.push(branch("Examples and Analogies", examplePoints));

  const typesPoints = [];
  if (textL.includes("batch")) typesPoints.push("Batch Gradient Descent");
  if (textL.includes("stochastic")) typesPoints.push("Stochastic Gradient Descent");
  if (textL.includes("mini") && textL.includes("batch")) typesPoints.push("Mini-batch Gradient Descent");
  if (typesPoints.length) children.push({ name: "Types of Gradient Descent", children: typesPoints.map((t) => ({ name: t, children: [] })) });

  const challPoints = pickPoints(["non-convex", "global minimum", "saddle", "vanishing", "exploding", "unstable", "struggle"], 8, 8);
  if (challPoints.length) children.push(branch("Challenges", challPoints));

  const takeaways = pickPoints(["powerful", "commonly used", "despite", "in summary", "end of this", "used to train"], 4, 8);
  if (takeaways.length) children.push(branch("Summary / Takeaways", takeaways));

  const finalChildren = children.length
    ? children
    : [
        { name: "Overview", children: [] },
        { name: "Key Concepts", children: [] },
        { name: "How it works", children: [] },
      ];

  return { name: safeTitle, children: finalChildren };
}

/** Generate a detailed, concept-focused JSON tree mindmap from a transcript. */
export async function generateMindmapTree(transcript, title = "Mindmap") {
  const safeTitle = (title || "Mindmap").trim().slice(0, 80);
  transcript = (transcript || "").trim();
  if (!transcript) return { name: safeTitle, children: [] };

  const prompt = `
You are an expert instructor. Read the transcript, infer the underlying concepts, and produce a DETAILED mindmap that helps a student study.

Output rules (STRICT):
- Output ONLY valid JSON (no markdown, no commentary, no backticks).
- Schema (recursive): {"name": string, "children": [schema]}
- Root MUST be exactly: {"name": "${safeTitle}", "children": [...]}
- Labels must be short: 2–8 words (no long sentences).
- Remove filler/intro/outro like: "hello everyone", "subscribe", "thanks for watching".
- Prefer concepts, definitions, steps, formulas, comparisons, examples, pitfalls.
- Expand acronyms when possible (e.g., SGD -> Stochastic Gradient Descent).
- Depth target: 4–6 levels.
- Breadth target: 6–10 top-level branches; each branch should have 3–10 children (when possible).
- If transcript is shallow, enrich with standard subtopics (1–2 nodes per concept) WITHOUT hallucinating facts.

Recommended top-level branches (adapt as relevant):
- Definition & Purpose
- Key Components / Concepts
- Workflow / Steps
- Examples / Applications
- Tools / Methods / Variants
- Comparisons (if any)
- Metrics / Evaluation (if any)
- Pitfalls / Challenges
- Summary / Takeaways

Transcript:
${transcript}
`.trim();

  try {
    const modelName = config.geminiMindmapModel || "gemini-3.5-flash";
    const model = genAI.getGenerativeModel({ model: modelName });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 3200,
        responseMimeType: "application/json",
      },
    });
    const resp = result.response;

    let raw = resp?.text?.() || "";
    raw = stripFences(raw);
    raw = cleanJsonText(raw);

    let data;
    try {
      data = safeJsonParse(raw);
    } catch (parseErr) {
      const repaired = await repairJsonWithGemini(raw);
      if (repaired) {
        try {
          data = safeJsonParse(repaired);
        } catch {
          throw parseErr;
        }
      } else {
        throw parseErr;
      }
    }

    if (!data || typeof data !== "object" || Array.isArray(data) || !("name" in data)) {
      throw new Error("Invalid mindmap JSON");
    }

    data.name = safeTitle;
    return cleanLabels(data, safeTitle);
  } catch (e) {
    console.log("❌ GEMINI MINDMAP FAILED:", e);
    if (isQuotaError(e)) {
      const ra = extractRetryAfterSeconds(String(e.message || e));
      const err = new Error("Gemini quota exceeded. Please retry later or enable billing.");
      err.retryAfter = ra;
      throw err;
    }
    return buildFallbackMindmap(transcript, safeTitle);
  }
}
