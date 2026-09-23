import { describe, expect, it } from "vitest";

import { summarizeRuntimeReassessments } from "../../src/observability/runtime-reassessment-summary.js";

describe("runtime reassessment summary", () => {
  it("correlates gate decisions and trace counts without exposing raw values", () => {
    const at = Date.parse("2026-09-23T00:00:00.000Z");
    const log = (outcome: string, reason = "none", time = at) =>
      JSON.stringify({
        time,
        code: "RUNTIME_REASSESSMENT_GATE_DECISION",
        event: "safety_stabilized",
        cause: "reflex:hostile",
        outcome,
        reason,
        privateMessage: "secret-chat-text",
      });
    const result = summarizeRuntimeReassessments(
      [
        log("accepted"),
        log("started"),
        log("completed"),
        log("suppressed", "unchanged_state"),
        log("suppressed", "unchanged_state", at - 1),
        JSON.stringify({
          ...JSON.parse(log("suppressed")),
          cause: "secret-id",
        }),
      ],
      [
        {
          event: "safety_stabilized",
          cause: "reflex:hostile",
          apiCalls: 2,
          speeches: 1,
        },
        { event: "secret-event", cause: "secret-id", apiCalls: 1, speeches: 0 },
      ],
      at,
    );
    expect(result).toEqual([
      {
        event: "other",
        cause: "other",
        accepted: 0,
        started: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        suppressed: {},
        tracedRuns: 1,
        apiCalls: 1,
        speeches: 0,
      },
      {
        event: "safety_stabilized",
        cause: "other",
        accepted: 0,
        started: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        suppressed: { other: 1 },
        tracedRuns: 0,
        apiCalls: 0,
        speeches: 0,
      },
      {
        event: "safety_stabilized",
        cause: "reflex:hostile",
        accepted: 1,
        started: 1,
        completed: 1,
        failed: 0,
        cancelled: 0,
        suppressed: { unchanged_state: 1 },
        tracedRuns: 1,
        apiCalls: 2,
        speeches: 1,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
