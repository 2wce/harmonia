import { describe, expect, it } from "vitest";

import {
  WatermarkError,
  advanceWatermark,
  completeBootstrap,
  createWatermark,
  requireBootstrap,
} from "../src/watermark.js";

describe("scoped opaque watermarks", () => {
  it("preserves an opaque cursor and advances it only through adapter ordering", () => {
    const watermark = createWatermark("library:alpha", "opaque:cursor:1");
    const advanced = advanceWatermark(
      watermark,
      "library:alpha",
      "opaque:cursor:2",
      (current, next) =>
        current === "opaque:cursor:1" && next === "opaque:cursor:2" ? "before" : "after",
    );

    expect(advanced).toEqual({
      scope: "library:alpha",
      cursor: "opaque:cursor:2",
      bootstrap: null,
    });
  });

  it("rejects scope mismatch and invalid cursor values", () => {
    const watermark = createWatermark("library:alpha", null);

    expect(() => advanceWatermark(watermark, "library:beta", "cursor", () => "before")).toThrow(
      WatermarkError,
    );
    expect(() => createWatermark("library:alpha", "")).toThrow(WatermarkError);
  });

  it("does not erase an established cursor", () => {
    const watermark = createWatermark("library:alpha", "opaque:cursor:1");

    expect(() => advanceWatermark(watermark, "library:alpha", null, () => "before")).toThrow(
      WatermarkError,
    );
  });

  it.each(["invalid-watermark", "watermark-compacted"] as const)(
    "records a %s bootstrap requirement without advancing the cursor",
    (reason) => {
      const blocked = requireBootstrap(createWatermark("library:alpha", "opaque:cursor:1"), {
        kind: "bootstrap-required",
        scope: "library:alpha",
        reason,
        snapshotToken: "snapshot:1",
      });

      expect(blocked).toEqual({
        scope: "library:alpha",
        cursor: "opaque:cursor:1",
        bootstrap: { reason, snapshotToken: "snapshot:1" },
      });
      expect(() =>
        advanceWatermark(blocked, "library:alpha", "opaque:cursor:2", () => "before"),
      ).toThrow(WatermarkError);
    },
  );

  it("completes bootstrap only by replacing the cursor after snapshot application", () => {
    const blocked = requireBootstrap(createWatermark("library:alpha", "old-cursor"), {
      kind: "bootstrap-required",
      scope: "library:alpha",
      reason: "watermark-compacted",
      snapshotToken: "snapshot:1",
    });

    expect(completeBootstrap(blocked, "new-opaque-cursor")).toEqual({
      scope: "library:alpha",
      cursor: "new-opaque-cursor",
      bootstrap: null,
    });
  });
});
