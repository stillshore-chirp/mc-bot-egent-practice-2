import { describe, expect, it } from "vitest";

import {
  isGatherMultiTargetCaseSelected,
  isCaseSelectedForTarget,
  isOwnerStopLatchTargeted,
  TARGETABLE_CASES,
} from "../e2e/target-case-selection.js";

describe("targeted E2E case selection", () => {
  it("keeps owner_stop_latch as an explicit standalone target", () => {
    expect(TARGETABLE_CASES).toContain("owner_stop_latch");
    expect(isOwnerStopLatchTargeted("owner_stop_latch")).toBe(true);
    expect(isOwnerStopLatchTargeted(undefined)).toBe(false);
    expect(isOwnerStopLatchTargeted("parallel_dialogue_stop")).toBe(false);
    expect(
      isCaseSelectedForTarget("owner_stop_latch", "owner_stop_latch"),
    ).toBe(true);
    for (const unrelatedCase of [
      "autonomous_life",
      "parallel_dialogue_stop",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget("owner_stop_latch", unrelatedCase)).toBe(
        false,
      );
    }
  });

  it("runs the owner door return case without unrelated prerequisites", () => {
    expect(TARGETABLE_CASES).toContain("owner_return_through_door");
    expect(
      isCaseSelectedForTarget(
        "owner_return_through_door",
        "owner_return_through_door",
      ),
    ).toBe(true);
    for (const caseId of [
      "runtime_contract",
      "autonomous_life",
      "game_action_discretion",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget("owner_return_through_door", caseId)).toBe(
        false,
      );
    }
  });

  it("runs only learning_reuse and its autonomous_life prerequisite", () => {
    expect(TARGETABLE_CASES).toContain("learning_reuse");
    expect(isCaseSelectedForTarget("learning_reuse", "learning_reuse")).toBe(
      true,
    );
    expect(isCaseSelectedForTarget("learning_reuse", "autonomous_life")).toBe(
      true,
    );
    for (const caseId of [
      "runtime_contract",
      "unknown_composite",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget("learning_reuse", caseId)).toBe(false);
    }
  });

  it("preserves the autonomous_life prerequisite for unknown_composite", () => {
    expect(
      isCaseSelectedForTarget("unknown_composite", "autonomous_life"),
    ).toBe(true);
    expect(
      isCaseSelectedForTarget("unknown_composite", "unknown_composite"),
    ).toBe(true);
    expect(isCaseSelectedForTarget("unknown_composite", "learning_reuse")).toBe(
      false,
    );
  });

  it("keeps compactness on its bounded learning chain", () => {
    const targetCase = "skill_compactness_and_knowledge_separation";
    expect(TARGETABLE_CASES).toContain(targetCase);
    for (const selectedCase of [
      "autonomous_life",
      "learning_reuse",
      targetCase,
    ]) {
      expect(isCaseSelectedForTarget(targetCase, selectedCase)).toBe(true);
    }
    for (const skippedCase of [
      "runtime_contract",
      "observation_boundary",
      "persistent_memory_restart",
      "skill_exchange",
      "game_action_discretion",
      "unknown_composite",
      "parallel_dialogue_stop",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget(targetCase, skippedCase)).toBe(false);
    }
  });

  it("runs skill_exchange without learning prerequisites", () => {
    const targetCase = "skill_exchange";
    expect(TARGETABLE_CASES).toContain(targetCase);
    expect(isCaseSelectedForTarget(targetCase, targetCase)).toBe(true);
    expect(isCaseSelectedForTarget(targetCase, "autonomous_life")).toBe(false);
    expect(isCaseSelectedForTarget(targetCase, "learning_reuse")).toBe(false);
    for (const skippedCase of [
      "runtime_contract",
      "observation_boundary",
      "persistent_memory_restart",
      "skill_compactness_and_knowledge_separation",
      "game_action_discretion",
      "unknown_composite",
      "parallel_dialogue_stop",
      "integrated_result",
    ]) {
      expect(isCaseSelectedForTarget(targetCase, skippedCase)).toBe(false);
    }
  });

  it("does not add autonomous_life to unrelated target cases", () => {
    expect(
      isCaseSelectedForTarget("game_action_discretion", "autonomous_life"),
    ).toBe(false);
    expect(
      isCaseSelectedForTarget("parallel_dialogue_stop", "autonomous_life"),
    ).toBe(false);
  });

  it("runs the multi-target gather case without unrelated prerequisites", () => {
    expect(TARGETABLE_CASES).toContain("gather_multi_target_continuity");
    expect(
      isCaseSelectedForTarget(
        "gather_multi_target_continuity",
        "gather_multi_target_continuity",
      ),
    ).toBe(true);
    for (const caseId of [
      "autonomous_life",
      "learning_reuse",
      "unknown_composite",
      "integrated_result",
    ]) {
      expect(
        isCaseSelectedForTarget("gather_multi_target_continuity", caseId),
      ).toBe(false);
    }
  });

  it("selects the gather request gate for targeted and all-case runs", () => {
    expect(isGatherMultiTargetCaseSelected(undefined)).toBe(true);
    expect(
      isGatherMultiTargetCaseSelected("gather_multi_target_continuity"),
    ).toBe(true);
    expect(isGatherMultiTargetCaseSelected("damage_response")).toBe(false);
  });

  it("selects every case when no target is configured", () => {
    expect(isCaseSelectedForTarget(undefined, "autonomous_life")).toBe(true);
    expect(
      isCaseSelectedForTarget(undefined, "gather_multi_target_continuity"),
    ).toBe(true);
    expect(isCaseSelectedForTarget(undefined, "integrated_result")).toBe(true);
    for (const optInTarget of [
      "companion_proactive_food",
      "companion_proactive_bed",
      "companion_proactive_threat",
    ] as const) {
      expect(isCaseSelectedForTarget(undefined, optInTarget)).toBe(false);
      expect(isCaseSelectedForTarget(optInTarget, optInTarget)).toBe(true);
    }
  });
});
