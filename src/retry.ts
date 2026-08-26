import type { RetryableTransportError, TransportError } from "./protocol.js";

export type RetryDecision = { kind: "retry" } | { kind: "terminal"; code: string };

export type RetryScheduleOptions = {
  now: () => number;
  random: () => number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export type RetrySchedule = { delayMs: number; retryAt: number };

export function classifyTransportError(error: TransportError): RetryDecision {
  return error.kind === "retryable-transport-error"
    ? { kind: "retry" }
    : { kind: "terminal", code: error.code };
}

export function scheduleRetry(
  error: RetryableTransportError,
  attempt: number,
  options: RetryScheduleOptions,
): RetrySchedule {
  const exponentialDelay = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const jitteredDelay = Math.round(exponentialDelay * (0.5 + clamp(options.random(), 0, 1)));
  const retryAfterDelay = error.retryAfterMs === null ? 0 : Math.max(0, error.retryAfterMs);
  const delayMs = Math.min(options.maxDelayMs, Math.max(jitteredDelay, retryAfterDelay));

  return { delayMs, retryAt: options.now() + delayMs };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
}
