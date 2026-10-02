import { describe, expect, it, vi } from "vitest";
import { InMemorySagaLog, SagaOrchestrator, type SagaStep } from "../src/saga/saga.js";

interface Ctx {
  orderId: string;
}

function steps(overrides: Partial<Record<"reserve" | "pay" | "confirm", () => Promise<void>>> = {}) {
  const calls: string[] = [];
  const step = (name: "reserve" | "pay" | "confirm", undo?: string): SagaStep<Ctx> => ({
    name,
    action: async () => {
      calls.push(name);
      await overrides[name]?.();
    },
    compensate: undo ? async () => void calls.push(undo) : undefined,
  });
  return { calls, list: [step("reserve", "release"), step("pay", "refund"), step("confirm")] };
}

const fastRetry = { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} };

describe("SagaOrchestrator", () => {
  it("runs every step and completes", async () => {
    const { calls, list } = steps();
    const saga = new SagaOrchestrator(list, new InMemorySagaLog<Ctx>(), fastRetry);
    const result = await saga.run("s1", { orderId: "o1" });
    expect(result.status).toBe("COMPLETED");
    expect(calls).toEqual(["reserve", "pay", "confirm"]);
  });

  it("compensates completed steps in reverse order when a step fails", async () => {
    const { calls, list } = steps({ confirm: () => Promise.reject(new Error("order db down")) });
    const saga = new SagaOrchestrator(list, new InMemorySagaLog<Ctx>(), fastRetry);
    const result = await saga.run("s2", { orderId: "o2" });
    expect(result.status).toBe("COMPENSATED");
    expect(result.failure).toContain("confirm: order db down");
    expect(calls).toEqual(["reserve", "pay", "confirm", "refund", "release"]);
  });

  it("is idempotent: re-running a finished saga does not repeat steps", async () => {
    const { calls, list } = steps();
    const log = new InMemorySagaLog<Ctx>();
    const saga = new SagaOrchestrator(list, log, fastRetry);
    await saga.run("s3", { orderId: "o3" });
    await saga.run("s3", { orderId: "o3" });
    expect(calls).toEqual(["reserve", "pay", "confirm"]);
  });

  it("resumes from the first incomplete step after a crash", async () => {
    const log = new InMemorySagaLog<Ctx>();
    await log.save({
      sagaId: "s4",
      status: "RUNNING",
      context: { orderId: "o4" },
      completedSteps: ["reserve"],
    });
    const { calls, list } = steps();
    const result = await new SagaOrchestrator(list, log, fastRetry).run("s4", { orderId: "o4" });
    expect(result.status).toBe("COMPLETED");
    expect(calls).toEqual(["pay", "confirm"]);
  });

  it("marks the saga FAILED when a compensation keeps failing", async () => {
    const release = vi.fn().mockRejectedValue(new Error("inventory down"));
    const list: SagaStep<Ctx>[] = [
      { name: "reserve", action: async () => {}, compensate: release },
      { name: "pay", action: async () => Promise.reject(new Error("declined")) },
    ];
    const result = await new SagaOrchestrator(list, new InMemorySagaLog<Ctx>(), fastRetry).run("s5", {
      orderId: "o5",
    });
    expect(result.status).toBe("FAILED");
    expect(release).toHaveBeenCalledTimes(2);
    expect(result.completedSteps).toEqual(["reserve"]);
  });

  it("rejects duplicate step names", () => {
    const s: SagaStep<Ctx> = { name: "a", action: async () => {} };
    expect(() => new SagaOrchestrator([s, s], new InMemorySagaLog<Ctx>())).toThrow("unique");
  });
});
