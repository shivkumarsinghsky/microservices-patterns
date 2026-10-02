import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/clock.js";
import { RoundRobinResolver, ServiceRegistry } from "../src/discovery/service-registry.js";

describe("service discovery", () => {
  const instance = (id: string) => ({
    serviceName: "orders",
    instanceId: id,
    host: `10.0.0.${id}`,
    port: 8080,
  });

  it("round-robins across healthy instances", () => {
    const registry = new ServiceRegistry(10_000, new ManualClock());
    registry.register(instance("1"));
    registry.register(instance("2"));
    const resolver = new RoundRobinResolver(registry);
    expect([1, 2, 3].map(() => resolver.resolve("orders").instanceId)).toEqual(["1", "2", "1"]);
  });

  it("drops instances whose lease expired without a heartbeat", () => {
    const clock = new ManualClock();
    const registry = new ServiceRegistry(10_000, clock);
    registry.register(instance("1"));
    registry.register(instance("2"));
    clock.advance(6_000);
    expect(registry.heartbeat("orders", "1")).toBe(true);
    clock.advance(6_000);
    expect(registry.healthyInstances("orders").map((i) => i.instanceId)).toEqual(["1"]);
    expect(registry.heartbeat("orders", "2")).toBe(false);
  });

  it("fails clearly when no instance is available", () => {
    const resolver = new RoundRobinResolver(new ServiceRegistry());
    expect(() => resolver.resolve("billing")).toThrow("no healthy instances");
  });
});
