import type { EventStore } from "./event-store.js";
import type { WorkOrderEvent } from "./work-order.js";

export interface OpenWorkOrderView {
  workOrderId: string;
  assetId: string;
  priority: number;
  technicianId?: string;
  status: "OPEN" | "ASSIGNED" | "IN_PROGRESS";
}

/**
 * CQRS read model: "open work orders by technician", denormalised for the technician's mobile worklist.
 *
 * The projection stores a checkpoint (last global position applied). Catch-up is therefore idempotent:
 * running it twice, or after a crash, never applies the same event twice.
 */
export class OpenWorkOrdersProjection {
  private readonly view = new Map<string, OpenWorkOrderView>();
  private checkpoint = 0;

  constructor(private readonly store: EventStore<WorkOrderEvent>) {}

  get position(): number {
    return this.checkpoint;
  }

  async catchUp(): Promise<number> {
    const events = await this.store.readAll(this.checkpoint);
    for (const e of events) {
      this.apply(e.data);
      this.checkpoint = e.globalPosition;
    }
    return events.length;
  }

  forTechnician(technicianId: string): OpenWorkOrderView[] {
    return [...this.view.values()]
      .filter((v) => v.technicianId === technicianId)
      .sort((a, b) => a.priority - b.priority);
  }

  unassigned(): OpenWorkOrderView[] {
    return [...this.view.values()].filter((v) => !v.technicianId);
  }

  private apply(event: WorkOrderEvent): void {
    const current = this.view.get(event.workOrderId);
    switch (event.type) {
      case "WorkOrderCreated":
        this.view.set(event.workOrderId, {
          workOrderId: event.workOrderId,
          assetId: event.assetId,
          priority: event.priority,
          status: "OPEN",
        });
        break;
      case "TechnicianAssigned":
        if (current)
          this.view.set(event.workOrderId, {
            ...current,
            technicianId: event.technicianId,
            status: "ASSIGNED",
          });
        break;
      case "WorkStarted":
        if (current) this.view.set(event.workOrderId, { ...current, status: "IN_PROGRESS" });
        break;
      case "WorkCompleted":
      case "WorkOrderCancelled":
        this.view.delete(event.workOrderId);
        break;
    }
  }
}
