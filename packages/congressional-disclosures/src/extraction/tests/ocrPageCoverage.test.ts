import { ocrPageShortfall, ocrReadsDisagreement } from "../ocrPageCoverage";
import type { RotationScore } from "../pageOrientation";

function scores(uprightLetters: number): RotationScore[] {
  return [
    { rotation: 0, confidentLetters: 3 },
    { rotation: 90, confidentLetters: uprightLetters },
    { rotation: 180, confidentLetters: 2 },
    { rotation: 270, confidentLetters: 4 },
  ];
}

describe("ocrPageShortfall", () => {
  it("fails a page the OCR returned as its header alone, and passes full or near-blank pages", () => {
    // Khanna 8218730 page 5 at render scale 3.
    expect(ocrPageShortfall("5.18\n\nWAMs: Multi Khotna Page", scores(107), 90)).toMatch(/where tesseract read 107/);

    const fullPage = "| SP | COCA-COLA COMPANY (THE) CMN | | x | 04/11/22 | 05/05/22 |\n".repeat(20);
    expect(ocrPageShortfall(fullPage, scores(107), 90)).toBeNull();
    expect(ocrPageShortfall("", scores(6), 90)).toBeNull();
  });

  it("fails a page two resolutions disagree on by more than a line or two", () => {
    const rows = (count: number): string => "| SP | ABBOTT LABORATORIES CMN | | x | 04/11/22 | 05/05/22 |\n".repeat(count);
    // Khanna 8218730 page 15: 19 lines at render scale 3, 75 at scale 4, 74 at scale 5.
    expect(ocrReadsDisagreement(rows(19), rows(75))).toMatch(/holds 19 dated lines where .* holds 75/);
    expect(ocrReadsDisagreement(rows(75), rows(74))).toBeNull();
    expect(ocrReadsDisagreement(rows(2), rows(3))).toBeNull();
  });
});
