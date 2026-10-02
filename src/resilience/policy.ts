import type { Bulkhead } from "./bulkhead.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { retry, type RetryOptions } from "./retry.js";
import { withTimeout } from "./timeout.js";

export interface ResiliencePolicy {
  timeoutMs: number;
  retry: RetryOptions;
  circuitBreaker: CircuitBreaker;
  bulkhead: Bulkhead;
}

/**
 * Compose the patterns in the conventional order (outermost first):
 *
 *   retry → circuit breaker → bulkhead → timeout → operation
 *
 * - Retry is outermost so each attempt is evaluated by the breaker.
 * - The breaker rejects fast when open, and retry does not retry CircuitOpenError.
 * - The bulkhead limits concurrency per attempt; the timeout bounds each attempt, not the whole sequence.
 */
export function resilientCall<T>(
  policy: ResiliencePolicy,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return retry(
    () =>
      policy.circuitBreaker.execute(() =>
        policy.bulkhead.execute(() => withTimeout(operation, policy.timeoutMs)),
      ),
    policy.retry,
  );
}
