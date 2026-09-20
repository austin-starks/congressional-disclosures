import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  console.log(`packed install verified for congressional-disclosures ${packageJson.version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
