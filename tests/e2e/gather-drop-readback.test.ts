import { describe, expect, it } from "vitest";

import {
  classifyGatherDropReadbackFailure,
  classifyGatherDropReadbackReply,
  gatherDropReadbackConfirmsAbsence,
} from "./gather-drop-readback.js";

describe("gather drop readback classification", () => {
  it("classifies a parsed position without retaining its coordinate", () => {
    expect(
      classifyGatherDropReadbackReply(
        "Synthetic entity data: [1.25d, 64.0d, -2.5d]",
      ),
    ).toBe("position");
  });

  it.each(["Test failed", " No entity was found. "])(
    "recognizes an explicit negative reply: %s",
    (reply) => {
      expect(classifyGatherDropReadbackReply(reply)).toBe("known_negative");
    },
  );

  it.each(["", "Unknown command", "Test failed: malformed selector"])(
    "does not treat an unrecognized reply as absence: %s",
    (reply) => {
      expect(classifyGatherDropReadbackReply(reply)).toBe("unknown_reply");
    },
  );

  it("distinguishes timeout from other unavailable RCON failures", () => {
    expect(classifyGatherDropReadbackFailure("RCON_TIMEOUT")).toBe("timeout");
    expect(classifyGatherDropReadbackFailure("RCON_UNAVAILABLE")).toBe(
      "unavailable",
    );
    expect(classifyGatherDropReadbackFailure(undefined)).toBe("unavailable");
  });

  it.each([
    "not_attempted",
    "position",
    "unknown_reply",
    "timeout",
    "unavailable",
  ] as const)(
    "does not accept %s as proof that the drop is absent",
    (value) => {
      expect(gatherDropReadbackConfirmsAbsence(value)).toBe(false);
    },
  );

  it("accepts only an explicit known-negative reply as proof of absence", () => {
    expect(gatherDropReadbackConfirmsAbsence("known_negative")).toBe(true);
  });
});
