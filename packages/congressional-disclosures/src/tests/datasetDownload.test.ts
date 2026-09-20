import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  datasetDownloadPlan,
  downloadCongressionalDataset,
  parseCongressionalDatasetSnapshot,
} from "../dataset";

function snapshotFor(content: Buffer, path = "data/political_trade_events/2026.parquet"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    dataset: "austin-starks/congressional-stock-trades",
    generatedAt: "2026-09-20T00:00:00.000Z",
    totals: { filings: 1, trades: 1, events: 1, failedFilings: 0 },
    tables: {
      political_trade_events: {
        rows: 1,
        years: [2026],
        manifests: [{
          year: 2026,
          files: [{
            publicPath: path,
            size: content.length,
            sha256: createHash("sha256").update(content).digest("hex"),
          }],
        }],
      },
    },
  };
}

describe("public dataset download", () => {
  test("downloads, verifies, and reuses a published file", async () => {
    const destination = await mkdtemp(join(tmpdir(), "congressional-dataset-"));
    const content = Buffer.from("parquet fixture");
    const snapshot = snapshotFor(content);
    const fetcher = jest.fn(async (url: string) => {
      if (url.endsWith("snapshot.json")) return new Response(JSON.stringify(snapshot));
      return new Response(content);
    });

    const first = await downloadCongressionalDataset({ destination, fetcher });
    expect(first.downloadedFiles).toBe(1);
    expect(await readFile(join(destination, "data/political_trade_events/2026.parquet"))).toEqual(content);
    expect(JSON.parse(await readFile(join(destination, "snapshot.json"), "utf8"))).toEqual(snapshot);

    const second = await downloadCongressionalDataset({ destination, fetcher });
    expect(second.downloadedFiles).toBe(0);
    expect(second.reusedFiles).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test("rejects a checksum mismatch without publishing the snapshot", async () => {
    const destination = await mkdtemp(join(tmpdir(), "congressional-dataset-"));
    const expected = Buffer.from("expected");
    const snapshot = snapshotFor(expected);
    const fetcher = async (url: string): Promise<Response> => url.endsWith("snapshot.json")
      ? new Response(JSON.stringify(snapshot))
      : new Response("corrupt!");

    await expect(downloadCongressionalDataset({ destination, fetcher })).rejects.toThrow(/checksum mismatch/);
    await expect(readFile(join(destination, "snapshot.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects unsafe paths from a remote manifest", () => {
    expect(() => parseCongressionalDatasetSnapshot(snapshotFor(Buffer.from("x"), "../outside.parquet")))
      .toThrow(/safe dataset path/);
  });

  test("reports whether the destination has enough space", () => {
    const files = [{ publicPath: "data/a.parquet", size: 100, sha256: "a".repeat(64) }];
    expect(datasetDownloadPlan("/tmp/data", files, 99).enoughSpace).toBe(false);
    expect(datasetDownloadPlan("/tmp/data", files, 100).enoughSpace).toBe(true);
  });
});
