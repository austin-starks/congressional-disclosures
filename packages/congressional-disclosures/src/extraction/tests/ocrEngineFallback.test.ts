import {
  enginePayload,
  readPageWithEngineFallback,
  type EngineFallbackConfig,
  type EnginePageAttempt,
} from "../ocrEngineFallback";
import type { OcrPageRead } from "../houseFilingExtraction";
import { ocrPageGeometry } from "../ocrPageGeometry";
import type { UprightPage } from "../pageOrientation";

/**
 * The engine fallback's contract: the Mistral ladder decides when it can, an engine read is held to the
 * letter floor and two-read agreement, and a rejected engine rung appends its reason to the Mistral one
 * instead of replacing it. The measured behavior behind these gates is in
 * designs/2026-09-18-ocr-engine-fallback.md.
 */

const PNG = Buffer.from("page");

function upright(letters = 300): UprightPage {
  return {
    image: PNG,
    rotation: 0,
    scores: [
      { rotation: 0, confidentLetters: letters },
      { rotation: 90, confidentLetters: 10 },
      { rotation: 180, confidentLetters: 5 },
      { rotation: 270, confidentLetters: 3 },
    ],
    decidedBy: "letters",
  };
}

function mistralRead(uprightPage: UprightPage): OcrPageRead {
  return {
    rotation: uprightPage.rotation,
    scores: uprightPage.scores,
    decidedBy: uprightPage.decidedBy,
    payload: { pages: [{ dimensions: { width: 100, height: 100 }, blocks: [] }] },
    checkPayload: {},
    markdown: "| 01/02/2003 | Purchase | AAPL | $1,001 - $15,000 |",
  };
}

/** A readPage whose Mistral rung fails after orienting, as the worker's does on a dropped-text page. */
function failingMistralRung(reason: string, page = upright()): (
  source: { image: Buffer; checkImage: Buffer; dpi: number }
) => Promise<EnginePageAttempt> {
  return async () => ({ failure: reason, upright: page });
}

function config(overrides: Partial<EngineFallbackConfig> = {}): EngineFallbackConfig {
  return {
    source: { image: PNG, checkImage: PNG, dpi: 288 },
    readPage: async () => ({ read: mistralRead(upright()) }),
    transcribe: async () => "UNITED STATES HOUSE OF REPRESENTATIVES\n| 01/02/2003 | Purchase | AAPL |",
    ...overrides,
  };
}

describe("readPageWithEngineFallback", () => {
  it("returns the Mistral read without consulting the engine when the ladder succeeds", async () => {
    let engineReads = 0;
    const read = await readPageWithEngineFallback(
      config({
        transcribe: async () => {
          engineReads += 1;
          return "engine text";
        },
      })
    );
    expect(read.decidedBy).toBe("letters");
    expect(read.markdown).toContain("AAPL");
    expect(engineReads).toBe(0);
  });

  it("accepts an engine read that clears the letter floor and agrees with its second read", async () => {
    const page = upright(300);
    const markdown =
      "Periodic Transaction Report\n" + "| 01/02/2003 | Purchase | AAPL | $1,001 - $15,000 |".repeat(40);
    const read = await readPageWithEngineFallback(
      config({
        readPage: failingMistralRung("Mistral OCR dropped text on 8216365 page 1", page),
        transcribe: async () => markdown,
      })
    );
    expect(read.rotation).toBe(page.rotation);
    expect(read.scores).toBe(page.scores);
    expect(read.markdown).toBe(markdown);
    // The synthesized payload carries no pages, so downstream band crops degrade to whole pages.
    expect(ocrPageGeometry(read.payload)).toBeNull();
    expect(ocrPageGeometry(read.checkPayload)).toBeNull();
  });

  it("rejects an engine read that holds too few letters against tesseract's page count", async () => {
    const page = upright(300);
    await expect(
      readPageWithEngineFallback(
        config({
          readPage: failingMistralRung("Mistral OCR dropped text on 8216365 page 1", page),
          transcribe: async () => "Periodic Transaction Report",
        })
      )
    ).rejects.toThrow(
      "Mistral OCR dropped text on 8216365 page 1 (engine fallback: engine read OCR text holds"
    );
  });

  it("rejects engine reads that disagree with each other in dated lines", async () => {
    const page = upright(300);
    const rows = (dates: number): string =>
      Array.from({ length: dates }, (_, index) => `| 01/0${(index % 8) + 1}/2003 | Purchase | AAPL |`).join("\n");
    let read = 0;
    await expect(
      readPageWithEngineFallback(
        config({
          readPage: failingMistralRung("Mistral OCR reads of X disagree", page),
          transcribe: async () => {
            read += 1;
            return read === 1 ? rows(20) : rows(2);
          },
        })
      )
    ).rejects.toThrow("Mistral OCR reads of X disagree (engine fallback: engine reads the OCR read holds");
  });

  it("rethrows the Mistral failure unchanged when no attempt oriented the page", async () => {
    await expect(
      readPageWithEngineFallback(
        config({
          readPage: async () => ({ failure: "page orientation undecided: confident letters 0=0 90=0 180=0 270=0" }),
        })
      )
    ).rejects.toThrow("page orientation undecided");
  });

  it("appends the engine's own failure when the transcription call errors", async () => {
    await expect(
      readPageWithEngineFallback(
        config({
          readPage: failingMistralRung("Mistral OCR dropped text on X page 1"),
          transcribe: async () => {
            throw new Error("OPENROUTER_API_KEY is not configured");
          },
        })
      )
    ).rejects.toThrow("Mistral OCR dropped text on X page 1 (engine fallback: OPENROUTER_API_KEY is not configured)");
  });
});

describe("enginePayload", () => {
  it("carries the transcription for the archive but no geometry", () => {
    const payload = enginePayload("transcription text");
    expect(payload.engine).toBe("openrouter-transcription");
    expect(payload.markdown).toBe("transcription text");
    expect(ocrPageGeometry(payload)).toBeNull();
  });
});
