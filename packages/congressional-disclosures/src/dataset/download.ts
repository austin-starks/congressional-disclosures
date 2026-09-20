import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, statfs, unlink, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";

export const PUBLIC_CONGRESSIONAL_DATASET = "austin-starks/congressional-stock-trades";
const DEFAULT_REVISION = "main";

export interface DatasetFile {
  publicPath: string;
  size: number;
  sha256: string;
}

export interface DatasetTable {
  rows: number;
  years: number[];
  manifests: Array<{ year: number; files: DatasetFile[] }>;
}

export interface CongressionalDatasetSnapshot {
  schemaVersion: number;
  dataset: string;
  generatedAt: string;
  totals: Record<string, number>;
  tables: Record<string, DatasetTable>;
}

export interface DatasetDownloadPlan {
  destination: string;
  files: number;
  requiredBytes: number;
  availableBytes: number;
  enoughSpace: boolean;
}

export interface DatasetDownloadResult {
  dataset: string;
  destination: string;
  generatedAt: string;
  downloadedFiles: number;
  reusedFiles: number;
  bytes: number;
  snapshot: CongressionalDatasetSnapshot;
}

interface DownloadResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DownloadCongressionalDatasetOptions {
  destination: string;
  table?: string;
  year?: number;
  revision?: string;
  fetcher?: (url: string) => Promise<DownloadResponse>;
  onPlan?: (plan: DatasetDownloadPlan) => void;
  onProgress?: (message: string) => void;
}

function datasetUrl(dataset: string, revision: string, path: string): string {
  const datasetParts = dataset.split("/").map(encodeURIComponent).join("/");
  const pathParts = path.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/datasets/${datasetParts}/resolve/${encodeURIComponent(revision)}/${pathParts}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function safePublicPath(value: unknown, label: string): string {
  const path = string(value, label);
  const normalized = posix.normalize(path);
  if (path !== normalized || path.startsWith("/") || !path.startsWith("data/") || path.includes("\\")) {
    throw new Error(`${label} is not a safe dataset path`);
  }
  return path;
}

export function parseCongressionalDatasetSnapshot(value: unknown): CongressionalDatasetSnapshot {
  const root = object(value, "snapshot");
  const rawTables = object(root.tables, "snapshot.tables");
  const tables: Record<string, DatasetTable> = {};
  for (const [tableName, rawTable] of Object.entries(rawTables)) {
    const table = object(rawTable, `snapshot.tables.${tableName}`);
    if (!Array.isArray(table.years) || !Array.isArray(table.manifests)) {
      throw new Error(`snapshot.tables.${tableName} is missing years or manifests`);
    }
    const years = table.years.map((year, index) => nonNegativeInteger(year, `${tableName}.years[${index}]`));
    const manifests = table.manifests.map((rawManifest, manifestIndex) => {
      const manifest = object(rawManifest, `${tableName}.manifests[${manifestIndex}]`);
      const year = nonNegativeInteger(manifest.year, `${tableName}.manifests[${manifestIndex}].year`);
      if (!Array.isArray(manifest.files)) throw new Error(`${tableName}.manifests[${manifestIndex}].files must be an array`);
      const files = manifest.files.map((rawFile, fileIndex) => {
        const file = object(rawFile, `${tableName}.${year}.files[${fileIndex}]`);
        const sha256 = string(file.sha256, `${tableName}.${year}.files[${fileIndex}].sha256`);
        if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${tableName}.${year}.files[${fileIndex}].sha256 is invalid`);
        return {
          publicPath: safePublicPath(file.publicPath, `${tableName}.${year}.files[${fileIndex}].publicPath`),
          size: nonNegativeInteger(file.size, `${tableName}.${year}.files[${fileIndex}].size`),
          sha256,
        };
      });
      return { year, files };
    });
    tables[tableName] = {
      rows: nonNegativeInteger(table.rows, `snapshot.tables.${tableName}.rows`),
      years,
      manifests,
    };
  }
  const rawTotals = object(root.totals, "snapshot.totals");
  const totals = Object.fromEntries(Object.entries(rawTotals).map(([name, total]) => [
    name,
    nonNegativeInteger(total, `snapshot.totals.${name}`),
  ]));
  return {
    schemaVersion: nonNegativeInteger(root.schemaVersion, "snapshot.schemaVersion"),
    dataset: string(root.dataset, "snapshot.dataset"),
    generatedAt: string(root.generatedAt, "snapshot.generatedAt"),
    totals,
    tables,
  };
}

async function fetchRequired(fetcher: (url: string) => Promise<DownloadResponse>, url: string): Promise<DownloadResponse> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Dataset request failed (${response.status} ${response.statusText}): ${url}`);
  return response;
}

async function sha256File(path: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function availableBytes(path: string): Promise<number> {
  const stats = await statfs(path, { bigint: true });
  const bytes = stats.bavail * stats.bsize;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
}

export function datasetDownloadPlan(
  destination: string,
  files: readonly DatasetFile[],
  freeBytes: number,
): DatasetDownloadPlan {
  const requiredBytes = files.reduce((total, file) => total + file.size, 0);
  return {
    destination,
    files: files.length,
    requiredBytes,
    availableBytes: freeBytes,
    enoughSpace: freeBytes >= requiredBytes,
  };
}

function selectFiles(snapshot: CongressionalDatasetSnapshot, tableName?: string, year?: number): DatasetFile[] {
  const entries = tableName === undefined
    ? Object.entries(snapshot.tables)
    : [[tableName, snapshot.tables[tableName]] as const];
  if (tableName !== undefined && snapshot.tables[tableName] === undefined) {
    throw new Error(`Unknown table ${tableName}. Available tables: ${Object.keys(snapshot.tables).join(", ")}`);
  }
  const selected: DatasetFile[] = [];
  for (const [name, table] of entries) {
    if (!table) throw new Error(`Dataset table ${name} is missing`);
    const manifests = year === undefined ? table.manifests : table.manifests.filter((manifest) => manifest.year === year);
    selected.push(...manifests.flatMap((manifest) => manifest.files));
  }
  if (selected.length === 0) throw new Error(`No dataset files matched${year === undefined ? "" : ` year ${year}`}`);
  return selected;
}

export async function downloadCongressionalDataset(
  options: DownloadCongressionalDatasetOptions,
): Promise<DatasetDownloadResult> {
  const destination = resolve(options.destination);
  const revision = options.revision ?? DEFAULT_REVISION;
  const fetcher = options.fetcher ?? ((url: string) => fetch(url));
  await mkdir(destination, { recursive: true });

  const snapshotResponse = await fetchRequired(
    fetcher,
    datasetUrl(PUBLIC_CONGRESSIONAL_DATASET, revision, "snapshot.json"),
  );
  const snapshotText = await snapshotResponse.text();
  const snapshot = parseCongressionalDatasetSnapshot(JSON.parse(snapshotText) as unknown);
  if (snapshot.dataset !== PUBLIC_CONGRESSIONAL_DATASET) {
    throw new Error(`Unexpected dataset ${snapshot.dataset}; expected ${PUBLIC_CONGRESSIONAL_DATASET}`);
  }
  const files = selectFiles(snapshot, options.table, options.year);
  const plan = datasetDownloadPlan(destination, files, await availableBytes(destination));
  options.onPlan?.(plan);
  if (!plan.enoughSpace) {
    const requiredGb = (plan.requiredBytes / 1_000_000_000).toFixed(4);
    const availableGb = (plan.availableBytes / 1_000_000_000).toFixed(4);
    throw new Error(`Insufficient disk space: ${requiredGb} GB required, ${availableGb} GB available`);
  }

  let downloadedFiles = 0;
  let reusedFiles = 0;
  let bytes = 0;
  for (const file of files) {
    const target = resolve(destination, ...file.publicPath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    if (await sha256File(target) === file.sha256) {
      reusedFiles += 1;
      options.onProgress?.(`Verified ${file.publicPath}`);
      continue;
    }
    const response = await fetchRequired(fetcher, datasetUrl(PUBLIC_CONGRESSIONAL_DATASET, revision, file.publicPath));
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length !== file.size) {
      throw new Error(`${file.publicPath} size mismatch: expected ${file.size}, received ${content.length}`);
    }
    const actualSha256 = createHash("sha256").update(content).digest("hex");
    if (actualSha256 !== file.sha256) {
      throw new Error(`${file.publicPath} checksum mismatch: expected ${file.sha256}, received ${actualSha256}`);
    }
    const partial = `${target}.partial-${process.pid}`;
    try {
      await writeFile(partial, content);
      await rename(partial, target);
    } catch (error) {
      await unlink(partial).catch(() => undefined);
      throw error;
    }
    downloadedFiles += 1;
    bytes += content.length;
    options.onProgress?.(`Downloaded ${file.publicPath}`);
  }

  await writeFile(resolve(destination, "snapshot.json"), snapshotText);
  return {
    dataset: snapshot.dataset,
    destination,
    generatedAt: snapshot.generatedAt,
    downloadedFiles,
    reusedFiles,
    bytes,
    snapshot,
  };
}
