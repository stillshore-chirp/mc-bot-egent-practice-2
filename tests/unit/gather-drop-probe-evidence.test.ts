import { describe, expect, it } from "vitest";
import type {
  PlayerOperation,
  PlayerOperationResult,
} from "../../src/minecraft/player-body.js";
import type { PlayerBodyObservation } from "../../src/minecraft/player-body-observation.js";

import {
  bucketGatherDropProbeCount,
  bucketGatherDropProbeFacing,
  bucketGatherDropProbePosition,
  createGatherDropProbeCapture,
  flattenGatherDropProbeEvidence,
  gatherDropProbeTwoStackInventoryEvidence,
  installScopedExecuteProbe,
  projectGatherOperationBodyTransition,
  withScopedExecuteProbeRestoration,
} from "../e2e/gather-drop-probe-evidence.js";

const origin = { x: 0, y: 64, z: 0 };
const target = { x: 1.5, y: 64.5, z: -4.5 };

describe("gather drop probe public evidence buckets", () => {
  it("retains only coarse position classes", () => {
    expect(bucketGatherDropProbePosition(origin, origin, target)).toBe(
      "origin",
    );
    expect(
      bucketGatherDropProbePosition({ x: 1.5, y: 64.5, z: -3 }, origin, target),
    ).toBe("target_area");
    expect(
      bucketGatherDropProbePosition({ x: 0, y: 64, z: -7 }, origin, target),
    ).toBe("fixture_area");
    expect(
      bucketGatherDropProbePosition({ x: 40, y: 64, z: 40 }, origin, target),
    ).toBe("outside_fixture_area");
    expect(bucketGatherDropProbePosition(undefined, origin, target)).toBe(
      "unknown",
    );
  });

  it("buckets angle drift across wraparound", () => {
    expect(bucketGatherDropProbeFacing(179, -179, "degrees")).toBe("unchanged");
    expect(bucketGatherDropProbeFacing(0, Math.PI / 2, "radians")).toBe(
      "changed",
    );
    expect(bucketGatherDropProbeFacing(undefined, 0, "radians")).toBe(
      "unknown",
    );
  });

  it("classifies counts without retaining values", () => {
    expect(bucketGatherDropProbeCount(0)).toBe("zero");
    expect(bucketGatherDropProbeCount(1)).toBe("one_or_more");
    expect(bucketGatherDropProbeCount(undefined)).toBe("unknown");
    expect(bucketGatherDropProbeCount(-1)).toBe("unknown");
  });

  it("classifies the opt-in two-stack seed and post-collection deltas", () => {
    const evidence = gatherDropProbeTwoStackInventoryEvidence({
      seedBody: { oak_log: 1, birch_log: 0 },
      seedRcon: { oak_log: 1, birch_log: 0 },
      seedRconReadReason: "parsed",
      seedRconParseStage: "parsed",
      afterBody: { oak_log: 1, birch_log: 1 },
      afterRcon: { oak_log: 1, birch_log: 1 },
      afterRconReadReason: "parsed",
      afterRconParseStage: "parsed",
    });
    expect(evidence).toEqual({
      seedBody: { oak: "one", birch: "zero", confirmed: true },
      seedRcon: { oak: "one", birch: "zero", confirmed: true },
      seedRconReadReason: "parsed",
      seedRconParseStage: "parsed",
      afterBody: {
        oakDelta: "unchanged",
        birchDelta: "increased_by_one",
        confirmed: true,
      },
      afterRcon: {
        oakDelta: "unchanged",
        birchDelta: "increased_by_one",
        confirmed: true,
      },
      afterRconReadReason: "parsed",
      afterRconParseStage: "parsed",
    });
    expect(JSON.stringify(evidence)).not.toContain('"oak_log"');
    expect(JSON.stringify(evidence)).not.toContain('"birch_log"');
  });

  it("keeps an unexpected or unavailable two-stack transition distinct", () => {
    const evidence = gatherDropProbeTwoStackInventoryEvidence({
      seedBody: { oak_log: 2, birch_log: 0 },
      seedRcon: { oak_log: 1, birch_log: 0 },
      afterBody: { oak_log: 2, birch_log: 1 },
      seedRconReadReason: "parsed",
      seedRconParseStage: "parsed",
      afterRconReadReason: "structure_invalid",
      afterRconParseStage: "nested_token_invalid",
    });
    expect(evidence).toMatchObject({
      seedBody: { oak: "multiple", birch: "zero", confirmed: false },
      seedRcon: { oak: "one", birch: "zero", confirmed: true },
      afterBody: {
        oakDelta: "unchanged",
        birchDelta: "increased_by_one",
        confirmed: false,
      },
      afterRcon: {
        oakDelta: "unknown",
        birchDelta: "unknown",
        confirmed: false,
      },
      afterRconReadReason: "structure_invalid",
      afterRconParseStage: "nested_token_invalid",
    });
  });

  it("projects before and after Body observations to safe buckets", () => {
    const transition = projectGatherOperationBodyTransition({
      before: bodyObservation({
        position: origin,
        birchCount: 0,
        visibleDrop: true,
        candidateSearchMayBeTruncated: true,
      }),
      after: bodyObservation({
        position: target,
        yaw: Math.PI / 2,
        birchCount: 1,
        visibleBirchBlock: true,
      }),
      origin,
      target,
      requestedEntityId: 987654,
    });

    expect(transition).toMatchObject({
      before: {
        observed: true,
        position: "origin",
        birchBlockVisible: false,
        nearbyDropCount: "single",
        requestedDropVisible: true,
        candidateSearchMayBeTruncated: true,
        birchInventoryCount: "zero",
      },
      after: {
        observed: true,
        position: "target_area",
        birchBlockVisible: true,
        nearbyDropCount: "none",
        birchInventoryCount: "one_or_more",
      },
      facingChange: "changed",
      birchInventoryDelta: "increased",
    });
    expect(JSON.stringify(transition)).not.toContain("PRIVATE_PLAYER");
    expect(JSON.stringify(transition)).not.toContain("987654");
    expect(JSON.stringify(transition)).not.toContain("101.25");
  });

  it("captures at most four scoped execute results and restores the exact method", async () => {
    const before = bodyObservation({ position: origin, birchCount: 0 });
    const after = bodyObservation({ position: target, birchCount: 1 });
    const prototype = {
      async execute(
        operation: PlayerOperation,
      ): Promise<PlayerOperationResult> {
        return {
          operationId: "PRIVATE_OPERATION_ID",
          operation,
          status: operation.kind === "collect_item" ? "failed" : "successful",
          startedAt: "2026-09-27T00:00:00.000Z",
          completedAt: "2026-09-27T00:00:01.000Z",
          before,
          after,
          recoveryRequired: false,
          detail: "PRIVATE_OPERATION_DETAIL",
          ...(operation.kind === "collect_item"
            ? {
                itemCollectionOutcome: "target_unobservable" as const,
                itemCollectionPathFailureReason: "path_timeout" as const,
              }
            : {}),
        };
      },
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "execute",
    );
    const capture = createGatherDropProbeCapture({ origin, target });
    const restore = installScopedExecuteProbe(prototype, () => capture);
    const execute = prototype.execute.bind(prototype);
    const dig: PlayerOperation = {
      kind: "dig",
      position: target,
    };
    const unrelatedDig: PlayerOperation = {
      kind: "dig",
      position: { x: target.x + 1, y: target.y, z: target.z },
    };
    const collect: PlayerOperation = { kind: "collect_item", entityId: 987654 };

    try {
      await execute(dig);
      expect(capture.snapshot()).toHaveLength(0);
      capture.enable();
      await execute(dig);
      await execute(collect);
      await execute(unrelatedDig);
      await execute(collect);
      await execute(dig);
      expect(() => installScopedExecuteProbe(prototype, () => capture)).toThrow(
        "execute method is already wrapped",
      );
      expect(capture.snapshot()).toHaveLength(4);
    } finally {
      capture.disable();
      restore();
      restore();
    }

    expect(Object.getOwnPropertyDescriptor(prototype, "execute")).toEqual(
      originalDescriptor,
    );
    const safeEvidence = flattenGatherDropProbeEvidence(
      capture.snapshot(),
      capture.counts(),
    );
    expect(safeEvidence).toMatchObject({
      bodyExecuteProbeOperationCount: 4,
      bodyExecuteProbeAttemptedCount: 5,
      bodyExecuteProbeRecordedCount: 4,
      bodyExecuteProbeOverflowCount: 1,
      bodyExecuteProbeUnrecordedCount: 0,
      bodyExecuteProbe1OperationKind: "dig",
      bodyExecuteProbe1TargetMatchesFixtureTarget: true,
      bodyExecuteProbe1Status: "successful",
      bodyExecuteProbe2OperationKind: "collect_item",
      bodyExecuteProbe2Status: "failed",
      bodyExecuteProbe2ItemCollectionOutcome: "target_unobservable",
      bodyExecuteProbe2PathFailureReason: "path_timeout",
      bodyExecuteProbe2BeforeBirchInventoryCount: "zero",
      bodyExecuteProbe2AfterBirchInventoryCount: "one_or_more",
      bodyExecuteProbe3TargetMatchesFixtureTarget: false,
    });
    const serialized = JSON.stringify(safeEvidence);
    expect(serialized).not.toContain("PRIVATE_OPERATION_ID");
    expect(serialized).not.toContain("PRIVATE_OPERATION_DETAIL");
    expect(serialized).not.toContain("PRIVATE_PLAYER");
    expect(serialized).not.toContain("987654");
    expect(serialized).not.toContain("2.5");
  });

  it("restores after record errors and failed evidence flattening", async () => {
    const operation: PlayerOperation = {
      kind: "collect_item",
      entityId: 987654,
    };
    const result: PlayerOperationResult = {
      operationId: "PRIVATE_OPERATION_ID",
      operation,
      status: "failed",
      startedAt: "2026-09-27T00:00:00.000Z",
      completedAt: "2026-09-27T00:00:01.000Z",
      before: null,
      after: null,
      recoveryRequired: false,
    };
    const prototype = {
      async execute(
        _operation: PlayerOperation,
      ): Promise<PlayerOperationResult> {
        return result;
      },
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "execute",
    );
    let recordAttempted = false;
    const restore = installScopedExecuteProbe(prototype, () => ({
      shouldCapture: () => true,
      record: () => {
        recordAttempted = true;
        throw new Error("synthetic evidence recorder failure");
      },
    }));

    await expect(
      withScopedExecuteProbeRestoration(restore, async () => {
        const returned = await prototype.execute(operation);
        expect(returned).toBe(result);
        expect(recordAttempted).toBe(true);
        flattenGatherDropProbeEvidence(null as unknown as readonly []);
      }),
    ).rejects.toThrow();
    expect(Object.getOwnPropertyDescriptor(prototype, "execute")).toEqual(
      originalDescriptor,
    );
  });
});

function bodyObservation(input: {
  readonly position: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly yaw?: number;
  readonly birchCount: number;
  readonly visibleBirchBlock?: boolean;
  readonly visibleDrop?: boolean;
  readonly candidateSearchMayBeTruncated?: boolean;
}): PlayerBodyObservation {
  return {
    self: {
      username: "PRIVATE_PLAYER",
      position: input.position,
      yaw: input.yaw ?? 0,
      inventory:
        input.birchCount === 0
          ? []
          : [{ name: "birch_log", count: input.birchCount }],
    },
    perception: {
      candidateSearchMayBeTruncated:
        input.candidateSearchMayBeTruncated ?? false,
      blocks: input.visibleBirchBlock
        ? [
            {
              name: "birch_log",
              position: target,
            },
          ]
        : [],
      entities: input.visibleDrop
        ? [
            {
              id: 987654,
              name: "item",
              position: target,
            },
          ]
        : [],
    },
  } as unknown as PlayerBodyObservation;
}
