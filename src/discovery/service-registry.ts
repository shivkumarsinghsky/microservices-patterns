import { type Clock, systemClock } from "../clock.js";

export interface ServiceInstance {
  serviceName: string;
  instanceId: string;
  host: string;
  port: number;
  metadata?: Record<string, string>;
}

interface Registration {
  instance: ServiceInstance;
  expiresAt: number;
}

/**
 * Self-registration service registry with heartbeat leases (the model used by Consul/Eureka-style
 * registries). An instance that stops heart-beating disappears after its TTL, so crashed instances are
 * removed without an explicit deregistration.
 */
export class ServiceRegistry {
  private readonly registrations = new Map<string, Registration>();

  constructor(
    private readonly leaseTtlMs = 30_000,
    private readonly clock: Clock = systemClock,
  ) {}

  register(instance: ServiceInstance): void {
    this.registrations.set(this.key(instance), { instance, expiresAt: this.clock.now() + this.leaseTtlMs });
  }

  heartbeat(serviceName: string, instanceId: string): boolean {
    const reg = this.registrations.get(`${serviceName}/${instanceId}`);
    if (!reg || reg.expiresAt <= this.clock.now()) return false; // must re-register
    reg.expiresAt = this.clock.now() + this.leaseTtlMs;
    return true;
  }

  deregister(serviceName: string, instanceId: string): void {
    this.registrations.delete(`${serviceName}/${instanceId}`);
  }

  healthyInstances(serviceName: string): ServiceInstance[] {
    const now = this.clock.now();
    return [...this.registrations.values()]
      .filter((r) => r.instance.serviceName === serviceName && r.expiresAt > now)
      .map((r) => r.instance)
      .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  }

  private key(i: ServiceInstance): string {
    return `${i.serviceName}/${i.instanceId}`;
  }
}

/** Client-side load balancing over the registry's healthy instances. */
export class RoundRobinResolver {
  private readonly counters = new Map<string, number>();

  constructor(private readonly registry: ServiceRegistry) {}

  resolve(serviceName: string): ServiceInstance {
    const instances = this.registry.healthyInstances(serviceName);
    if (instances.length === 0) throw new Error(`no healthy instances of '${serviceName}'`);
    const n = this.counters.get(serviceName) ?? 0;
    this.counters.set(serviceName, n + 1);
    return instances[n % instances.length]!;
  }
}
