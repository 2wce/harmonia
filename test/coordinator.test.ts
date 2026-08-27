import { describe, expect, it } from "vitest";

import type {
  BootstrapRequired,
  OperationOutcome,
  PullResponse,
  PushResponse,
  SyncChange,
  SyncOperation,
} from "../src/protocol.js";
import type {
  SyncCancellation,
  SyncEntityApplier,
  SyncLifecycleSink,
  SyncStorage,
  SyncTransport,
} from "../src/ports.js";
import { createWatermark, type Watermark } from "../src/watermark.js";
import { SyncCoordinator } from "../src/coordinator.js";

function operation(operationId: string): SyncOperation {
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
  };
}

function outcome(
  operationId: string,
  status: OperationOutcome["status"] = "acknowledged",
): OperationOutcome {
  return {
    operationId,
    status,
    changeId: status === "acknowledged" ? `change-${operationId}` : null,
    code: null,
    message: null,
    remoteVersion: null,
    remotePayload: null,
  };
}

function change(changeId: string): SyncChange {
  return {
    changeId,
    operationId: null,
    scope: "library:alpha",
    entity: "highlight",
    recordId: changeId,
    kind: "insert",
    payload: { text: changeId },
    logicalTime: null,
    version: null,
  };
}

class FakeStorage implements SyncStorage {
  ready: SyncOperation[] = [];
  watermark: Watermark = createWatermark("library:alpha", null);
  markedSending: string[][] = [];
  appliedOutcomes: OperationOutcome[][] = [];
  recovered: Array<{
    operationIds: string[];
    reason: "partial-outcome" | "retry" | "cancelled" | "terminal";
  }> = [];
  appliedBatches: Array<{ changes: SyncChange[]; nextCursor: string | null; bootstrap: boolean }> =
    [];
  applyError: Error | null = null;

  async listReady(): Promise<SyncOperation[]> {
    return this.ready;
  }

  async markSending(operationIds: string[]): Promise<void> {
    this.markedSending.push(operationIds);
  }

  async applyOutcomes(outcomes: OperationOutcome[]): Promise<void> {
    this.appliedOutcomes.push(outcomes);
  }

  async recoverOperations(
    operationIds: string[],
    reason: "partial-outcome" | "retry" | "cancelled" | "terminal",
  ): Promise<void> {
    this.recovered.push({ operationIds, reason });
  }

  async getWatermark(): Promise<Watermark> {
    return this.watermark;
  }

  async applyChangesAndAdvance(
    _scope: string,
    changes: SyncChange[],
    nextCursor: string | null,
    applyChange: (change: SyncChange) => Promise<void>,
    bootstrap: boolean,
  ): Promise<void> {
    for (const remoteChange of changes) await applyChange(remoteChange);
    if (this.applyError) throw this.applyError;
    this.appliedBatches.push({ changes, nextCursor, bootstrap });
    this.watermark = { ...this.watermark, cursor: nextCursor, bootstrap: null };
  }

  async recordBootstrapRequired(instruction: BootstrapRequired): Promise<void> {
    this.watermark = {
      ...this.watermark,
      bootstrap: { reason: instruction.reason, snapshotToken: instruction.snapshotToken },
    };
  }
}

class FakeTransport implements SyncTransport {
  pushRequests: SyncOperation[][] = [];
  pullCalls = 0;
  bootstrapCalls = 0;
  pushResponse: PushResponse = { protocolVersion: 1, scope: "library:alpha", outcomes: [] };
  pullResponse: PullResponse | BootstrapRequired = {
    protocolVersion: 1,
    scope: "library:alpha",
    changes: [],
    nextCursor: null,
  };
  bootstrapResponse: PullResponse = {
    protocolVersion: 1,
    scope: "library:alpha",
    changes: [],
    nextCursor: "bootstrapped",
  };
  pushError: unknown = null;

  async push(request: { operations: SyncOperation[] }): Promise<PushResponse> {
    this.pushRequests.push(request.operations);
    if (this.pushError) throw this.pushError;
    return this.pushResponse;
  }

  async pull(): Promise<PullResponse | BootstrapRequired> {
    this.pullCalls += 1;
    return this.pullResponse;
  }

  async bootstrap(): Promise<PullResponse> {
    this.bootstrapCalls += 1;
    return this.bootstrapResponse;
  }
}

class FakeEntities implements SyncEntityApplier {
  applied: SyncChange[] = [];

  async apply(changeToApply: SyncChange): Promise<void> {
    this.applied.push(changeToApply);
  }
}

class FakeLifecycle implements SyncLifecycleSink {
  events: Parameters<SyncLifecycleSink["emit"]>[0][] = [];

  emit(event: Parameters<SyncLifecycleSink["emit"]>[0]): void {
    this.events.push(event);
  }
}

class FakeCancellation implements SyncCancellation {
  aborted = false;

  onAbort(): () => void {
    return () => undefined;
  }
}

const clock = { now: () => 1_000, random: () => 0.5 };

function setup() {
  const storage = new FakeStorage();
  const transport = new FakeTransport();
  const entities = new FakeEntities();
  const lifecycle = new FakeLifecycle();
  const cancellation = new FakeCancellation();
  const coordinator = new SyncCoordinator({
    storage,
    transport,
    entities,
    lifecycle,
    clock,
    batchSize: 10,
    retry: { baseDelayMs: 100, maxDelayMs: 1_000 },
    cancellation,
  });
  return { storage, transport, entities, lifecycle, cancellation, coordinator };
}

describe("sync coordinator", () => {
  it("pushes only the ready operations returned by storage", async () => {
    const { storage, transport, coordinator } = setup();
    storage.ready = [operation("ready")];
    transport.pushResponse = {
      protocolVersion: 1,
      scope: "library:alpha",
      outcomes: [outcome("ready")],
    };

    await coordinator.run("library:alpha");

    expect(transport.pushRequests).toEqual([[storage.ready[0]]]);
  });

  it("applies push outcomes by operation identity", async () => {
    const { storage, transport, coordinator } = setup();
    storage.ready = [operation("one"), operation("two")];
    transport.pushResponse = {
      protocolVersion: 1,
      scope: "library:alpha",
      outcomes: [outcome("two", "rejected"), outcome("one")],
    };

    await coordinator.run("library:alpha");

    expect(storage.appliedOutcomes).toEqual([[outcome("two", "rejected"), outcome("one")]]);
  });

  it("recovers unreturned operations after a partial push response", async () => {
    const { storage, transport, coordinator } = setup();
    storage.ready = [operation("one"), operation("two")];
    transport.pushResponse = {
      protocolVersion: 1,
      scope: "library:alpha",
      outcomes: [outcome("one")],
    };

    await coordinator.run("library:alpha");

    expect(storage.recovered).toEqual([{ operationIds: ["two"], reason: "partial-outcome" }]);
  });

  it("schedules a retry and leaves operations recoverable after a retryable push failure", async () => {
    const { storage, transport, lifecycle, coordinator } = setup();
    storage.ready = [operation("one")];
    transport.pushError = {
      kind: "retryable-transport-error",
      code: "offline",
      message: "Offline",
      retryAfterMs: null,
    };

    const result = await coordinator.run("library:alpha");

    expect(result.status).toBe("retry-scheduled");
    expect(storage.recovered).toEqual([{ operationIds: ["one"], reason: "retry" }]);
    expect(lifecycle.events).toContainEqual({
      kind: "operation-retry-scheduled",
      scope: "library:alpha",
      operationId: "one",
      retryAfterMs: 100,
      code: "offline",
    });
  });

  it("applies pulled changes and advances the cursor in one storage call", async () => {
    const { storage, transport, entities, coordinator } = setup();
    transport.pullResponse = {
      protocolVersion: 1,
      scope: "library:alpha",
      changes: [change("change-1")],
      nextCursor: "cursor-1",
    };

    await coordinator.run("library:alpha");

    expect(storage.appliedBatches).toEqual([
      { changes: [change("change-1")], nextCursor: "cursor-1", bootstrap: false },
    ]);
    expect(entities.applied).toEqual([change("change-1")]);
  });

  it("does not advance the cursor when applying a pulled change fails", async () => {
    const { storage, transport, coordinator } = setup();
    const original = storage.watermark;
    storage.applyError = new Error("local apply failed");
    transport.pullResponse = {
      protocolVersion: 1,
      scope: "library:alpha",
      changes: [change("change-1")],
      nextCursor: "cursor-1",
    };

    await expect(coordinator.run("library:alpha")).rejects.toThrow("local apply failed");
    expect(storage.watermark).toEqual(original);
    expect(storage.appliedBatches).toEqual([]);
  });

  it("uses bootstrap instead of normal pull while a scope is blocked", async () => {
    const { storage, transport, coordinator } = setup();
    storage.watermark = {
      ...storage.watermark,
      bootstrap: { reason: "watermark-compacted", snapshotToken: "snapshot-1" },
    };
    transport.bootstrapResponse = {
      protocolVersion: 1,
      scope: "library:alpha",
      changes: [change("snapshot-change")],
      nextCursor: "cursor-after-snapshot",
    };

    await coordinator.run("library:alpha");

    expect(transport.bootstrapCalls).toBe(1);
    expect(transport.pullCalls).toBe(0);
    expect(storage.appliedBatches[0]?.bootstrap).toBe(true);
  });

  it("recovers claimed operations and emits cancellation without acknowledging them", async () => {
    const { storage, transport, lifecycle, cancellation, coordinator } = setup();
    storage.ready = [operation("one")];
    const originalMarkSending = storage.markSending.bind(storage);
    storage.markSending = async (operationIds) => {
      await originalMarkSending(operationIds);
      cancellation.aborted = true;
    };

    const result = await coordinator.run("library:alpha");

    expect(result.status).toBe("cancelled");
    expect(transport.pushRequests).toEqual([]);
    expect(storage.recovered).toEqual([{ operationIds: ["one"], reason: "cancelled" }]);
    expect(lifecycle.events).toContainEqual({ kind: "connection-state-changed", state: "stopped" });
  });
});
