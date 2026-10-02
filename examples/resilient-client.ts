/**
 * Calls a simulated flaky dependency through retry → circuit breaker → bulkhead → timeout and prints what
 * each layer did. Run: npm run build && node dist/examples/resilient-client.js
 */
import { Bulkhead, CircuitBreaker, CircuitOpenError, resilientCall, sleep } from "../src/index.js";

let call = 0;
// First 4 calls alternate between slow (timeout) and 503; afterwards the dependency recovers.
async function inventoryApi(): Promise<string> {
  call++;
  if (call <= 4) {
    if (call % 2) await sleep(100);
    else throw new Error("503 Service Unavailable");
  }
  return `stock=42 (call ${call})`;
}

const breaker = new CircuitBreaker({
  name: "inventory",
  failureRateThreshold: 0.5,
  slidingWindowSize: 6,
  minimumCalls: 4,
  openDurationMs: 200,
  halfOpenMaxCalls: 1,
  onStateChange: (from, to) => console.log(`  [breaker] ${from} -> ${to}`),
});
const policy = {
  timeoutMs: 30,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 50,
    onRetry: ({ attempt, error }: { attempt: number; error: unknown }) =>
      console.log(`  [retry] attempt ${attempt} failed: ${(error as Error).message}`),
  },
  circuitBreaker: breaker,
  bulkhead: new Bulkhead({ name: "inventory", maxConcurrent: 4, maxQueue: 8 }),
};

for (let request = 1; request <= 5; request++) {
  try {
    console.log(`request ${request}: ${await resilientCall(policy, inventoryApi)}`);
  } catch (error) {
    const reason =
      error instanceof CircuitOpenError ? "rejected fast (circuit open)" : (error as Error).message;
    console.log(`request ${request}: FAILED - ${reason}`);
  }
  if (request === 3) {
    console.log("  ...waiting for the open duration to elapse");
    await sleep(250);
  }
}
