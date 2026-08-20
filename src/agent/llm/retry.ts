// Shared bounded retry wrapper for Anthropic and OpenAI HTTP requests. It keeps
// a temporary provider/network problem from destroying an active discovery run,
// while allowing permanent request/authentication errors to fail immediately.
export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  // Reports retries to an operator or lets an evaluation harness count provider
  // noise separately from failures in the model's browser reasoning.
  onRetry?: (detail: { attempt: number; attempts: number; delayMs: number; reason: string }) => void;
  // Injectable with fetchImpl so tests can verify retries without real waiting.
  sleep?: (ms: number) => Promise<void>;
}

// Retry timeouts, conflicts, rate limits, and server failures. Client mistakes
// such as bad credentials or malformed input will not improve on another try.
const retriableStatuses = new Set([408, 409, 429]);

function isRetriable(status: number): boolean {
  return retriableStatuses.has(status) || status >= 500;
}

// Prefer a provider's numeric Retry-After value (capped at 30 seconds);
// otherwise use exponential delays such as 500ms, 1000ms, and 2000ms.
function backoffMs(attempt: number, baseDelayMs: number, retryAfter: string | null): number {
  const advertised = Number(retryAfter);
  if (Number.isFinite(advertised) && advertised > 0) return Math.min(advertised * 1_000, 30_000);
  return baseDelayMs * 2 ** (attempt - 1);
}

// The default callback makes a live retry visible instead of looking like a hang.
function warn(detail: { attempt: number; attempts: number; delayMs: number; reason: string }): void {
  console.error(`Model request failed (${detail.reason}); retrying in ${detail.delayMs}ms — attempt ${detail.attempt + 1} of ${detail.attempts}.`);
}

// Try at most four times by default. Successful and permanent-error responses
// return to the provider adapter; only transport/transient failures are retried.
export async function fetchWithRetry(url: string, init: RequestInit, options: RetryOptions = {}): Promise<Response> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const call = options.fetchImpl ?? fetch;
  const onRetry = options.onRetry ?? warn;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt === attempts;
    let response: Response;
    try {
      response = await call(url, init);
    } catch (error) {
      // A network failure has no HTTP response. Retry while attempts remain,
      // then rethrow the original transport error for an accurate diagnosis.
      if (last) throw error;
      const delayMs = backoffMs(attempt, baseDelayMs, null);
      onRetry({ attempt, attempts, delayMs, reason: String(error) });
      await sleep(delayMs);
      continue;
    }

    // Return the final failed response instead of replacing it with a generic
    // retry error, allowing the adapter to report the real status and message.
    if (response.ok || !isRetriable(response.status) || last) return response;
    const delayMs = backoffMs(attempt, baseDelayMs, response.headers.get("retry-after"));
    onRetry({ attempt, attempts, delayMs, reason: `HTTP ${response.status}` });
    await sleep(delayMs);
  }
}
