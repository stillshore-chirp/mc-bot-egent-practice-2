import { describe, expect, it } from "vitest";

import {
  parseGatherMultiTargetInventoryReply,
  parseGatherMultiTargetInventoryReplyDetailed,
  readGatherMultiTargetInventory,
} from "../e2e/gather-multi-target-acceptance.js";

describe("multi-target gather inventory oracle", () => {
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
