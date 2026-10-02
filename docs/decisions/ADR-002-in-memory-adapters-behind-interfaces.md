# ADR-002: In-Memory Adapters Behind Storage Interfaces

- **Status:** Accepted
- **Date:** 2026-10-01

## Context

Patterns like outbox, idempotency and event sourcing depend on storage guarantees (atomic transactions,
conditional inserts, optimistic concurrency). Running PostgreSQL, Redis and a broker to demonstrate them makes the
repository slower to try and harder to test.

## Decision

Define small storage interfaces (`IdempotencyStore`, `SagaLog`, `EventStore`, `Transaction`) and ship in-memory
implementations that honour the **same guarantees**. Each interface documents the production mechanism that
provides the guarantee (e.g. `INSERT … ON CONFLICT DO NOTHING`, `SET NX PX`, expected-version append).

## Alternatives Considered

- **Real infrastructure via Docker Compose** — closer to production, but the patterns would be buried under
  driver code; this is done instead in
  [event-driven-platform](https://github.com/shivkumarsinghsky/event-driven-platform).
- **Mocks in tests only** — would not demonstrate the guarantees, only the call sequence.

## Trade-offs

In-memory implementations cannot show real-world failure modes such as network partitions or lock contention.
These are covered in the documentation's *Trade-offs* sections rather than in code.

## Consequences

- `npm test` runs in about a second with no infrastructure.
- Swapping in a real adapter means implementing one interface.
