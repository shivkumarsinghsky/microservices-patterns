import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../src/clock.js";
import {
  backoffDelay,
  Bulkhead,
  BulkheadRejectedError,
  CircuitBreaker,
  CircuitOpenError,
  resilientCall,
  retry,
  RetryExhaustedError,
  TimeoutError,
  withTimeout,
} from "../src/resilience/index.js";

const noSleep = async () => {};

describe("withTimeout", () => {
  it("returns the result when the operation finishes in time", async () => {
    await expect(withTimeout(async () => "ok", 50)).resolves.toBe("ok");
  });

  it("rejects with TimeoutError and aborts the signal when the deadline passes", async () => {
    let seen: AbortSignal | undefined;
    const slow = (signal: AbortSignal) => {
      seen = signal;
      return new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
    };
    await expect(withTimeout(slow, 10)).rejects.toBeInstanceOf(TimeoutError);
    expect(seen?.aborted).toBe(true);
  });
});

describe("retry", () => {
  it("full-jitter backoff is bounded by the exponential ceiling and maxDelay", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 1_000, random: () => 0.999 };
    expect(backoffDelay(1, opts)).toBe(99);
    expect(backoffDelay(3, opts)).toBe(399);
    expect(backoffDelay(10, opts)).toBe(999);
    expect(backoffDelay(3, { ...opts, random: () => 0 })).toBe(0);
  });

  it("retries transient failures and eventually succeeds", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();
    const result = await retry(op, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      sleep: noSleep,
      onRetry,
    });
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts with the last error attached", async () => {
    const op = vi.fn().mockRejectedValue(new Error("down"));
    const err = await retry(op, { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RetryExhaustedError);
    expect((err as RetryExhaustedError).attempts).toBe(4);
    expect(op).toHaveBeenCalledTimes(4);
  });

  it("does not retry non-retryable errors", async () => {
    const op = vi.fn().mockRejectedValue(new CircuitOpenError("x"));
    await expect(
      retry(op, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe("CircuitBreaker", () => {
  const make = (clock: ManualClock, onStateChange = vi.fn()) =>
    new CircuitBreaker({
      name: "inventory",
      failureRateThreshold: 0.5,
      slidingWindowSize: 4,
      minimumCalls: 4,
      openDurationMs: 1_000,
      halfOpenMaxCalls: 2,
      clock,
      onStateChange,
    });
  const fail = () => Promise.reject(new Error("boom"));
  const ok = () => Promise.resolve("ok");

  it("opens when the failure rate over the window reaches the threshold", async () => {
    const cb = make(new ManualClock());
    await cb.execute(ok);
    await cb.execute(ok);
    await expect(cb.execute(fail)).rejects.toThrow("boom");
    expect(cb.currentState).toBe("CLOSED"); // only 3 calls, below minimumCalls
    await expect(cb.execute(fail)).rejects.toThrow("boom");
    expect(cb.currentState).toBe("OPEN"); // 2/4 = 50%
  });

  it("rejects fast while open, without calling the dependency", async () => {
    const cb = make(new ManualClock());
    for (let i = 0; i < 4; i++) await cb.execute(fail).catch(() => {});
    const dependency = vi.fn(ok);
    await expect(cb.execute(dependency)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(dependency).not.toHaveBeenCalled();
  });

  it("half-opens after the open duration and closes after successful trial calls", async () => {
    const clock = new ManualClock();
    const transitions = vi.fn();
    const cb = make(clock, transitions);
    for (let i = 0; i < 4; i++) await cb.execute(fail).catch(() => {});
    clock.advance(1_000);
    expect(cb.currentState).toBe("HALF_OPEN");
    await cb.execute(ok);
    await cb.execute(ok);
    expect(cb.currentState).toBe("CLOSED");
    expect(transitions.mock.calls).toEqual([
      ["CLOSED", "OPEN"],
      ["OPEN", "HALF_OPEN"],
      ["HALF_OPEN", "CLOSED"],
    ]);
  });

  it("re-opens if a trial call fails", async () => {
    const clock = new ManualClock();
    const cb = make(clock);
    for (let i = 0; i < 4; i++) await cb.execute(fail).catch(() => {});
    clock.advance(1_000);
    await cb.execute(fail).catch(() => {});
    expect(cb.currentState).toBe("OPEN");
  });

  it("ignores errors classified as non-failures (e.g. validation errors)", async () => {
    const cb = new CircuitBreaker({
      name: "x",
      failureRateThreshold: 0.5,
      slidingWindowSize: 2,
      minimumCalls: 2,
      openDurationMs: 1,
      halfOpenMaxCalls: 1,
      isFailure: (e) => !(e instanceof RangeError),
    });
    for (let i = 0; i < 5; i++)
      await cb.execute(() => Promise.reject(new RangeError("bad input"))).catch(() => {});
    expect(cb.currentState).toBe("CLOSED");
  });
});

describe("Bulkhead", () => {
  it("limits concurrency, queues up to maxQueue and rejects beyond that", async () => {
    const bh = new Bulkhead({ name: "reports", maxConcurrent: 2, maxQueue: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await gate;
      running--;
      return "done";
    };
    const a = bh.execute(task);
    const b = bh.execute(task);
    const c = bh.execute(task); // queued
    await expect(bh.execute(task)).rejects.toBeInstanceOf(BulkheadRejectedError);
    expect(bh.stats).toEqual({ active: 2, queued: 1 });
    release();
    await expect(Promise.all([a, b, c])).resolves.toEqual(["done", "done", "done"]);
    expect(peak).toBe(2);
    expect(bh.stats).toEqual({ active: 0, queued: 0 });
  });
});

describe("resilientCall (composed policy)", () => {
  it("retries timeouts and transient errors, then succeeds", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) await new Promise((r) => setTimeout(r, 50)); // times out
      if (calls === 2) throw new Error("503");
      return "ok";
    };
    const policy = {
      timeoutMs: 10,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
      circuitBreaker: new CircuitBreaker({
        name: "dep",
        failureRateThreshold: 1,
        slidingWindowSize: 10,
        minimumCalls: 10,
        openDurationMs: 1_000,
        halfOpenMaxCalls: 1,
      }),
      bulkhead: new Bulkhead({ name: "dep", maxConcurrent: 5, maxQueue: 0 }),
    };
    await expect(resilientCall(policy, flaky)).resolves.toBe("ok");
    expect(calls).toBe(3);
  });
});
