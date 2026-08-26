import { describe, expect, it } from "vitest";

import { classifyTransportError, scheduleRetry } from "../src/retry.js";

describe("transport retry policy", () => {
  it("retries retryable transport failures with deterministic injected jitter", () => {
    const error = {
      kind: "retryable-transport-error" as const,
      code: "network-unavailable",
      message: "Offline",
      retryAfterMs: null,
    };

    expect(classifyTransportError(error)).toEqual({ kind: "retry" });
    expect(
      scheduleRetry(error, 2, {
        now: () => 1_000,
        random: () => 0.5,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
      }),
    ).toEqual({ delayMs: 200, retryAt: 1_200 });
  });

  it("does not retry terminal authentication and validation failures", () => {
    for (const code of ["authentication-failed", "validation-failed"]) {
      expect(
        classifyTransportError({
          kind: "terminal-transport-error",
          code,
          message: "Terminal error",
        }),
      ).toEqual({ kind: "terminal", code });
    }
  });
});
