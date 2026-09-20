#!/usr/bin/env node

import { resolve } from "node:path";

import { LocalCache } from "./runtime/cache";
import { commandAvailable } from "./runtime/poppler";
import { MistralOcrClient } from "./providers/mistralOcr";
import { OpenAiCompatibleCompletionClient } from "./providers/openaiCompatible";
import { SQLitePoliticalRepository } from "./storage/sqlite";
import { auditPoliticalRepository, syncPoliticalDisclosures } from "./sync";

type FlagValue = string | true;

function parseArgs(args: readonly string[]): { command: string; flags: Map<string, FlagValue> } {
  const [command = "help", ...rest] = args;
  const flags = new Map<string, FlagValue>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) { flags.set(name, next); index += 1; }
    else flags.set(name, true);
  }
  return { command, flags };
}

function textFlag(flags: Map<string, FlagValue>, name: string, fallback?: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return fallback;
  if (value === true) throw new Error(`--${name} requires a value`);
  return value;
}

function numberFlag(flags: Map<string, FlagValue>, name: string, fallback?: number): number | undefined {
  const value = textFlag(flags, name, fallback === undefined ? undefined : String(fallback));
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative integer`);
  return parsed;
}

function help(): void {
  process.stdout.write(`congressional-disclosures

Commands:
  doctor                         Check local runtime and provider configuration
  sync --db FILE --since YEAR    Discover, extract, and persist official filings
  status --db FILE               Show local lake counts
  audit --db FILE                Run integrity checks (non-zero exit on failure)

Sync options:
  --cache-dir DIR                Raw documents and paid response cache
  --year YEAR                    Sync one year instead of --since through current year
  --chamber house|senate|both    Default: both
  --max-filings N                Bound one run
  --model MODEL                  OpenAI-compatible model slug
  --ocr-model MODEL              Mistral OCR model slug
  --accept-senate-terms          Accept the eFD prohibition agreement
  --dry-run                      Discover and plan without provider calls or writes

Environment:
  OPENROUTER_API_KEY             Required for House and Senate paper extraction
  MISTRAL_API_KEY                Required for scanned House and Senate paper OCR
  OPENAI_COMPATIBLE_BASE_URL     Optional; defaults to OpenRouter
  CONGRESSIONAL_DISCLOSURES_MODEL Optional tested model override
`);
}

async function doctor(): Promise<number> {
  const checks = {
    node: process.versions.node,
    pdftotext: await commandAvailable("pdftotext"),
    pdftocairo: await commandAvailable("pdftocairo"),
    pdftoppm: await commandAvailable("pdftoppm"),
    tesseract: await commandAvailable("tesseract"),
    openrouterKey: Boolean(process.env.OPENROUTER_API_KEY),
    mistralKey: Boolean(process.env.MISTRAL_API_KEY),
  };
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  return checks.pdftotext && checks.pdftocairo && checks.pdftoppm && checks.tesseract ? 0 : 1;
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "help" || flags.has("help")) { help(); return 0; }
  if (command === "doctor") return doctor();

  const dbPath = resolve(textFlag(flags, "db", "./congressional-disclosures.sqlite") ?? "./congressional-disclosures.sqlite");
  const repository = new SQLitePoliticalRepository(dbPath);
  try {
    if (command === "status") {
      const snapshot = await repository.snapshot();
      process.stdout.write(`${JSON.stringify({
        database: dbPath,
        filings: snapshot.filings.length,
        trades: snapshot.trades.length,
        events: snapshot.events.length,
        failedFilings: snapshot.filings.filter((row) => row.extractionStatus === "failed").length,
      }, null, 2)}\n`);
      return 0;
    }
    if (command === "audit") {
      const report = await auditPoliticalRepository(repository);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.passed ? 0 : 1;
    }
    if (command !== "sync") { help(); throw new Error(`Unknown command: ${command}`); }

    const currentYear = new Date().getUTCFullYear();
    const sinceYear = numberFlag(flags, "since", currentYear);
    const year = numberFlag(flags, "year");
    if (sinceYear === undefined) throw new Error("--since is required");
    const chamber = textFlag(flags, "chamber", "both");
    if (chamber !== "house" && chamber !== "senate" && chamber !== "both") throw new Error("--chamber must be house, senate, or both");
    const cache = new LocalCache(resolve(textFlag(flags, "cache-dir", "./.congressional-disclosures") ?? "./.congressional-disclosures"));
    const ocrModel = textFlag(flags, "ocr-model");
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const mistralKey = process.env.MISTRAL_API_KEY;
    const completion = openRouterKey ? new OpenAiCompatibleCompletionClient({
      apiKey: openRouterKey, cache,
      ...(process.env.OPENAI_COMPATIBLE_BASE_URL ? { baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL } : {}),
    }) : undefined;
    const ocr = mistralKey ? new MistralOcrClient({
      apiKey: mistralKey, cache,
      ...(ocrModel ? { model: ocrModel } : {}),
    }) : undefined;
    const maxFilings = numberFlag(flags, "max-filings");
    const model = textFlag(flags, "model", process.env.CONGRESSIONAL_DISCLOSURES_MODEL ?? "google/gemini-3.1-flash-lite")
      ?? "google/gemini-3.1-flash-lite";
    const summary = await syncPoliticalDisclosures({
      repository, cache, sinceYear, chamber, model,
      ...(year !== undefined ? { year } : {}),
      ...(completion ? { completion } : {}),
      ...(ocr ? { ocr } : {}),
      ...(maxFilings !== undefined ? { maxFilings } : {}),
      acceptSenateTerms: flags.has("accept-senate-terms"),
      dryRun: flags.has("dry-run"),
      onProgress: (progress) => process.stderr.write(`[${progress.chamber}] ${progress.docId ? `${progress.docId} ` : ""}${progress.message}\n`),
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.audit?.passed === false ? 1 : 0;
  } finally {
    await repository.close();
  }
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
