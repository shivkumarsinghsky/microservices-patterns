/**
 * Event-sourced aggregate using the decide/evolve style:
 *   decide(command, state) -> events   (business rules, no side effects)
 *   evolve(state, event)   -> state    (pure state transition)
 *
 * The domain is a maintenance work order, as found in Enterprise Asset Management (EAM) systems.
 */

export type WorkOrderStatus = "NONE" | "OPEN" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export type WorkOrderEvent =
  | {
      type: "WorkOrderCreated";
      workOrderId: string;
      assetId: string;
      priority: 1 | 2 | 3 | 4;
      description: string;
    }
  | { type: "TechnicianAssigned"; workOrderId: string; technicianId: string }
  | { type: "WorkStarted"; workOrderId: string; startedAt: string }
  | { type: "WorkCompleted"; workOrderId: string; completedAt: string; laborHours: number }
  | { type: "WorkOrderCancelled"; workOrderId: string; reason: string };

export type WorkOrderCommand =
  | {
      type: "CreateWorkOrder";
      workOrderId: string;
      assetId: string;
      priority: 1 | 2 | 3 | 4;
      description: string;
    }
  | { type: "AssignTechnician"; workOrderId: string; technicianId: string }
  | { type: "StartWork"; workOrderId: string; at: string }
  | { type: "CompleteWork"; workOrderId: string; at: string; laborHours: number }
  | { type: "CancelWorkOrder"; workOrderId: string; reason: string };

export interface WorkOrderState {
  status: WorkOrderStatus;
  workOrderId?: string;
  assetId?: string;
  technicianId?: string;
  laborHours?: number;
}

export const initialState: WorkOrderState = { status: "NONE" };

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export function decide(command: WorkOrderCommand, state: WorkOrderState): WorkOrderEvent[] {
  switch (command.type) {
    case "CreateWorkOrder":
      if (state.status !== "NONE") throw new DomainError("work order already exists");
      if (!command.description.trim()) throw new DomainError("description is required");
      return [{ ...command, type: "WorkOrderCreated" }];
    case "AssignTechnician":
      if (state.status !== "OPEN" && state.status !== "ASSIGNED") {
        throw new DomainError(`cannot assign a technician to a ${state.status} work order`);
      }
      if (state.technicianId === command.technicianId) return []; // idempotent: no new event
      return [
        { type: "TechnicianAssigned", workOrderId: command.workOrderId, technicianId: command.technicianId },
      ];
    case "StartWork":
      if (state.status !== "ASSIGNED")
        throw new DomainError("work can only start once a technician is assigned");
      return [{ type: "WorkStarted", workOrderId: command.workOrderId, startedAt: command.at }];
    case "CompleteWork":
      if (state.status !== "IN_PROGRESS") throw new DomainError("only in-progress work can be completed");
      if (command.laborHours <= 0) throw new DomainError("labor hours must be positive");
      return [
        {
          type: "WorkCompleted",
          workOrderId: command.workOrderId,
          completedAt: command.at,
          laborHours: command.laborHours,
        },
      ];
    case "CancelWorkOrder":
      if (state.status === "COMPLETED" || state.status === "CANCELLED" || state.status === "NONE") {
        throw new DomainError(`cannot cancel a ${state.status} work order`);
      }
      return [{ type: "WorkOrderCancelled", workOrderId: command.workOrderId, reason: command.reason }];
  }
}

export function evolve(state: WorkOrderState, event: WorkOrderEvent): WorkOrderState {
  switch (event.type) {
    case "WorkOrderCreated":
      return { status: "OPEN", workOrderId: event.workOrderId, assetId: event.assetId };
    case "TechnicianAssigned":
      return { ...state, status: "ASSIGNED", technicianId: event.technicianId };
    case "WorkStarted":
      return { ...state, status: "IN_PROGRESS" };
    case "WorkCompleted":
      return { ...state, status: "COMPLETED", laborHours: event.laborHours };
    case "WorkOrderCancelled":
      return { ...state, status: "CANCELLED" };
  }
}
