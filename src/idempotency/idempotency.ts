import { createHash } from "node:crypto";
import { type Clock, systemClock } from "../clock.js";

/** 409: the same key is currently being processed by another request. */
export class IdempotencyInProgressError extends Error {
  constructor(readonly key: string) {
    super(`request with idempotency key '${key}' is already in progress`);
    this.name = "IdempotencyInProgressError";
  }
}

/** 422: the key was reused with a different request body — almost always a client bug. */
export class IdempotencyKeyReuseError extends Error {
  constructor(readonly key: string) {
    super(`idempotency key '${key}' was already used with a different request`);
    this.name = "IdempotencyKeyReuseError";
  }
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

type Entry =
  | { state: "IN_PROGRESS"; fingerprint: string; expiresAt: number }
  | { state: "COMPLETED"; fingerprint: string; expiresAt: number; response: StoredResponse };

export type BeginResult = { kind: "started" } | { kind: "replay"; response: StoredResponse };

/**
 * Storage contract. A production implementation must make `begin` atomic, e.g.
 * `INSERT ... ON CONFLICT DO NOTHING` in PostgreSQL or `SET key value NX PX ttl` in Redis.
 */
export interface IdempotencyStore {
  begin(key: string, fingerprint: string): Promise<BeginResult>;
  complete(key: string, response: StoredResponse): Promise<void>;
  /** Release the key after a failure so the client can retry. */
  release(key: string): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly clock: Clock = systemClock,
  ) {}

  async begin(key: string, fingerprint: string): Promise<BeginResult> {
    const now = this.clock.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) {
      if (existing.fingerprint !== fingerprint) throw new IdempotencyKeyReuseError(key);
      if (existing.state === "IN_PROGRESS") throw new IdempotencyInProgressError(key);
      return { kind: "replay", response: existing.response };
    }
    this.entries.set(key, { state: "IN_PROGRESS", fingerprint, expiresAt: now + this.ttlMs });
    return { kind: "started" };
  }

  async complete(key: string, response: StoredResponse): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`unknown idempotency key '${key}'`);
    this.entries.set(key, { ...entry, state: "COMPLETED", response });
  }

  async release(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/** Stable fingerprint of a request: method + path + canonical JSON body. */
export function fingerprint(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()} ${path}\n${canonicalJson(body)}`)
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Execute `handler` at most once per idempotency key. Repeated requests with the same key and body receive
 * the stored response; the handler's side effects are not repeated.
 */
export async function handleIdempotently(
  store: IdempotencyStore,
  key: string,
  requestFingerprint: string,
  handler: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  const begin = await store.begin(key, requestFingerprint);
  if (begin.kind === "replay") return { ...begin.response, replayed: true };
  try {
    const response = await handler();
    // Only cache definitive outcomes. 5xx means "unknown" — let the client retry.
    if (response.status < 500) await store.complete(key, response);
    else await store.release(key);
    return { ...response, replayed: false };
  } catch (error) {
    await store.release(key);
    throw error;
  }
}
