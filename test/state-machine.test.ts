import { describe, expect, it } from "vitest";

import type { OperationOutcome, SyncOperation } from "../src/protocol.js";
import {
  OperationTransitionError,
  applyOperationOutcome,
  markOperationForRetry,
  markOperationSending,
} from "../src/state-machine.js";

const operation: SyncOperation = {
  operationId: "operation-1",
  idempotencyKey: "idempotency-1",
  clientId: "client-1",
  scope: "library:alpha",
  entity: "highlight",
  recordId: "highlight-1",
  kind: "update",
  payload: { text: "A note" },
  baseVersion: null,
  logicalTime: null,
  dependsOn: [],
  createdAt: "2026-08-26T10:00:00.000Z",
  attempts: 0,
  status: "pending",
};

function outcome(status: OperationOutcome["status"]): OperationOutcome {
  return {
    operationId: operation.operationId,
    status,
    changeId: status === "acknowledged" ? "change-1" : null,
    code: null,
    message: null,
    remoteVersion: null,
    remotePayload: null,
  };
}

describe("operation lifecycle", () => {
  it.each(["acknowledged", "rejected", "conflicted"] as const)(
    "moves a sending operation to %s when its outcome matches",
    (status) => {
      expect(applyOperationOutcome(markOperationSending(operation), outcome(status))).toMatchObject(
        {
          operationId: operation.operationId,
          status,
          attempts: 1,
        },
      );
    },
  );

  it("returns a sending operation to pending for retry", () => {
    expect(markOperationForRetry(markOperationSending(operation))).toMatchObject({
      status: "pending",
      attempts: 1,
    });
  });

  it("rejects illegal terminal transitions and duplicate acknowledgement", () => {
    const acknowledged = applyOperationOutcome(
      markOperationSending(operation),
      outcome("acknowledged"),
    );

    expect(() => markOperationSending(acknowledged)).toThrow(OperationTransitionError);
    expect(() => applyOperationOutcome(acknowledged, outcome("acknowledged"))).toThrow(
      OperationTransitionError,
    );
  });

  it("does not acknowledge an operation from an outcome with another identity", () => {
    expect(() =>
      applyOperationOutcome(markOperationSending(operation), {
        ...outcome("acknowledged"),
        operationId: "operation-2",
      }),
    ).toThrow("does not match");
  });
});
