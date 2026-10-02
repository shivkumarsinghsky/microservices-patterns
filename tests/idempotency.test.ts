import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../src/clock.js";
import {
  fingerprint,
  handleIdempotently,
  IdempotencyInProgressError,
  IdempotencyKeyReuseError,
  InMemoryIdempotencyStore,
} from "../src/idempotency/idempotency.js";

describe("idempotency keys", () => {
  const body = { amount: 100, currency: "EUR" };
  const fp = fingerprint("POST", "/payments", body);

  it("fingerprint is independent of JSON key order", () => {
    expect(fingerprint("post", "/payments", { currency: "EUR", amount: 100 })).toBe(fp);
    expect(fingerprint("POST", "/payments", { amount: 101, currency: "EUR" })).not.toBe(fp);
  });

  it("executes the handler once and replays the stored response", async () => {
    const store = new InMemoryIdempotencyStore();
    const handler = vi.fn().mockResolvedValue({ status: 201, body: { paymentId: "p1" } });
    const first = await handleIdempotently(store, "k1", fp, handler);
    const second = await handleIdempotently(store, "k1", fp, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ status: 201, body: { paymentId: "p1" }, replayed: false });
    expect(second).toEqual({ status: 201, body: { paymentId: "p1" }, replayed: true });
  });

  it("rejects a concurrent duplicate while the first request is in progress", async () => {
    const store = new InMemoryIdempotencyStore();
    let finish!: () => void;
    const slow = () =>
      new Promise<{ status: number; body: unknown }>((r) => (finish = () => r({ status: 200, body: {} })));
    const first = handleIdempotently(store, "k2", fp, slow);
    await expect(handleIdempotently(store, "k2", fp, slow)).rejects.toBeInstanceOf(
      IdempotencyInProgressError,
    );
    finish();
    await first;
  });

  it("rejects reuse of a key with a different body", async () => {
    const store = new InMemoryIdempotencyStore();
    await handleIdempotently(store, "k3", fp, async () => ({ status: 201, body: {} }));
    const other = fingerprint("POST", "/payments", { amount: 5, currency: "EUR" });
    await expect(
      handleIdempotently(store, "k3", other, async () => ({ status: 201, body: {} })),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });

  it("does not cache 5xx responses or thrown errors, so the client can retry", async () => {
    const store = new InMemoryIdempotencyStore();
    await handleIdempotently(store, "k4", fp, async () => ({ status: 503, body: {} }));
    await expect(
      handleIdempotently(store, "k4", fp, async () => Promise.reject(new Error("db down"))),
    ).rejects.toThrow();
    const ok = await handleIdempotently(store, "k4", fp, async () => ({ status: 201, body: { id: 1 } }));
    expect(ok.replayed).toBe(false);
  });

  it("keys expire after the TTL", async () => {
    const clock = new ManualClock();
    const store = new InMemoryIdempotencyStore(1_000, clock);
    const handler = vi.fn().mockResolvedValue({ status: 201, body: {} });
    await handleIdempotently(store, "k5", fp, handler);
    clock.advance(1_001);
    await handleIdempotently(store, "k5", fp, handler);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
