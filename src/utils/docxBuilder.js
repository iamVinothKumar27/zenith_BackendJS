import { Document, Packer, Paragraph, HeadingLevel } from "docx";

// Deviation from Python: python-docx mutates an uploaded template's paragraphs in place
// (_docx_replace_section) so the user's original formatting is preserved. Node has no
// equivalent in-place OOXML editor, so we always generate a clean, freshly-built DOCX
// from the structured tailored sections instead of mutating an uploaded template.
export async function buildTailoredResumeDocx(tailoredSections, title = "TAILORED RESUME") {
  const t = tailoredSections || {};
  const summaryLines = t.professional_summary || [];
  const skillsLines = t.skills || [];
  const expBullets = t.experience_bullets || [];
  const projBullets = t.projects_bullets || [];
  const eduLines = t.education_lines || [];

  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];

  const addSection = (heading, lines, bullet) => {
    const items = (lines || []).map(String).filter((l) => l.trim());
    if (!items.length) return;
    children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_1 }));
    for (const line of items) {
      children.push(new Paragraph({ text: line, bullet: bullet ? { level: 0 } : undefined }));
    }
  };

  addSection("Professional Summary", summaryLines, false);
  addSection("Skills", skillsLines, true);
  addSection("Experience", expBullets, true);
  addSection("Projects", projBullets, true);
  addSection("Education", eduLines, false);

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// Deviation from Python: _pdf_bytes_to_docx_document used pdf2docx for a best-effort
// PDF->DOCX conversion. No equivalent exists in Node; this always returns null, matching
// the Python code's own graceful fallback when pdf2docx isn't installed.
export async function pdfBytesToDocxDocument(_pdfBytes) {
  return null;
}
