import type { CompletionClient, CompletionUsage } from "../extraction";
import { LocalCache, requestHash } from "../runtime/cache";

export interface OpenAiCompatibleConfig {
  apiKey: string;
  baseUrl?: string;
  headers?: Readonly<Record<string, string>>;
  cache?: LocalCache;
}

function usageOf(payload: Record<string, unknown>): CompletionUsage {
  const raw = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : {};
  const promptTokens = Number(raw.prompt_tokens ?? raw.promptTokens ?? 0);
  const completionTokens = Number(raw.completion_tokens ?? raw.completionTokens ?? 0);
  return { promptTokens, completionTokens, totalTokens: Number(raw.total_tokens ?? raw.totalTokens ?? promptTokens + completionTokens) };
}

/** Fetch-based adapter for OpenRouter and other OpenAI-compatible chat-completion APIs. */
export class OpenAiCompatibleCompletionClient implements CompletionClient {
  private readonly endpoint: string;
  constructor(private readonly config: OpenAiCompatibleConfig) {
    this.endpoint = `${(config.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "")}/chat/completions`;
  }

  async complete(request: { model: string; body: Record<string, unknown>; idempotencyKey?: string; timeoutMs?: number; maxCompletionTokens?: number }): Promise<{ payload: Record<string, unknown>; usage: CompletionUsage }> {
    const key = request.idempotencyKey ?? requestHash(this.endpoint, JSON.stringify(request.body));
    const cached = await this.config.cache?.readJson(key);
    if (cached) return { payload: cached, usage: usageOf(cached) };
    const response = await fetch(this.endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(request.timeoutMs ?? 240_000),
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Cache": "true",
        "X-OpenRouter-Title": "congressional-disclosures",
        ...this.config.headers,
      },
      body: JSON.stringify(request.body),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Completion API ${response.status}: ${body.slice(0, 500)}`);
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") throw new Error("Completion API returned a non-object response");
    const payload = parsed as Record<string, unknown>;
    await this.config.cache?.writeJson(key, payload);
    return { payload, usage: usageOf(payload) };
  }
}
