export interface StoredEvent<E = unknown> {
  streamId: string;
  /** 1-based position within the stream. */
  version: number;
  /** Position across all streams, used by projections as a checkpoint. */
  globalPosition: number;
  type: string;
  data: E;
  recordedAt: string;
}

export class ConcurrencyError extends Error {
  constructor(
    readonly streamId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`stream ${streamId}: expected version ${expectedVersion} but found ${actualVersion}`);
    this.name = "ConcurrencyError";
  }
}

export interface EventStore<E extends { type: string }> {
  /** Append atomically, only if the stream is still at `expectedVersion` (optimistic concurrency). */
  append(streamId: string, expectedVersion: number, events: E[]): Promise<StoredEvent<E>[]>;
  readStream(streamId: string): Promise<StoredEvent<E>[]>;
  readAll(fromGlobalPosition: number): Promise<StoredEvent<E>[]>;
}

export class InMemoryEventStore<E extends { type: string }> implements EventStore<E> {
  private readonly log: StoredEvent<E>[] = [];
  private readonly versions = new Map<string, number>();

  async append(streamId: string, expectedVersion: number, events: E[]): Promise<StoredEvent<E>[]> {
    const actual = this.versions.get(streamId) ?? 0;
    if (actual !== expectedVersion) throw new ConcurrencyError(streamId, expectedVersion, actual);
    const stored = events.map((data, i) => ({
      streamId,
      version: actual + i + 1,
      globalPosition: this.log.length + i + 1,
      type: data.type,
      data: structuredClone(data),
      recordedAt: new Date().toISOString(),
    }));
    this.log.push(...stored);
    this.versions.set(streamId, actual + events.length);
    return stored;
  }

  async readStream(streamId: string): Promise<StoredEvent<E>[]> {
    return this.log.filter((e) => e.streamId === streamId);
  }

  async readAll(fromGlobalPosition: number): Promise<StoredEvent<E>[]> {
    return this.log.filter((e) => e.globalPosition > fromGlobalPosition);
  }
}
