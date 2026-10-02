import { retry, type RetryOptions } from "../resilience/retry.js";

export type SagaStatus = "RUNNING" | "COMPLETED" | "COMPENSATING" | "COMPENSATED" | "FAILED";

export interface SagaStep<C> {
  name: string;
  /** Forward action. Must be idempotent: it may be re-run after a crash. */
  action: (ctx: C) => Promise<void>;
  /** Semantic undo. Must be idempotent. Omit for steps with nothing to undo (e.g. final notification). */
  compensate?: (ctx: C) => Promise<void>;
}

export interface SagaRecord<C> {
  sagaId: string;
  status: SagaStatus;
  context: C;
  completedSteps: string[];
  failure?: string;
}

/** Durable saga log. Production implementations persist this in the orchestrator's database. */
export interface SagaLog<C> {
  load(sagaId: string): Promise<SagaRecord<C> | undefined>;
  save(record: SagaRecord<C>): Promise<void>;
}

export class InMemorySagaLog<C> implements SagaLog<C> {
  private readonly records = new Map<string, SagaRecord<C>>();
  async load(sagaId: string) {
    const r = this.records.get(sagaId);
    return r ? structuredClone(r) : undefined;
  }
  async save(record: SagaRecord<C>) {
    this.records.set(record.sagaId, structuredClone(record));
  }
}

/**
 * Orchestration-based saga.
 *
 * - Progress is persisted after every step, so `run` can be called again after a crash and resumes from the
 *   first incomplete step (or returns immediately if the saga already finished).
 * - On a step failure, completed steps are compensated in reverse order. Compensations are retried; if a
 *   compensation still fails the saga is marked FAILED for manual intervention — never silently dropped.
 */
export class SagaOrchestrator<C> {
  constructor(
    private readonly steps: SagaStep<C>[],
    private readonly log: SagaLog<C>,
    private readonly compensationRetry: RetryOptions = { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 500 },
  ) {
    const names = new Set(steps.map((s) => s.name));
    if (names.size !== steps.length) throw new Error("saga step names must be unique");
  }

  async run(sagaId: string, initialContext: C): Promise<SagaRecord<C>> {
    let record = (await this.log.load(sagaId)) ?? {
      sagaId,
      status: "RUNNING" as SagaStatus,
      context: initialContext,
      completedSteps: [],
    };
    if (record.status !== "RUNNING" && record.status !== "COMPENSATING") return record;
    await this.log.save(record);

    if (record.status === "RUNNING") {
      for (const step of this.steps) {
        if (record.completedSteps.includes(step.name)) continue;
        try {
          await step.action(record.context);
          record = { ...record, completedSteps: [...record.completedSteps, step.name] };
          await this.log.save(record);
        } catch (error) {
          record = { ...record, status: "COMPENSATING", failure: `${step.name}: ${errorMessage(error)}` };
          await this.log.save(record);
          break;
        }
      }
      if (record.status === "RUNNING") {
        record = { ...record, status: "COMPLETED" };
        await this.log.save(record);
        return record;
      }
    }
    return this.compensate(record);
  }

  private async compensate(record: SagaRecord<C>): Promise<SagaRecord<C>> {
    const toUndo = this.steps.filter((s) => record.completedSteps.includes(s.name)).reverse();
    for (const step of toUndo) {
      if (step.compensate) {
        try {
          await retry(() => step.compensate!(record.context), this.compensationRetry);
        } catch (error) {
          record = {
            ...record,
            status: "FAILED",
            failure: `${record.failure}; compensation ${step.name}: ${errorMessage(error)}`,
          };
          await this.log.save(record);
          return record;
        }
      }
      record = { ...record, completedSteps: record.completedSteps.filter((n) => n !== step.name) };
      await this.log.save(record);
    }
    record = { ...record, status: "COMPENSATED" };
    await this.log.save(record);
    return record;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
