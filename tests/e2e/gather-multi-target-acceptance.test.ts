import { describe, expect, it } from "vitest";

import {
  gatherMultiTargetBodySmokeSafeFailureEvidence,
  shouldRunGatherMultiTargetOracleProbe,
  gatherMultiTargetInventorySafeEvidence,
  gatherMultiTargetOracleProbeBaselineFailureFields,
  gatherMultiTargetOracleProbeResultFailureFields,
  parseGatherMultiTargetInventoryReplyDetailed,
  readGatherMultiTargetInventory,
} from "./gather-multi-target-acceptance.js";

describe("gather multi-target probe routing", () => {
  it("runs the strict probe only for an explicit matching diagnostic", () => {
    expect(
      shouldRunGatherMultiTargetOracleProbe(
        "gather_multi_target_continuity",
        "YES",
      ),
    ).toBe(true);
    expect(
      shouldRunGatherMultiTargetOracleProbe(
        "gather_multi_target_continuity",
        undefined,
      ),
    ).toBe(false);
    expect(
      shouldRunGatherMultiTargetOracleProbe("food_intent_continuity", "YES"),
    ).toBe(false);
  });
});

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

  it("preserves unknown probe counts and reports only confirmed failures", () => {
    const unreadable = {
      reason: "structure_invalid",
      parseStage: "root_invalid",
    } as const;
    const unreadableEvidence = gatherMultiTargetInventorySafeEvidence(
      "Final",
      unreadable,
    );

    expect(unreadableEvidence).toEqual({
      gatherOracleProbeFinalInventoryReadReason: "structure_invalid",
      gatherOracleProbeFinalInventoryParseStage: "root_invalid",
      gatherOracleProbeFinalOakCount: null,
      gatherOracleProbeFinalBirchCount: null,
      gatherOracleProbeFinalOakStackCount: null,
      gatherOracleProbeFinalBirchStackCount: null,
    });
    expect(
      gatherMultiTargetOracleProbeBaselineFailureFields(unreadable),
    ).toEqual(["inventory_read"]);
    expect(
      gatherMultiTargetOracleProbeResultFailureFields(unreadable, 0),
    ).toEqual(["inventory_read"]);
    expect(
      gatherMultiTargetInventorySafeEvidence("Final", undefined),
    ).toMatchObject({
      gatherOracleProbeFinalInventoryReadReason: "not_read",
      gatherOracleProbeFinalInventoryParseStage: "not_parsed",
      gatherOracleProbeFinalOakCount: null,
      gatherOracleProbeFinalBirchCount: null,
    });
    expect(
      gatherMultiTargetOracleProbeResultFailureFields(undefined, 0),
    ).toEqual(["inventory_read"]);

    const parsedEmpty = {
      reason: "parsed",
      parseStage: "parsed",
      counts: { oak_log: 0, birch_log: 0 },
      stackCounts: { oak_log: 0, birch_log: 0 },
    } as const;
    expect(
      gatherMultiTargetInventorySafeEvidence("Final", parsedEmpty),
    ).toMatchObject({
      gatherOracleProbeFinalOakCount: 0,
      gatherOracleProbeFinalBirchCount: 0,
      gatherOracleProbeFinalOakStackCount: 0,
    });
    expect(
      gatherMultiTargetOracleProbeResultFailureFields(parsedEmpty, 0),
    ).toEqual(["oak_count", "oak_stack_count"]);
  });

  it("keeps the existing baseline, two-stack, and drop acceptance thresholds", () => {
    const baseline = {
      reason: "parsed",
      parseStage: "parsed",
      counts: { oak_log: 64, birch_log: 0 },
      stackCounts: { oak_log: 1, birch_log: 0 },
    } as const;
    const final = {
      reason: "parsed",
      parseStage: "parsed",
      counts: { oak_log: 65, birch_log: 0 },
      stackCounts: { oak_log: 2, birch_log: 0 },
    } as const;

    expect(gatherMultiTargetOracleProbeBaselineFailureFields(baseline)).toEqual(
      [],
    );
    expect(gatherMultiTargetOracleProbeResultFailureFields(final, 0)).toEqual(
      [],
    );
    expect(gatherMultiTargetOracleProbeResultFailureFields(final, 1)).toEqual([
      "drop_after_collection",
    ]);
  });

  it("retains probe evidence on the matching Body smoke failure only", () => {
    const diagnostic = {
      gatherOracleProbeFinalInventoryReadReason: "structure_invalid",
      gatherOracleProbeFinalOakCount: null,
      gatherOracleProbeResultMismatchFields: "inventory_read",
    } as const;

    expect(
      gatherMultiTargetBodySmokeSafeFailureEvidence(
        "body_operation_smoke",
        "gather_multi_target_continuity",
        diagnostic,
      ),
    ).toEqual(diagnostic);
    expect(
      gatherMultiTargetBodySmokeSafeFailureEvidence(
        "gather_multi_target_continuity",
        "gather_multi_target_continuity",
        diagnostic,
      ),
    ).toEqual({});
    expect(
      gatherMultiTargetBodySmokeSafeFailureEvidence(
        "body_operation_smoke",
        "other_case",
        diagnostic,
      ),
    ).toEqual({});
  });
});
