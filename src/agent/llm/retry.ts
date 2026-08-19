export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  /** Called before each wait. The default warns on stderr so a live operator can
   *  see the run is backing off rather than hung; an eval harness can count these
   *  instead, keeping transport noise out of its capability success rate. */
  onRetry?: (detail: { attempt: number; attempts: number; delayMs: number; reason: string }) => void;
  /** Injectable so tests can assert the schedule without waiting it out. */
  sleep?: (ms: number) => Promise<void>;
}

// Rate limits, conflicts and server faults are worth another attempt. Anything
// else the API rejects — a bad key, a malformed request — will be rejected
// identically next time, so retrying only delays the real error.
const retriableStatuses = new Set([408, 409, 429]);

function isRetriable(status: number): boolean {
  return retriableStatuses.has(status) || status >= 500;
}

function backoffMs(attempt: number, baseDelayMs: number, retryAfter: string | null): number {
  const advertised = Number(retryAfter);
  if (Number.isFinite(advertised) && advertised > 0) return Math.min(advertised * 1_000, 30_000);
  return baseDelayMs * 2 ** (attempt - 1);
}

function warn(detail: { attempt: number; attempts: number; delayMs: number; reason: string }): void {
  console.error(`Model request failed (${detail.reason}); retrying in ${detail.delayMs}ms — attempt ${detail.attempt + 1} of ${detail.attempts}.`);
}

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
      // A transport failure has no response to hand back, so the final attempt
      // rethrows and the caller reports the original cause.
      if (last) throw error;
      const delayMs = backoffMs(attempt, baseDelayMs, null);
      onRetry({ attempt, attempts, delayMs, reason: String(error) });
      await sleep(delayMs);
      continue;
    }
    // The last response is returned even when retriable, so the caller's own
    // error path still reports the status and message the API actually sent.
    if (response.ok || !isRetriable(response.status) || last) return response;
    const delayMs = backoffMs(attempt, baseDelayMs, response.headers.get("retry-after"));
    onRetry({ attempt, attempts, delayMs, reason: `HTTP ${response.status}` });
    await sleep(delayMs);
  }
}
