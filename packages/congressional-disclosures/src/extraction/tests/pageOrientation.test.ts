import {
  confidentLetters,
  uprightPage,
  voteUprightRotation,
  type OrientationCandidate,
  type PageRotation,
} from "../pageOrientation";

function scores(values: Record<PageRotation, number>) {
  return ([0, 90, 180, 270] as const).map((rotation) => ({ rotation, confidentLetters: values[rotation] }));
}

function fakeRotate(png: Buffer, rotation: number): Promise<Buffer> {
  return Promise.resolve(Buffer.from(`${png.toString()}-${rotation}`));
}

describe("pageOrientation", () => {
  it("counts letters only in confidently read words of three or more letters", () => {
    // 9108156 page 2 read sideways: confident junk tokens and dollar labels score nothing.
    expect(
      confidentLetters([
        { text: "z", confidence: 85 },
        { text: "=", confidence: 96 },
        { text: "$15,001-", confidence: 89 },
        { text: "mm", confidence: 91 },
        { text: "Over", confidence: 96 },
        { text: "Transaction", confidence: 95 },
        { text: "REPRESENTATIVES", confidence: 79 },
      ])
    ).toBe(15);
  });

  it("decides only when the best rotation has enough letters and twice the runner-up", () => {
    // Letter scores of fixture pages with macOS tesseract 5.5.0: 9111823 page 2, 8217728 pages 2 and 16.
    expect(voteUprightRotation(scores({ 0: 47, 90: 5, 180: 0, 270: 176 }))).toEqual({ rotation: 270, decisive: true });
    expect(voteUprightRotation(scores({ 0: 0, 90: 0, 180: 0, 270: 33 }))).toEqual({ rotation: 270, decisive: true });
    expect(voteUprightRotation(scores({ 0: 0, 90: 5, 180: 0, 270: 6 }))).toEqual({ rotation: 270, decisive: false });
    expect(voteUprightRotation(scores({ 0: 12, 90: 0, 180: 0, 270: 0 }))).toEqual({ rotation: 0, decisive: false });
    expect(voteUprightRotation(scores({ 0: 40, 90: 40, 180: 0, 270: 0 }))).toEqual({ rotation: 0, decisive: false });
    expect(() => voteUprightRotation(scores({ 0: 1, 90: 2, 180: 3, 270: 4 }).slice(1))).toThrow(
      "Missing confident-letter score for rotation 0"
    );
  });

  it("turns a page by a decisive letter vote without asking the model", async () => {
    const page = Buffer.from("page");
    const text: Record<string, string> = {
      page: "ab",
      "page-90": "abc",
      "page-180": "",
      "page-270": "REPRESENTATIVES TRANSACTION",
    };
    const asked: number[] = [];
    const result = await uprightPage(page, {
      rotate: fakeRotate,
      readWords: async (png) =>
        text[png.toString()]!
          .split(" ")
          .filter(Boolean)
          .map((word) => ({ text: word, confidence: 96 })),
      askUpright: async (candidates) => {
        asked.push(candidates.length);
        return 90;
      },
    });
    expect(result).toMatchObject({ rotation: 270, decidedBy: "letters" });
    expect(result.image.toString()).toBe("page-270");
    expect(result.scores).toEqual(scores({ 0: 0, 90: 3, 180: 0, 270: 26 }));
    expect(asked).toEqual([]);
  });

  it("asks the model when the vote is not decisive, and fails the page when no two model reads agree", async () => {
    const page = Buffer.from("page");
    const deps = (answer: PageRotation | null) => ({
      rotate: fakeRotate,
      readWords: async (png: Buffer) => (png.toString() === "page-270" ? [{ text: "Page", confidence: 90 }] : []),
      askUpright: async (candidates: readonly OrientationCandidate[]) => {
        expect(candidates.map((candidate) => candidate.rotation)).toEqual([0, 90, 180, 270]);
        return answer;
      },
    });
    const judged = await uprightPage(page, deps(270));
    expect(judged).toMatchObject({ rotation: 270, decidedBy: "model" });
    expect(judged.image.toString()).toBe("page-270");
    await expect(uprightPage(page, deps(null))).rejects.toThrow("page orientation undecided");
  });

  it("keeps a textless page as rendered instead of asking the model", async () => {
    // 821410 page 1: every turn scored 0 confident letters and the model judge could not
    // decide, failing the filing. A page with no text cannot be mis-rotated.
    const page = Buffer.from("page");
    const asked: number[] = [];
    const result = await uprightPage(page, {
      rotate: fakeRotate,
      readWords: async () => [],
      askUpright: async (candidates) => {
        asked.push(candidates.length);
        return null;
      },
    });
    expect(result).toMatchObject({ rotation: 0, decidedBy: "letters" });
    expect(result.image.toString()).toBe("page");
    expect(result.scores).toEqual(scores({ 0: 0, 90: 0, 180: 0, 270: 0 }));
    expect(asked).toEqual([]);
  });
});
