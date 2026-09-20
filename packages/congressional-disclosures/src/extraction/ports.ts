/**
 * The model port extraction runs against, ported from the NexusGenAI passthrough client the
 * pipeline was measured on (`chatCompletionsPassthrough`).
 *
 * It is deliberately NOT the backfill's `LanguageModel`: that port's result carries a
 * `truncated` verdict and no token usage, while extraction reads truncation from gateway
 * rejections at its own `run` seam and must report `usage` — the read passes count prompt and
 * completion tokens per pass (`ConsensusCounts`), and those counts are part of what a round
 * records. One method, because one method is all the extraction path ever called.
 */

/** Token counts of one completion, as the gateway reported them. */
export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Any chat or structured-output model behind an OpenAI-compatible completions endpoint.
 * The body is the verbatim passthrough payload (messages, `response_format`, attachments,
 * gateway flags such as `allowExpensiveModel`); `payload` is the verbatim response.
 */
export interface CompletionClient {
  complete(request: {
    model: string;
    body: Record<string, unknown>;
    /** Replay key. A provider that honours it must not bill a repeat twice. */
    idempotencyKey?: string;
    timeoutMs?: number;
    maxCompletionTokens?: number;
  }): Promise<{ payload: Record<string, unknown>; usage: CompletionUsage }>;
}
