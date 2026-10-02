import { TimeoutError } from "./errors.js";

/**
 * Run `operation` with a deadline. The operation receives an AbortSignal and SHOULD pass it to the
 * underlying I/O (fetch, database driver) so that work is actually cancelled, not merely ignored.
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!(timeoutMs > 0)) throw new RangeError("timeoutMs must be > 0");
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
