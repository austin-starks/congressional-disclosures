import crypto from "crypto";

import type { OcrPageRead } from "./houseFilingExtraction";
import { ocrPageShortfall, ocrReadsDisagreement } from "./ocrPageCoverage";
import { readPageWithRescale, type PageReadAttempt, type RescaleSource } from "./ocrPageRescale";
import type { UprightPage } from "./pageOrientation";
import type { CompletionClient } from "./ports";

/**
 * A second OCR engine as the last rung of a scanned page's read ladder.
 *
 * Measured 2026-09-18 on round `backfill-2026-09-16`'s failing pages (designs/2026-09-18-ocr-engine-fallback.md):
 * on 18 filings Mistral returned the identical header-only read at render scale 4, scale 6 and cropped —
 * a deterministic engine refusal no re-render can fix — while a Gemini Flash transcribed the same pages to
 * 2.6-2.8x tesseract's own confident letters. So when the Mistral ladder (`readPageWithRescale`) has thrown,
 * the page is offered to a second engine before its filing fails.
 *
 * An engine read is held to the same standard a Mistral page meets, with one deliberate difference: its two
 * reads must agree with EACH OTHER in dated lines (`ocrReadsDisagreement`), never with tesseract's — on
 * house:9110423 the engine read 12 dated lines tesseract reads zero of; tesseract is a floor-check for
 * letters (`ocrPageShortfall`), not a date oracle.
 */

/** A `readPage` attempt that also reports the upright page it oriented, for the engine rung. */
export type EnginePageAttempt = PageReadAttempt & { upright?: UprightPage };

/** The two independent physical reads required before the fallback may accept a page. */
export type EngineReadIndex = 1 | 2;

/** The second engine: the Gemini Flash generation NexusGenAI routes (see the design doc before changing it). */
export const DEFAULT_ENGINE_FALLBACK_OCR_MODEL = "google/gemini-3.5-flash";

const ENGINE_SYSTEM = "You transcribe scanned U.S. congressional financial disclosure pages.";
const ENGINE_INSTRUCTIONS =
  "Transcribe every line of printed text on this page verbatim, in top-to-bottom order. " +
  "Render the transactions table as a markdown table with one table row per printed row, keeping the printed " +
  "column order. Copy dates exactly as printed (MM/DD/YYYY). Do not summarize, do not skip rows, do not add " +
  "commentary. Output only the transcription.";

/**
 * Keys tried for one engine read, in order. The gateway answers a key whose request failed with that failure for
 * good ("previously failed; refusing to dispatch another physical request"), and a client that disconnects mid-read
 * fails its key as "canceled". House 8216921 page 1 lost its first key to an upstream idle timeout and its second to
 * a gate run that exited while the read was in flight, so a read gets three keys, each tried only after the one
 * before it fails.
 */
export const ENGINE_READ_GENERATIONS = 3;

/**
 * A retry-stable identity for one of the two independent engine reads. Generation 1 is the key every earlier release
 * sent, so reads it already answered keep replaying; a later generation adds its number.
 */
export function engineIdempotencyKey(
  image: Buffer,
  read: EngineReadIndex,
  model: string = DEFAULT_ENGINE_FALLBACK_OCR_MODEL,
  generation = 1
): string {
  const requestHash = crypto
    .createHash("sha256")
    .update(model)
    .update("\0")
    .update(ENGINE_SYSTEM)
    .update("\0")
    .update(ENGINE_INSTRUCTIONS)
    .update("\0")
    .update(image)
    .digest("hex")
    .slice(0, 24);
  return generation === 1
    ? `ptr-engine-ocr-v2-r${read}-${requestHash}`
    : `ptr-engine-ocr-v2-r${read}-g${generation}-${requestHash}`;
}

/**
 * One page transcription by the second engine, through the same completion port every other model
 * call in the disclosure pipeline takes (orientation judge, extraction reads) — no separate credential.
 * Each independent read has its own stable idempotency key. Retrying read 1 replays read 1,
 * while read 2 is a separate physical request whose agreement is real rather than a replay.
 * A read whose request fails is tried once more under its next generation's key.
 *
 * `model` defaults to the Gemini Flash generation the rung was measured on. `prepareImage`
 * normalizes the upright PNG for a request (the gateway-specific 4 MB JPEG fallback of
 * `modelPageImage.ts` stays with the adapter that injects it); it defaults to the identity
 * so a caller whose images already fit sends them as they are.
 */
export function createEngineTranscriber(
  client: CompletionClient,
  model: string = DEFAULT_ENGINE_FALLBACK_OCR_MODEL,
  prepareImage: (png: Buffer) => Promise<Buffer> = (png) => Promise.resolve(png)
): (png: Buffer, read: EngineReadIndex) => Promise<string> {
  const readOnce = async (image: Buffer, read: EngineReadIndex, generation: number): Promise<string> => {
    const { payload } = await client.complete({
      model,
      body: {
        model,
        temperature: 0,
        // gemini-3.5-flash has no verified price row in NexusGenAI's catalog, which the
        // expensive-model guard answers with 403 (seen live on the 2026-09-16-retry
        // validation machine). This opt-in is deliberate and bounded: the fallback runs
        // two reads only on pages the Mistral ladder already failed, measured at pennies
        // per page (designs/2026-09-18-ocr-engine-fallback.md).
        allowExpensiveModel: true,
        messages: [
          { role: "system", content: ENGINE_SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: ENGINE_INSTRUCTIONS },
              { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}` } },
            ],
          },
        ],
      },
      idempotencyKey: engineIdempotencyKey(image, read, model, generation),
    });
    const content = (payload.choices as Array<Record<string, unknown>>)[0]?.message;
    const text = (content as Record<string, unknown> | undefined)?.content;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error(`engine read (${model}) returned no text`);
    }
    return text;
  };
  return async (png: Buffer, read: EngineReadIndex): Promise<string> => {
    const image = await prepareImage(png);
    const failures: string[] = [];
    for (let generation = 1; generation <= ENGINE_READ_GENERATIONS; generation += 1) {
      try {
        return await readOnce(image, read, generation);
      } catch (error: unknown) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(failures.join("; then "));
  };
}

export interface EngineFallbackConfig {
  source: RescaleSource;
  reRender?: () => Promise<{ image: Buffer; checkImage: Buffer; dpi?: number }>;
  readPage(source: RescaleSource): Promise<EnginePageAttempt>;
  /** One of two independent transcriptions of the upright page by the second engine. */
  transcribe(png: Buffer, read: EngineReadIndex): Promise<string>;
}

/** The payload shape an accepted engine read carries: no `pages`, so `ocrPageGeometry` yields null. */
export function enginePayload(markdown: string): Record<string, unknown> {
  return { engine: "openrouter-transcription", markdown };
}

/**
 * Read one page: the Mistral ladder first, and where that threw and the page was oriented, two engine
 * transcriptions that must pass the letter floor and agree in dated lines. Returns the engine read as the
 * page's `OcrPageRead` — orientation evidence kept from the page itself, both payloads describing the
 * engine, geometry deliberately null. Throws the Mistral reason with the engine's appended when the
 * engine rung also fails, so a receipt says which rung rejected the page last.
 */
export async function readPageWithEngineFallback(config: EngineFallbackConfig): Promise<OcrPageRead> {
  let upright: UprightPage | undefined;
  const readPage = async (source: RescaleSource): Promise<EnginePageAttempt> => {
    const attempt = await config.readPage(source);
    if (attempt.upright) upright = attempt.upright;
    return attempt;
  };
  try {
    return await readPageWithRescale({
      source: config.source,
      ...(config.reRender ? { reRender: config.reRender } : {}),
      readPage,
    });
  } catch (mistralFailure) {
    const reason = mistralFailure instanceof Error ? mistralFailure.message : String(mistralFailure);
    if (!upright) throw mistralFailure;
    let engineFailure: string;
    try {
      const [first, second] = await Promise.all([
        config.transcribe(upright.image, 1),
        config.transcribe(upright.image, 2),
      ]);
      const scores = upright.scores;
      const shortfall = ocrPageShortfall(first, scores, upright.rotation);
      if (shortfall) {
        engineFailure = `engine read ${shortfall}`;
      } else {
        const disagreement = ocrReadsDisagreement(first, second);
        if (disagreement) engineFailure = `engine reads ${disagreement}`;
        else {
          return {
            rotation: upright.rotation,
            scores: upright.scores,
            decidedBy: upright.decidedBy,
            payload: enginePayload(first),
            checkPayload: enginePayload(second),
            markdown: first,
          };
        }
      }
    } catch (error: unknown) {
      engineFailure = error instanceof Error ? error.message : String(error);
    }
    throw new Error(`${reason} (engine fallback: ${engineFailure})`);
  }
}
