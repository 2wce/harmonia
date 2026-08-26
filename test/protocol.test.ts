import { describe, expect, it } from "vitest";

import type {
  BootstrapRequired,
  PullResponse,
  PushResponse,
  SyncOperation,
} from "../src/protocol.js";

const operation: SyncOperation = {
  operationId: "operation-1",
  idempotencyKey: "idempotency-1",
  clientId: "client-1",
  scope: "library:alpha",
  entity: "highlight",
  recordId: "highlight-1",
  kind: "update",
  payload: {
    metadata: ["annotation", { locations: [4, 8], shared: false }],
  },
  baseVersion: "version-1",
  logicalTime: "2026-08-26T10:00:00.000Z",
  dependsOn: ["operation-0"],
  createdAt: "2026-08-26T10:00:00.000Z",
  attempts: 1,
  status: "pending",
};

describe("sync protocol records", () => {
  it("preserves a recursive JSON operation payload", () => {
    const roundTripped = JSON.parse(JSON.stringify(operation)) as SyncOperation;

    expect(roundTripped).toEqual(operation);
  });

  it("identifies out-of-order push outcomes by operation identity", () => {
    const response: PushResponse = {
      protocolVersion: 1,
      scope: "library:alpha",
      outcomes: [
        {
          operationId: "operation-2",
          status: "rejected",
          changeId: null,
          code: "invalid-title",
          message: "A title is required.",
          remoteVersion: null,
          remotePayload: null,
        },
        {
          operationId: operation.operationId,
          status: "acknowledged",
          changeId: "change-1",
          code: null,
          message: null,
          remoteVersion: "version-2",
          remotePayload: null,
        },
      ],
    };

    const outcomesByOperationId = new Map(
      response.outcomes.map((outcome) => [outcome.operationId, outcome]),
    );

    expect(outcomesByOperationId.get(operation.operationId)?.status).toBe("acknowledged");
    expect(outcomesByOperationId.get("operation-2")?.status).toBe("rejected");
  });

  it("keeps the next pull cursor opaque", () => {
    const response: PullResponse = {
      protocolVersion: 1,
      scope: "library:alpha",
      changes: [],
      nextCursor: "opaque:cursor:after/change-19",
    };

    expect(response.nextCursor).toBe("opaque:cursor:after/change-19");
  });

  it("represents an explicit bootstrap requirement", () => {
    const instruction: BootstrapRequired = {
      kind: "bootstrap-required",
      scope: "library:alpha",
      reason: "watermark-compacted",
      snapshotToken: "snapshot:library-alpha:42",
    };

    expect(instruction).toEqual({
      kind: "bootstrap-required",
      scope: "library:alpha",
      reason: "watermark-compacted",
      snapshotToken: "snapshot:library-alpha:42",
    });
  });
});
