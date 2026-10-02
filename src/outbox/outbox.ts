import { randomUUID } from "node:crypto";
import { type Clock, systemClock } from "../clock.js";

export interface OutboxMessage {
  id: string;
  sequence: number;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: unknown;
  correlationId?: string;
  occurredAt: string;
  publishedAt?: string;
  attempts: number;
}

export interface Transaction {
  put<T>(table: string, id: string, row: T): void;
  get<T>(table: string, id: string): T | undefined;
}

/**
 * Minimal in-memory database with atomic multi-table transactions. It stands in for PostgreSQL so the
 * pattern can be demonstrated and tested without infrastructure. Writes are staged and applied only if the
 * transaction callback completes without throwing.
 */
export class InMemoryDatabase {
  private readonly tables = new Map<string, Map<string, unknown>>();

  async transaction<R>(work: (tx: Transaction) => Promise<R> | R): Promise<R> {
    const staged = new Map<string, Map<string, unknown>>();
    const tx: Transaction = {
      put: (table, id, row) => {
        if (!staged.has(table)) staged.set(table, new Map());
        staged.get(table)!.set(id, structuredClone(row));
      },
      get: <T>(table: string, id: string) =>
        (staged.get(table)?.get(id) ?? this.tables.get(table)?.get(id)) as T | undefined,
    };
    const result = await work(tx);
    for (const [table, rows] of staged) {
      if (!this.tables.has(table)) this.tables.set(table, new Map());
      for (const [id, row] of rows) this.tables.get(table)!.set(id, row);
    }
    return result;
  }

  rows<T>(table: string): T[] {
    return [...(this.tables.get(table)?.values() ?? [])].map((r) => structuredClone(r) as T);
  }
}

let sequence = 0;

/** Stage an event in the same transaction as the business change. */
export function enqueue(
  tx: Transaction,
  event: Pick<OutboxMessage, "aggregateType" | "aggregateId" | "type" | "payload" | "correlationId">,
  clock: Clock = systemClock,
): OutboxMessage {
  const message: OutboxMessage = {
    ...event,
    id: randomUUID(),
    sequence: ++sequence,
    occurredAt: new Date(clock.now()).toISOString(),
    attempts: 0,
  };
  tx.put("outbox", message.id, message);
  return message;
}

export type Publisher = (message: OutboxMessage) => Promise<void>;

/**
 * Polls unpublished outbox rows in sequence order and publishes them.
 *
 * Delivery is at-least-once: if the process crashes after publishing but before marking the row, the
 * message is published again on restart. Consumers must therefore be idempotent (dedupe on `id`).
 * On a publish failure the batch stops, preserving order for the remaining messages.
 */
export class OutboxRelay {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly publish: Publisher,
    private readonly batchSize = 100,
    private readonly clock: Clock = systemClock,
  ) {}

  async pollOnce(): Promise<{ published: number; failed: boolean }> {
    const pending = this.db
      .rows<OutboxMessage>("outbox")
      .filter((m) => !m.publishedAt)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, this.batchSize);

    let published = 0;
    for (const message of pending) {
      try {
        await this.publish(message);
      } catch {
        await this.db.transaction((tx) =>
          tx.put("outbox", message.id, { ...message, attempts: message.attempts + 1 }),
        );
        return { published, failed: true };
      }
      await this.db.transaction((tx) =>
        tx.put("outbox", message.id, { ...message, publishedAt: new Date(this.clock.now()).toISOString() }),
      );
      published++;
    }
    return { published, failed: false };
  }
}
