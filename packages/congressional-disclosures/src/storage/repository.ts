import type { IdentifiedFilingRows } from "../identity/apply";
import type { MemberResolver } from "../identity/resolve";
import type { PoliticalLakeSnapshot } from "../lake/types";

/** Storage boundary used by the sync engine. Implementations replace complete filings atomically. */
export interface PoliticalRepository {
  snapshot(): Promise<PoliticalLakeSnapshot>;
  replaceFilings(updates: readonly IdentifiedFilingRows[], runId: string): Promise<void>;
  /** Re-derive every row's identity and rebuild events when any moved; returns filings whose identity changed. */
  reidentify(resolver: MemberResolver): Promise<number>;
  recordRun(run: { runId: string; startedAt: Date; finishedAt: Date; status: "ok" | "failed"; detail: string }): Promise<void>;
  close(): Promise<void>;
}
