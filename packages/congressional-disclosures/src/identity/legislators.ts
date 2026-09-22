import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Legislator, LegislatorsSnapshot, LegislatorTerm } from "./types";

/** Public-domain (CC0-1.0) member data; JSON is built onto the `gh-pages` branch, never `main`. */
export const LEGISLATORS_REPOSITORY = "unitedstates/congress-legislators";
export const LEGISLATORS_BRANCH = "gh-pages";
const FILES = { current: "legislators-current.json", historical: "legislators-historical.json" } as const;
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface LegislatorsFetch {
  (url: string, init?: { headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    json(): Promise<unknown>;
  }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} is not an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${where} is not a non-empty string`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseTerm(raw: unknown, where: string): LegislatorTerm {
  const term = record(raw, where);
  const type = term.type;
  if (type !== "rep" && type !== "sen") throw new Error(`${where}.type is ${String(type)}`);
  const district = term.district;
  return {
    type,
    start: text(term.start, `${where}.start`),
    end: text(term.end, `${where}.end`),
    state: text(term.state, `${where}.state`),
    district: type === "rep" && typeof district === "number" ? district : null,
  };
}

function parseLegislator(raw: unknown, index: number, file: string): Legislator {
  const where = `${file}[${index}]`;
  const entry = record(raw, where);
  const id = record(entry.id, `${where}.id`);
  const name = record(entry.name, `${where}.name`);
  const terms = entry.terms;
  if (!Array.isArray(terms)) throw new Error(`${where}.terms is not an array`);
  return {
    bioguide: text(id.bioguide, `${where}.id.bioguide`),
    first: text(name.first, `${where}.name.first`),
    middle: optionalText(name.middle),
    nickname: optionalText(name.nickname),
    last: text(name.last, `${where}.name.last`),
    officialFull: optionalText(name.official_full),
    terms: terms.map((term, termIndex) => parseTerm(term, `${where}.terms[${termIndex}]`)),
  };
}

function parseFile(bytes: Uint8Array, file: string): Legislator[] {
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${file} is not a JSON array`);
  return parsed.map((entry, index) => parseLegislator(entry, index, file));
}

/** Parse the two upstream files into a snapshot that records exactly which bytes it used. */
export function legislatorsFromFiles(commit: string, current: Uint8Array, historical: Uint8Array): LegislatorsSnapshot {
  if (!FULL_SHA.test(commit)) throw new Error(`legislators commit must be a full SHA, got ${commit}`);
  return {
    commit,
    sha256: { current: sha256(current), historical: sha256(historical) },
    legislators: [...parseFile(current, FILES.current), ...parseFile(historical, FILES.historical)],
  };
}

/** The newest `gh-pages` commit, from the GitHub API. */
export async function latestLegislatorsCommit(fetcher: LegislatorsFetch = fetch): Promise<string> {
  const response = await fetcher(`https://api.github.com/repos/${LEGISLATORS_REPOSITORY}/commits/${LEGISLATORS_BRANCH}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub commit lookup failed with HTTP ${response.status}`);
  const commit = text(record(await response.json(), "commit response").sha, "commit sha");
  if (!FULL_SHA.test(commit)) throw new Error(`GitHub returned a malformed commit ${commit}`);
  return commit;
}

/** Download both files at a pinned commit. Raw URLs need the full SHA to resolve reliably. */
export async function downloadLegislators(
  commit: string,
  fetcher: LegislatorsFetch = fetch,
): Promise<{ current: Uint8Array; historical: Uint8Array }> {
  const get = async (file: string): Promise<Uint8Array> => {
    const response = await fetcher(`https://raw.githubusercontent.com/${LEGISLATORS_REPOSITORY}/${commit}/${file}`);
    if (!response.ok) throw new Error(`${file} at ${commit} failed with HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const [current, historical] = await Promise.all([get(FILES.current), get(FILES.historical)]);
  return { current, historical };
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(`${path}.tmp`, bytes);
  await rename(`${path}.tmp`, path);
}

async function readCached(dir: string, commit: string): Promise<LegislatorsSnapshot | null> {
  try {
    const [current, historical] = await Promise.all([
      readFile(join(dir, commit, FILES.current)),
      readFile(join(dir, commit, FILES.historical)),
    ]);
    return legislatorsFromFiles(commit, current, historical);
  } catch {
    return null;
  }
}

export interface LoadLegislatorsOptions {
  /** Where downloaded files are kept, one folder per commit, plus a `latest` pointer. */
  cacheDir: string;
  /** Pin a commit instead of looking up the newest. */
  commit?: string;
  fetcher?: LegislatorsFetch;
}

/**
 * The newest member data, cached by commit. When GitHub cannot be reached, the last
 * commit this cache downloaded is used, so an outage never blocks a sync that has run
 * before; a first sync with no cache and no network fails loudly.
 */
export async function loadLegislators(options: LoadLegislatorsOptions): Promise<LegislatorsSnapshot> {
  const pointer = join(options.cacheDir, "latest");
  let commit = options.commit;
  if (!commit) {
    try {
      commit = await latestLegislatorsCommit(options.fetcher);
    } catch (error) {
      const cachedCommit = await readFile(pointer, "utf8").then((value) => value.trim()).catch(() => null);
      const cached = cachedCommit ? await readCached(options.cacheDir, cachedCommit) : null;
      if (cached) return cached;
      throw new Error(`congress-legislators is unreachable and nothing is cached: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const cached = await readCached(options.cacheDir, commit);
  if (cached) return cached;
  const files = await downloadLegislators(commit, options.fetcher);
  const snapshot = legislatorsFromFiles(commit, files.current, files.historical);
  await mkdir(join(options.cacheDir, commit), { recursive: true });
  await writeAtomic(join(options.cacheDir, commit, FILES.current), files.current);
  await writeAtomic(join(options.cacheDir, commit, FILES.historical), files.historical);
  await writeAtomic(pointer, new TextEncoder().encode(commit));
  return snapshot;
}
