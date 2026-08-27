import {
  PROTOCOL_VERSION,
  type BootstrapRequired,
  type PullResponse,
  type SyncChange,
  type SyncLifecycleEvent,
  type SyncOperation,
  type SyncScope,
} from "./protocol.js";
import { classifyTransportError, scheduleRetry, type RetryScheduleOptions } from "./retry.js";
import type {
  SyncCancellation,
  SyncClock,
  SyncEntityApplier,
  SyncLifecycleSink,
  SyncStorage,
  SyncTransport,
} from "./ports.js";

export type SyncRunStatus = "completed" | "retry-scheduled" | "bootstrap-required" | "cancelled";

export type SyncRunResult = {
  status: SyncRunStatus;
  pushed: number;
  pulled: number;
};

export type SyncCoordinatorOptions = {
  storage: SyncStorage;
  transport: SyncTransport;
  entities: SyncEntityApplier;
  lifecycle: SyncLifecycleSink;
  clock: SyncClock;
  cancellation: SyncCancellation;
  batchSize: number;
  retry: Pick<RetryScheduleOptions, "baseDelayMs" | "maxDelayMs">;
};

export class SyncCoordinator {
  constructor(private readonly options: SyncCoordinatorOptions) {
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
      throw new RangeError("SyncCoordinator batchSize must be a positive integer.");
    }
  }

  async run(scope: SyncScope): Promise<SyncRunResult> {
    this.emit({ kind: "connection-state-changed", state: "syncing" });
    if (this.options.cancellation.aborted) return this.cancelled([], scope);

    const operations = await this.options.storage.listReady(scope, this.options.batchSize);
    let pushed = 0;
    if (operations.length > 0) {
      const operationIds = operations.map(({ operationId }) => operationId);
      await this.options.storage.markSending(operationIds);
      this.emit({ kind: "operations-claimed", scope, operationIds });
      if (this.options.cancellation.aborted) return this.cancelled(operationIds, scope);

      const pushResult = await this.push(scope, operations);
      if (pushResult.status === "retry-scheduled") {
        return { ...pushResult, pushed: 0, pulled: 0 };
      }
      pushed = pushResult.pushed;
    }

    if (this.options.cancellation.aborted) return this.cancelled([], scope, pushed);
    const pullResult = await this.pull(scope);
    if (pullResult.status !== "completed") return { ...pullResult, pushed };

    this.emit({ kind: "connection-state-changed", state: "idle" });
    return { status: "completed", pushed, pulled: pullResult.pulled };
  }

  private async push(scope: SyncScope, operations: SyncOperation[]): Promise<SyncRunResult> {
    try {
      const response = await this.options.transport.push({
        protocolVersion: PROTOCOL_VERSION,
        scope,
        operations,
      });
      assertScope(response.scope, scope);

      const returnedIds = new Set(response.outcomes.map(({ operationId }) => operationId));
      const operationIds = new Set(operations.map(({ operationId }) => operationId));
      if (
        returnedIds.size !== response.outcomes.length ||
        [...returnedIds].some((operationId) => !operationIds.has(operationId))
      ) {
        throw new Error("Sync response contains an outcome for an unknown operation.");
      }
      const unreturnedIds = operations
        .map(({ operationId }) => operationId)
        .filter((operationId) => !returnedIds.has(operationId));

      await this.options.storage.applyOutcomes(response.outcomes);
      if (unreturnedIds.length > 0) {
        await this.options.storage.recoverOperations(unreturnedIds, "partial-outcome");
      }
      for (const outcome of response.outcomes) {
        if (outcome.status === "rejected") {
          this.emit({
            kind: "operation-rejected",
            scope,
            operationId: outcome.operationId,
            code: outcome.code,
          });
        }
        if (outcome.status === "conflicted") {
          this.emit({
            kind: "operation-conflicted",
            scope,
            operationId: outcome.operationId,
            code: outcome.code,
          });
        }
      }
      return { status: "completed", pushed: response.outcomes.length, pulled: 0 };
    } catch (error) {
      const transportError = asTransportError(error);
      const decision = classifyTransportError(transportError);
      const operationIds = operations.map(({ operationId }) => operationId);
      if (decision.kind === "retry" && transportError.kind === "retryable-transport-error") {
        const schedule = scheduleRetry(transportError, 1, {
          ...this.options.retry,
          now: () => this.options.clock.now(),
          random: () => this.options.clock.random(),
        });
        await this.options.storage.recoverOperations(operationIds, "retry");
        for (const operation of operations) {
          this.emit({
            kind: "operation-retry-scheduled",
            scope,
            operationId: operation.operationId,
            retryAfterMs: schedule.delayMs,
            code: transportError.code,
          });
        }
        return { status: "retry-scheduled", pushed: 0, pulled: 0 };
      }

      await this.options.storage.recoverOperations(operationIds, "terminal");
      throw error;
    }
  }

  private async pull(scope: SyncScope): Promise<Pick<SyncRunResult, "status" | "pulled">> {
    const watermark = await this.options.storage.getWatermark(scope);
    if (this.options.cancellation.aborted) return this.cancelled([], scope);

    let response: PullResponse | BootstrapRequired;
    let bootstrap = false;
    if (watermark.bootstrap) {
      bootstrap = true;
      response = await this.options.transport.bootstrap({
        scope,
        snapshotToken: watermark.bootstrap.snapshotToken,
      });
    } else {
      response = await this.options.transport.pull({
        protocolVersion: PROTOCOL_VERSION,
        scope,
        cursor: watermark.cursor,
      });
    }

    if (isBootstrapRequired(response)) {
      await this.options.storage.recordBootstrapRequired(response);
      this.emit({ kind: "bootstrap-required", scope, reason: response.reason });
      return { status: "bootstrap-required", pulled: 0 };
    }

    assertScope(response.scope, scope);
    await this.options.storage.applyChangesAndAdvance(
      scope,
      response.changes,
      response.nextCursor,
      (change) => this.applyChange(change),
      bootstrap,
    );
    return { status: "completed", pulled: response.changes.length };
  }

  private applyChange(change: SyncChange): Promise<void> {
    return this.options.entities.apply(change);
  }

  private async cancelled(
    operationIds: string[],
    scope: SyncScope,
    pushed = 0,
  ): Promise<SyncRunResult> {
    if (operationIds.length > 0) {
      await this.options.storage.recoverOperations(operationIds, "cancelled");
    }
    this.emit({ kind: "connection-state-changed", state: "stopped" });
    return { status: "cancelled", pushed, pulled: 0 };
  }

  private emit(event: SyncLifecycleEvent): void {
    this.options.lifecycle.emit(event);
  }
}

function assertScope(responseScope: SyncScope, requestedScope: SyncScope): void {
  if (responseScope !== requestedScope) {
    throw new Error(`Sync response scope ${responseScope} does not match ${requestedScope}.`);
  }
}

function isBootstrapRequired(
  response: PullResponse | BootstrapRequired,
): response is BootstrapRequired {
  return "kind" in response && response.kind === "bootstrap-required";
}

function asTransportError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    ((error as { kind?: unknown }).kind === "retryable-transport-error" ||
      (error as { kind?: unknown }).kind === "terminal-transport-error")
  ) {
    return error as import("./protocol.js").TransportError;
  }
  return {
    kind: "terminal-transport-error" as const,
    code: "unknown-transport-error",
    message: error instanceof Error ? error.message : "Unknown transport error.",
  };
}
