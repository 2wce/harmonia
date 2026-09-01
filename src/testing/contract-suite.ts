import type { SyncCoordinator, SyncRunResult } from "../coordinator.js";
import type { DependencyBlock } from "../dependencies.js";
import type { SyncEntityApplier, SyncStorage, SyncTransport } from "../ports.js";
import type {
  BootstrapRequired,
  OperationOutcome,
  PullResponse,
  PushRequest,
  SyncChange,
  SyncLifecycleEvent,
  SyncOperation,
  SyncScope,
  TransportError,
} from "../protocol.js";
import { parsePushResponse } from "../wire.js";
import type { Watermark } from "../watermark.js";

export type SyncAdapterApplicationFailurePhase = "before" | "during";

export type SyncAdapterContractArrange = {
  seedOperations(operations: SyncOperation[]): Promise<void> | void;
  configureOutcome(outcome: OperationOutcome): Promise<void> | void;
  omitOutcome(operationId: string): Promise<void> | void;
  failNextPush(error: TransportError): Promise<void> | void;
  failNextPushAfterRemoteApply(error: TransportError): Promise<void> | void;
  afterPush(handler: () => void | Promise<void>): Promise<void> | void;
  abort(): Promise<void> | void;
  appendChange(
    scope: SyncScope,
    cursor: string | null,
    changes: SyncChange[],
    nextCursor: string | null,
  ): Promise<void> | void;
  compactHistory(
    scope: SyncScope,
    cursor: string | null,
    snapshotToken: string,
    reason?: BootstrapRequired["reason"],
  ): Promise<void> | void;
  setBootstrapResponse(snapshotToken: string, response: PullResponse): Promise<void> | void;
  setPullResponse(
    scope: SyncScope,
    response: PullResponse | BootstrapRequired,
  ): Promise<void> | void;
  failApplication(phase: SyncAdapterApplicationFailurePhase): Promise<void> | void;
};

export type SyncAdapterContractInspect = {
  operation(operationId: string): Promise<SyncOperation | undefined> | SyncOperation | undefined;
  watermark(scope: SyncScope): Promise<Watermark> | Watermark;
  changes(scope: SyncScope): Promise<SyncChange[]> | SyncChange[];
  blocked(scope: SyncScope): Promise<DependencyBlock[]> | DependencyBlock[];
  lastPushRequest(): Promise<PushRequest | undefined> | PushRequest | undefined;
  pushRequestCount(): Promise<number> | number;
  lifecycleEvents(): Promise<readonly SyncLifecycleEvent[]> | readonly SyncLifecycleEvent[];
  diagnostics(): Promise<unknown> | unknown;
  remoteEffectCount(idempotencyKey: string): Promise<number> | number;
};

export type SyncAdapterContractHarness = {
  coordinator: Pick<SyncCoordinator, "run">;
  ports: {
    storage: SyncStorage;
    transport: SyncTransport;
    entities: SyncEntityApplier;
  };
  scope: SyncScope;
  otherScope: SyncScope;
  arrange: SyncAdapterContractArrange;
  inspect: SyncAdapterContractInspect;
  retryAfterMs: number;
};

export type SyncAdapterContractFactory = () => SyncAdapterContractHarness;

export type SyncAdapterContractScenario = {
  name: string;
  run: () => Promise<void>;
};

/**
 * Runner-neutral synchronization adapter scenarios. Consumers can register the
 * returned cases with Vitest, Jest, node:test, or another test runner.
 *
 * The arrange and inspect interfaces deliberately belong to the consumer test
 * harness. The package fakes are one implementation, not a requirement for
 * Easy HMS or Better Reader adapters.
 */
export function createSyncAdapterContract(
  createHarness: SyncAdapterContractFactory,
): SyncAdapterContractScenario[] {
  return [
    scenario("preserves recursive payloads and matches outcomes by identity", async () => {
      const harness = createHarness();
      const first = operation("first", { payload: { nested: [{ label: "kept" }] } });
      const second = operation("second");
      await harness.arrange.seedOperations([first, second]);
      await harness.arrange.configureOutcome(outcome("second", "rejected", "validation-failed"));
      await harness.arrange.configureOutcome(outcome("first"));

      await harness.coordinator.run(harness.scope);

      const request = await harness.inspect.lastPushRequest();
      equal(
        request?.operations.map(({ operationId }) => operationId),
        ["first", "second"],
        "push order",
      );
      equal(
        request?.operations[0]?.payload,
        { nested: [{ label: "kept" }] },
        "recursive operation payload",
      );
      equal((await harness.inspect.operation("first"))?.status, "acknowledged", "first outcome");
      equal((await harness.inspect.operation("second"))?.status, "rejected", "second outcome");

      const parsed = parsePushResponse(
        JSON.parse(
          JSON.stringify({
            protocolVersion: 1,
            scope: harness.scope,
            outcomes: [
              {
                operationId: "first",
                status: "acknowledged",
                changeId: null,
                code: null,
                message: null,
                remoteVersion: null,
                remotePayload: { nested: [{ label: "kept" }] },
              },
            ],
          }),
        ),
      );
      equal(parsed.outcomes[0]?.remotePayload, { nested: [{ label: "kept" }] }, "wire payload");
    }),
    scenario("treats at-least-once duplicate delivery as idempotent", async () => {
      const harness = createHarness();
      const pending = operation("once", { scope: harness.scope });
      await harness.arrange.seedOperations([pending]);
      await harness.arrange.failNextPushAfterRemoteApply({
        kind: "retryable-transport-error",
        code: "response-lost",
        message: "Response lost after remote commit.",
        retryAfterMs: null,
      });

      equal(
        (await harness.coordinator.run(harness.scope)).status,
        "retry-scheduled",
        "lost response",
      );
      await harness.coordinator.run(harness.scope);

      equal(
        await harness.inspect.remoteEffectCount(pending.idempotencyKey),
        1,
        "remote idempotent effect count",
      );
      equal(await harness.inspect.pushRequestCount(), 2, "delivery attempts");
      equal((await harness.inspect.operation("once"))?.status, "acknowledged", "final status");
    }),
    scenario("blocks unresolved dependencies and exposes dependency cycles", async () => {
      const blockedHarness = createHarness();
      await blockedHarness.arrange.seedOperations([
        operation("parent", { scope: blockedHarness.scope }),
        operation("child", { scope: blockedHarness.scope, dependsOn: ["parent"] }),
      ]);
      await blockedHarness.coordinator.run(blockedHarness.scope);
      equal(
        await blockedHarness.inspect.blocked(blockedHarness.scope),
        [{ operationId: "child", dependencyId: "parent", reason: "dependency-pending" }],
        "pending dependency diagnostic",
      );

      const cycleHarness = createHarness();
      await cycleHarness.arrange.seedOperations([
        operation("one", { scope: cycleHarness.scope, dependsOn: ["two"] }),
        operation("two", { scope: cycleHarness.scope, dependsOn: ["one"] }),
      ]);
      await cycleHarness.coordinator.run(cycleHarness.scope);
      equal(await cycleHarness.inspect.pushRequestCount(), 0, "cycle push count");
      equal(
        await cycleHarness.inspect.blocked(cycleHarness.scope),
        [
          { operationId: "one", dependencyId: "two", reason: "dependency-cycle" },
          { operationId: "two", dependencyId: "one", reason: "dependency-cycle" },
        ],
        "cycle diagnostic",
      );
    }),
    scenario("classifies retryable and terminal delivery failures deterministically", async () => {
      const retryHarness = createHarness();
      await retryHarness.arrange.seedOperations([
        operation("retry", { scope: retryHarness.scope }),
      ]);
      await retryHarness.arrange.failNextPush({
        kind: "retryable-transport-error",
        code: "offline",
        message: "Offline",
        retryAfterMs: null,
      });

      const retryResult = await retryHarness.coordinator.run(retryHarness.scope);
      equal(retryResult.status, "retry-scheduled", "retry result");
      assert(
        (await retryHarness.inspect.lifecycleEvents()).some(
          (event) =>
            event.kind === "operation-retry-scheduled" &&
            event.operationId === "retry" &&
            event.retryAfterMs === retryHarness.retryAfterMs &&
            event.code === "offline",
        ),
        "expected deterministic retry lifecycle event",
      );
      equal((await retryHarness.inspect.operation("retry"))?.status, "pending", "retry recovery");

      for (const code of ["authentication-failed", "validation-failed"]) {
        const terminalHarness = createHarness();
        await terminalHarness.arrange.seedOperations([
          operation(code, { scope: terminalHarness.scope }),
        ]);
        await terminalHarness.arrange.failNextPush({
          kind: "terminal-transport-error",
          code,
          message: "Terminal failure",
        });
        await rejects(
          () => terminalHarness.coordinator.run(terminalHarness.scope),
          `${code} delivery failure`,
        );
        const requestCount = await terminalHarness.inspect.pushRequestCount();
        await terminalHarness.coordinator.run(terminalHarness.scope);
        equal(
          await terminalHarness.inspect.pushRequestCount(),
          requestCount,
          `${code} is quarantined`,
        );
        assert(
          !(await terminalHarness.inspect.lifecycleEvents()).some(
            (event) => event.kind === "operation-retry-scheduled",
          ),
          `${code} must not schedule a retry`,
        );
      }
    }),
    scenario("recovers unreturned operations from partial outcomes", async () => {
      const harness = createHarness();
      await harness.arrange.seedOperations([
        operation("returned", { scope: harness.scope }),
        operation("unreturned", { scope: harness.scope }),
      ]);
      await harness.arrange.omitOutcome("unreturned");

      await harness.coordinator.run(harness.scope);

      equal(
        (await harness.inspect.operation("returned"))?.status,
        "acknowledged",
        "returned outcome",
      );
      equal(
        (await harness.inspect.operation("unreturned"))?.status,
        "pending",
        "unreturned recovery",
      );
    }),
    scenario("keeps rejected and conflicted operations visible", async () => {
      const harness = createHarness();
      await harness.arrange.seedOperations([
        operation("rejected", { scope: harness.scope }),
        operation("conflicted", { scope: harness.scope }),
      ]);
      await harness.arrange.configureOutcome(outcome("rejected", "rejected", "validation-failed"));
      await harness.arrange.configureOutcome(
        outcome("conflicted", "conflicted", "version-conflict"),
      );

      await harness.coordinator.run(harness.scope);

      equal((await harness.inspect.operation("rejected"))?.status, "rejected", "rejected status");
      equal(
        (await harness.inspect.operation("conflicted"))?.status,
        "conflicted",
        "conflicted status",
      );
      assert(
        (await harness.inspect.lifecycleEvents()).some(
          (event) => event.kind === "operation-rejected" && event.operationId === "rejected",
        ),
        "missing rejected lifecycle event",
      );
      assert(
        (await harness.inspect.lifecycleEvents()).some(
          (event) => event.kind === "operation-conflicted" && event.operationId === "conflicted",
        ),
        "missing conflicted lifecycle event",
      );
    }),
    scenario("advances watermarks atomically with applied changes", async () => {
      const harness = createHarness();
      const remoteChange = change("change-1", harness.scope);
      await harness.arrange.appendChange(harness.scope, null, [remoteChange], "cursor-1");

      await harness.coordinator.run(harness.scope);

      equal(await harness.inspect.changes(harness.scope), [remoteChange], "committed changes");
      equal((await harness.inspect.watermark(harness.scope)).cursor, "cursor-1", "advanced cursor");
    }),
    scenario(
      "rolls back materialized changes and watermarks when local application fails",
      async () => {
        const harness = createHarness();
        await harness.arrange.appendChange(
          harness.scope,
          null,
          [change("rollback-1", harness.scope), change("rollback-2", harness.scope)],
          "cursor-1",
        );
        await harness.arrange.failApplication("during");

        await rejects(() => harness.coordinator.run(harness.scope), "during application failure");

        equal(await harness.inspect.changes(harness.scope), [], "rolled-back changes");
        equal((await harness.inspect.watermark(harness.scope)).cursor, null, "rolled-back cursor");
      },
    ),
    scenario("is safe to replay an already committed remote change", async () => {
      const harness = createHarness();
      const replayed = change("replayed", harness.scope);
      await harness.arrange.appendChange(harness.scope, null, [replayed], "cursor-1");
      await harness.arrange.appendChange(harness.scope, "cursor-1", [replayed], "cursor-2");

      await harness.coordinator.run(harness.scope);
      await harness.coordinator.run(harness.scope);

      equal(await harness.inspect.changes(harness.scope), [replayed], "replay-safe changes");
      equal((await harness.inspect.watermark(harness.scope)).cursor, "cursor-2", "replay cursor");
    }),
    scenario("isolates operations and watermarks by scope", async () => {
      const harness = createHarness();
      await harness.arrange.seedOperations([
        operation("alpha", { scope: harness.scope }),
        operation("beta", { scope: harness.otherScope }),
      ]);
      await harness.arrange.appendChange(
        harness.otherScope,
        null,
        [change("beta-change", harness.otherScope)],
        "beta-1",
      );

      await harness.coordinator.run(harness.scope);

      equal((await harness.inspect.lastPushRequest())?.scope, harness.scope, "push scope");
      equal((await harness.inspect.operation("beta"))?.status, "pending", "other scope operation");
      equal(
        (await harness.inspect.watermark(harness.otherScope)).cursor,
        null,
        "other scope watermark",
      );
      equal(await harness.inspect.changes(harness.otherScope), [], "other scope changes");
    }),
    scenario("rejects a foreign-scope response without mutating local state", async () => {
      const harness = createHarness();
      await harness.arrange.setPullResponse(harness.scope, {
        protocolVersion: 1,
        scope: harness.otherScope,
        changes: [],
        nextCursor: "foreign-cursor",
      });

      await rejects(() => harness.coordinator.run(harness.scope), "foreign-scope response");

      equal(
        (await harness.inspect.watermark(harness.scope)).cursor,
        null,
        "foreign cursor ignored",
      );
      equal(await harness.inspect.changes(harness.scope), [], "foreign changes ignored");
    }),
    scenario(
      "requires bootstrap for compacted and invalid history and resumes from a snapshot",
      async () => {
        for (const reason of ["watermark-compacted", "invalid-watermark"] as const) {
          const harness = createHarness();
          await harness.arrange.appendChange(harness.scope, null, [], "cursor-old");
          await harness.coordinator.run(harness.scope);
          await harness.arrange.compactHistory(
            harness.scope,
            "cursor-old",
            `snapshot-${reason}`,
            reason,
          );

          const blocked = await harness.coordinator.run(harness.scope);
          equal(blocked.status, "bootstrap-required", `${reason} bootstrap result`);
          equal(
            (await harness.inspect.watermark(harness.scope)).bootstrap,
            { reason, snapshotToken: `snapshot-${reason}` },
            `${reason} bootstrap watermark`,
          );

          await harness.arrange.setBootstrapResponse(`snapshot-${reason}`, {
            protocolVersion: 1,
            scope: harness.scope,
            changes: [change(`snapshot-${reason}`, harness.scope)],
            nextCursor: "cursor-new",
          });
          const resumed = await harness.coordinator.run(harness.scope);
          equal(resumed.status, "completed", `${reason} bootstrap completion`);
          equal(
            (await harness.inspect.watermark(harness.scope)).cursor,
            "cursor-new",
            `${reason} bootstrap cursor`,
          );
        }
      },
    ),
    scenario("retains bootstrap recovery state when snapshot application fails", async () => {
      const harness = createHarness();
      await harness.arrange.appendChange(harness.scope, null, [], "cursor-old");
      await harness.coordinator.run(harness.scope);
      await harness.arrange.compactHistory(harness.scope, "cursor-old", "snapshot-failed");
      await harness.coordinator.run(harness.scope);
      await harness.arrange.setBootstrapResponse("snapshot-failed", {
        protocolVersion: 1,
        scope: harness.scope,
        changes: [change("failed-snapshot", harness.scope)],
        nextCursor: "cursor-new",
      });
      await harness.arrange.failApplication("before");

      await rejects(() => harness.coordinator.run(harness.scope), "failed bootstrap application");

      equal((await harness.inspect.watermark(harness.scope)).cursor, "cursor-old", "old cursor");
      equal(
        (await harness.inspect.watermark(harness.scope)).bootstrap,
        { reason: "watermark-compacted", snapshotToken: "snapshot-failed" },
        "bootstrap recovery state",
      );
    }),
    scenario("recovers cancellation without acknowledging in-flight work", async () => {
      const harness = createHarness();
      await harness.arrange.seedOperations([operation("cancelled", { scope: harness.scope })]);
      await harness.arrange.afterPush(() => harness.arrange.abort());

      const result = await harness.coordinator.run(harness.scope);

      equal(result.status, "cancelled", "cancellation result");
      equal(
        (await harness.inspect.operation("cancelled"))?.status,
        "pending",
        "cancelled operation",
      );
      assert(
        (await harness.inspect.lifecycleEvents()).some(
          (event) => event.kind === "connection-state-changed" && event.state === "stopped",
        ),
        "missing stopped lifecycle event",
      );
    }),
    scenario("keeps every lifecycle diagnostic payload-free", async () => {
      const sentinel = "payload-must-not-appear";
      const paths: Array<(harness: SyncAdapterContractHarness) => Promise<void>> = [
        async (harness) => {
          await harness.arrange.seedOperations([
            operation("ordinary", { scope: harness.scope, payload: { sentinel } }),
          ]);
          await harness.coordinator.run(harness.scope);
        },
        async (harness) => {
          await harness.arrange.seedOperations([
            operation("retry-diagnostic", { scope: harness.scope, payload: { sentinel } }),
          ]);
          await harness.arrange.failNextPush({
            kind: "retryable-transport-error",
            code: "offline",
            message: "Offline",
            retryAfterMs: null,
          });
          await harness.coordinator.run(harness.scope);
        },
        async (harness) => {
          await harness.arrange.seedOperations([
            operation("rejection-diagnostic", { scope: harness.scope, payload: { sentinel } }),
          ]);
          await harness.arrange.configureOutcome(
            outcome("rejection-diagnostic", "rejected", "validation-failed"),
          );
          await harness.coordinator.run(harness.scope);
        },
        async (harness) => {
          await harness.arrange.appendChange(
            harness.scope,
            null,
            [change("bootstrap-diagnostic", harness.scope, { sentinel })],
            "cursor-old",
          );
          await harness.coordinator.run(harness.scope);
          await harness.arrange.compactHistory(harness.scope, "cursor-old", "snapshot-diagnostic");
          await harness.coordinator.run(harness.scope);
        },
      ];

      for (const runPath of paths) {
        const harness = createHarness();
        await runPath(harness);
        assert(
          !JSON.stringify(await harness.inspect.diagnostics()).includes(sentinel),
          "diagnostics exposed operation or change payload",
        );
      }
    }),
  ];
}

function scenario(name: string, run: () => Promise<void>): SyncAdapterContractScenario {
  return { name, run };
}

function operation(
  operationId: string,
  options: Partial<Pick<SyncOperation, "dependsOn" | "payload" | "scope">> = {},
): SyncOperation {
  return {
    operationId,
    idempotencyKey: `idempotency:${operationId}`,
    clientId: "contract-client",
    scope: "library:alpha",
    entity: "contract-entity",
    recordId: operationId,
    kind: "update",
    payload: { operationId },
    baseVersion: null,
    logicalTime: null,
    dependsOn: [],
    createdAt: "2026-08-26T10:00:00.000Z",
    attempts: 0,
    status: "pending",
    ...options,
  };
}

function outcome(
  operationId: string,
  status: OperationOutcome["status"] = "acknowledged",
  code: string | null = null,
): OperationOutcome {
  return {
    operationId,
    status,
    changeId: status === "acknowledged" ? `change:${operationId}` : null,
    code,
    message: null,
    remoteVersion: null,
    remotePayload: null,
  };
}

function change(
  changeId: string,
  scope: SyncScope,
  payload: SyncChange["payload"] = { changeId },
): SyncChange {
  return {
    changeId,
    operationId: null,
    scope,
    entity: "contract-entity",
    recordId: changeId,
    kind: "update",
    payload,
    logicalTime: null,
    version: null,
  };
}

async function rejects(run: () => Promise<SyncRunResult>, label: string): Promise<void> {
  try {
    await run();
  } catch {
    return;
  }
  throw new Error(`Expected ${label} to reject.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Contract assertion failed: ${message}`);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Contract assertion failed for ${label}. Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}
