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
  listReady(scope: SyncScope, limit: number): Promise<SyncOperation[]>;
  markSending(operationIds: string[]): Promise<void>;
  applyOutcomes(outcomes: OperationOutcome[]): Promise<void>;
  recoverOperations(operationIds: string[], reason: SyncRecoveryReason): Promise<void>;
  getWatermark(scope: SyncScope): Promise<Watermark>;
  applyChangesAndAdvance(
    scope: SyncScope,
    changes: SyncChange[],
    nextCursor: string | null,
    applyChange: (change: SyncChange) => Promise<void>,
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
  apply(change: SyncChange): Promise<void>;
}

export interface SyncLifecycleSink {
  emit(event: SyncLifecycleEvent): void;
}
