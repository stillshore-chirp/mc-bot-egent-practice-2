import { describe, expect, it } from "vitest";

import {
  unknownDistanceImprovedByMinimum,
  recordUnknownTaskProgressSample,
  unknownDistanceBucket,
} from "./unknown-task-progress.js";

describe("unknown-task distance buckets", () => {
  it("keeps spawn-return evidence coarse at each bucket boundary", () => {
    expect(unknownDistanceBucket(0)).toBe("under_2");
    expect(unknownDistanceBucket(1.999)).toBe("under_2");
    expect(unknownDistanceBucket(2)).toBe("2_to_under_5");
    expect(unknownDistanceBucket(4.999)).toBe("2_to_under_5");
    expect(unknownDistanceBucket(5)).toBe("5_to_under_10");
    expect(unknownDistanceBucket(9.999)).toBe("5_to_under_10");
    expect(unknownDistanceBucket(10)).toBe("10_or_more");
    expect(unknownDistanceBucket(Number.NaN)).toBeUndefined();
  });

  it("uses the progress aggregate's minimum closer distance", () => {
    expect(unknownDistanceImprovedByMinimum(10, 9.749)).toBe(true);
    expect(unknownDistanceImprovedByMinimum(10, 9.75)).toBe(false);
    expect(unknownDistanceImprovedByMinimum(10, 9.8)).toBe(false);
  });
});

const startingPosition = { x: 0, y: 64, z: 0 };
const targetPosition = { x: 10, y: 64, z: 0 };
const beforeWorld = {
  position: startingPosition,
  blockRegionChanged: false,
  inventorySignature: "before",
};

function sample(
  currentPosition: { x: number; y: number; z: number },
  options: {
    taskSentAt?: number;
    sampledAt?: number;
    blockRegionChanged?: boolean;
    inventorySignature?: string;
  } = {},
) {
  return {
    taskSentAt: options.taskSentAt ?? 100,
    sampledAt: options.sampledAt ?? 101,
    startingPosition,
    targetPosition,
    currentPosition,
    beforeWorld,
    currentWorld: {
      position: currentPosition,
      blockRegionChanged: options.blockRegionChanged ?? false,
      inventorySignature: options.inventorySignature ?? "before",
    },
  };
}

describe("unknown task progress aggregate", () => {
  it("leaves missing and pre-task samples unknown", () => {
    expect(
      recordUnknownTaskProgressSample(undefined, {
        ...sample({ x: 1, y: 64, z: 0 }),
        taskSentAt: undefined,
      }),
    ).toBeUndefined();
    expect(
      recordUnknownTaskProgressSample(undefined, {
        ...sample({ x: 1, y: 64, z: 0 }),
        taskSentAt: Number.NaN,
      }),
    ).toBeUndefined();
    expect(
      recordUnknownTaskProgressSample(
        undefined,
        sample({ x: 1, y: 64, z: 0 }, { sampledAt: 100 }),
      ),
    ).toBeUndefined();
    expect(
      recordUnknownTaskProgressSample(
        undefined,
        sample({ x: Number.NaN, y: 64, z: 0 }),
      ),
    ).toBeUndefined();
  });

  it("buckets maximum displacement and nearest target distance across samples", () => {
    const first = recordUnknownTaskProgressSample(
      undefined,
      sample({ x: 3, y: 64, z: 0 }),
    );
    const second = recordUnknownTaskProgressSample(
      first,
      sample({ x: 8, y: 64, z: 0 }, { sampledAt: 102 }),
    );

    expect(second).toEqual({
      sampleCount: 2,
      sampleLimitReached: false,
      maxDisplacementBucket: "5_to_under_10",
      nearestTargetDistanceBucket: "2_to_under_5",
      movedCloserToTarget: true,
      blocksObserved: false,
      positionObserved: true,
      inventoryObserved: false,
    });
  });

  it("retains multiple independent progress kinds in one aggregate", () => {
    const aggregate = recordUnknownTaskProgressSample(
      undefined,
      sample(
        { x: 2, y: 64, z: 0 },
        { blockRegionChanged: true, inventorySignature: "after" },
      ),
    );

    expect(aggregate).toMatchObject({
      blocksObserved: true,
      positionObserved: true,
      inventoryObserved: true,
    });
  });

  it("saturates the count while continuing bounded aggregate updates", () => {
    let aggregate = recordUnknownTaskProgressSample(
      undefined,
      sample({ x: 1, y: 64, z: 0 }),
    );
    for (let index = 1; index < 64; index += 1) {
      aggregate = recordUnknownTaskProgressSample(
        aggregate,
        sample({ x: 1, y: 64, z: 0 }, { sampledAt: 101 + index }),
      );
    }
    aggregate = recordUnknownTaskProgressSample(
      aggregate,
      sample({ x: 10, y: 64, z: 0 }, { sampledAt: 200 }),
    );

    expect(aggregate).toMatchObject({
      sampleCount: 64,
      sampleLimitReached: true,
      maxDisplacementBucket: "10_or_more",
      nearestTargetDistanceBucket: "under_2",
      movedCloserToTarget: true,
    });
  });
});
