import { confidentLetters, type PageRotation, type RotationScore } from "./pageOrientation";

/**
 * Detects an OCR read that silently dropped or cut short a scanned page. Both
 * checks count text in a machine format, never values a model states. Thresholds
 * and their measurements: designs/2026-09-14-political-disclosure-lake.md.
 */

/** OCR letters must reach this share of tesseract's confident letters on the upright page. */
export const MIN_OCR_LETTER_RATIO = 0.5;
/** Below this many tesseract letters a page is too blank to judge. */
export const MIN_TESSERACT_LETTERS = 40;

/** Two reads at different resolutions may differ by the larger of these in dated lines. */
export const MAX_DATED_LINE_SPREAD = 2;
export const MAX_DATED_LINE_SPREAD_FRACTION = 0.1;

const DATE_TOKEN = /\d{1,2}\/\d{1,2}\/\d{2,4}/;

/** Letters in the OCR markdown's words of three or more letters, table pipes treated as spaces. */
export function ocrMarkdownLetters(markdown: string): number {
  return confidentLetters(markdown.split(/[\s|]+/).map((text) => ({ text, confidence: 100 })));
}

/** Lines of OCR markdown holding a date shaped like MM/DD/YY or MM/DD/YYYY; every transaction row prints one. */
export function datedLineCount(markdown: string): number {
  return markdown.split("\n").filter((line) => DATE_TOKEN.test(line)).length;
}

/** Why the OCR read of a page turned to `rotation` falls short of tesseract's read of it, or null when it does not. */
export function ocrPageShortfall(
  markdown: string,
  scores: readonly RotationScore[],
  rotation: PageRotation
): string | null {
  const tesseractLetters = scores.find((score) => score.rotation === rotation)?.confidentLetters;
  if (tesseractLetters === undefined) throw new Error(`No confident-letter score for rotation ${rotation}`);
  if (tesseractLetters < MIN_TESSERACT_LETTERS) return null;
  const ocrLetters = ocrMarkdownLetters(markdown);
  if (ocrLetters >= MIN_OCR_LETTER_RATIO * tesseractLetters) return null;
  return `OCR text holds ${ocrLetters} letters where tesseract read ${tesseractLetters} confident letters on the page`;
}

/** Why two OCR reads of one page at different resolutions disagree on its dated lines, or null when they agree. */
export function ocrReadsDisagreement(primary: string, check: string): string | null {
  const primaryLines = datedLineCount(primary);
  const checkLines = datedLineCount(check);
  const allowed = Math.max(
    MAX_DATED_LINE_SPREAD,
    Math.ceil(MAX_DATED_LINE_SPREAD_FRACTION * Math.max(primaryLines, checkLines))
  );
  if (Math.abs(primaryLines - checkLines) <= allowed) return null;
  return `the OCR read holds ${primaryLines} dated lines where a read at another resolution holds ${checkLines}`;
}
