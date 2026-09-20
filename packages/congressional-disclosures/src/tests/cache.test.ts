import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { LocalCache } from "../runtime/cache";

describe("LocalCache", () => {
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), "congressional-disclosures-cache-"));
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  test("hashes replay keys before using them as filenames", async () => {
    const cache = new LocalCache(join(temp, "cache"));
    const key = "../../outside/package";
    const target = cache.path("responses", key);

    expect(target.startsWith(join(temp, "cache", "responses"))).toBe(true);
    expect(target).not.toContain("outside");
    await cache.writeJson(key, { ok: true });
    expect(await cache.readJson(key)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ ok: true });
  });

  test("does not let a replay key read a JSON file outside the cache", async () => {
    const cache = new LocalCache(join(temp, "cache"));
    const outside = join(temp, "private.json");
    await writeFile(outside, JSON.stringify({ secret: "not-a-cache-entry" }));

    expect(await cache.readJson("../../private")).toBeNull();
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual({ secret: "not-a-cache-entry" });
  });

  test("rejects path-shaped namespaces and extensions", () => {
    const cache = new LocalCache(join(temp, "cache"));
    expect(() => cache.path("../responses", "key")).toThrow("Invalid cache namespace");
    expect(() => cache.path("responses", "key", "/../../outside")).toThrow("Invalid cache extension");
    expect(dirname(cache.path("responses", "key"))).toBe(join(temp, "cache", "responses"));
  });
});
