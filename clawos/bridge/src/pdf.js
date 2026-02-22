/**
 * PDF text extraction helper.
 * Wraps pdf-parse and returns { text, pageCount } or throws on failure.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

// pdf-parse is CJS-only; use createRequire to import it from ESM.
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

/**
 * @param {string} filePath  Local path to the PDF file
 * @returns {Promise<{ text: string, pageCount: number }>}
 */
export async function extractPdfText(filePath) {
  const buffer = await readFile(filePath);
  const data = await pdfParse(buffer);
  return {
    text: data.text ?? "",
    pageCount: data.numpages ?? 0,
  };
}
