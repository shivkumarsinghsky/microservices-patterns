# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-10-02

### Added

- Dockerfile and docker compose services that build the library and run both demos.
- 17 pattern documents with a CI-enforced structure and Mermaid diagrams.
- TypeScript reference implementations: timeout, retry, circuit breaker, bulkhead, composed policy,
  idempotency keys, transactional outbox, saga orchestrator, event-sourced work order with CQRS projection,
  service registry.
- Runnable examples: checkout saga, resilient client.
- ADR-001 to ADR-003; CI (lint, typecheck, tests, examples, docs) and security workflows.
