export const TARGETABLE_CASES = [
  "owner_return_through_door",
  "game_action_discretion",
  "food_intent_continuity",
  "gather_multi_target_continuity",
  "damage_response",
  "no_food_replan",
  "learning_reuse",
  "skill_compactness_and_knowledge_separation",
  "skill_exchange",
  "unknown_composite",
  "parallel_dialogue_stop",
  "owner_stop_latch",
] as const;

export type TargetableCase = (typeof TARGETABLE_CASES)[number];

const TARGET_CASE_PREREQUISITES: Partial<
  Record<TargetableCase, readonly string[]>
> = {
  learning_reuse: ["autonomous_life"],
  skill_compactness_and_knowledge_separation: [
    "autonomous_life",
    "learning_reuse",
  ],
  unknown_composite: ["autonomous_life"],
};

export function isCaseSelectedForTarget(
  targetCase: TargetableCase | undefined,
  caseId: string,
): boolean {
  if (targetCase === undefined || caseId === targetCase) return true;
  return TARGET_CASE_PREREQUISITES[targetCase]?.includes(caseId) === true;
}

export function isOwnerStopLatchTargeted(
  targetCase: TargetableCase | undefined,
): boolean {
  return targetCase === "owner_stop_latch";
}

export function isGatherMultiTargetCaseSelected(
  targetCase: TargetableCase | undefined,
): boolean {
  return isCaseSelectedForTarget(targetCase, "gather_multi_target_continuity");
}
