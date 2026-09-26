import type { PlayerAgentRoundActivity } from "../../src/player/responses.js";

export const persistentMemoryStages = [
  "request_sent",
  "waiting_for_conversation",
  "conversation_in_progress",
  "conversation_finished_without_save_tool",
  "save_tool_rejected",
  "save_tool_not_verified",
  "fact_persisted_before_restart",
] as const;

export type PersistentMemoryStage = (typeof persistentMemoryStages)[number];

export interface PersistentMemoryProgress {
  readonly stage: PersistentMemoryStage;
  readonly ownerReplyObserved: boolean;
  readonly rememberToolCalled: boolean;
  readonly rememberToolResult: "none" | "ok" | "rejected" | "error" | "unknown";
  readonly factPersisted: boolean;
}

export function maxAgentActivityRunSequence(
  activity: readonly PlayerAgentRoundActivity[],
): number {
  return activity.reduce(
    (maximum, item) => Math.max(maximum, item.runSequence),
    0,
  );
}

export function inspectPersistentMemoryProgress(input: {
  readonly activity: readonly PlayerAgentRoundActivity[];
  readonly afterRunSequence: number;
  readonly ownerReplyObserved: boolean;
  readonly factPersisted: boolean;
}): PersistentMemoryProgress {
  const conversationActivity = input.activity.filter(
    (activity) =>
      activity.runSequence > input.afterRunSequence &&
      activity.role === "conversation",
  );
  const rememberTools = conversationActivity.flatMap((activity) =>
    activity.toolCalls.filter((tool) => tool.name === "remember_owner_fact"),
  );
  const rememberToolResult = rememberTools.at(-1)?.resultClass ?? "none";
  const lastConversation = conversationActivity.at(-1);
  const conversationFinished =
    lastConversation?.responseStatus === "completed" &&
    lastConversation.processingStatus === "complete" &&
    lastConversation.functionCallCount === 0;

  let stage: PersistentMemoryStage = "waiting_for_conversation";
  if (input.factPersisted) {
    stage = "fact_persisted_before_restart";
  } else if (
    rememberToolResult === "rejected" ||
    rememberToolResult === "error"
  ) {
    stage = "save_tool_rejected";
  } else if (
    input.ownerReplyObserved &&
    conversationFinished &&
    rememberTools.length === 0
  ) {
    stage = "conversation_finished_without_save_tool";
  } else if (
    input.ownerReplyObserved &&
    conversationFinished &&
    rememberTools.length > 0
  ) {
    stage = "save_tool_not_verified";
  } else if (conversationActivity.length > 0) {
    stage = "conversation_in_progress";
  }

  return {
    stage,
    ownerReplyObserved: input.ownerReplyObserved,
    rememberToolCalled: rememberTools.length > 0,
    rememberToolResult,
    factPersisted: input.factPersisted,
  };
}
