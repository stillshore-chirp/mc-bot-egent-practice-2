import { describe, expect, it, vi } from "vitest";

import { extractBehaviorMemory } from "../../src/memory/behavior-memory.js";
import { behaviorMemoryTools } from "../../src/tools/behavior-memory-tools.js";
import type {
  BehaviorMemoryPort,
  ToolContext,
} from "../../src/tools/contracts.js";
import { toOpenAIFunctionTool } from "../../src/tools/definition.js";

const ownerContext = {
  requesterUsername: "owner",
  authorizedOwnerUsername: "owner",
  requestKind: "owner_message",
} as unknown as ToolContext;

describe("behavior memory tool contract", () => {
  it("exposes strict schemas for list, correction, and forgetting", () => {
    expect(behaviorMemoryTools.map(({ name }) => name)).toEqual([
      "remember_behavior_memory",
      "list_behavior_memory",
      "correct_behavior_memory",
      "forget_behavior_memory",
    ]);
    for (const definition of behaviorMemoryTools) {
      for (const fixture of definition.fixtures.valid) {
        expect(
          definition.input.safeParse(fixture).success,
          definition.name,
        ).toBe(true);
      }
      for (const fixture of definition.fixtures.invalid) {
        expect(
          definition.input.safeParse(fixture).success,
          definition.name,
        ).toBe(false);
      }
      expect(toOpenAIFunctionTool(definition).strict).toBe(true);
    }
  });

  it("rejects non-owner requests before the optional persistence adapter", async () => {
    const remember = vi.fn();
    const context = {
      ...ownerContext,
      requesterUsername: "other",
      behaviorMemory: { remember } as unknown as ToolContext["behaviorMemory"],
    } as unknown as ToolContext;
    const result = await behaviorMemoryTools[0].execute(
      {
        category: "communication",
        slot: "terminology",
        value: "plain_language",
        summary: "専門用語を避け、平易な言葉で説明する",
      },
      context,
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: "REQUESTER_NOT_AUTHORIZED" },
    });
    expect(remember).not.toHaveBeenCalled();
  });

  it("does not allow runtime reassessment to write behavior memory", async () => {
    const context = {
      ...ownerContext,
      requestKind: "runtime_reassessment" as const,
    };
    const result = await behaviorMemoryTools[2].execute(
      {
        memoryId: null,
        category: "communication",
        slot: "length",
        value: "brief",
        summary: "説明を短くする",
      },
      context,
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: "RUNTIME_REASSESSMENT_TOOL_NOT_ALLOWED" },
    });
  });

  it("accepts remember only when the values match the authenticated owner candidate", async () => {
    const candidate = extractBehaviorMemory(
      "今後は専門用語を使わず、平易に説明して",
    )[0];
    if (candidate === undefined) throw new Error("candidate was not extracted");
    const record = {
      id: "00000000-0000-0000-0000-000000000001",
      playerId: "player",
      category: candidate.category,
      slot: candidate.slot,
      value: candidate.value,
      summary: candidate.summary,
      source: "owner_explicit" as const,
      confidence: "explicit" as const,
      scope: "owner_global" as const,
      supportCount: 1,
      status: "active" as const,
      createdAt: "2026-09-22T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
    };
    let rememberedInput:
      | { confidence?: string; idempotencyKey?: string; source?: string }
      | undefined;
    const remember = vi.fn(
      (input: {
        confidence?: string;
        idempotencyKey?: string;
        source?: string;
      }) => {
        rememberedInput = input;
        return record;
      },
    );
    const context = {
      ...ownerContext,
      playerId: "player",
      behaviorMemory: { remember } as unknown as BehaviorMemoryPort,
      behaviorMemoryCandidates: [candidate],
      behaviorMemoryEventId: "accepted-event-0001",
    } as unknown as ToolContext;

    const accepted = await behaviorMemoryTools[0].execute(
      {
        category: candidate.category,
        slot: candidate.slot,
        value: candidate.value,
        summary: candidate.summary,
      },
      context,
    );
    expect(accepted).toMatchObject({ success: true });
    expect(rememberedInput).toMatchObject({
      source: "owner_explicit",
      confidence: "explicit",
    });
    expect(rememberedInput?.idempotencyKey).toMatch(
      /^owner-message:[0-9a-f]{32}:terminology$/u,
    );

    const rejected = await behaviorMemoryTools[0].execute(
      {
        category: candidate.category,
        slot: candidate.slot,
        value: candidate.value,
        summary: "別の希望を保存する",
      },
      context,
    );
    expect(rejected).toMatchObject({
      success: false,
      error: { code: "BEHAVIOR_MEMORY_REJECTED" },
    });
    expect(remember).toHaveBeenCalledTimes(1);
  });

  it("accepts correct only for an extracted owner correction", async () => {
    const candidate = extractBehaviorMemory("訂正: 今後は短く説明して")[0];
    if (candidate === undefined) throw new Error("candidate was not extracted");
    let correctedInput: { idempotencyKey?: string } | undefined;
    const correct = vi.fn((input: { idempotencyKey?: string }) => {
      correctedInput = input;
      return {
        id: "00000000-0000-0000-0000-000000000002",
        playerId: "player",
        category: candidate.category,
        slot: candidate.slot,
        value: candidate.value,
        summary: candidate.summary,
        source: "owner_correction" as const,
        confidence: "corrected" as const,
        scope: "owner_global" as const,
        supportCount: 1,
        status: "active" as const,
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
      };
    });
    const context = {
      ...ownerContext,
      playerId: "player",
      behaviorMemory: { correct } as unknown as BehaviorMemoryPort,
      behaviorMemoryCandidates: [candidate],
      behaviorMemoryEventId: "accepted-event-0002",
    } as unknown as ToolContext;

    const accepted = await behaviorMemoryTools[2].execute(
      {
        memoryId: null,
        category: candidate.category,
        slot: candidate.slot,
        value: candidate.value,
        summary: candidate.summary,
      },
      context,
    );
    expect(accepted).toMatchObject({ success: true });
    expect(correctedInput?.idempotencyKey).toMatch(
      /^owner-message:[0-9a-f]{32}:length$/u,
    );
  });
});
