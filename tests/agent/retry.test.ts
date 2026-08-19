import { describe, expect, it } from "vitest";
import { fetchWithRetry } from "../../src/agent/llm/retry.js";

const respond = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message: "boom" } }), { status, headers });

function stub(...responses: (Response | Error)[]) {
  const seen: string[] = [];
  const impl = (async () => {
    const next = responses[seen.length];
    seen.push("call");
    if (next instanceof Error) throw next;
    return next ?? respond(500);
  }) as unknown as typeof fetch;
  return { impl, calls: () => seen.length };
}

const noWait = async () => undefined;
const options = (fetchImpl: typeof fetch) => ({ fetchImpl, baseDelayMs: 0, onRetry: () => undefined, sleep: noWait });

describe("fetchWithRetry", () => {
  it("retries a rate limit and returns the eventual success", async () => {
    const { impl, calls } = stub(respond(429), respond(503), new Response("{}", { status: 200 }));
    const response = await fetchWithRetry("https://example.test", {}, options(impl));
    expect(response.status).toBe(200);
    expect(calls()).toBe(3);
  });

  it("does not retry a rejection that will repeat", async () => {
    const { impl, calls } = stub(respond(401));
    const response = await fetchWithRetry("https://example.test", {}, options(impl));
    expect(response.status).toBe(401);
    expect(calls()).toBe(1);
  });

  it("hands back the last retriable response so the caller reports the real status", async () => {
    const { impl, calls } = stub(respond(429), respond(429), respond(429), respond(429));
    const response = await fetchWithRetry("https://example.test", {}, { ...options(impl), attempts: 4 });
    expect(response.status).toBe(429);
    expect(calls()).toBe(4);
  });

  it("retries a transport failure and rethrows the original cause when it never recovers", async () => {
    const { impl, calls } = stub(new Error("socket hang up"), new Error("socket hang up"));
    await expect(fetchWithRetry("https://example.test", {}, { ...options(impl), attempts: 2 })).rejects.toThrow(/socket hang up/);
    expect(calls()).toBe(2);
  });

  it("honours a Retry-After header ahead of the backoff schedule", async () => {
    const waits: number[] = [];
    const { impl } = stub(respond(429, { "retry-after": "2" }), new Response("{}", { status: 200 }));
    await fetchWithRetry("https://example.test", {}, { fetchImpl: impl, baseDelayMs: 0, sleep: noWait, onRetry: (detail) => waits.push(detail.delayMs) });
    expect(waits).toEqual([2_000]);
  });
});
