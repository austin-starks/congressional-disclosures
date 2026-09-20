/**
 * Run an async mapper over a list with a bounded number of in-flight tasks.
 *
 * Results are returned in input order regardless of completion order. The first
 * rejection propagates; remaining queued work is not started, though tasks
 * already in flight run to completion (there is no cancellation channel).
 *
 * Use `mapWithConcurrencySettled` when partial success is acceptable.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: effectiveLimit }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * A limiter shared by every caller holding it: at most `limit` tasks run at once, started in the order
 * they were submitted. `mapWithConcurrency` bounds one list; a shared limiter bounds nested work, such
 * as several filings each submitting their pages, without multiplying the bound.
 */
export function createConcurrencyLimiter(
  limit: number,
): <R>(task: () => Promise<R>) => Promise<R> {
  const effectiveLimit = Math.max(1, limit);
  const queue: Array<() => void> = [];
  let active = 0;
  const startNext = (): void => {
    if (active >= effectiveLimit) {
      return;
    }
    const start = queue.shift();
    if (start) {
      active += 1;
      start();
    }
  };
  return <R>(task: () => Promise<R>): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            startNext();
          });
      });
      startNext();
    });
}

export type SettledResult<R> =
  | { status: "fulfilled"; value: R }
  | { status: "rejected"; reason: unknown };

/**
 * Bounded-concurrency map that never rejects. Every item yields a settled entry
 * in input order, so a single failing shard cannot discard its siblings' work.
 */
export async function mapWithConcurrencySettled<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<Array<SettledResult<R>>> {
  return mapWithConcurrency(items, limit, async (item, index) => {
    try {
      return { status: "fulfilled" as const, value: await mapper(item, index) };
    } catch (reason) {
      return { status: "rejected" as const, reason };
    }
  });
}
