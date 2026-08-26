import type { OperationOutcome, SyncOperation } from "./protocol.js";

export class OperationTransitionError extends Error {
  override name = "OperationTransitionError";
}

export function markOperationSending(operation: SyncOperation): SyncOperation {
  if (operation.status !== "pending") {
    throw new OperationTransitionError(
      `Operation ${operation.operationId} cannot enter sending from ${operation.status}.`,
    );
  }

  return { ...operation, status: "sending", attempts: operation.attempts + 1 };
}

export function markOperationForRetry(operation: SyncOperation): SyncOperation {
  if (operation.status !== "sending") {
    throw new OperationTransitionError(
      `Operation ${operation.operationId} cannot be retried from ${operation.status}.`,
    );
  }

  return { ...operation, status: "pending" };
}

export function applyOperationOutcome(
  operation: SyncOperation,
  outcome: OperationOutcome,
): SyncOperation {
  if (operation.operationId !== outcome.operationId) {
    throw new OperationTransitionError(
      `Outcome operation ${outcome.operationId} does not match operation ${operation.operationId}.`,
    );
  }

  if (operation.status !== "sending") {
    throw new OperationTransitionError(
      `Operation ${operation.operationId} cannot accept an outcome from ${operation.status}.`,
    );
  }

  return { ...operation, status: outcome.status };
}
