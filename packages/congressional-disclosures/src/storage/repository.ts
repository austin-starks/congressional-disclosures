import type { PoliticalFilingRows, PoliticalLakeSnapshot } from "../lake/types";

/** Storage boundary used by the sync engine. Implementations replace complete filings atomically. */
export interface PoliticalRepository {
  snapshot(): Promise<PoliticalLakeSnapshot>;
  replaceFilings(updates: readonly PoliticalFilingRows[], runId: string): Promise<void>;
  recordRun(run: { runId: string; startedAt: Date; finishedAt: Date; status: "ok" | "failed"; detail: string }): Promise<void>;
  close(): Promise<void>;
}
