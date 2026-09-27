import { describe, expect, it } from "vitest";

import {
  classifyGatherDropReadbackFailure,
  classifyGatherDropReadbackReply,
  gatherDropPositionReadbackCommand,
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

  it("recognizes the missing-entity reply from the direct data lookup", () => {
    expect(classifyGatherDropReadbackReply(" No entity was found. ")).toBe(
      "known_negative",
    );
  });

  it.each(["Test failed", "Execute subcommand if entity test failed"])(
    "does not accept an execute-condition failure as proof of absence: %s",
    (reply) => {
      expect(classifyGatherDropReadbackReply(reply)).toBe("unknown_reply");
    },
  );

  it.each(["", "Unknown command", "Test failed: malformed selector"])(
    "does not treat an unrecognized reply as absence: %s",
    (reply) => {
      expect(classifyGatherDropReadbackReply(reply)).toBe("unknown_reply");
    },
  );

  it("queries the item selector directly so the data command reports absence", () => {
    expect(
      gatherDropPositionReadbackCommand({ x: 1, y: 64, z: -2 }, "oak_log"),
    ).toBe(
      'execute positioned 1.5 64.5 -1.5 run data get entity @e[type=minecraft:item,limit=1,sort=nearest,distance=..3,nbt={Item:{id:"minecraft:oak_log"}}] Pos',
    );
  });

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
