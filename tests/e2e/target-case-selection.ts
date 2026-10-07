export const TARGETABLE_CASES = [
  "owner_return_through_door",
  "game_action_discretion",
  "food_intent_continuity",
  "companion_intent_collection",
  "companion_proactive_food",
  "companion_proactive_bed",
  "companion_proactive_threat",
  "gather_multi_target_continuity",
  "death_recovery",
  "underwater_item_recovery",
  "damage_response",
  "no_food_replan",
  "learning_reuse",
  "skill_compactness_and_knowledge_separation",
  "skill_exchange",
  "unknown_composite",
  "parallel_dialogue_stop",
  "owner_stop_latch",
  "armor_capability",
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

const OPT_IN_ONLY_CASES = new Set<string>([
  "companion_proactive_food",
  "companion_proactive_bed",
  "companion_proactive_threat",
]);

export function isCaseSelectedForTarget(
  targetCase: TargetableCase | undefined,
  caseId: string,
): boolean {
  if (targetCase === undefined) return !OPT_IN_ONLY_CASES.has(caseId);
  if (caseId === targetCase) return true;
  return TARGET_CASE_PREREQUISITES[targetCase]?.includes(caseId) === true;
}

export function isOwnerStopLatchTargeted(
  targetCase: TargetableCase | undefined,
): boolean {
  return targetCase === "owner_stop_latch";
}

export function isUnderwaterItemRecoveryTargeted(
  targetCase: TargetableCase | undefined,
): boolean {
  return targetCase === "underwater_item_recovery";
}

export function isArmorCapabilityTargeted(
  targetCase: TargetableCase | undefined,
): boolean {
  return targetCase === "armor_capability";
}

export function isGatherMultiTargetCaseSelected(
  targetCase: TargetableCase | undefined,
): boolean {
  return isCaseSelectedForTarget(targetCase, "gather_multi_target_continuity");
}
