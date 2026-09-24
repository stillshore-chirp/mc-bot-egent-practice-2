import { describe, expect, it } from "vitest";

import { projectPlayerSnapshot } from "./player-snapshot-sidecar.js";

describe("projectPlayerSnapshot", () => {
  it("copies only the allowlisted top-level fields and bounds arrays", () => {
    const source = {
      purpose: "Find the target",
      goals: Array.from({ length: 25 }, (_, index) => ({ index })),
      recentJudgments: [{ summary: "continue" }],
      recentOutcomes: [{ kind: "look", status: "successful" }],
      activeOperation: { operationId: "private-id", kind: "move_to" },
      proposals: [{ title: "proposal" }],
      lastObservation: { visibleBlockNames: ["stone"] },
      counters: { llmCalls: 5 },
      recentAgentActivity: [{ round: 2 }],
    };

    const projected = projectPlayerSnapshot(source);

    expect(Object.keys(projected).sort()).toEqual([
      "activeOperation",
      "goals",
      "lastObservation",
      "proposals",
      "purpose",
      "recentJudgments",
      "recentOutcomes",
    ]);
    expect(projected.goals).toHaveLength(20);
    const firstGoal = projected.goals[0];
    expect(firstGoal).toEqual({ index: 5 });
    expect(projected).not.toHaveProperty("counters");
    expect(projected).not.toHaveProperty("recentAgentActivity");
  });

  it("deep-copies selected values so later snapshot mutation cannot alter evidence", () => {
    const source = {
      purpose: "Find the target",
      goals: [{ title: "Explore" }],
    };

    const projected = projectPlayerSnapshot(source);
    const sourceGoal = source.goals[0];
    if (sourceGoal === undefined) throw new Error("fixture goal missing");
    sourceGoal.title = "Changed";

    expect(projected.goals[0]).toEqual({ title: "Explore" });
  });
});
