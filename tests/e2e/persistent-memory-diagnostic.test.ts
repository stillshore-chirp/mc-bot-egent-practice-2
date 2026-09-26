import { describe, expect, it } from "vitest";

import type { PlayerAgentRoundActivity } from "../../src/player/responses.js";
import {
  inspectPersistentMemoryProgress,
  maxAgentActivityRunSequence,
} from "./persistent-memory-diagnostic.js";

function activity(input: {
  readonly runSequence: number;
  readonly functionCallCount?: number;
  readonly toolCalls?: PlayerAgentRoundActivity["toolCalls"];
}): PlayerAgentRoundActivity {
  return {
    runSequence: input.runSequence,
    role: "conversation",
    round: 1,
    responseStatus: "completed",
    processingStatus: "complete",
    inputTokens: 20,
    outputTokens: 4,
    latencyMs: 12,
    requestInputChars: 80,
    initialInputChars: 80,
    instructionsChars: 20,
    toolSchemaChars: 40,
    initialObservationChars: 0,
    responseOutputChars: 10,
    functionCallCount: input.functionCallCount ?? 0,
    compactionItemPresent: false,
    toolCalls: input.toolCalls ?? [],
  };
}

describe("persistent memory diagnostics", () => {
  it("uses the maximum run sequence when activity completion order is out of order", () => {
    const activityInCompletionOrder = [
      activity({ runSequence: 6 }),
      activity({ runSequence: 5 }),
    ];

    expect(maxAgentActivityRunSequence(activityInCompletionOrder)).toBe(6);
    expect(
      inspectPersistentMemoryProgress({
        activity: activityInCompletionOrder,
        afterRunSequence: maxAgentActivityRunSequence(
          activityInCompletionOrder,
        ),
        ownerReplyObserved: false,
        factPersisted: false,
      }).stage,
    ).toBe("waiting_for_conversation");
  });

  it("identifies a completed owner reply that never called the save tool", () => {
    const result = inspectPersistentMemoryProgress({
      activity: [activity({ runSequence: 2 })],
      afterRunSequence: 1,
      ownerReplyObserved: true,
      factPersisted: false,
    });

    expect(result).toEqual({
      stage: "conversation_finished_without_save_tool",
      ownerReplyObserved: true,
      rememberToolCalled: false,
      rememberToolResult: "none",
      factPersisted: false,
    });
    expect(result).not.toHaveProperty("runSequence");
  });

  it("waits for the request's owner reply before declaring a completed reply omitted the tool", () => {
    const withoutReply = inspectPersistentMemoryProgress({
      activity: [activity({ runSequence: 2 })],
      afterRunSequence: 1,
      ownerReplyObserved: false,
      factPersisted: false,
    });
    const withReply = inspectPersistentMemoryProgress({
      activity: [activity({ runSequence: 2 })],
      afterRunSequence: 1,
      ownerReplyObserved: true,
      factPersisted: false,
    });

    expect(withoutReply.stage).toBe("conversation_in_progress");
    expect(withReply.stage).toBe("conversation_finished_without_save_tool");
  });

  it("keeps pending replies in progress and distinguishes a rejected save", () => {
    const inProgress = inspectPersistentMemoryProgress({
      activity: [activity({ runSequence: 2, functionCallCount: 1 })],
      afterRunSequence: 1,
      ownerReplyObserved: false,
      factPersisted: false,
    });
    const rejected = inspectPersistentMemoryProgress({
      activity: [
        activity({
          runSequence: 2,
          functionCallCount: 1,
          toolCalls: [
            {
              name: "remember_owner_fact",
              resultClass: "rejected",
              outputChars: 12,
            },
          ],
        }),
      ],
      afterRunSequence: 1,
      ownerReplyObserved: true,
      factPersisted: false,
    });

    expect(inProgress.stage).toBe("conversation_in_progress");
    expect(rejected.stage).toBe("save_tool_rejected");
    expect(rejected.rememberToolCalled).toBe(true);
  });

  it("marks persistence only from the database observation", () => {
    const result = inspectPersistentMemoryProgress({
      activity: [activity({ runSequence: 2 })],
      afterRunSequence: 1,
      ownerReplyObserved: false,
      factPersisted: true,
    });

    expect(result.stage).toBe("fact_persisted_before_restart");
    expect(result.factPersisted).toBe(true);
  });
});
