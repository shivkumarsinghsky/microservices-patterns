# ADR-003: Order of Composed Resilience Policies

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

Retry, circuit breaker, bulkhead and timeout are frequently combined, and the nesting order changes behaviour
significantly (for example a timeout outside the retry bounds the *total* time instead of each attempt).

## Decision

Compose as `retry → circuit breaker → bulkhead → timeout → operation` (outermost first), implemented in
[`src/resilience/policy.ts`](../../src/resilience/policy.ts):

- Each attempt is evaluated by the circuit breaker, so repeated failures open it.
- Retry does not retry `CircuitOpenError` — an open circuit ends the sequence immediately.
- The bulkhead limits concurrent attempts; the timeout bounds each attempt.

## Alternatives Considered

- **Circuit breaker outside retry** — the breaker would only see the final outcome of a retry sequence and would
  open much later.
- **Timeout outermost** — useful when the caller has a hard total budget; can be added as an additional outer
  timeout.

## Trade-offs

Total latency in the worst case is `attempts × timeout + backoff delays`. Callers with strict budgets should add
an overall deadline.

## Consequences

The composition is covered by a test that exercises a timeout, a transient error and a success in sequence.
