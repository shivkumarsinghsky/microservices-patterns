export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`operation timed out after ${timeoutMs} ms`);
    this.name = "TimeoutError";
  }
}

export class CircuitOpenError extends Error {
  constructor(readonly circuit: string) {
    super(`circuit '${circuit}' is open; call rejected without reaching the dependency`);
    this.name = "CircuitOpenError";
  }
}

export class BulkheadRejectedError extends Error {
  constructor(readonly bulkhead: string) {
    super(`bulkhead '${bulkhead}' is full; call rejected`);
    this.name = "BulkheadRejectedError";
  }
}

export class RetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(
      `gave up after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    this.name = "RetryExhaustedError";
  }
}
