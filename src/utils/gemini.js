import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "../config/env.js";

const genAI = new GoogleGenerativeAI(config.googleApiKey);

export function isQuotaError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") || msg.includes("resource exhausted");
}

export function extractRetryAfterSeconds(msg) {
  try {
    const m = String(msg || "").match(/retry in ([0-9]+(?:\.[0-9]+)?)s/i);
    if (m) return parseFloat(m[1]);
  } catch {}
  return null;
}

export async function generateContent(prompt, modelName = "gemini-3.5-flash", generationConfig) {
  const model = genAI.getGenerativeModel({ model: modelName, generationConfig });
  const result = await model.generateContent(prompt);
  return result.response;
}

/** Mirrors get_gemini_response(): returns response text, raising on quota errors.
 * `maxOutputTokens`, when given, is forwarded as generationConfig — the SDK doesn't set one by
 * default, and this model has "thinking" enabled (spends part of its output budget on internal
 * reasoning before writing the actual answer — e.g. ~59 thinking tokens vs 1 real output token
 * for a trivial "Say OK" prompt). For prompts that ask for a lot of structured output (long JSON
 * with many fields), the default budget can be consumed by thinking before any real content gets
 * written, silently producing an empty/near-empty response instead of an error.
 */
export async function getGeminiResponse(inputPrompt, { maxOutputTokens } = {}) {
  const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash",
    generationConfig: maxOutputTokens ? { maxOutputTokens } : undefined,
  });
  let response;
  try {
    const result = await model.generateContent(inputPrompt);
    response = result.response;
  } catch (e) {
    if (isQuotaError(e)) throw new Error("quota exceeded");
    throw e;
  }
  const text = (response?.text?.() || "").trim();
  if (!text) {
    const finishReason = response?.candidates?.[0]?.finishReason;
    const usage = response?.usageMetadata;
    console.log(
      `[gemini] empty text response. finishReason=${finishReason} usageMetadata=${JSON.stringify(usage)}`
    );
    throw new Error("Gemini API returned no candidates.");
  }
  return text;
}

export function stripCodeFences(s) {
  if (!s) return s;
  let out = s.trim().replace(/^```(?:json)?\s*/i, "");
  out = out.replace(/\s*```$/, "");
  return out.trim();
}

export function removeTrailingCommas(s) {
  return s.replace(/,\s*([}\]])/g, "$1");
}

export function findFirstJsonSpan(text) {
  if (!text) return null;
  let start = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      start = i;
      break;
    }
  }
  if (start === null) return null;

  const stack = [];
  let inStr = false;
  let esc = false;

  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      if (!stack.length) return null;
      const top = stack.pop();
      if ((top === "{" && ch !== "}") || (top === "[" && ch !== "]")) return null;
      if (!stack.length) return text.slice(start, j + 1);
    }
  }
  return null;
}

/** Defensive JSON parsing for LLM outputs (mirrors safe_json_parse). */
export function safeJsonParse(modelText) {
  if (!modelText || !String(modelText).trim()) throw new Error("Empty model output");

  const raw = stripCodeFences(String(modelText));
  let span = findFirstJsonSpan(raw);
  if (span === null) {
    const raw2 = raw.replace(/^[^[{]*/s, "");
    span = findFirstJsonSpan(raw2);
  }
  if (span === null) throw new Error("Could not parse mindmap JSON from model output.");

  span = removeTrailingCommas(span);
  try {
    return JSON.parse(span);
  } catch {
    const repaired = removeTrailingCommas(span.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
    return JSON.parse(repaired);
  }
}

/** Ask Gemini to repair arbitrary text into strict JSON mindmap shape. */
export async function repairJsonWithGemini(badText) {
  badText = (badText || "").trim();
  if (!badText) return "";
  const prompt = `You are a strict JSON repair tool.

Return ONLY valid JSON. No markdown. No commentary. No code fences.

Target schema (recursive):
{"name": string, "children": [ ... ]}

Rules:
- Use double quotes for all keys/strings.
- No trailing commas.
- Ensure all brackets/braces are closed.
- Remove any non-JSON text.
- If input is truncated, COMPLETE the JSON in the most likely way.
- Keep labels short (2–8 words).

Input:
${badText}
`;
  try {
    const response = await generateContent(prompt);
    const text = (response?.text?.() || "").trim();
    return stripCodeFences(text);
  } catch {
    return "";
  }
}

/** Generic helper: ask Gemini for JSON and parse it defensively. */
export async function geminiJson(prompt, modelName = "gemini-3.5-flash") {
  const response = await generateContent(prompt, modelName);
  const text = (response?.text?.() || "").trim();
  return safeJsonParse(text);
}

export default genAI;
