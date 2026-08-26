import { describe, expect, it } from "vitest";

import type { SyncOperation } from "../src/protocol.js";
import { selectReadyOperations } from "../src/dependencies.js";

function operation(
  operationId: string,
  options: Partial<Pick<SyncOperation, "dependsOn" | "status">> = {},
): SyncOperation {
  return {
    operationId,
    idempotencyKey: `idempotency-${operationId}`,
    clientId: "client-1",
    scope: "library:alpha",
    entity: "highlight",
    recordId: operationId,
    kind: "update",
    payload: null,
    baseVersion: null,
    logicalTime: null,
    dependsOn: [],
    createdAt: "2026-08-26T10:00:00.000Z",
    attempts: 0,
    status: "pending",
    ...options,
  };
}

describe("dependency-aware operation selection", () => {
  it("selects dependency-ready pending operations in a bounded queue order", () => {
    const result = selectReadyOperations(
      [
        operation("acknowledged", { status: "acknowledged" }),
        operation("ready", { dependsOn: ["acknowledged"] }),
        operation("also-ready"),
      ],
      1,
    );

    expect(result.ready.map((candidate) => candidate.operationId)).toEqual(["ready"]);
    expect(result.blocked).toEqual([]);
  });

  it("reports operations blocked by a pending or missing dependency", () => {
    const result = selectReadyOperations([
      operation("pending"),
      operation("blocked", { dependsOn: ["pending"] }),
      operation("missing", { dependsOn: ["not-in-queue"] }),
    ]);

    expect(result.blocked).toEqual([
      { operationId: "blocked", dependencyId: "pending", reason: "dependency-pending" },
      { operationId: "missing", dependencyId: "not-in-queue", reason: "dependency-missing" },
    ]);
  });

  it("reports dependency cycles without selecting their members", () => {
    const result = selectReadyOperations([
      operation("one", { dependsOn: ["two"] }),
      operation("two", { dependsOn: ["one"] }),
    ]);

    expect(result.ready).toEqual([]);
    expect(result.blocked).toEqual([
      { operationId: "one", dependencyId: "two", reason: "dependency-cycle" },
      { operationId: "two", dependencyId: "one", reason: "dependency-cycle" },
    ]);
  });
});
