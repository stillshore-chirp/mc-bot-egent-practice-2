import { describe, expect, it } from "vitest";

import {
  gatherMultiTargetItemCountSafeEvidence,
  gatherMultiTargetOracleProbeBaselineCountFailureFields,
  gatherMultiTargetPostBirchProgressSinceGoalAcceptance,
  gatherMultiTargetOracleProbeResultCountFailureFields,
  parseGatherMultiTargetInventoryReply,
  parseGatherMultiTargetInventoryReplyDetailed,
  readGatherMultiTargetItemCounts,
  readGatherMultiTargetInventory,
} from "../e2e/gather-multi-target-acceptance.js";

describe("multi-target gather inventory oracle", () => {
  it("requires new birch inventory after goal acceptance and a later Body outcome", () => {
    const acceptedAfterPriorPickup = {
      reason: "parsed",
      parseStage: "parsed",
      counts: { oak_log: 1, birch_log: 1 },
    } as const;
    const unchanged = {
      ...acceptedAfterPriorPickup,
      counts: { oak_log: 1, birch_log: 1 },
    } as const;
    const gainedAfterAcceptance = {
      ...acceptedAfterPriorPickup,
      counts: { oak_log: 1, birch_log: 2 },
    } as const;
    const unknown = {
      reason: "response_unrecognized",
      parseStage: "response_unrecognized",
      counts: { oak_log: 1, birch_log: null },
    } as const;

    expect(
      gatherMultiTargetPostBirchProgressSinceGoalAcceptance(
        acceptedAfterPriorPickup,
        unchanged,
        2,
      ),
    ).toEqual({ birchDelta: 0, confirmed: false });
    expect(
      gatherMultiTargetPostBirchProgressSinceGoalAcceptance(
        acceptedAfterPriorPickup,
        gainedAfterAcceptance,
        0,
      ),
    ).toEqual({ birchDelta: 1, confirmed: false });
    expect(
      gatherMultiTargetPostBirchProgressSinceGoalAcceptance(
        acceptedAfterPriorPickup,
        gainedAfterAcceptance,
        1,
      ),
    ).toEqual({ birchDelta: 1, confirmed: true });
    expect(
      gatherMultiTargetPostBirchProgressSinceGoalAcceptance(
        acceptedAfterPriorPickup,
        unknown,
        1,
      ),
    ).toEqual({ birchDelta: null, confirmed: false });
    expect(
      gatherMultiTargetPostBirchProgressSinceGoalAcceptance(
        unknown,
        gainedAfterAcceptance,
        1,
      ),
    ).toEqual({ birchDelta: null, confirmed: false });
  });

  it("parses top-level target stacks regardless of field order and NBT suffix", () => {
    expect(
      parseGatherMultiTargetInventoryReply(
        'entity data: [{id:"minecraft:oak_log",count:2b,Slot:0b},{Count:3,id:"minecraft:birch_log",Slot:1b}]',
      ),
    ).toEqual({ oak_log: 2, birch_log: 3 });
  });

  it("sums separate top-level stacks of the same target item", () => {
    expect(
      parseGatherMultiTargetInventoryReply(
        'entity data: [{id:"minecraft:oak_log",Count:2b,Slot:0b},{Slot:1b,count:3,id:"minecraft:oak_log"},{id:"minecraft:birch_log",count:1}]',
      ),
    ).toEqual({ oak_log: 5, birch_log: 1 });
  });

  it("reads exact non-mutating clear-count feedback for both target items", async () => {
    const result = await readGatherMultiTargetItemCounts(
      async (item) =>
        item === "oak_log"
          ? "Found 7 matching item(s) on player test_bot"
          : "No items were found on player test_bot",
      "test_bot",
    );

    expect(result).toEqual({
      reason: "parsed",
      parseStage: "parsed",
      counts: { oak_log: 7, birch_log: 0 },
    });
  });

  it("keeps an unrecognized target count unknown without discarding a known count", async () => {
    const result = await readGatherMultiTargetItemCounts(
      async (item) =>
        item === "oak_log"
          ? "Found 7 matching item(s) on player test_bot"
          : "No items were found on player another_bot",
      "test_bot",
    );

    expect(result).toEqual({
      reason: "response_unrecognized",
      parseStage: "response_unrecognized",
      counts: { oak_log: 7, birch_log: null },
    });
    expect(JSON.stringify(result)).not.toContain("another_bot");
  });

  it("keeps the scalar probe unknown when either item read is unrecognized", async () => {
    const baseline = await readGatherMultiTargetItemCounts(
      async (item) =>
        item === "oak_log"
          ? "Found 64 matching item(s) on player test_bot"
          : "No items were found on player test_bot",
      "test_bot",
    );
    const final = await readGatherMultiTargetItemCounts(
      async (item) =>
        item === "oak_log"
          ? "Found 65 matching item(s) on player test_bot"
          : "unexpected response",
      "test_bot",
    );

    expect(
      gatherMultiTargetOracleProbeBaselineCountFailureFields(baseline),
    ).toEqual([]);
    expect(
      gatherMultiTargetOracleProbeResultCountFailureFields(final, 0),
    ).toEqual(["inventory_read"]);
    expect(
      gatherMultiTargetItemCountSafeEvidence("Final", final),
    ).toMatchObject({
      gatherOracleProbeFinalInventoryReadReason: "response_unrecognized",
      gatherOracleProbeFinalOakCount: 65,
      gatherOracleProbeFinalBirchCount: null,
      gatherOracleProbeFinalOakStackCount: null,
      gatherOracleProbeFinalBirchStackCount: null,
    });
  });

  it("does not count target names inside nested component text", () => {
    expect(
      parseGatherMultiTargetInventoryReply(
        `entity data: [{components:{"minecraft:custom_name":'{"text":"minecraft:birch_log, count:99"}'},id:"minecraft:oak_log",count:2},{id:"minecraft:stone",count:1,display:{Name:'oak_log minecraft:birch_log'}}]`,
      ),
    ).toEqual({ oak_log: 2, birch_log: 0 });
  });

  it("returns fixed unknown classifications for failed, missing, invalid, and truncated reads", async () => {
    const readFailed = await readGatherMultiTargetInventory(async () => {
      throw new Error("synthetic-rcon-sentinel");
    });
    const commandRejected = await readGatherMultiTargetInventory(
      async () => "Unknown command: synthetic-rcon-sentinel",
    );
    const markerMissing = parseGatherMultiTargetInventoryReplyDetailed(
      "synthetic-rcon-sentinel",
    );
    const countInvalid = parseGatherMultiTargetInventoryReplyDetailed(
      'Entity data: [{id:"minecraft:oak_log",count:"1"}]',
    );
    const truncated = parseGatherMultiTargetInventoryReplyDetailed(
      'Entity data: [{id:"minecraft:oak_log",count:1',
    );

    expect([
      readFailed.reason,
      commandRejected.reason,
      markerMissing.reason,
      countInvalid.reason,
      truncated.reason,
    ]).toEqual([
      "read_failed",
      "command_rejected",
      "marker_missing",
      "target_count_invalid",
      "structure_invalid",
    ]);
    expect(truncated.parseStage).toBe("response_truncated_possible");
    expect(
      JSON.stringify({
        readFailed,
        commandRejected,
        markerMissing,
        countInvalid,
        truncated,
      }),
    ).not.toContain("synthetic-rcon-sentinel");
  });
});
