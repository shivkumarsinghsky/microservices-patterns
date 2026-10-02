import { sleep as realSleep } from "../clock.js";
import { CircuitOpenError, RetryExhaustedError } from "./errors.js";

export interface RetryOptions {
  /** Total attempts including the first call. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Decide whether an error is transient. Default: everything except an open circuit. */
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Injected for deterministic tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * "Full jitter" exponential backoff: delay = random(0, min(maxDelay, base * 2^(attempt-1))).
 * Jitter spreads retries from many clients so they do not hit a recovering dependency in lockstep.
 */
export function backoffDelay(
  attempt: number,
  opts: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "random">,
): number {
  const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor((opts.random ?? Math.random)() * ceiling);
}

const defaultRetryable = (error: unknown) => !(error instanceof CircuitOpenError);

/**
 * Retry an operation with exponential backoff and jitter.
 * Only wrap operations that are idempotent (or made idempotent with an idempotency key).
 */
export async function retry<T>(operation: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  if (opts.maxAttempts < 1) throw new RangeError("maxAttempts must be >= 1");
  const isRetryable = opts.isRetryable ?? defaultRetryable;
  const wait = opts.sleep ?? realSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) throw error;
      if (attempt === opts.maxAttempts) break;
      const delayMs = backoffDelay(attempt, opts);
      opts.onRetry?.({ attempt, delayMs, error });
      await wait(delayMs);
    }
  }
  throw new RetryExhaustedError(opts.maxAttempts, lastError);
}
