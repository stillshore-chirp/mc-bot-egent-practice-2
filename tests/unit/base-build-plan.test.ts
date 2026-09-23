import { describe, expect, it } from "vitest";
import {
  baseBuildMaxBlocks,
  buildBlockKey,
  buildPlan,
  buildSiteCandidates,
  groundSuitable,
  placementState,
  siteClearOfPlayers,
} from "../../src/skills/base-build-plan.js";
import { createSnapshot } from "../support/fake-minecraft.js";

describe("bounded base plan", () => {
  it("makes one supported shelter with an open entrance", () => {
    const plan = buildPlan(
      { x: 4, y: 64, z: 0 },
      "overworld",
      {
        x: 0,
        y: 64,
        z: 0,
      },
      "00000000-0000-4000-8000-000000000001",
    );
    expect(plan.blocks).toHaveLength(baseBuildMaxBlocks);
    expect(new Set(plan.blocks.map(buildBlockKey)).size).toBe(
      baseBuildMaxBlocks,
    );
    expect(plan.blocks.some((block) => buildBlockKey(block) === "3:64:0")).toBe(
      false,
    );
    expect(plan.blocks.some((block) => buildBlockKey(block) === "3:65:0")).toBe(
      false,
    );
    expect(plan.blocks.at(-1)).toEqual({ x: 4, y: 66, z: 0 });
  });

  it("avoids building around an observed player", () => {
    const snapshot = createSnapshot();
    const [current, nearby] = buildSiteCandidates(snapshot);
    if (current === undefined || nearby === undefined)
      throw new Error("missing candidate");
    expect(siteClearOfPlayers(snapshot, current)).toBe(false);
    expect(siteClearOfPlayers(snapshot, nearby)).toBe(true);
  });

  it("counts only previously verified matching blocks on resume", () => {
    const matching = {
      name: "oak_planks",
      serverConfirmed: true,
      placementAllowed: false,
    };
    expect(placementState(matching, "oak_planks", false)).toBe("blocked");
    expect(placementState(matching, "oak_planks", true)).toBe("verified");
    expect(
      placementState(
        { name: "air", serverConfirmed: true, placementAllowed: false },
        "oak_planks",
        false,
      ),
    ).toBe("blocked");
    expect(
      groundSuitable({
        name: "grass_block",
        serverConfirmed: true,
        placementAllowed: false,
      }),
    ).toBe(true);
    expect(
      groundSuitable({
        name: "oak_planks",
        serverConfirmed: true,
        placementAllowed: false,
      }),
    ).toBe(false);
  });
});
