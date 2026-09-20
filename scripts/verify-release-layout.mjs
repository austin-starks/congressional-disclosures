import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = join(root, "packages", "congressional-disclosures");
const subpaths = ["backfill", "extraction", "integrity", "lake", "sources", "storage"];

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const rootPackage = await json(join(root, "package.json"));
const npmPackage = await json(join(packageRoot, "package.json"));

assert(rootPackage.name === npmPackage.name, "root and npm package names differ");
assert(rootPackage.version === npmPackage.version, "root and npm package versions differ");
assert(
  await readFile(join(root, "README.md"), "utf8") === await readFile(join(packageRoot, "README.md"), "utf8"),
  "root and npm READMEs differ",
);

for (const subpath of subpaths) {
  const exportName = `./${subpath}`;
  assert(rootPackage.exports?.[exportName], `root package is missing ${exportName}`);
  assert(npmPackage.exports?.[exportName], `npm package is missing ${exportName}`);

  const rootJs = `module.exports = require("./packages/congressional-disclosures/dist/${subpath}");\n`;
  const rootTypes = `export * from "./packages/congressional-disclosures/dist/${subpath}";\n`;
  const npmJs = `module.exports = require("./dist/${subpath}");\n`;
  const npmTypes = `export * from "./dist/${subpath}";\n`;
  assert(await readFile(join(root, `${subpath}.js`), "utf8") === rootJs, `${subpath}.js is not the GitHub-install forwarder`);
  assert(await readFile(join(root, `${subpath}.d.ts`), "utf8") === rootTypes, `${subpath}.d.ts is not the GitHub-install type forwarder`);
  assert(await readFile(join(packageRoot, `${subpath}.js`), "utf8") === npmJs, `npm ${subpath}.js is not the package forwarder`);
  assert(await readFile(join(packageRoot, `${subpath}.d.ts`), "utf8") === npmTypes, `npm ${subpath}.d.ts is not the package type forwarder`);
  await access(join(packageRoot, "dist", subpath, "index.js")).catch(async () => {
    if (subpath !== "integrity") throw new Error(`built ${subpath} entry point is missing`);
    await access(join(packageRoot, "dist", "integrity.js"));
  });
}

await access(join(packageRoot, "dist", "index.js"));
await access(join(packageRoot, "dist", "cli.js"));
console.log(`release layout verified for congressional-disclosures ${npmPackage.version}`);
