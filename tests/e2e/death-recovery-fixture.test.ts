import { describe, expect, it } from "vitest";

import {
  deathRecoveryDropConfirmed,
  isNoEntitySelectionReply,
  safeEntityCountBucket,
  type DeathRecoveryDropProof,
} from "./death-recovery-fixture.js";

const confirmedProof: DeathRecoveryDropProof = {
  deathEventObserved: true,
  freshBodyAfterDeath: true,
  dimensionMatched: true,
  testItemAbsentFromInventory: true,
  rconDropCount: 1,
  bodyVisibleDropCount: 1,
  bodyVisibilityComplete: true,
};

describe("death recovery drop fixture oracle", () => {
  it("requires independent death, respawn, inventory, and drop observations", () => {
    expect(deathRecoveryDropConfirmed(confirmedProof)).toBe(true);
  });

  it.each([
    ["no death event", { deathEventObserved: false }],
    ["stale Body", { freshBodyAfterDeath: false }],
    ["dimension mismatch", { dimensionMatched: false }],
    ["item retained", { testItemAbsentFromInventory: false }],
    ["no RCON drop", { rconDropCount: 0 }],
    ["ambiguous RCON drop", { rconDropCount: 2 }],
    ["Body cannot see drop", { bodyVisibleDropCount: 0 }],
    ["ambiguous Body view", { bodyVisibleDropCount: 2 }],
    ["truncated Body view", { bodyVisibilityComplete: false }],
    ["unavailable RCON readback", { rconDropCount: undefined }],
  ] as const)("rejects %s", (_label, changes) => {
    expect(deathRecoveryDropConfirmed({ ...confirmedProof, ...changes })).toBe(
      false,
    );
  });
});

describe("death recovery drop RCON entity selection", () => {
  it.each([
    "",
    "test failed",
    "No entity was found.",
    "No entities were found.",
  ])("accepts a no entity selection reply", (reply) => {
    expect(isNoEntitySelectionReply(reply)).toBe(true);
  });

  it("does not treat other RCON replies as an empty selection", () => {
    expect(isNoEntitySelectionReply("unexpected reply")).toBe(false);
  });
});

describe("death recovery visible candidate count", () => {
  it.each([
    [0, "0"],
    [1, "1"],
    [2, "2+"],
    [99, "2+"],
  ] as const)("safely buckets candidate count %i", (count, bucket) => {
    expect(safeEntityCountBucket(count)).toBe(bucket);
  });
});
