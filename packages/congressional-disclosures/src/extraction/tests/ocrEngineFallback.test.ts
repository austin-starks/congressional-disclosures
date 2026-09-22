import {
  createEngineTranscriber,
  engineIdempotencyKey,
  enginePayload,
  readPageWithEngineFallback,
  type EngineFallbackConfig,
  type EnginePageAttempt,
} from "../ocrEngineFallback";
import type { OcrPageRead } from "../houseFilingExtraction";
import { ocrPageGeometry } from "../ocrPageGeometry";
import type { UprightPage } from "../pageOrientation";
import type { CompletionClient } from "../ports";

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
  it("uses separate stable idempotency keys for the two physical engine reads", async () => {
    const keys: string[] = [];
    const client: CompletionClient = {
      complete: async (request) => {
        keys.push(request.idempotencyKey ?? "");
        return {
          payload: { choices: [{ message: { content: "transcription" } }] },
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    };
    const transcribe = createEngineTranscriber(client);

    await Promise.all([transcribe(PNG, 1), transcribe(PNG, 2)]);
    const firstKeys = [...keys];
    await transcribe(PNG, 1);

    expect(firstKeys).toHaveLength(2);
    expect(firstKeys[0]).not.toBe(firstKeys[1]);
    expect(keys[2]).toBe(firstKeys[0]);
  });

  it("tries a failed engine read once more under a new key, keeping the first key as before", async () => {
    // house:8216921: read 2 failed once on an upstream idle timeout, and the gateway then refused that key for good.
    const keys: string[] = [];
    const client: CompletionClient = {
      complete: async (request) => {
        keys.push(request.idempotencyKey ?? "");
        if (keys.length === 1) throw new Error("previously failed; refusing to dispatch another physical request");
        return {
          payload: { choices: [{ message: { content: "transcription" } }] },
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
    };

    await expect(createEngineTranscriber(client)(PNG, 2)).resolves.toBe("transcription");
    expect(keys).toEqual([engineIdempotencyKey(PNG, 2), engineIdempotencyKey(PNG, 2, undefined, 2)]);
    expect(keys[0]).toMatch(/^ptr-engine-ocr-v2-r2-[0-9a-f]{24}$/);
    expect(keys[1]).toMatch(/^ptr-engine-ocr-v2-r2-g2-[0-9a-f]{24}$/);
  });

  it("gives up after its second key, naming both failures", async () => {
    let calls = 0;
    const client: CompletionClient = {
      complete: async () => {
        calls += 1;
        throw new Error(`attempt ${calls} failed`);
      },
    };
    await expect(createEngineTranscriber(client)(PNG, 1)).rejects.toThrow("attempt 1 failed; then attempt 2 failed");
    expect(calls).toBe(2);
  });

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
