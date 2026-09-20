import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import type { RawDisclosureSource } from "../lake/normalize";

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin";
}

export class LocalCache {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  path(namespace: string, key: string, extension = ".json"): string {
    return join(this.root, namespace, `${key}${extension}`);
  }

  async readJson(key: string): Promise<Record<string, unknown> | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path("responses", key), "utf8"));
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async writeJson(key: string, value: Record<string, unknown>): Promise<void> {
    const target = this.path("responses", key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(value));
  }

  async archive(bytes: Buffer, sourceUrl: string, sourceName: string): Promise<RawDisclosureSource> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const relative = join("raw", sha256.slice(0, 2), `${sha256}${safeExtension(sourceName)}`);
    const target = join(this.root, relative);
    await mkdir(dirname(target), { recursive: true });
    try { await writeFile(target, bytes, { flag: "wx" }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return { sourceUrl, rawArchiveKey: relative, rawSha256: sha256 };
  }
}

export function requestHash(...parts: readonly (string | Buffer)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) { hash.update(part); hash.update("\0"); }
  return hash.digest("hex");
}
