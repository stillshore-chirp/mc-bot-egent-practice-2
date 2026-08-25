import { describe, expect, it } from "vitest";

import type {
  GameController,
  MemoryPort,
  ToolContext,
} from "../../src/tools/contracts.js";
import { toOpenAIFunctionTool } from "../../src/tools/definition.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { toolDefinitions } from "../../src/tools/registry.js";

const status = {
  connected: true,
  spawned: true,
  health: 20,
  food: 20,
  oxygen: 20,
  position: { x: 0, y: 64, z: 0, dimension: "overworld" },
  inventory: {},
  activeTaskState: null,
};

function context(requesterUsername = "owner"): ToolContext {
  const game: GameController = {
    observeStatus: async () => status,
    observeSurroundings: async () => ({
      blocks: [],
      entities: [],
      hazards: [],
    }),
    say: async () => undefined,
    followOwner: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "追従を確認しました。",
    }),
    stopCurrentAction: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "停止しました。",
    }),
    moveTo: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "到達しました。",
    }),
    gatherResource: async (resource, count) => ({
      before: status,
      after: status,
      outcome: "completed",
      evidenceKind: "inventory_delta",
      confirmedState: {
        resource,
        requestedCount: count,
        collectedCount: count,
        heldCount: count,
        playerDistance: 3,
      },
      summary: "原木を収集して戻りました。",
    }),
    returnToOwner: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "利用者へ戻りました。",
    }),
    currentPosition: async () => status.position,
  };
  const memory: MemoryPort = {
    rememberPlayerFact: () => ({ id: "fact" }),
    rememberLocation: () => ({ id: "location" }),
    recall: () => [],
    setCommitment: () => ({ id: "commitment" }),
    getCommitment: ({ commitmentId }) =>
      commitmentId === "commitment"
        ? {
            status: "active",
            fulfillment: {
              toolName: "gather_resource",
              resource: "oak_log",
              count: 1,
            },
          }
        : undefined,
    completeCommitment: () => ({ id: "commitment", status: "completed" }),
  };
  return {
    correlationId: "test-correlation",
    requesterUsername,
    authorizedOwnerUsername: "owner",
    playerId: "player",
    signal: new AbortController().signal,
    requestKind: "owner_message",
    executionEvidence: { verifiedActionReceipts: [] },
    game,
    memory,
    limits: {
      maxMoveDistance: 128,
      maxGatherCount: 16,
      followDistance: 3,
      memoryContextLimit: 10,
    },
  };
}

describe("tool schema registry", () => {
  it("has the complete tool set with strict JSON schemas and fixtures", () => {
    expect(toolDefinitions.map(({ name }) => name)).toEqual([
      "observe_status",
      "observe_surroundings",
      "say",
      "follow_player",
      "stop_current_action",
      "move_to",
      "gather_resource",
      "return_to_player",
      "remember_player_fact",
      "remember_location",
      "recall_memory",
      "set_commitment",
      "complete_commitment",
    ]);

    for (const definition of toolDefinitions) {
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
});

describe("ToolExecutor", () => {
  it("rejects an unauthorized requester before executing", async () => {
    const result = await new ToolExecutor().execute(
      "observe_status",
      "{}",
      context("other"),
    );
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.code).toBe("REQUESTER_NOT_AUTHORIZED");
  });

  it("rejects malformed or unknown calls", async () => {
    const executor = new ToolExecutor();
    expect(
      (await executor.execute("observe_status", "{", context())).success,
    ).toBe(false);
    expect((await executor.execute("missing", "{}", context())).success).toBe(
      false,
    );
  });

  it("enforces configured action limits", async () => {
    const result = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({ resource: "oak_log", count: 17, commitmentId: null }),
      context(),
    );
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.code).toBe("GATHER_COUNT_EXCEEDED");
  });

  it("allows only read operations during a runtime reassessment", async () => {
    const reassessment = context();
    reassessment.requestKind = "runtime_reassessment";
    const result = await new ToolExecutor().execute(
      "follow_player",
      JSON.stringify({ safeDistance: 3, maxDurationSeconds: 10 }),
      reassessment,
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: "RUNTIME_REASSESSMENT_TOOL_NOT_ALLOWED" },
    });
  });

  it("requires a verified action before completing a commitment on tool evidence", async () => {
    const toolContext = context();
    const result = await new ToolExecutor().execute(
      "complete_commitment",
      JSON.stringify({
        commitmentId: "commitment",
        outcome: "done",
        basis: "verified_tool_result",
        receiptId: null,
        evidenceSummary: null,
      }),
      toolContext,
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: "COMMITMENT_VERIFIED_ACTION_MISSING" },
    });
  });

  it("rejects a partially specified commitment fulfillment", async () => {
    const result = await new ToolExecutor().execute(
      "set_commitment",
      JSON.stringify({
        description: "collect logs",
        fulfillmentTool: "gather_resource",
        resource: "oak_log",
        count: null,
      }),
      context(),
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: "COMMITMENT_FULFILLMENT_INVALID" },
    });
  });

  it("completes a commitment only with its bound one-time action receipt", async () => {
    const toolContext = context();
    const action = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({
        resource: "oak_log",
        count: 1,
        commitmentId: "commitment",
      }),
      toolContext,
    );
    expect(action.success).toBe(true);
    if (!action.success || action.verificationReceipt === undefined)
      throw new Error("expected a verification receipt");

    const mismatched = await new ToolExecutor().execute(
      "complete_commitment",
      JSON.stringify({
        commitmentId: "other-commitment",
        outcome: "done",
        basis: "verified_tool_result",
        receiptId: action.verificationReceipt.receiptId,
        evidenceSummary: null,
      }),
      toolContext,
    );
    expect(mismatched).toMatchObject({
      success: false,
      error: { code: "COMMITMENT_VERIFIED_ACTION_MISSING" },
    });

    toolContext.correlationId = "different-correlation";
    const correlationMismatched = await new ToolExecutor().execute(
      "complete_commitment",
      JSON.stringify({
        commitmentId: "commitment",
        outcome: "done",
        basis: "verified_tool_result",
        receiptId: action.verificationReceipt.receiptId,
        evidenceSummary: null,
      }),
      toolContext,
    );
    expect(correlationMismatched).toMatchObject({
      success: false,
      error: { code: "COMMITMENT_VERIFIED_ACTION_MISSING" },
    });
    toolContext.correlationId = "test-correlation";

    const matched = await new ToolExecutor().execute(
      "complete_commitment",
      JSON.stringify({
        commitmentId: "commitment",
        outcome: "done",
        basis: "verified_tool_result",
        receiptId: action.verificationReceipt.receiptId,
        evidenceSummary: null,
      }),
      toolContext,
    );
    expect(matched.success).toBe(true);

    const reused = await new ToolExecutor().execute(
      "complete_commitment",
      JSON.stringify({
        commitmentId: "commitment",
        outcome: "done again",
        basis: "verified_tool_result",
        receiptId: action.verificationReceipt.receiptId,
        evidenceSummary: null,
      }),
      toolContext,
    );
    expect(reused).toMatchObject({
      success: false,
      error: { code: "COMMITMENT_VERIFIED_ACTION_MISSING" },
    });
  });

  it("does not issue a receipt for an unbound action or stop", async () => {
    const toolContext = context();
    const unbound = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({
        resource: "oak_log",
        count: 1,
        commitmentId: null,
      }),
      toolContext,
    );
    const stopped = await new ToolExecutor().execute(
      "stop_current_action",
      JSON.stringify({ reason: "stop" }),
      toolContext,
    );

    expect(unbound.success && unbound.verificationReceipt).toBeUndefined();
    expect(stopped.success).toBe(true);
    expect(toolContext.executionEvidence.verifiedActionReceipts).toEqual([]);
  });

  it("does not issue a receipt when gather input differs from typed fulfillment", async () => {
    const toolContext = context();
    const unrelated = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({
        resource: "birch_log",
        count: 1,
        commitmentId: "commitment",
      }),
      toolContext,
    );

    expect(unrelated.success).toBe(true);
    expect(unrelated.success && unrelated.verificationReceipt).toBeUndefined();
    expect(toolContext.executionEvidence.verifiedActionReceipts).toEqual([]);
  });
});
