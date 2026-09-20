import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { HouseReadPath, PdfDecrypt } from "../extraction";

const execute = promisify(execFile);

async function withPdfFiles<T>(pdf: Buffer, run: (input: string, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "congressional-disclosures-"));
  const input = join(directory, "input.pdf");
  try {
    await writeFile(input, pdf);
    return await run(input, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function commandAvailable(command: string): Promise<boolean> {
  try { await execute(command, ["-v"]); return true; } catch { return false; }
}

/** Classify by the real text Poppler can extract, not by pdf-lib's encrypted-page metadata. */
export async function popplerReadPath(pdf: Buffer): Promise<HouseReadPath> {
  return withPdfFiles(pdf, async (input) => {
    const { stdout } = await execute("pdftotext", ["-layout", input, "-"]);
    const letters = stdout.replace(/[^A-Za-z]/g, "").length;
    return letters >= 80 ? "text_layer" : "page_image_ocr";
  });
}

/** Rewrites even RC4-encrypted input as an unencrypted PDF using Poppler's renderer. */
export const popplerDecryptPdf: PdfDecrypt = async (pdf) => withPdfFiles(pdf, async (input, directory) => {
  const output = join(directory, "decrypted.pdf");
  await execute("pdftocairo", ["-pdf", input, output], { maxBuffer: 64 * 1024 * 1024 });
  return readFile(output);
});
