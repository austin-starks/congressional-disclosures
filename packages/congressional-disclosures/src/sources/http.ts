export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Readonly<Record<string, string>>;
  acceptedStatuses?: readonly number[];
  maxBytes?: number;
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
      if (response.ok || options.acceptedStatuses?.includes(response.status)) return response;
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
  return readResponseBuffer(await fetchWithRetry(url, {}, options), options.maxBytes);
}

export async function readResponseBuffer(response: Response, maxBytes?: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeded ${maxBytes} bytes`);
  }
  if (maxBytes === undefined) return Buffer.from(await response.arrayBuffer());
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, received);
}
