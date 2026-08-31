import { describe, expect, it } from "vitest";

import * as production from "../src/index.js";
import { SyncCoordinator, type SyncCoordinatorOptions } from "../src/coordinator.js";
import type { SyncEntityApplier, SyncLifecycleSink, SyncStorage } from "../src/ports.js";
import type {
  OperationOutcome,
  SyncChange,
  SyncOperation,
  TransportError,
} from "../src/protocol.js";
import {
  FakeSyncCancellation,
  FakeSyncEntities,
  FakeSyncLifecycle,
  FakeSyncStorage,
  FakeSyncTransport,
  createSyncAdapterContract,
  type SyncAdapterContractHarness,
} from "../src/testing/index.js";

function operation(
  operationId: string,
  options: Partial<Pick<SyncOperation, "dependsOn" | "payload" | "scope" | "status">> = {},
): SyncOperation {
  return {
    operationId,
    idempotencyKey: `idempotency-${operationId}`,
    clientId: "client-1",
    scope: "library:alpha",
    entity: "highlight",
    recordId: operationId,
    kind: "update",
    payload: { text: operationId },
    baseVersion: null,
    logicalTime: null,
    dependsOn: [],
    createdAt: "2026-08-26T10:00:00.000Z",
    attempts: 0,
    status: "pending",
    ...options,
  };
}

function createHarness(): SyncAdapterContractHarness {
  const storage = new FakeSyncStorage();
  const transport = new FakeSyncTransport();
  const entities = new FakeSyncEntities();
  const lifecycle = new FakeSyncLifecycle();
  const cancellation = new FakeSyncCancellation();
  const options: SyncCoordinatorOptions = {
    storage,
    transport,
    entities,
    lifecycle,
    cancellation,
    clock: { now: () => 1_000, random: () => 0.5 },
    batchSize: 10,
    retry: { baseDelayMs: 100, maxDelayMs: 1_000 },
  };

  return {
    coordinator: new SyncCoordinator(options),
    ports: { storage, transport, entities },
    scope: "library:alpha",
    otherScope: "library:beta",
    arrange: {
      seedOperations(operations) {
        storage.seedOperations(operations);
      },
      configureOutcome(outcome: OperationOutcome) {
        transport.configureOutcome(outcome);
      },
      omitOutcome(operationId: string) {
        transport.omitOutcome(operationId);
      },
      failNextPush(error: TransportError) {
        transport.failNextPush(error);
      },
      failNextPushAfterRemoteApply(error: TransportError) {
        transport.failNextPushAfterRemoteApply(error);
      },
      afterPush(handler: () => void | Promise<void>) {
        transport.afterPush(handler);
      },
      abort() {
        cancellation.abort();
      },
      appendChange(scope, cursor, changes, nextCursor) {
        transport.appendChange(scope, cursor, changes, nextCursor);
      },
      compactHistory(scope, cursor, snapshotToken, reason) {
        transport.compactHistory(scope, cursor, snapshotToken, reason);
      },
      setBootstrapResponse(snapshotToken, response) {
        transport.setBootstrapResponse(snapshotToken, response);
      },
      setPullResponse(scope, response) {
        transport.setPullResponse(scope, response);
      },
      failApplication(phase) {
        storage.failApplication(phase);
      },
    },
    inspect: {
      operation(operationId) {
        return storage.operation(operationId);
      },
      watermark(scope) {
        return storage.watermark(scope);
      },
      changes(scope) {
        return storage.changes(scope);
      },
      blocked(scope) {
        return storage.blocked(scope);
      },
      lastPushRequest() {
        return transport.pushRequests.at(-1);
      },
      pushRequestCount() {
        return transport.pushRequests.length;
      },
      lifecycleEvents() {
        return lifecycle.diagnostics();
      },
      diagnostics() {
        return { lifecycle: lifecycle.diagnostics(), transport: transport.diagnostics() };
      },
      remoteEffectCount(idempotencyKey) {
        return transport.remoteEffectCount(idempotencyKey);
      },
    },
    retryAfterMs: 100,
  };
}

describe("reusable synchronization adapter contract", () => {
  for (const scenario of createSyncAdapterContract(createHarness)) {
    it(scenario.name, scenario.run);
  }

  it("keeps test fakes out of the neutral production entry point", () => {
    const storage: SyncStorage = new FakeSyncStorage();
    const entities: SyncEntityApplier = new FakeSyncEntities();
    const lifecycle: SyncLifecycleSink = new FakeSyncLifecycle();

    expect(production).not.toHaveProperty("FakeSyncStorage");
    expect(production).not.toHaveProperty("createSyncAdapterContract");
    expect(storage.claimReady).toBeTypeOf("function");
    expect(entities.apply).toBeTypeOf("function");
    expect(lifecycle.emit).toBeTypeOf("function");
  });

  it("records fake change-log compaction without retaining payload diagnostics", async () => {
    const transport = new FakeSyncTransport();
    const change: SyncChange = {
      changeId: "change-1",
      operationId: null,
      scope: "library:alpha",
      entity: "highlight",
      recordId: "record-1",
      kind: "update",
      payload: { private: "payload-value" },
      logicalTime: null,
      version: "v1",
    };

    transport.appendChange("library:alpha", null, [change], "cursor-1");
    transport.compactHistory("library:alpha", "cursor-1", "snapshot-1");

    expect(
      await transport.pull({ protocolVersion: 1, scope: "library:alpha", cursor: null }),
    ).toEqual({
      protocolVersion: 1,
      scope: "library:alpha",
      changes: [change],
      nextCursor: "cursor-1",
    });
    expect(
      await transport.pull({ protocolVersion: 1, scope: "library:alpha", cursor: "cursor-1" }),
    ).toEqual({
      kind: "bootstrap-required",
      scope: "library:alpha",
      reason: "watermark-compacted",
      snapshotToken: "snapshot-1",
    });
    expect(JSON.stringify(transport.diagnostics())).not.toContain("payload-value");
  });
});

void operation;
