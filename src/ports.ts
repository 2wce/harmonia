import type {
  BootstrapRequired,
  OperationOutcome,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SyncChange,
  SyncOperation,
  SyncScope,
  SyncLifecycleEvent,
} from "./protocol.js";
import type { Watermark } from "./watermark.js";

export type SyncRecoveryReason = "partial-outcome" | "retry" | "cancelled" | "terminal";

export interface SyncCancellation {
  readonly aborted: boolean;
  onAbort(listener: () => void): () => void;
}

export interface SyncClock {
  now(): number;
  random(): number;
}

export interface SyncStorage {
  /** Claims ready operations atomically; concurrent callers receive disjoint sets. */
  claimReady(scope: SyncScope, limit: number): Promise<SyncOperation[]>;
  /** Applies returned outcomes and releases unreturned claimed IDs atomically. */
  applyOutcomesAndRecover(
    outcomes: OperationOutcome[],
    unreturnedOperationIds: string[],
  ): Promise<void>;
  recoverOperations(operationIds: string[], reason: SyncRecoveryReason): Promise<void>;
  getWatermark(scope: SyncScope): Promise<Watermark>;
  applyChangesAndAdvance(
    scope: SyncScope,
    changes: SyncChange[],
    nextCursor: string | null,
    applyChange: (change: SyncChange, transaction: SyncRemoteChangeTransaction) => Promise<void>,
    bootstrap: boolean,
  ): Promise<void>;
  recordBootstrapRequired(instruction: BootstrapRequired): Promise<void>;
}

export interface SyncTransport {
  push(request: PushRequest): Promise<PushResponse>;
  pull(request: PullRequest): Promise<PullResponse | BootstrapRequired>;
  bootstrap(request: { scope: SyncScope; snapshotToken: string }): Promise<PullResponse>;
}

export interface SyncEntityApplier {
  apply(change: SyncChange, transaction: SyncRemoteChangeTransaction): Promise<void>;
}

/**
 * The storage adapter owns this transaction and must commit staged remote
 * mutations together with the cursor, or roll both back when application fails.
 */
export interface SyncRemoteChangeTransaction {
  stage(change: SyncChange): void;
}

export interface SyncLifecycleSink {
  emit(event: SyncLifecycleEvent): void;
}
