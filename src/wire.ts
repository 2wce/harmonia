import {
  PROTOCOL_VERSION,
  type BootstrapRequired,
  type JsonValue,
  type OperationKind,
  type OperationOutcome,
  type PullResponse,
  type PushResponse,
  type SyncChange,
} from "./protocol.js";

type RecordValue = Record<string, unknown>;

export class WireValidationError extends Error {
  override name = "WireValidationError";
}

/**
 * Decodes an untrusted push response without inspecting or logging payload
 * contents. Outcomes retain wire order but are identified by operationId.
 */
export function parsePushResponse(input: unknown): PushResponse {
  const record = requireRecord(input, "push response");
  const scope = requireString(record.scope, "push response.scope");
  const outcomes = requireArray(record.outcomes, "push response.outcomes").map((outcome, index) =>
    parseOperationOutcome(outcome, `push response.outcomes[${index}]`),
  );
  const operationIds = new Set<string>();

  for (const outcome of outcomes) {
    if (operationIds.has(outcome.operationId)) {
      fail("push response contains duplicate outcome operationId");
    }
    operationIds.add(outcome.operationId);
  }

  return {
    protocolVersion: parseProtocolVersion(record.protocolVersion, "push response"),
    scope,
    outcomes,
  };
}

/** Decodes an untrusted pull response and enforces the envelope scope. */
export function parsePullResponse(input: unknown): PullResponse {
  const record = requireRecord(input, "pull response");
  const scope = requireString(record.scope, "pull response.scope");
  const changes = requireArray(record.changes, "pull response.changes").map((change, index) =>
    parseSyncChange(change, `pull response.changes[${index}]`, scope),
  );

  return {
    protocolVersion: parseProtocolVersion(record.protocolVersion, "pull response"),
    scope,
    changes,
    nextCursor: parseCursor(record.nextCursor, "pull response.nextCursor"),
  };
}

/** Decodes an explicit instruction to stop cursor advancement and bootstrap. */
export function parseBootstrapRequired(input: unknown): BootstrapRequired {
  const record = requireRecord(input, "bootstrap instruction");

  if (record.kind !== "bootstrap-required") {
    fail("bootstrap instruction.kind must be bootstrap-required");
  }

  const reason = record.reason;
  if (reason !== "watermark-compacted" && reason !== "invalid-watermark") {
    fail("bootstrap instruction.reason is invalid");
  }

  return {
    kind: "bootstrap-required",
    scope: requireString(record.scope, "bootstrap instruction.scope"),
    reason,
    snapshotToken: requireString(record.snapshotToken, "bootstrap instruction.snapshotToken"),
  };
}

function parseOperationOutcome(input: unknown, path: string): OperationOutcome {
  const record = requireRecord(input, path);
  const status = record.status;
  if (status !== "acknowledged" && status !== "rejected" && status !== "conflicted") {
    fail(`${path}.status is invalid`);
  }

  return {
    operationId: requireString(record.operationId, `${path}.operationId`),
    status,
    changeId: requireNullableString(record.changeId, `${path}.changeId`),
    code: requireNullableString(record.code, `${path}.code`),
    message: requireNullableString(record.message, `${path}.message`),
    remoteVersion: requireNullableString(record.remoteVersion, `${path}.remoteVersion`),
    remotePayload: requireJsonOrNull(record.remotePayload, `${path}.remotePayload`),
  };
}

function parseSyncChange(input: unknown, path: string, envelopeScope: string): SyncChange {
  const record = requireRecord(input, path);
  const scope = requireString(record.scope, `${path}.scope`);
  if (scope !== envelopeScope) {
    fail(`${path}.scope differs from the pull response scope`);
  }

  return {
    changeId: requireString(record.changeId, `${path}.changeId`),
    operationId: requireNullableString(record.operationId, `${path}.operationId`),
    scope,
    entity: requireString(record.entity, `${path}.entity`),
    recordId: requireString(record.recordId, `${path}.recordId`),
    kind: parseOperationKind(record.kind, `${path}.kind`),
    payload: requireJsonOrNull(record.payload, `${path}.payload`),
    logicalTime: requireNullableString(record.logicalTime, `${path}.logicalTime`),
    version: requireNullableString(record.version, `${path}.version`),
  };
}

function parseProtocolVersion(input: unknown, context: string): typeof PROTOCOL_VERSION {
  if (input !== PROTOCOL_VERSION) {
    fail(`${context}.protocolVersion is unsupported`);
  }
  return PROTOCOL_VERSION;
}

function parseOperationKind(input: unknown, path: string): OperationKind {
  if (input === "insert" || input === "update" || input === "delete") {
    return input;
  }
  fail(`${path} is invalid`);
}

function parseCursor(input: unknown, path: string): string | null {
  if (input === null) return null;
  return requireString(input, path);
}

function requireJsonOrNull(input: unknown, path: string): JsonValue | null {
  if (input === null) return null;
  if (!isJsonValue(input, new WeakSet<object>())) {
    fail(`${path} is not JSON-safe`);
  }
  return input;
}

function isJsonValue(input: unknown, ancestors: WeakSet<object>): input is JsonValue {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return true;
  }

  if (typeof input !== "object" || ancestors.has(input)) return false;
  ancestors.add(input);

  const valid = Array.isArray(input)
    ? input.every((value) => isJsonValue(value, ancestors))
    : isPlainRecord(input) && Object.values(input).every((value) => isJsonValue(value, ancestors));

  ancestors.delete(input);
  return valid;
}

function requireRecord(input: unknown, path: string): RecordValue {
  if (!isPlainRecord(input)) fail(`${path} must be an object`);
  return input;
}

function isPlainRecord(input: unknown): input is RecordValue {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function requireArray(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) fail(`${path} must be an array`);
  return input;
}

function requireString(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return input;
}

function requireNullableString(input: unknown, path: string): string | null {
  if (input === null) return null;
  return requireString(input, path);
}

function fail(message: string): never {
  throw new WireValidationError(message);
}
