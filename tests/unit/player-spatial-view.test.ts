import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PlayerBodyObservation } from "../../src/minecraft/player-body.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import { toSpatialView } from "../../src/player/spatial-view.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("visibility-bounded spatial views", () => {
  it("keeps observed block bounds and labels them as a visible subset", () => {
    const view = toSpatialView(
      observation({
        blocks: [
          block("stone", 2, 64, -2),
          block("stone", 2, 67, 2),
          block("water", 5, 64, 0),
        ],
      }),
    );

    expect(view).toMatchObject({
      selfCell: { x: 0, y: 64, z: 0 },
      facingCardinal: "east",
      coverage: "visible_subset",
      candidateSearchMayBeTruncated: true,
      omittedBlockCandidates: 3,
      visibleBlockBounds: [
        { name: "stone", count: 2, x: [2, 2], y: [64, 67], z: [-2, 2] },
        { name: "water", count: 1, x: [5, 5], y: [64, 64], z: [0, 0] },
      ],
    });
    expect(JSON.stringify(view)).not.toContain("ownerPositionException");
  });

  it("deduplicates the same viewpoint, bounds history, and restores it after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "player-spatial-view-"));
    directories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    try {
      const first = toSpatialView(observation());
      if (first === undefined) throw new Error("test view missing");
      mind.recordSpatialView(first);
      mind.recordSpatialView({
        ...first,
        observedAt: "2026-09-25T00:00:01.000Z",
      });
      expect(mind.recentSpatialViews()).toHaveLength(1);
      for (let x = 1; x <= 8; x += 1)
        mind.recordSpatialView({ ...first, selfCell: { x, y: 64, z: 0 } });
      expect(mind.recentSpatialViews()).toHaveLength(7);
      expect(mind.recentSpatialViews()[0]?.selfCell.x).toBe(2);
      expect(JSON.stringify(mind.snapshot())).not.toContain(
        "visibleBlockBounds",
      );
    } finally {
      mind.close();
    }
    const reopened = PlayerMindStore.open(databasePath);
    try {
      expect(reopened.recentSpatialViews()).toHaveLength(7);
      expect(reopened.recentSpatialViews().at(-1)?.selfCell.x).toBe(8);
    } finally {
      reopened.close();
    }
  });
});

function block(name: string, x: number, y: number, z: number) {
  return { name, position: { x, y, z, dimension: "overworld" } };
}

function observation(input: { blocks?: ReturnType<typeof block>[] } = {}) {
  return {
    observedAt: "2026-09-25T00:00:00.000Z",
    dimension: "overworld",
    self: {
      position: { x: 0.5, y: 64, z: 0.5 },
      yaw: -Math.PI / 2,
    },
    perception: {
      blocks: input.blocks ?? [],
      candidateSearchMayBeTruncated: true,
      omittedBlockCandidates: 3,
    },
  } as unknown as PlayerBodyObservation;
}
