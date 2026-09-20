import { fetchWithRetry } from "../sources/http";

describe("official-source HTTP client", () => {
  test("accepts an explicitly allowed redirect status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "/search/" },
    })) as typeof fetch;
    try {
      const response = await fetchWithRetry("https://example.test/agreement", {
        method: "POST",
        redirect: "manual",
      }, { acceptedStatuses: [302], retries: 0 });
      expect(response.status).toBe(302);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("still rejects an unapproved redirect status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => new Response(null, { status: 302 })) as typeof fetch;
    try {
      await expect(fetchWithRetry("https://example.test/agreement", {
        method: "POST",
        redirect: "manual",
      }, { retries: 0 })).rejects.toThrow(/302/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
