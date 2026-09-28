import { describe, expect, it } from "vitest";

import {
  parseGatherMultiTargetInventoryReplyDetailed,
  readGatherMultiTargetInventory,
} from "./gather-multi-target-acceptance.js";

describe("gather multi-target inventory oracle", () => {
  it("sums target quantities and counts matching stacks independently", () => {
    const result = parseGatherMultiTargetInventoryReplyDetailed(
      'Synthetic entity data: [{id:"minecraft:oak_log",count:64b},{id:"minecraft:oak_log",count:1b},{id:"minecraft:birch_log",count:3b},{id:"minecraft:dirt",count:12b}]',
    );

    expect(result).toEqual({
      reason: "parsed",
      parseStage: "parsed",
      counts: { oak_log: 65, birch_log: 3 },
      stackCounts: { oak_log: 2, birch_log: 1 },
    });
  });

  it("keeps unavailable or malformed inventory distinct from an empty inventory", async () => {
    await expect(
      readGatherMultiTargetInventory(async () => {
        throw new Error("read failed");
      }),
    ).resolves.toEqual({ reason: "read_failed", parseStage: "not_parsed" });

    expect(
      parseGatherMultiTargetInventoryReplyDetailed(
        'Synthetic entity data: [{id:"minecraft:oak_log",count:"64"}]',
      ),
    ).toEqual({
      reason: "target_count_invalid",
      parseStage: "target_count_invalid",
    });
  });
});
