import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

import type { HouseReadPath, OrientationWord, PdfDecrypt, ScanPageImages } from "../extraction";

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
  for (const versionFlag of ["--version", "-v"]) {
    try { await execute(command, [versionFlag]); return true; } catch { /* try the other conventional flag */ }
  }
  return false;
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

async function renderAtDpi(input: string, directory: string, dpi: number): Promise<Buffer[]> {
  const prefix = join(directory, `page-${dpi}`);
  await execute("pdftoppm", ["-png", "-r", String(dpi), input, prefix], { maxBuffer: 64 * 1024 * 1024 });
  const names = (await readdir(directory))
    .filter((name) => name.startsWith(`page-${dpi}-`) && name.endsWith(".png"))
    .sort((left, right) => {
      const numberOf = (name: string): number => Number(/-(\d+)\.png$/.exec(name)?.[1] ?? 0);
      return numberOf(left) - numberOf(right);
    });
  return Promise.all(names.map((name) => readFile(join(directory, name))));
}

/** Render every PDF page at independent OCR/check resolutions, with a higher-resolution retry. */
export async function popplerRenderPages(pdf: Buffer, dpi = 216, checkDpi = 144): Promise<ScanPageImages[]> {
  return withPdfFiles(pdf, async (input, directory) => {
    const [images, checks] = await Promise.all([
      renderAtDpi(input, directory, dpi),
      renderAtDpi(input, directory, checkDpi),
    ]);
    if (images.length === 0 || images.length !== checks.length) {
      throw new Error(`Poppler rendered ${images.length} OCR pages and ${checks.length} check pages`);
    }
    return images.map((image, index): ScanPageImages => ({
      image,
      checkImage: checks[index]!,
      reRender: async () => {
        const retryDpi = Math.max(dpi + 72, Math.round(dpi * 1.5));
        const retryCheckDpi = Math.max(checkDpi + 72, Math.round(checkDpi * 1.5));
        const [retryImages, retryChecks] = await Promise.all([
          renderAtDpi(input, directory, retryDpi),
          renderAtDpi(input, directory, retryCheckDpi),
        ]);
        const retryImage = retryImages[index];
        const retryCheck = retryChecks[index];
        if (!retryImage || !retryCheck) throw new Error(`Poppler did not re-render page ${index + 1}`);
        return { image: retryImage, checkImage: retryCheck, dpi: retryDpi };
      },
    }));
  });
}

export async function rotateImage(image: Buffer, rotation: 90 | 180 | 270): Promise<Buffer> {
  return sharp(image).rotate(rotation).png().toBuffer();
}

/** Tesseract's word-level orientation evidence from a PNG. */
export async function tesseractWords(image: Buffer): Promise<OrientationWord[]> {
  const directory = await mkdtemp(join(tmpdir(), "congressional-disclosures-tesseract-"));
  const input = join(directory, "page.png");
  try {
    await writeFile(input, image);
    const { stdout } = await execute("tesseract", [input, "stdout", "tsv"], { maxBuffer: 64 * 1024 * 1024 });
    const lines = stdout.split(/\r?\n/).slice(1);
    return lines.flatMap((line): OrientationWord[] => {
      const cells = line.split("\t");
      const confidence = Number(cells[10]);
      const text = (cells[11] ?? "").trim();
      return text && Number.isFinite(confidence) ? [{ text, confidence }] : [];
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
