/** The wire contract version understood by this release of Harmonia. */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type OperationKind = "insert" | "update" | "delete";
export type OperationStatus = "pending" | "sending" | "acknowledged" | "rejected" | "conflicted";

/** A product-defined serialized synchronization boundary. */
export type SyncScope = string;

export type SyncOperation = {
  operationId: string;
  idempotencyKey: string;
  clientId: string;
  scope: SyncScope;
  entity: string;
  recordId: string;
  kind: OperationKind;
  payload: JsonValue | null;
  baseVersion: string | null;
  logicalTime: string | null;
  dependsOn: string[];
  createdAt: string;
  attempts: number;
  status: OperationStatus;
};

export type OperationOutcome = {
  operationId: string;
  status: "acknowledged" | "rejected" | "conflicted";
  changeId: string | null;
  code: string | null;
  message: string | null;
  remoteVersion: string | null;
  remotePayload: JsonValue | null;
};

export type SyncChange = {
  changeId: string;
  operationId: string | null;
  scope: SyncScope;
  entity: string;
  recordId: string;
  kind: OperationKind;
  payload: JsonValue | null;
  logicalTime: string | null;
  version: string | null;
};

export type BootstrapRequired = {
  kind: "bootstrap-required";
  scope: SyncScope;
  reason: "watermark-compacted" | "invalid-watermark";
  snapshotToken: string;
};

export type PushRequest = {
  protocolVersion: ProtocolVersion;
  scope: SyncScope;
  operations: SyncOperation[];
};

export type PushResponse = {
  protocolVersion: ProtocolVersion;
  scope: SyncScope;
  outcomes: OperationOutcome[];
};

export type PullRequest = {
  protocolVersion: ProtocolVersion;
  scope: SyncScope;
  cursor: string | null;
};

export type PullResponse = {
  protocolVersion: ProtocolVersion;
  scope: SyncScope;
  changes: SyncChange[];
  nextCursor: string | null;
};

export type RetryableTransportError = {
  kind: "retryable-transport-error";
  code: string;
  message: string;
  retryAfterMs: number | null;
};

export type TerminalTransportError = {
  kind: "terminal-transport-error";
  code: string;
  message: string;
};

export type TransportError = RetryableTransportError | TerminalTransportError;

export type SyncLifecycleEvent =
  | {
      kind: "connection-state-changed";
      state: "idle" | "syncing" | "offline" | "stopped";
    }
  | { kind: "operations-claimed"; scope: SyncScope; operationIds: string[] }
  | {
      kind: "operation-retry-scheduled";
      scope: SyncScope;
      operationId: string;
      retryAfterMs: number;
      code: string;
    }
  | {
      kind: "operation-rejected";
      scope: SyncScope;
      operationId: string;
      code: string | null;
    }
  | {
      kind: "operation-conflicted";
      scope: SyncScope;
      operationId: string;
      code: string | null;
    }
  | {
      kind: "bootstrap-required";
      scope: SyncScope;
      reason: BootstrapRequired["reason"];
    };
