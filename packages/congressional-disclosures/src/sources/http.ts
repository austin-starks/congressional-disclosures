export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Readonly<Record<string, string>>;
}

export async function fetchWithRetry(url: string, init: RequestInit = {}, options: HttpOptions = {}): Promise<Response> {
  const retries = options.retries ?? 4;
  let last: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
        headers: { "User-Agent": "congressional-disclosures/0.2", ...options.headers, ...init.headers },
      });
      if (response.ok) return response;
      if (response.status === 404 || response.status < 500 && response.status !== 429) {
        throw new Error(`${response.status} ${response.statusText} from ${url}`);
      }
      last = new Error(`${response.status} ${response.statusText} from ${url}`);
    } catch (error) {
      last = error;
    }
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw last instanceof Error ? last : new Error(`Request failed: ${url}`);
}

export async function fetchBuffer(url: string, options: HttpOptions = {}): Promise<Buffer> {
  return Buffer.from(await (await fetchWithRetry(url, {}, options)).arrayBuffer());
}
