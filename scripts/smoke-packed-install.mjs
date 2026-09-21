import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "congressional-disclosures-pack-"));
const installRoot = join(temporary, "install");
const cache = join(root, ".tmp", "npm-cache");

function run(args) {
  return execFileSync(npm, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

try {
  await mkdir(installRoot, { recursive: true });
  const packed = JSON.parse(run([
    "pack",
    "--json",
    "--workspace",
    "congressional-disclosures",
    "--pack-destination",
    temporary,
    "--cache",
    cache,
  ]));
  const filename = packed?.[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not report a tarball filename");
  const tarball = join(temporary, filename);
  execFileSync(npm, ["install", "--prefix", installRoot, "--cache", cache, tarball], {
    cwd: root,
    stdio: "inherit",
    timeout: 120_000,
  });

  const packageRoot = join(installRoot, "node_modules", "congressional-disclosures");
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const requireFromInstall = createRequire(join(installRoot, "package.json"));
  for (const entry of ["", "/dataset", "/backfill", "/extraction", "/integrity", "/lake", "/sources", "/storage"]) {
    requireFromInstall(`congressional-disclosures${entry}`);
  }
  await access(join(packageRoot, packageJson.bin["congressional-disclosures"]));

  const fixtureRoot = join(root, "packages", "congressional-disclosures", "src", "tests", "fixtures", "public-dataset");
  const tableNames = ["political_filings", "political_trades", "political_trade_events"];
  const tables = {};
  for (const table of tableNames) {
    const publicPath = `data/${table}/2026.parquet`;
    tables[table] = {
      rows: 1,
      years: [2026],
      manifests: [{
        year: 2026,
        files: [{ publicPath, size: (await stat(join(fixtureRoot, publicPath))).size, sha256: "0".repeat(64) }],
      }],
    };
  }
  const snapshot = {
    schemaVersion: 1,
    dataset: "austin-starks/congressional-stock-trades",
    generatedAt: "2026-09-20T00:00:00.000Z",
    totals: { filings: 1, trades: 1, events: 1, failedFilings: 0 },
    tables,
  };
  const database = join(temporary, "fixture.sqlite");
  const datasetApi = requireFromInstall("congressional-disclosures/dataset");
  const imported = await datasetApi.materializeCongressionalDatasetSqlite({
    datasetDirectory: fixtureRoot,
    databasePath: database,
    snapshot,
  });
  if (imported.filings !== 1 || imported.trades !== 1 || imported.events !== 1) {
    throw new Error(`packed SQLite import returned wrong counts: ${JSON.stringify(imported)}`);
  }
  const { SQLitePoliticalRepository } = requireFromInstall("congressional-disclosures/storage");
  const repository = new SQLitePoliticalRepository(database);
  try {
    const lake = await repository.snapshot();
    if (lake.events[0]?.ticker !== "SPYB") throw new Error("packed SQLite import did not preserve the event row");
  } finally {
    await repository.close();
  }
  console.log(`packed install verified for congressional-disclosures ${packageJson.version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
