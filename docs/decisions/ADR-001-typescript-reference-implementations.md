# ADR-001: TypeScript for the Reference Implementations

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

The catalogue is primarily documentation, but patterns such as circuit breakers, sagas and outboxes are easy to
describe and easy to get subtly wrong. Small, tested implementations prove the descriptions are precise.

## Decision

Implement the code-relevant patterns in **TypeScript (Node.js 20+)** with strict compiler settings, Vitest for
tests and no runtime dependencies.

## Alternatives Considered

- **C#/.NET** — excellent for these patterns (Polly, MassTransit exist), but those libraries would hide the
  mechanics this repository is meant to show.
- **Java** — similar argument; also more boilerplate for small examples.
- **Python** — readable, but weaker typing for discriminated unions used by the event-sourced aggregate.

## Trade-offs

Production systems would normally use mature libraries (Polly, resilience4j, cockatiel) rather than hand-written
implementations. The code here optimises for readability and testability, not feature completeness.

## Consequences

- Each pattern implementation is a single, short file that can be read alongside its documentation.
- Zero runtime dependencies keeps the supply-chain surface minimal.
