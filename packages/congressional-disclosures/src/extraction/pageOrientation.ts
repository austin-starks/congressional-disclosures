/**
 * Turns a scanned page upright before OCR. Each clockwise turn is scored by letters in
 * words of three or more letters that tesseract reads at confidence 80+; counting whole
 * words misjudges sideways forms, whose rules read as confident one-character tokens.
 * A turn wins when decisive (DECISIVE_MIN_LETTERS, DECISIVE_RATIO); otherwise the model
 * judges (`pageOrientationRead.ts`), and a page neither decides fails its filing.
 */
export type PageRotation = 0 | 90 | 180 | 270;

export const PAGE_ROTATIONS: readonly PageRotation[] = [0, 90, 180, 270];

export const CLOCKWISE_ROTATIONS = [90, 180, 270] as const;

export const CONFIDENT_WORD_THRESHOLD = 80;
export const MIN_WORD_LETTERS = 3;
export const DECISIVE_MIN_LETTERS = 20;
export const DECISIVE_RATIO = 2;

export interface OrientationWord {
  text: string;
  confidence: number;
}

export interface RotationScore {
  rotation: PageRotation;
  confidentLetters: number;
}

export interface OrientationCandidate {
  rotation: PageRotation;
  image: Buffer;
}

export interface OrientationVote {
  rotation: PageRotation;
  decisive: boolean;
}

export interface UprightPageDeps {
  rotate(png: Buffer, rotation: (typeof CLOCKWISE_ROTATIONS)[number]): Promise<Buffer>;
  readWords(png: Buffer): Promise<OrientationWord[]>;
  /** Judge a page the letter vote did not decide: its upright rotation, or null when no two model reads agree. */
  askUpright(candidates: readonly OrientationCandidate[]): Promise<PageRotation | null>;
}

export interface UprightPage {
  image: Buffer;
  rotation: PageRotation;
  scores: RotationScore[];
  decidedBy: "letters" | "model";
}

const LETTER = /\p{L}/u;

/** Letters in the confidently read words that hold at least MIN_WORD_LETTERS letters. */
export function confidentLetters(words: readonly OrientationWord[]): number {
  return words
    .filter((word) => word.confidence >= CONFIDENT_WORD_THRESHOLD)
    .map((word) => [...word.text].filter((character) => LETTER.test(character)).length)
    .filter((letters) => letters >= MIN_WORD_LETTERS)
    .reduce((total, letters) => total + letters, 0);
}

/** The best-scoring rotation, checked 0, 90, 180, 270 with a tie kept at the earlier one, and whether it is decisive. */
export function voteUprightRotation(scores: readonly RotationScore[]): OrientationVote {
  const ordered = PAGE_ROTATIONS.map((rotation) => {
    const score = scores.find((entry) => entry.rotation === rotation);
    if (!score) throw new Error(`Missing confident-letter score for rotation ${rotation}`);
    return score;
  });
  const best = ordered.reduce((winner, score) => (score.confidentLetters > winner.confidentLetters ? score : winner));
  const runnerUp = Math.max(...ordered.filter((score) => score !== best).map((score) => score.confidentLetters));
  return {
    rotation: best.rotation,
    decisive: best.confidentLetters >= DECISIVE_MIN_LETTERS && best.confidentLetters >= DECISIVE_RATIO * runnerUp,
  };
}

export async function uprightPage(png: Buffer, deps: UprightPageDeps): Promise<UprightPage> {
  const candidates: OrientationCandidate[] = [
    { rotation: 0, image: png },
    ...(await Promise.all(
      CLOCKWISE_ROTATIONS.map(async (rotation) => ({ rotation, image: await deps.rotate(png, rotation) }))
    )),
  ];
  const scores: RotationScore[] = await Promise.all(
    candidates.map(async (candidate) => ({
      rotation: candidate.rotation,
      confidentLetters: confidentLetters(await deps.readWords(candidate.image)),
    }))
  );
  const imageOf = (rotation: PageRotation): Buffer =>
    candidates.find((candidate) => candidate.rotation === rotation)?.image ?? png;
  const vote = voteUprightRotation(scores);
  if (vote.decisive) {
    return { image: imageOf(vote.rotation), rotation: vote.rotation, scores, decidedBy: "letters" };
  }
  // A page tesseract reads no confident letters on at any turn holds no text to mis-rotate:
  // keep it as rendered. Judging it by model reads failed such a page outright (house:821410,
  // all four turns 0) when the only content downstream is none — the extraction's
  // no-transactions answer covers a textless page, and a page with a few faint letters
  // (any turn above 0) still goes to the model.
  if (scores.every((score) => score.confidentLetters === 0)) {
    return { image: png, rotation: 0, scores, decidedBy: "letters" };
  }
  const judged = await deps.askUpright(candidates);
  if (judged === null) {
    const letters = scores.map((score) => `${score.rotation}=${score.confidentLetters}`).join(" ");
    throw new Error(
      `page orientation undecided: confident letters ${letters} are not decisive and no two model reads agreed`
    );
  }
  return { image: imageOf(judged), rotation: judged, scores, decidedBy: "model" };
}
