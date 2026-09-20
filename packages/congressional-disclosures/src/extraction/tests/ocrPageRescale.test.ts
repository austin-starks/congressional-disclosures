import type { OcrPageRead } from "../houseFilingExtraction";
import { readPageWithRescale, type RescaleSource } from "../ocrPageRescale";

const read = (markdown: string): OcrPageRead => ({
  rotation: 0,
  scores: [{ rotation: 0, confidentLetters: 100 }],
  decidedBy: "letters",
  payload: { pages: [{ index: 0, markdown }] },
  checkPayload: { pages: [{ index: 0, markdown }] },
  markdown,
});

const source = (label: string): RescaleSource => ({
  image: Buffer.from(`${label}-image`),
  checkImage: Buffer.from(`${label}-check`),
  dpi: 288,
});

describe("readPageWithRescale", () => {
  it("does not re-render a page that read cleanly", async () => {
    let reRendered = 0;
    const seen: string[] = [];

    const page = await readPageWithRescale({
      source: source("first"),
      readPage: async (attempt) => {
        seen.push(attempt.image.toString());
        return { read: read("rows") };
      },
      reRender: async () => {
        reRendered += 1;
        return { image: Buffer.from("retry-image"), checkImage: Buffer.from("retry-check") };
      },
    });

    expect(page.markdown).toBe("rows");
    expect(reRendered).toBe(0);
    expect(seen).toEqual(["first-image"]);
  });

  it("retries a rejected read against different bytes, which is the whole point", async () => {
    // Identical bytes are answered from the OCR cache with the identical failure, so a retry that
    // did not change the render would fail in exactly the same way and cost money doing it.
    const seen: string[] = [];

    const page = await readPageWithRescale({
      source: source("first"),
      readPage: async (attempt) => {
        seen.push(attempt.image.toString());
        return attempt.dpi === 432 ? { read: read("recovered rows") } : { failure: "dropped text" };
      },
      reRender: async () => ({
        image: Buffer.from("retry-image"),
        checkImage: Buffer.from("retry-check"),
        dpi: 432,
      }),
    });

    expect(page.markdown).toBe("recovered rows");
    expect(seen).toEqual(["first-image", "retry-image"]);
  });

  it("gives up after one retry and reports the reason the second render was rejected", async () => {
    let attempts = 0;

    await expect(
      readPageWithRescale({
        source: source("first"),
        readPage: async () => {
          attempts += 1;
          return { failure: attempts === 1 ? "dropped text at scale 4" : "reads disagree at scale 6" };
        },
        reRender: async () => ({ image: Buffer.from("retry-image"), checkImage: Buffer.from("retry-check") }),
      })
    ).rejects.toThrow("reads disagree at scale 6");

    expect(attempts).toBe(2);
  });

  it("makes one attempt when the page cannot be rendered another way", async () => {
    let attempts = 0;

    await expect(
      readPageWithRescale({
        source: source("only"),
        readPage: async () => {
          attempts += 1;
          return { failure: "dropped text" };
        },
      })
    ).rejects.toThrow("dropped text");

    expect(attempts).toBe(1);
  });

  it("keeps the original dpi when a re-render does not state one", async () => {
    const dpis: number[] = [];

    await expect(
      readPageWithRescale({
        source: source("first"),
        readPage: async (attempt) => {
          dpis.push(attempt.dpi);
          return { failure: "dropped text" };
        },
        reRender: async () => ({ image: Buffer.from("retry-image"), checkImage: Buffer.from("retry-check") }),
      })
    ).rejects.toThrow("dropped text");

    expect(dpis).toEqual([288, 288]);
  });
});
