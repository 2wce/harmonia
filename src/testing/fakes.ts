import { selectReadyOperations, type DependencyBlock } from "../dependencies.js";
import { markOperationForRetry, markOperationSending } from "../state-machine.js";
import { createWatermark, type Watermark } from "../watermark.js";
import type {
  BootstrapRequired,
  OperationOutcome,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SyncChange,
  SyncLifecycleEvent,
  SyncOperation,
  SyncScope,
} from "../protocol.js";
import type {
  SyncCancellation,
  SyncEntityApplier,
  SyncLifecycleSink,
  SyncRecoveryReason,
  SyncRemoteChangeTransaction,
  SyncStorage,
  SyncTransport,
} from "../ports.js";

export type ApplicationFailurePhase = "before" | "during";

export type FakeChangeBatch = {
  cursor: string | null;
  changes: SyncChange[];
  nextCursor: string | null;
};

/** A deterministic in-memory implementation of the storage adapter contract. */
export class FakeSyncStorage implements SyncStorage {
  private readonly operationsById = new Map<string, SyncOperation>();
  private readonly watermarksByScope = new Map<SyncScope, Watermark>();
  private readonly changesByScope = new Map<SyncScope, SyncChange[]>();
  private readonly seenChangeIds = new Set<string>();
  private readonly terminalOperationIds = new Set<string>();
  private readonly blockedByScope = new Map<SyncScope, DependencyBlock[]>();
  private applicationFailure: ApplicationFailurePhase | null = null;

  readonly recoveryLog: Array<{ operationIds: string[]; reason: SyncRecoveryReason }> = [];
  readonly appliedBatches: Array<{
    scope: SyncScope;
    changes: SyncChange[];
    nextCursor: string | null;
    bootstrap: boolean;
  }> = [];

  seedOperations(operations: SyncOperation[]): void {
    for (const operation of operations) {
      this.terminalOperationIds.delete(operation.operationId);
      this.operationsById.set(operation.operationId, cloneOperation(operation));
    }
  }

  operation(operationId: string): SyncOperation | undefined {
    const operation = this.operationsById.get(operationId);
    return operation ? cloneOperation(operation) : undefined;
  }

  blocked(scope: SyncScope): DependencyBlock[] {
    return (this.blockedByScope.get(scope) ?? []).map((block) => ({ ...block }));
  }

  changes(scope: SyncScope): SyncChange[] {
    return (this.changesByScope.get(scope) ?? []).map(cloneChange);
  }

  watermark(scope: SyncScope): Watermark {
    return { ...this.watermarkFor(scope) };
  }

  failApplication(phase: ApplicationFailurePhase): void {
    this.applicationFailure = phase;
  }

  async claimReady(scope: SyncScope, limit: number): Promise<SyncOperation[]> {
    const candidates = [...this.operationsById.values()].filter(
      (operation) =>
        operation.scope === scope && !this.terminalOperationIds.has(operation.operationId),
    );
    const selection = selectReadyOperations(candidates, limit);
    this.blockedByScope.set(
      scope,
      selection.blocked.map((block) => ({ ...block })),
    );

    const claimed = selection.ready.map((operation) => markOperationSending(operation));
    for (const operation of claimed) this.operationsById.set(operation.operationId, operation);
    return claimed.map(cloneOperation);
  }

  async applyOutcomesAndRecover(
    outcomes: OperationOutcome[],
    unreturnedOperationIds: string[],
  ): Promise<void> {
    for (const outcome of outcomes) {
      const operation = this.operationsById.get(outcome.operationId);
      if (!operation) throw new Error(`No operation exists for outcome ${outcome.operationId}.`);
      if (operation.status !== "sending") {
        throw new Error(`Operation ${outcome.operationId} is not claimed for an outcome.`);
      }
      this.operationsById.set(outcome.operationId, { ...operation, status: outcome.status });
    }
    await this.recoverOperations(unreturnedOperationIds, "partial-outcome");
  }

  async recoverOperations(operationIds: string[], reason: SyncRecoveryReason): Promise<void> {
    this.recoveryLog.push({ operationIds: [...operationIds], reason });
    for (const operationId of operationIds) {
      const operation = this.operationsById.get(operationId);
      if (!operation) continue;
      if (reason === "terminal") this.terminalOperationIds.add(operationId);
      else this.terminalOperationIds.delete(operationId);
      if (operation.status === "sending") {
        this.operationsById.set(operationId, markOperationForRetry(operation));
      }
    }
  }

  async getWatermark(scope: SyncScope): Promise<Watermark> {
    return this.watermark(scope);
  }

  async applyChangesAndAdvance(
    scope: SyncScope,
    changes: SyncChange[],
    nextCursor: string | null,
    applyChange: (change: SyncChange, transaction: SyncRemoteChangeTransaction) => Promise<void>,
    bootstrap: boolean,
  ): Promise<void> {
    if (this.consumeApplicationFailure("before")) {
      throw new Error("Fake local application failed before staging changes.");
    }

    const staged: SyncChange[] = [];
    let stagedCount = 0;
    const transaction: SyncRemoteChangeTransaction = {
      stage: (change) => {
        if (change.scope !== scope) throw new Error("A staged change cannot cross sync scopes.");
        if (this.applicationFailure === "during" && stagedCount > 0) {
          this.applicationFailure = null;
          throw new Error("Fake local application failed while staging changes.");
        }
        staged.push(cloneChange(change));
        stagedCount += 1;
      },
    };

    for (const change of changes) await applyChange(change, transaction);

    const committed = this.changesByScope.get(scope) ?? [];
    for (const change of staged) {
      const identity = `${scope}\u0000${change.changeId}`;
      if (this.seenChangeIds.has(identity)) continue;
      this.seenChangeIds.add(identity);
      committed.push(change);
    }
    this.changesByScope.set(scope, committed);
    this.watermarksByScope.set(scope, { scope, cursor: nextCursor, bootstrap: null });
    this.appliedBatches.push({
      scope,
      changes: staged.map(cloneChange),
      nextCursor,
      bootstrap,
    });
  }

  async recordBootstrapRequired(instruction: BootstrapRequired): Promise<void> {
    const watermark = this.watermarkFor(instruction.scope);
    this.watermarksByScope.set(instruction.scope, {
      ...watermark,
      bootstrap: { reason: instruction.reason, snapshotToken: instruction.snapshotToken },
    });
  }

  private watermarkFor(scope: SyncScope): Watermark {
    const existing = this.watermarksByScope.get(scope);
    if (existing) return existing;
    const created = createWatermark(scope, null);
    this.watermarksByScope.set(scope, created);
    return created;
  }

  private consumeApplicationFailure(phase: ApplicationFailurePhase): boolean {
    if (this.applicationFailure !== phase) return false;
    this.applicationFailure = null;
    return true;
  }
}

/** A deterministic transport fake with inspectable requests and scripted responses. */
export class FakeSyncTransport implements SyncTransport {
  readonly pushRequests: PushRequest[] = [];
  readonly pullRequests: PullRequest[] = [];
  readonly bootstrapRequests: Array<{ scope: SyncScope; snapshotToken: string }> = [];

  private readonly configuredOutcomes = new Map<string, OperationOutcome>();
  private readonly remoteEffectsByIdempotencyKey = new Map<string, number>();
  private readonly omittedOutcomeIds = new Set<string>();
  private readonly changeLogByScope = new Map<SyncScope, FakeChangeBatch[]>();
  private readonly compactionsByScope = new Map<
    SyncScope,
    Map<string | null, { snapshotToken: string; reason: BootstrapRequired["reason"] }>
  >();
  private readonly bootstrapResponses = new Map<string, PullResponse>();
  private readonly pullResponses = new Map<SyncScope, PullResponse | BootstrapRequired>();
  private pushFailure: unknown = null;
  private pushFailureAfterRemoteApply: unknown = null;
  private afterPushHandler: ((request: PushRequest) => void | Promise<void>) | null = null;

  configureOutcome(outcome: OperationOutcome): void {
    this.configuredOutcomes.set(outcome.operationId, cloneOutcome(outcome));
    this.omittedOutcomeIds.delete(outcome.operationId);
  }

  omitOutcome(operationId: string): void {
    this.omittedOutcomeIds.add(operationId);
    this.configuredOutcomes.delete(operationId);
  }

  failNextPush(error: unknown): void {
    this.pushFailure = error;
  }

  failNextPushAfterRemoteApply(error: unknown): void {
    this.pushFailureAfterRemoteApply = error;
  }

  afterPush(handler: (request: PushRequest) => void | Promise<void>): void {
    this.afterPushHandler = handler;
  }

  remoteEffectCount(idempotencyKey: string): number {
    return this.remoteEffectsByIdempotencyKey.get(idempotencyKey) ?? 0;
  }

  appendChange(
    scope: SyncScope,
    cursor: string | null,
    changes: SyncChange[],
    nextCursor: string | null,
  ): void {
    const changeLog = this.changeLogByScope.get(scope) ?? [];
    changeLog.push({ cursor, changes: changes.map(cloneChange), nextCursor });
    this.changeLogByScope.set(scope, changeLog);
  }

  compactHistory(
    scope: SyncScope,
    cursor: string | null,
    snapshotToken: string,
    reason: BootstrapRequired["reason"] = "watermark-compacted",
  ): void {
    const compactions = this.compactionsByScope.get(scope) ?? new Map();
    compactions.set(cursor, { snapshotToken, reason });
    this.compactionsByScope.set(scope, compactions);
  }

  setBootstrapResponse(snapshotToken: string, response: PullResponse): void {
    this.bootstrapResponses.set(snapshotToken, clonePullResponse(response));
  }

  setPullResponse(scope: SyncScope, response: PullResponse | BootstrapRequired): void {
    this.pullResponses.set(scope, clonePullOrBootstrapResponse(response));
  }

  async push(request: PushRequest): Promise<PushResponse> {
    this.pushRequests.push(clonePushRequest(request));
    await this.afterPushHandler?.(clonePushRequest(request));
    if (this.pushFailure !== null) {
      const error = this.pushFailure;
      this.pushFailure = null;
      throw error;
    }

    for (const operation of request.operations) {
      if (!this.remoteEffectsByIdempotencyKey.has(operation.idempotencyKey)) {
        this.remoteEffectsByIdempotencyKey.set(operation.idempotencyKey, 1);
      }
    }
    const requestIds = new Set(request.operations.map(({ operationId }) => operationId));
    const outcomes = [...this.configuredOutcomes.values()]
      .filter(({ operationId }) => requestIds.has(operationId))
      .map(cloneOutcome);
    const configuredIds = new Set(outcomes.map(({ operationId }) => operationId));
    for (const operation of request.operations) {
      if (
        configuredIds.has(operation.operationId) ||
        this.omittedOutcomeIds.has(operation.operationId)
      ) {
        continue;
      }
      outcomes.push(acknowledgedOutcome(operation.operationId));
    }
    if (this.pushFailureAfterRemoteApply !== null) {
      const error = this.pushFailureAfterRemoteApply;
      this.pushFailureAfterRemoteApply = null;
      throw error;
    }
    return { protocolVersion: request.protocolVersion, scope: request.scope, outcomes };
  }

  async pull(request: PullRequest): Promise<PullResponse | BootstrapRequired> {
    this.pullRequests.push({ ...request });
    const configuredResponse = this.pullResponses.get(request.scope);
    if (configuredResponse) return clonePullOrBootstrapResponse(configuredResponse);
    const compacted = this.compactionsByScope.get(request.scope)?.get(request.cursor);
    if (compacted) {
      return {
        kind: "bootstrap-required",
        scope: request.scope,
        reason: compacted.reason,
        snapshotToken: compacted.snapshotToken,
      };
    }
    const batch = this.changeLogByScope
      .get(request.scope)
      ?.find((candidate) => candidate.cursor === request.cursor);
    if (!batch) {
      return {
        protocolVersion: request.protocolVersion,
        scope: request.scope,
        changes: [],
        nextCursor: request.cursor,
      };
    }
    return {
      protocolVersion: request.protocolVersion,
      scope: request.scope,
      changes: batch.changes.map(cloneChange),
      nextCursor: batch.nextCursor,
    };
  }

  async bootstrap(request: { scope: SyncScope; snapshotToken: string }): Promise<PullResponse> {
    this.bootstrapRequests.push({ ...request });
    const response = this.bootstrapResponses.get(request.snapshotToken);
    if (response) return clonePullResponse(response);
    return {
      protocolVersion: 1,
      scope: request.scope,
      changes: [],
      nextCursor: request.snapshotToken,
    };
  }

  /** Payload-free metadata suitable for assertions and test diagnostics. */
  diagnostics(): {
    pushes: Array<{ scope: SyncScope; operationIds: string[] }>;
    pulls: PullRequest[];
    bootstraps: Array<{ scope: SyncScope; snapshotToken: string }>;
    changeLog: Array<{
      scope: SyncScope;
      cursor: string | null;
      changeIds: string[];
      nextCursor: string | null;
    }>;
    compactions: Array<{ scope: SyncScope; cursor: string | null; snapshotToken: string }>;
    remoteEffects: Array<{ idempotencyKey: string; count: number }>;
  } {
    return {
      pushes: this.pushRequests.map((request) => ({
        scope: request.scope,
        operationIds: request.operations.map(({ operationId }) => operationId),
      })),
      pulls: this.pullRequests.map((request) => ({ ...request })),
      bootstraps: this.bootstrapRequests.map((request) => ({ ...request })),
      changeLog: [...this.changeLogByScope.entries()].flatMap(([scope, batches]) =>
        batches.map((batch) => ({
          scope,
          cursor: batch.cursor,
          changeIds: batch.changes.map(({ changeId }) => changeId),
          nextCursor: batch.nextCursor,
        })),
      ),
      compactions: [...this.compactionsByScope.entries()].flatMap(([scope, compactions]) =>
        [...compactions.entries()].map(([cursor, compaction]) => ({
          scope,
          cursor,
          snapshotToken: compaction.snapshotToken,
        })),
      ),
      remoteEffects: [...this.remoteEffectsByIdempotencyKey.entries()].map(
        ([idempotencyKey, count]) => ({ idempotencyKey, count }),
      ),
    };
  }
}

export class FakeSyncEntities implements SyncEntityApplier {
  private applicationError: Error | null = null;

  failNextApply(error = new Error("Fake entity application failed.")): void {
    this.applicationError = error;
  }

  async apply(change: SyncChange, transaction: SyncRemoteChangeTransaction): Promise<void> {
    if (this.applicationError) {
      const error = this.applicationError;
      this.applicationError = null;
      throw error;
    }
    transaction.stage(change);
  }
}

export class FakeSyncLifecycle implements SyncLifecycleSink {
  readonly events: SyncLifecycleEvent[] = [];

  emit(event: SyncLifecycleEvent): void {
    this.events.push(cloneLifecycleEvent(event));
  }

  diagnostics(): SyncLifecycleEvent[] {
    return this.events.map(cloneLifecycleEvent);
  }
}

export class FakeSyncCancellation implements SyncCancellation {
  aborted = false;
  private readonly listeners = new Set<() => void>();

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of this.listeners) listener();
  }

  onAbort(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function acknowledgedOutcome(operationId: string): OperationOutcome {
  return {
    operationId,
    status: "acknowledged",
    changeId: `change:${operationId}`,
    code: null,
    message: null,
    remoteVersion: null,
    remotePayload: null,
  };
}

function clonePushRequest(request: PushRequest): PushRequest {
  return { ...request, operations: request.operations.map(cloneOperation) };
}

function clonePullResponse(response: PullResponse): PullResponse {
  return { ...response, changes: response.changes.map(cloneChange) };
}

function clonePullOrBootstrapResponse(
  response: PullResponse | BootstrapRequired,
): PullResponse | BootstrapRequired {
  if ("kind" in response && response.kind === "bootstrap-required") return { ...response };
  return clonePullResponse(response as PullResponse);
}

function cloneOperation(operation: SyncOperation): SyncOperation {
  return {
    ...operation,
    payload: cloneJson(operation.payload),
    dependsOn: [...operation.dependsOn],
  };
}

function cloneOutcome(outcome: OperationOutcome): OperationOutcome {
  return { ...outcome, remotePayload: cloneJson(outcome.remotePayload) };
}

function cloneChange(change: SyncChange): SyncChange {
  return { ...change, payload: cloneJson(change.payload) };
}

function cloneLifecycleEvent(event: SyncLifecycleEvent): SyncLifecycleEvent {
  return event.kind === "operations-claimed"
    ? { ...event, operationIds: [...event.operationIds] }
    : { ...event };
}

function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]),
  ) as T;
}
