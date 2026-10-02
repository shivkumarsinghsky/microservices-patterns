import { describe, expect, it, vi } from "vitest";
import { enqueue, InMemoryDatabase, type OutboxMessage, OutboxRelay } from "../src/outbox/outbox.js";

async function placeOrder(db: InMemoryDatabase, orderId: string, failAfterWrite = false) {
  await db.transaction((tx) => {
    tx.put("orders", orderId, { orderId, status: "PLACED" });
    enqueue(tx, { aggregateType: "Order", aggregateId: orderId, type: "OrderPlaced", payload: { orderId } });
    if (failAfterWrite) throw new Error("constraint violation");
  });
}

describe("transactional outbox", () => {
  it("commits the business row and the event atomically", async () => {
    const db = new InMemoryDatabase();
    await placeOrder(db, "o1");
    await expect(placeOrder(db, "o2", true)).rejects.toThrow();
    expect(db.rows("orders")).toHaveLength(1);
    expect(db.rows<OutboxMessage>("outbox").map((m) => m.aggregateId)).toEqual(["o1"]);
  });

  it("relay publishes pending messages in order and marks them published", async () => {
    const db = new InMemoryDatabase();
    for (const id of ["o1", "o2", "o3"]) await placeOrder(db, id);
    const published: string[] = [];
    const relay = new OutboxRelay(db, async (m) => void published.push(m.aggregateId));
    expect(await relay.pollOnce()).toEqual({ published: 3, failed: false });
    expect(published).toEqual(["o1", "o2", "o3"]);
    expect(await relay.pollOnce()).toEqual({ published: 0, failed: false });
  });

  it("stops at the first failure to preserve ordering, and resumes later", async () => {
    const db = new InMemoryDatabase();
    for (const id of ["o1", "o2", "o3"]) await placeOrder(db, id);
    const publish = vi
      .fn<(m: OutboxMessage) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValue();
    const relay = new OutboxRelay(db, publish);
    expect(await relay.pollOnce()).toEqual({ published: 1, failed: true });
    const failed = db.rows<OutboxMessage>("outbox").find((m) => m.aggregateId === "o2");
    expect(failed?.attempts).toBe(1);
    expect(await relay.pollOnce()).toEqual({ published: 2, failed: false });
    expect(publish.mock.calls.map(([m]) => m.aggregateId)).toEqual(["o1", "o2", "o2", "o3"]);
  });
});
