import pdfParse from "pdf-parse";
import mammoth from "mammoth";

/** Extract text from PDF bytes; cap size to avoid huge prompts. */
export async function extractPdfTextBytes(pdfBytes, maxChars = 250_000) {
  try {
    const data = await pdfParse(pdfBytes);
    const text = (data.text || "").trim();
    return text.slice(0, maxChars);
  } catch {
    return "";
  }
}

export function isDocxFilename(name) {
  const n = (name || "").toLowerCase();
  return n.endsWith(".docx") || n.endsWith(".docm");
}

/** Extract plain text from DOCX bytes. */
export async function extractDocxTextBytes(docxBytes, maxChars = 250_000) {
  try {
    const result = await mammoth.extractRawText({ buffer: docxBytes });
    const text = (result.value || "").trim();
    return text.slice(0, maxChars);
  } catch {
    return "";
  }
}

/** Returns {text, kind, data} where kind in {pdf, docx, unknown}. `file` is a multer file object. */
export async function extractResumeText(file) {
  const filename = file?.originalname || "";
  const ctype = file?.mimetype || "";
  const data = file?.buffer || Buffer.alloc(0);

  let kind = "unknown";
  let text = "";
  if (ctype.includes("pdf") || filename.toLowerCase().endsWith(".pdf")) {
    kind = "pdf";
    text = await extractPdfTextBytes(data);
  } else if (ctype.includes("word") || isDocxFilename(filename)) {
    kind = "docx";
    text = await extractDocxTextBytes(data);
  } else {
    text = await extractPdfTextBytes(data);
    if (text) {
      kind = "pdf";
    } else {
      text = await extractDocxTextBytes(data);
      if (text) kind = "docx";
    }
  }
  return { text: text || "", kind, data };
}
