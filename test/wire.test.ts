import { describe, expect, it } from "vitest";

import {
  WireValidationError,
  parseBootstrapRequired,
  parsePullResponse,
  parsePushResponse,
} from "../src/wire.js";

describe("wire validation", () => {
  it("decodes a push response with out-of-order identity-keyed outcomes", () => {
    const response = parsePushResponse({
      protocolVersion: 1,
      scope: "library:alpha",
      outcomes: [
        {
          operationId: "operation-2",
          status: "rejected",
          changeId: null,
          code: "invalid-title",
          message: "A title is required.",
          remoteVersion: null,
          remotePayload: null,
        },
        {
          operationId: "operation-1",
          status: "acknowledged",
          changeId: "change-1",
          code: null,
          message: null,
          remoteVersion: "version-2",
          remotePayload: { nested: [true, null] },
        },
      ],
    });

    expect(response.outcomes.map((outcome) => outcome.operationId)).toEqual([
      "operation-2",
      "operation-1",
    ]);
  });

  it("rejects missing and duplicate outcome identities", () => {
    expect(() =>
      parsePushResponse({
        protocolVersion: 1,
        scope: "library:alpha",
        outcomes: [{ status: "acknowledged" }],
      }),
    ).toThrow(WireValidationError);

    expect(() =>
      parsePushResponse({
        protocolVersion: 1,
        scope: "library:alpha",
        outcomes: [
          {
            operationId: "operation-1",
            status: "acknowledged",
            changeId: null,
            code: null,
            message: null,
            remoteVersion: null,
            remotePayload: null,
          },
          {
            operationId: "operation-1",
            status: "rejected",
            changeId: null,
            code: null,
            message: null,
            remoteVersion: null,
            remotePayload: null,
          },
        ],
      }),
    ).toThrow(WireValidationError);
  });

  it("rejects invalid operation kinds, non-JSON payloads, and mixed scopes", () => {
    const response = {
      protocolVersion: 1,
      scope: "library:alpha",
      changes: [
        {
          changeId: "change-1",
          operationId: null,
          scope: "library:alpha",
          entity: "highlight",
          recordId: "highlight-1",
          kind: "replace",
          payload: null,
          logicalTime: null,
          version: null,
        },
      ],
      nextCursor: "cursor-1",
    };

    expect(() => parsePullResponse(response)).toThrow(WireValidationError);

    response.changes[0].kind = "update";
    response.changes[0].payload = new Date();
    expect(() => parsePullResponse(response)).toThrow(WireValidationError);

    response.changes[0].payload = null;
    response.changes[0].scope = "library:beta";
    expect(() => parsePullResponse(response)).toThrow(WireValidationError);
  });

  it("accepts opaque cursors and rejects malformed cursors", () => {
    const response = parsePullResponse({
      protocolVersion: 1,
      scope: "library:alpha",
      changes: [],
      nextCursor: "opaque:cursor:after/change-19",
    });

    expect(response.nextCursor).toBe("opaque:cursor:after/change-19");
    expect(() =>
      parsePullResponse({
        protocolVersion: 1,
        scope: "library:alpha",
        changes: [],
        nextCursor: "",
      }),
    ).toThrow(WireValidationError);
  });

  it("decodes a bootstrap instruction", () => {
    expect(
      parseBootstrapRequired({
        kind: "bootstrap-required",
        scope: "library:alpha",
        reason: "invalid-watermark",
        snapshotToken: "snapshot:library-alpha:42",
      }),
    ).toEqual({
      kind: "bootstrap-required",
      scope: "library:alpha",
      reason: "invalid-watermark",
      snapshotToken: "snapshot:library-alpha:42",
    });
  });
});
