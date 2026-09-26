export const TARGETABLE_CASES = [
  "game_action_discretion",
  "food_intent_continuity",
  "learning_reuse",
  "skill_compactness_and_knowledge_separation",
  "skill_exchange",
  "unknown_composite",
  "parallel_dialogue_stop",
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
  skill_exchange: ["autonomous_life", "learning_reuse"],
  unknown_composite: ["autonomous_life"],
};

export function isCaseSelectedForTarget(
  targetCase: TargetableCase | undefined,
  caseId: string,
): boolean {
  if (targetCase === undefined || caseId === targetCase) return true;
  return TARGET_CASE_PREREQUISITES[targetCase]?.includes(caseId) === true;
}
