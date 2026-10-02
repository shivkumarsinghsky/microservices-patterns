import { describe, expect, it } from "vitest";
import {
  ConcurrencyError,
  decide,
  DomainError,
  evolve,
  handleCommand,
  InMemoryEventStore,
  initialState,
  OpenWorkOrdersProjection,
  type WorkOrderEvent,
} from "../src/index.js";

const create = (id: string, priority: 1 | 2 | 3 | 4 = 2) =>
  ({
    type: "CreateWorkOrder",
    workOrderId: id,
    assetId: `pump-${id}`,
    priority,
    description: "Seal leak",
  }) as const;

describe("work order aggregate (decide/evolve)", () => {
  it("enforces the lifecycle", () => {
    let state = initialState;
    for (const e of decide(create("1"), state)) state = evolve(state, e);
    expect(state.status).toBe("OPEN");
    expect(() => decide({ type: "StartWork", workOrderId: "1", at: "t" }, state)).toThrow(DomainError);
    for (const e of decide({ type: "AssignTechnician", workOrderId: "1", technicianId: "t1" }, state))
      state = evolve(state, e);
    expect(decide({ type: "AssignTechnician", workOrderId: "1", technicianId: "t1" }, state)).toEqual([]);
    for (const e of decide({ type: "StartWork", workOrderId: "1", at: "t" }, state)) state = evolve(state, e);
    expect(() => decide({ type: "CompleteWork", workOrderId: "1", at: "t", laborHours: 0 }, state)).toThrow(
      "labor hours",
    );
    for (const e of decide({ type: "CompleteWork", workOrderId: "1", at: "t", laborHours: 2.5 }, state))
      state = evolve(state, e);
    expect(state).toMatchObject({ status: "COMPLETED", laborHours: 2.5 });
    expect(() => decide({ type: "CancelWorkOrder", workOrderId: "1", reason: "x" }, state)).toThrow(
      DomainError,
    );
  });
});

describe("event store", () => {
  it("rejects appends with a stale expected version", async () => {
    const store = new InMemoryEventStore<WorkOrderEvent>();
    await store.append("s", 0, [{ type: "WorkOrderCancelled", workOrderId: "1", reason: "r" }]);
    await expect(store.append("s", 0, [])).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("command handler re-evaluates against new state on a concurrent write", async () => {
    const store = new InMemoryEventStore<WorkOrderEvent>();
    await handleCommand(store, create("7"));
    // Two concurrent assignment commands racing on the same stream.
    await Promise.all([
      handleCommand(store, { type: "AssignTechnician", workOrderId: "7", technicianId: "a" }),
      handleCommand(store, { type: "AssignTechnician", workOrderId: "7", technicianId: "b" }),
    ]);
    const events = await store.readStream("work-order-7");
    expect(events.map((e) => e.version)).toEqual([1, 2, 3]);
  });
});

describe("CQRS projection", () => {
  it("builds a per-technician worklist and is idempotent on catch-up", async () => {
    const store = new InMemoryEventStore<WorkOrderEvent>();
    await handleCommand(store, create("1", 3));
    await handleCommand(store, create("2", 1));
    await handleCommand(store, create("3", 2));
    for (const id of ["1", "2"])
      await handleCommand(store, { type: "AssignTechnician", workOrderId: id, technicianId: "tech-9" });
    await handleCommand(store, { type: "StartWork", workOrderId: "2", at: "t" });
    await handleCommand(store, { type: "CompleteWork", workOrderId: "2", at: "t", laborHours: 1 });

    const projection = new OpenWorkOrdersProjection(store);
    expect(await projection.catchUp()).toBe(7);
    expect(await projection.catchUp()).toBe(0);
    expect(projection.forTechnician("tech-9").map((v) => v.workOrderId)).toEqual(["1"]);
    expect(projection.unassigned().map((v) => v.workOrderId)).toEqual(["3"]);

    await handleCommand(store, { type: "AssignTechnician", workOrderId: "3", technicianId: "tech-9" });
    await projection.catchUp();
    expect(projection.forTechnician("tech-9").map((v) => v.workOrderId)).toEqual(["3", "1"]); // priority order
    expect(projection.position).toBe(8);
  });
});
