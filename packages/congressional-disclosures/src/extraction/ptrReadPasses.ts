import {
  gapFillSourceId,
  planGapFillAttachment,
  planReconcileAttachment,
  planSourceReadRequests,
  sourceReadId,
  windowRowPages,
  type OcrTextBudget,
} from "./ocrTextPlan";
import {
  decidePtrConsensus,
  failedPtrResult,
  firstCitedRow,
  idsNeedingThirdRead,
  MAX_EXTRACTION_READS,
  pageReadsAgree,
  type PtrConsensusDecision,
} from "./ptrConsensus";
import { describePtrRow, ptrRowDateFindings } from "./ptrDateChecks";
import type { PtrBatchResult, PtrDocumentResult, PtrPriorRead, PtrRowWindow } from "./ptrExtraction";
import { gapFillRanges, mergeGapFills } from "./ptrGapFill";
import type { PlannedPtrAttachment, PtrAttachmentMeta } from "./ptrRequestPlan";

/**
 * The read passes of a PTR extraction, shared by the Phase 0 gate and the daily
 * job so production runs exactly what the gate measured. The caller supplies how
 * one set of requests is sent (`RunReadRequests`); this module decides what is
 * read and how reads combine:
 *
 * 1. Every planned attachment is read. A row window read whose only defect is rows
 *    without a disposition gets a gap read of those rows (`ptrGapFill.ts`).
 * 2. With two reads, the same requests are read again in reverse order, so each
 *    attachment sits at a different prompt position, and every attachment whose
 *    two reads disagree is read a third time on its own.
 * 3. `ptrConsensus.ts` decides each attachment. One still undecided is read again on
 *    its own, up to `MAX_EXTRACTION_READS` reads, and one that no two reads agree on
 *    after that fails, so a later run retries it.
 *
 * Scans read from OCR text take map-reduce reads instead (`runMapReduceReads`): a read
 * of the OCR text, a read of the filed pages without it, and a reconciling read where
 * those two disagree.
 */
export interface ReadOutcome {
  attachments: PtrAttachmentMeta[];
  result: PtrBatchResult | null;
  /** The read stopped at the model's output token limit, so this request cannot be read whole. */
  truncated?: boolean;
}

export interface ReadPass {
  /** 1 for the first read, 2 for the second, 3 for third reads. */
  pass: number;
  /** True for that pass's gap reads. */
  gap: boolean;
}

export type RunReadRequests = (
  requests: PlannedPtrAttachment[][],
  read: ReadPass
) => Promise<ReadOutcome[]>;

export interface ConsensusCounts {
  agreed: number;
  arbitrated: number;
  failed: number;
  /** Reads after the first two: third reads and further reads of undecided attachments. */
  laterReads: number;
  gapReads: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ExtractionReads {
  /** The first read's requests, carrying each attachment's decided result. */
  outcomes: ReadOutcome[];
  consensus: ConsensusCounts | null;
}

export const GAP_READS_PER_REQUEST = 5;

export function readsOf(outcomes: readonly ReadOutcome[]): Map<string, PtrDocumentResult> {
  return new Map(
    outcomes.flatMap((outcome) =>
      (outcome.result?.documents ?? []).map(
        (document): [string, PtrDocumentResult] => [document.sourceId, document]
      )
    )
  );
}

/** Gap read attachments for every window read whose only defect is rows without a disposition. */
export function planGapFills(
  requests: readonly PlannedPtrAttachment[][],
  outcomes: readonly ReadOutcome[]
): PlannedPtrAttachment[] {
  const planned = new Map(requests.flat().map((attachment) => [attachment.sourceId, attachment]));
  return outcomes.flatMap((outcome) =>
    (outcome.result?.documents ?? []).flatMap((document) => {
      const attachment = planned.get(document.sourceId);
      if (!attachment?.rowWindow || !attachment.numberedOcr) return [];
      return gapFillRanges(attachment.rowWindow, document).map((range) =>
        planGapFillAttachment(attachment, range)
      );
    })
  );
}

function rowWindowsOf(outcomes: readonly ReadOutcome[]): Map<string, PtrRowWindow> {
  return new Map(
    outcomes.flatMap((outcome) =>
      outcome.attachments.flatMap((attachment): Array<[string, PtrRowWindow]> =>
        attachment.rowWindow ? [[attachment.sourceId, attachment.rowWindow]] : []
      )
    )
  );
}

/** Merge gap reads back into the window reads they came from; each merged read is proved again. */
export function applyGapFills(
  outcomes: readonly ReadOutcome[],
  gapOutcomes: readonly ReadOutcome[]
): ReadOutcome[] {
  const windows = rowWindowsOf(outcomes);
  const gapReads = readsOf(gapOutcomes);
  return outcomes.map((outcome): ReadOutcome => {
    if (!outcome.result) return outcome;
    return {
      attachments: outcome.attachments,
      result: {
        ...outcome.result,
        documents: outcome.result.documents.map((document) => {
          const window = windows.get(document.sourceId);
          const ranges = window ? gapFillRanges(window, document) : [];
          if (!window || ranges.length === 0) return document;
          return mergeGapFills(
            window,
            document,
            ranges.map((range) => ({
              window: range,
              result: gapReads.get(gapFillSourceId(document.sourceId, range)),
            }))
          );
        }),
      },
    };
  });
}

/** One pass: read every request, then gap-read what the proof found without a disposition. */
export async function runReadPass(
  requests: PlannedPtrAttachment[][],
  pass: number,
  run: RunReadRequests
): Promise<{ outcomes: ReadOutcome[]; gapOutcomes: ReadOutcome[] }> {
  const outcomes = await run(requests, { pass, gap: false });
  const gapAttachments = planGapFills(requests, outcomes);
  if (gapAttachments.length === 0) return { outcomes, gapOutcomes: [] };
  const gapRequests = Array.from(
    { length: Math.ceil(gapAttachments.length / GAP_READS_PER_REQUEST) },
    (_, index) => gapAttachments.slice(index * GAP_READS_PER_REQUEST, (index + 1) * GAP_READS_PER_REQUEST)
  );
  const gapOutcomes = await run(gapRequests, { pass, gap: true });
  return { outcomes: applyGapFills(outcomes, gapOutcomes), gapOutcomes };
}

/**
 * Decide every first-read attachment from all of its reads (`reads[0]` is the first
 * read) and put the decided documents back into the first read's requests, so later
 * steps merge them as they would a single read. `gapOutcomes` count toward reads and
 * tokens only.
 */
export function applyConsensus(
  reads: ReadonlyArray<readonly ReadOutcome[]>,
  gapOutcomes: readonly ReadOutcome[] = []
): ExtractionReads & { consensus: ConsensusCounts } {
  const [first = []] = reads;
  const ids = first.flatMap((outcome) => outcome.attachments.map((attachment) => attachment.sourceId));
  return decidedReads(
    first,
    decidePtrConsensus(ids, reads.map(readsOf), rowWindowsOf(first)),
    reads.flat(),
    reads.slice(2).flat().reduce((total, outcome) => total + outcome.attachments.length, 0),
    gapOutcomes
  );
}

/** Decided documents put back into the first read's requests, with the counts and tokens of every read. */
function decidedReads(
  first: readonly ReadOutcome[],
  decisions: readonly PtrConsensusDecision[],
  allOutcomes: readonly ReadOutcome[],
  laterReads: number,
  gapOutcomes: readonly ReadOutcome[]
): ExtractionReads & { consensus: ConsensusCounts } {
  const decided = new Map(decisions.map((decision) => [decision.id, decision.result]));
  const count = (outcome: PtrConsensusDecision["outcome"]): number =>
    decisions.filter((decision) => decision.outcome === outcome).length;
  const results = [...allOutcomes, ...gapOutcomes].flatMap((outcome) =>
    outcome.result ? [outcome.result] : []
  );
  const template = results[0] ?? null;
  return {
    outcomes: first.map((outcome): ReadOutcome => {
      const base = outcome.result ?? template;
      return {
        attachments: outcome.attachments,
        result: base
          ? {
              ...base,
              documents: outcome.attachments.map(
                (attachment) => decided.get(attachment.sourceId) as PtrDocumentResult
              ),
            }
          : null,
      };
    }),
    consensus: {
      agreed: count("agreed"),
      arbitrated: count("arbitrated"),
      failed: count("failed"),
      laterReads,
      gapReads: gapOutcomes.reduce((total, outcome) => total + outcome.attachments.length, 0),
      promptTokens: results.reduce((sum, result) => sum + result.usage.promptTokens, 0),
      completionTokens: results.reduce((sum, result) => sum + result.usage.completionTokens, 0),
    },
  };
}

/** Every read pass for a set of planned requests: one read, or two with third reads and consensus. */
export async function runExtractionReads(
  requests: PlannedPtrAttachment[][],
  reads: 1 | 2,
  run: RunReadRequests
): Promise<ExtractionReads> {
  const first = await runReadPass(requests, 1, run);
  if (reads === 1) return { outcomes: first.outcomes, consensus: null };
  const second = await runReadPass(
    [...requests].reverse().map((request) => [...request].reverse()),
    2,
    run
  );
  const attachments = requests.flat();
  const passes: ReadOutcome[][] = [first.outcomes, second.outcomes];
  const gapOutcomes = [...first.gapOutcomes, ...second.gapOutcomes];
  const windows = rowWindowsOf(first.outcomes);
  let pending = new Set(
    idsNeedingThirdRead(
      attachments.map((attachment) => attachment.sourceId),
      readsOf(first.outcomes),
      readsOf(second.outcomes)
    )
  );
  for (let pass = 3; pass <= MAX_EXTRACTION_READS && pending.size > 0; pass += 1) {
    const next = await runReadPass(
      attachments.filter((attachment) => pending.has(attachment.sourceId)).map((attachment) => [attachment]),
      pass,
      run
    );
    passes.push(next.outcomes);
    gapOutcomes.push(...next.gapOutcomes);
    pending = new Set(
      decidePtrConsensus([...pending], passes.map(readsOf), windows)
        .filter((decision) => decision.outcome === "failed")
        .map((decision) => decision.id)
    );
  }
  return applyConsensus(passes, gapOutcomes);
}

export const MAP_READ_LABELS = {
  text: "Read A (OCR text alone)",
  source: "Read B (the filed pages alone)",
} as const;

/** Counts of several read runs added together; null when none ran. */
export function sumConsensus(counts: ReadonlyArray<ConsensusCounts | null>): ConsensusCounts | null {
  const present = counts.filter((count): count is ConsensusCounts => count !== null);
  if (present.length === 0) return null;
  return present.reduce((total, count) => ({
    agreed: total.agreed + count.agreed,
    arbitrated: total.arbitrated + count.arbitrated,
    failed: total.failed + count.failed,
    laterReads: total.laterReads + count.laterReads,
    gapReads: total.gapReads + count.gapReads,
    promptTokens: total.promptTokens + count.promptTokens,
    completionTokens: total.completionTokens + count.completionTokens,
  }));
}

function pageKey(filingId: string, page: number): string {
  return `${filingId}#${page}`;
}

/**
 * Pages where the map reads disagree, as `pageKey`s: the transactions Read A starts on a page, across every window,
 * against those Read B lists for it. A page is disputed as well when a read of it failed or gave no answer, or when a
 * Read A transaction cites no row.
 */
function disputedPages(
  windows: readonly PlannedPtrAttachment[],
  textReads: ReadonlyMap<string, PtrDocumentResult>,
  sourceReads: ReadonlyMap<string, PtrDocumentResult>
): Set<string> {
  const disputed = new Set<string>();
  const textRows = new Map<string, Array<Record<string, unknown>>>();
  for (const window of windows) {
    const read = textReads.get(window.sourceId);
    const located: Array<[string, Record<string, unknown>]> = [];
    let unplaced = !read || read.error !== null;
    for (const row of read && !read.error ? read.rows : []) {
      const page = window.numberedOcr?.rowPages[firstCitedRow(row) - 1];
      if (page === undefined) unplaced = true;
      else located.push([pageKey(window.filingId, page), row]);
    }
    if (unplaced) {
      for (const page of windowRowPages(window)) disputed.add(pageKey(window.filingId, page));
      continue;
    }
    for (const [key, row] of located) textRows.set(key, [...(textRows.get(key) ?? []), row]);
  }
  for (const window of windows) {
    for (const page of windowRowPages(window)) {
      const key = pageKey(window.filingId, page);
      const source = sourceReads.get(sourceReadId(window.filingId, page));
      if (!source || source.error || !pageReadsAgree(textRows.get(key) ?? [], source.rows)) disputed.add(key);
    }
  }
  return disputed;
}

/**
 * Date findings (`ptrDateChecks.ts`) of both map reads, by `pageKey`: Read A's transactions on the page they start on,
 * and every transaction Read B lists for the page. A page with one is disputed even where the reads agree, since both
 * can share a misread digit, and each finding is stated to the reconciling read of every window on that page.
 */
function dateFindingsByPage(
  windows: readonly PlannedPtrAttachment[],
  textReads: ReadonlyMap<string, PtrDocumentResult>,
  sourceReads: ReadonlyMap<string, PtrDocumentResult>
): Map<string, string[]> {
  const findings = new Map<string, string[]>();
  const add = (key: string, finding: string): void => {
    const list = findings.get(key) ?? [];
    if (!list.includes(finding)) findings.set(key, [...list, finding]);
  };
  for (const window of windows) {
    const filedOn = window.filedOn ?? null;
    const text = textReads.get(window.sourceId);
    for (const row of text && !text.error ? text.rows : []) {
      const page = window.numberedOcr?.rowPages[firstCitedRow(row) - 1];
      if (page === undefined) continue;
      for (const finding of ptrRowDateFindings(row, filedOn)) {
        add(pageKey(window.filingId, page), `${MAP_READ_LABELS.text}, ${describePtrRow(row)}: ${finding}`);
      }
    }
    for (const page of windowRowPages(window)) {
      const source = sourceReads.get(sourceReadId(window.filingId, page));
      for (const row of source && !source.error ? source.rows : []) {
        for (const finding of ptrRowDateFindings(row, filedOn)) {
          add(
            pageKey(window.filingId, page),
            `${MAP_READ_LABELS.source}, ${describePtrRow({ ...row, page })}: ${finding}`
          );
        }
      }
    }
  }
  return findings;
}

/** Read B as a window's reconciling read sees it: every transaction listed on the pages its rows sit on, by page. */
function sourceReadOfWindow(
  window: PlannedPtrAttachment,
  sourceReads: ReadonlyMap<string, PtrDocumentResult>
): PtrDocumentResult {
  const pages = windowRowPages(window).map((page) => ({
    page,
    read: sourceReads.get(sourceReadId(window.filingId, page)),
  }));
  const failures = pages.flatMap(({ page, read }) =>
    !read ? [`page ${page}: no answer`] : read.error ? [`page ${page}: ${read.error}`] : []
  );
  return {
    sourceId: window.sourceId,
    rows: pages.flatMap(({ page, read }) =>
      (read?.rows ?? []).map((row) => ({
        page,
        ...Object.fromEntries(Object.entries(row).filter(([field]) => field !== "ocr_rows")),
      }))
    ),
    noTransactionsStatement: null,
    amendedReportDate: null,
    amendedReportDateIso: null,
    nonTransactionRows: [],
    continuationRows: [],
    invalidRowIndexes: [],
    reviewRowIndexes: [],
    error: failures.length > 0 ? failures.join("; ") : null,
  };
}

/** A row the lake refuses for having no asset name. */
function missingAsset(row: Record<string, unknown>): boolean {
  return typeof row.asset_description !== "string" || row.asset_description.trim() === "";
}

/** No transaction and no statement that there is none, which fails a filing. */
function emptyRead(result: PtrDocumentResult | undefined): boolean {
  return result !== undefined && result.rows.length === 0 && !result.noTransactionsStatement;
}

interface RepairFindings {
  assetFindings: string[];
  emptyReadFindings: string[];
}

export const EMPTY_READ_FINDING = "No read of this report found a transaction or a statement that it has none.";

/**
 * Findings for each window whose decided read would fail its filing for a reason a second look at the filed pages can
 * settle, by source id. Rows without an asset name: filers mark a repeated asset with a ditto mark or an arrow down the
 * column (house:9108075, 8217760). A filing where no window found a transaction or a statement that there is none: an
 * amendment letter that corrects a checked box or withdraws a transaction lists none (house:9107269, 8214458). Only
 * these windows are read again, so no window of a filing that passes today is re-read.
 */
function repairFindingsOf(
  windows: readonly PlannedPtrAttachment[],
  decisions: readonly PtrConsensusDecision[],
  reconciled: ReadonlyMap<string, PtrDocumentResult>
): Map<string, RepairFindings> {
  const decided = new Map(decisions.map((decision) => [decision.id, decision]));
  const findings = new Map<string, RepairFindings>();
  for (const window of windows) {
    const decision = decided.get(window.sourceId);
    if (!decision || decision.outcome === "failed") continue;
    const assetFindings = decision.result.rows
      .filter(missingAsset)
      .map((row) => `${describePtrRow(row)} has no asset name`);
    if (assetFindings.length > 0) findings.set(window.sourceId, { assetFindings, emptyReadFindings: [] });
  }
  const byFiling = new Map<string, PlannedPtrAttachment[]>();
  for (const window of windows) byFiling.set(window.filingId, [...(byFiling.get(window.filingId) ?? []), window]);
  for (const group of byFiling.values()) {
    const empty = group.every((window) => {
      const decision = decided.get(window.sourceId);
      if (!decision) return false;
      // A failed window counts only when its reconciling read also found nothing, never for a failed page read.
      return decision.outcome === "failed"
        ? emptyRead(reconciled.get(window.sourceId))
        : !decision.result.error && emptyRead(decision.result);
    });
    if (!empty) continue;
    for (const window of group) {
      findings.set(window.sourceId, { assetFindings: [], emptyReadFindings: [EMPTY_READ_FINDING] });
    }
  }
  return findings;
}

/** A repair read settles its window only when it clears the finding that sent it; otherwise the decision stands. */
function repairSettles(findings: RepairFindings, result: PtrDocumentResult | undefined): result is PtrDocumentResult {
  if (!result || result.error) return false;
  if (findings.assetFindings.length > 0 && result.rows.some(missingAsset)) return false;
  return true;
}

/**
 * Map-reduce reads of OCR text windows. Read A takes the OCR text and Read B the filed page
 * alone, so their errors are mostly unrelated and show as page-level disagreement. A window whose
 * pages all agree and give no date finding is accepted; any other gets one reconciling read with
 * both reads, the filed pages and its date findings, which must still pass row coverage or the
 * window fails for a later retry. A window whose decided read would still fail its filing for a missing asset name or
 * an empty report gets one repair read with that finding (`repairFindingsOf`).
 */
export async function runMapReduceReads(
  requests: PlannedPtrAttachment[][],
  run: RunReadRequests,
  budget: OcrTextBudget
): Promise<ExtractionReads & { consensus: ConsensusCounts }> {
  const sourcePlan = planSourceReadRequests(requests, budget);
  const [textRead, sourceOutcomes] = await Promise.all([
    runReadPass(requests, 1, run),
    sourcePlan.then(({ requests: sourceRequests }) =>
      sourceRequests.length > 0 ? run(sourceRequests, { pass: 2, gap: false }) : []
    ),
  ]);
  const { unreadable } = await sourcePlan;
  const windows = requests.flat();
  const textReads = readsOf(textRead.outcomes);
  const sourceReads = readsOf(sourceOutcomes);
  const disagreed = disputedPages(windows, textReads, sourceReads);
  const dateFindings = dateFindingsByPage(windows, textReads, sourceReads);
  const disputed = new Set([...disagreed, ...dateFindings.keys()]);
  const reconciling = windows.filter((window) =>
    windowRowPages(window).some((page) => disputed.has(pageKey(window.filingId, page)))
  );
  // Windows whose map reads agree on every page, sent to reconcile only by a date finding. Before date findings
  // existed they were accepted as read, so a reconciling read that fails leaves them as read rather than failing them.
  const dateOnly = new Set(
    reconciling
      .filter((window) => windowRowPages(window).every((page) => !disagreed.has(pageKey(window.filingId, page))))
      .map((window) => window.sourceId)
  );
  const planningErrors = new Map<string, string>();
  const reconcileAttachments = (
    await Promise.all(
      reconciling.map((window) => {
        const text = textReads.get(window.sourceId);
        const priorReads: PtrPriorRead[] = [
          ...(text ? [{ label: MAP_READ_LABELS.text, result: text }] : []),
          { label: MAP_READ_LABELS.source, result: sourceReadOfWindow(window, sourceReads) },
        ];
        const findings = [
          ...new Set(windowRowPages(window).flatMap((page) => dateFindings.get(pageKey(window.filingId, page)) ?? [])),
        ];
        return planReconcileAttachment(window, priorReads, findings).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          planningErrors.set(window.sourceId, unreadable.get(window.filingId) ?? reason);
          return null;
        });
      })
    )
  ).flatMap((attachment) => (attachment ? [attachment] : []));
  const reconcileOutcomes =
    reconcileAttachments.length === 0
      ? []
      : await run(
          reconcileAttachments.map((attachment) => [attachment]),
          { pass: 3, gap: false }
        );
  const reconciled = readsOf(reconcileOutcomes);
  const reconcilingIds = new Set(reconciling.map((window) => window.sourceId));
  const decisions = windows.map((window): PtrConsensusDecision => {
    const id = window.sourceId;
    const text = textReads.get(id);
    if (text && !reconcilingIds.has(id)) return { id, outcome: "agreed", result: text };
    const result = reconciled.get(id);
    if (result && !result.error) return { id, outcome: "arbitrated", result };
    if (text && !text.error && dateOnly.has(id)) return { id, outcome: "agreed", result: text };
    const reason = planningErrors.get(id) ?? result?.error ?? "the reconciling read returned no answer";
    return { id, outcome: "failed", result: failedPtrResult(id, `map reads disagreed and reconciling failed: ${reason}`) };
  });
  const repairs = repairFindingsOf(windows, decisions, reconciled);
  const repairAttachments = (
    await Promise.all(
      windows
        .filter((window) => repairs.has(window.sourceId))
        .map((window) => {
          const text = textReads.get(window.sourceId);
          const priorReads: PtrPriorRead[] = [
            ...(text ? [{ label: MAP_READ_LABELS.text, result: text }] : []),
            { label: MAP_READ_LABELS.source, result: sourceReadOfWindow(window, sourceReads) },
          ];
          return planReconcileAttachment(window, priorReads, [], repairs.get(window.sourceId)).catch(() => null);
        })
    )
  ).flatMap((attachment) => (attachment ? [attachment] : []));
  const repairOutcomes =
    repairAttachments.length === 0
      ? []
      : await run(
          repairAttachments.map((attachment) => [attachment]),
          { pass: 4, gap: false }
        );
  const repaired = readsOf(repairOutcomes);
  const finalDecisions = decisions.map((decision): PtrConsensusDecision => {
    const findings = repairs.get(decision.id);
    const result = repaired.get(decision.id);
    return findings && repairSettles(findings, result) ? { id: decision.id, outcome: "arbitrated", result } : decision;
  });
  return decidedReads(
    textRead.outcomes,
    finalDecisions,
    [...textRead.outcomes, ...sourceOutcomes, ...reconcileOutcomes, ...repairOutcomes],
    [...reconcileOutcomes, ...repairOutcomes].reduce((total, outcome) => total + outcome.attachments.length, 0),
    textRead.gapOutcomes
  );
}
