import { describe, expect, it, vi } from "vitest";

import { behaviorMemoryTools } from "../../src/tools/behavior-memory-tools.js";
import type { ToolContext } from "../../src/tools/contracts.js";
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
});
