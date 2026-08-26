import type { OperationStatus, SyncOperation } from "./protocol.js";

export type DependencyBlockReason =
  | "dependency-pending"
  | "dependency-missing"
  | "dependency-failed"
  | "dependency-cycle";

export type DependencyBlock = {
  operationId: string;
  dependencyId: string;
  reason: DependencyBlockReason;
};

export type ReadyOperationSelection = {
  ready: SyncOperation[];
  blocked: DependencyBlock[];
};

export function selectReadyOperations(
  operations: SyncOperation[],
  limit = Number.POSITIVE_INFINITY,
): ReadyOperationSelection {
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  const pending = operations.filter((operation) => operation.status === "pending");
  const cycleMembers = findCycleMembers(pending, byId);
  const ready: SyncOperation[] = [];
  const blocked: DependencyBlock[] = [];

  for (const operation of pending) {
    const dependency = firstBlockingDependency(operation, byId, cycleMembers);
    if (dependency) {
      blocked.push({ operationId: operation.operationId, ...dependency });
      continue;
    }

    if (ready.length < limit) ready.push(operation);
  }

  return { ready, blocked };
}

function firstBlockingDependency(
  operation: SyncOperation,
  byId: Map<string, SyncOperation>,
  cycleMembers: Set<string>,
): { dependencyId: string; reason: DependencyBlockReason } | null {
  for (const dependencyId of operation.dependsOn) {
    const dependency = byId.get(dependencyId);
    if (!dependency) return { dependencyId, reason: "dependency-missing" };
    if (cycleMembers.has(operation.operationId) && cycleMembers.has(dependencyId)) {
      return { dependencyId, reason: "dependency-cycle" };
    }
    if (dependency.status === "acknowledged") continue;
    if (dependency.status === "rejected" || dependency.status === "conflicted") {
      return { dependencyId, reason: "dependency-failed" };
    }
    return { dependencyId, reason: "dependency-pending" };
  }

  return null;
}

function findCycleMembers(pending: SyncOperation[], byId: Map<string, SyncOperation>): Set<string> {
  const pendingIds = new Set(pending.map((operation) => operation.operationId));
  const cycleMembers = new Set<string>();
  const visiting: string[] = [];
  const visitingSet = new Set<string>();
  const visited = new Set<string>();

  const visit = (operationId: string): void => {
    if (visited.has(operationId)) return;
    if (visitingSet.has(operationId)) {
      const cycleStart = visiting.indexOf(operationId);
      for (const member of visiting.slice(cycleStart)) cycleMembers.add(member);
      return;
    }

    const operation = byId.get(operationId);
    if (!operation || !pendingIds.has(operationId)) {
      visited.add(operationId);
      return;
    }

    visiting.push(operationId);
    visitingSet.add(operationId);
    for (const dependencyId of operation.dependsOn) visit(dependencyId);
    visiting.pop();
    visitingSet.delete(operationId);
    visited.add(operationId);
  };

  for (const operation of pending) visit(operation.operationId);
  return cycleMembers;
}

export function isTerminalOperationStatus(status: OperationStatus): boolean {
  return status === "acknowledged" || status === "rejected" || status === "conflicted";
}
