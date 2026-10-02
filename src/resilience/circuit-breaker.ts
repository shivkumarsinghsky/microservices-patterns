import { type Clock, systemClock } from "../clock.js";
import { CircuitOpenError } from "./errors.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  name: string;
  /** Failure rate (0..1) over the sliding window that opens the circuit. */
  failureRateThreshold: number;
  /** Number of most recent calls considered. */
  slidingWindowSize: number;
  /** Do not evaluate the failure rate until at least this many calls are recorded. */
  minimumCalls: number;
  /** How long to stay OPEN before allowing trial calls. */
  openDurationMs: number;
  /** Trial calls permitted in HALF_OPEN; all must succeed to close. */
  halfOpenMaxCalls: number;
  /** Errors that should not count as dependency failures (e.g. 4xx validation errors). */
  isFailure?: (error: unknown) => boolean;
  clock?: Clock;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * Count-based sliding-window circuit breaker.
 *
 * CLOSED   → calls pass; outcomes recorded. Failure rate >= threshold ⇒ OPEN.
 * OPEN     → calls rejected immediately with CircuitOpenError until openDurationMs elapses ⇒ HALF_OPEN.
 * HALF_OPEN→ up to halfOpenMaxCalls trial calls. All succeed ⇒ CLOSED; any failure ⇒ OPEN.
 */
export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private outcomes: boolean[] = []; // true = failure
  private openedAt = 0;
  private halfOpenInFlight = 0;
  private halfOpenSuccesses = 0;
  private readonly clock: Clock;

  constructor(private readonly opts: CircuitBreakerOptions) {
    if (opts.failureRateThreshold <= 0 || opts.failureRateThreshold > 1) {
      throw new RangeError("failureRateThreshold must be in (0, 1]");
    }
    if (opts.minimumCalls > opts.slidingWindowSize) {
      throw new RangeError("minimumCalls cannot exceed slidingWindowSize");
    }
    this.clock = opts.clock ?? systemClock;
  }

  get currentState(): CircuitState {
    if (this.state === "OPEN" && this.clock.now() - this.openedAt >= this.opts.openDurationMs) {
      this.transition("HALF_OPEN");
    }
    return this.state;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const state = this.currentState;
    if (state === "OPEN") throw new CircuitOpenError(this.opts.name);
    if (state === "HALF_OPEN") {
      if (this.halfOpenInFlight >= this.opts.halfOpenMaxCalls) throw new CircuitOpenError(this.opts.name);
      this.halfOpenInFlight++;
    }
    try {
      const result = await operation();
      this.onSuccess(state);
      return result;
    } catch (error) {
      const counts = this.opts.isFailure ? this.opts.isFailure(error) : true;
      if (counts) this.onFailure(state);
      else this.onSuccess(state);
      throw error;
    } finally {
      if (state === "HALF_OPEN") this.halfOpenInFlight--;
    }
  }

  private onSuccess(stateAtCall: CircuitState): void {
    if (stateAtCall === "HALF_OPEN") {
      if (this.state !== "HALF_OPEN") return; // another trial already re-opened the circuit
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.opts.halfOpenMaxCalls) this.transition("CLOSED");
      return;
    }
    this.record(false);
  }

  private onFailure(stateAtCall: CircuitState): void {
    if (stateAtCall === "HALF_OPEN") {
      this.transition("OPEN");
      return;
    }
    this.record(true);
    if (
      this.outcomes.length >= this.opts.minimumCalls &&
      this.failureRate() >= this.opts.failureRateThreshold
    ) {
      this.transition("OPEN");
    }
  }

  private record(failed: boolean): void {
    this.outcomes.push(failed);
    if (this.outcomes.length > this.opts.slidingWindowSize) this.outcomes.shift();
  }

  failureRate(): number {
    if (this.outcomes.length === 0) return 0;
    return this.outcomes.filter(Boolean).length / this.outcomes.length;
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    if (to === "OPEN") this.openedAt = this.clock.now();
    if (to === "HALF_OPEN") this.halfOpenSuccesses = 0;
    if (to === "CLOSED") this.outcomes = [];
    this.opts.onStateChange?.(from, to);
  }
}
