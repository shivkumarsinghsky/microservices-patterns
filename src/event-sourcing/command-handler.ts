import { ConcurrencyError, type EventStore } from "./event-store.js";
import { decide, evolve, initialState, type WorkOrderCommand, type WorkOrderEvent } from "./work-order.js";

/**
 * Load → decide → append with optimistic concurrency. On a concurrent write the command is re-evaluated
 * against the new state (a bounded number of times) instead of overwriting another writer's events.
 */
export async function handleCommand(
  store: EventStore<WorkOrderEvent>,
  command: WorkOrderCommand,
  maxConflictRetries = 3,
): Promise<WorkOrderEvent[]> {
  const streamId = `work-order-${command.workOrderId}`;
  for (let attempt = 0; ; attempt++) {
    const history = await store.readStream(streamId);
    const state = history.reduce((s, e) => evolve(s, e.data), initialState);
    const events = decide(command, state);
    if (events.length === 0) return [];
    try {
      await store.append(streamId, history.length, events);
      return events;
    } catch (error) {
      if (!(error instanceof ConcurrencyError) || attempt >= maxConflictRetries) throw error;
    }
  }
}
