import type { BootstrapRequired, SyncScope } from "./protocol.js";

export type Watermark = {
  scope: SyncScope;
  cursor: string | null;
  bootstrap: { reason: BootstrapRequired["reason"]; snapshotToken: string } | null;
};

export type CursorOrder = "before" | "equal" | "after";
export type CursorComparator = (current: string, next: string) => CursorOrder;

export class WatermarkError extends Error {
  override name = "WatermarkError";
}

export function createWatermark(scope: SyncScope, cursor: string | null): Watermark {
  requireScope(scope);
  requireCursor(cursor);
  return { scope, cursor, bootstrap: null };
}

export function advanceWatermark(
  watermark: Watermark,
  scope: SyncScope,
  nextCursor: string | null,
  compare: CursorComparator,
): Watermark {
  requireScope(scope);
  requireCursor(nextCursor);
  assertScope(watermark, scope);
  if (watermark.bootstrap) {
    throw new WatermarkError(`Scope ${scope} requires bootstrap before cursor advancement.`);
  }
  if (watermark.cursor === null) {
    return { ...watermark, cursor: nextCursor };
  }
  if (nextCursor === null) {
    throw new WatermarkError("A watermark cannot move backwards to an empty cursor.");
  }

  const order = compare(watermark.cursor, nextCursor);
  if (order === "after") {
    throw new WatermarkError("A watermark cannot move backwards.");
  }
  return order === "equal" ? watermark : { ...watermark, cursor: nextCursor };
}

export function requireBootstrap(watermark: Watermark, instruction: BootstrapRequired): Watermark {
  assertScope(watermark, instruction.scope);
  requireCursor(instruction.snapshotToken);
  return {
    ...watermark,
    bootstrap: {
      reason: instruction.reason,
      snapshotToken: instruction.snapshotToken,
    },
  };
}

export function completeBootstrap(watermark: Watermark, cursor: string): Watermark {
  assertScope(watermark, watermark.scope);
  if (!watermark.bootstrap) {
    throw new WatermarkError("Cannot complete bootstrap when bootstrap is not required.");
  }
  requireCursor(cursor);
  return { scope: watermark.scope, cursor, bootstrap: null };
}

function assertScope(watermark: Watermark, scope: SyncScope): void {
  if (watermark.scope !== scope) {
    throw new WatermarkError(`Watermark scope ${watermark.scope} does not match ${scope}.`);
  }
}

function requireScope(scope: SyncScope): void {
  if (scope.length === 0) throw new WatermarkError("A watermark scope must be non-empty.");
}

function requireCursor(cursor: string | null): void {
  if (cursor !== null && cursor.length === 0) {
    throw new WatermarkError("A cursor must be null or a non-empty string.");
  }
}
