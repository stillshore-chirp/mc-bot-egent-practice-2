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
    findSafeResourceCandidates: async () => [
      { resource: "birch_log", distance: 2 },
      { resource: "oak_log", distance: 5 },
    ],
    findSafeActionCandidates: async ({ count }) => [
      {
        id: "collect-birch",
        label: "近くのシラカバを集める",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        distance: 2,
        order: 0,
        steps: [
          { tool: "say", input: { message: "安全な候補を選びました。" } },
          {
            tool: "gather_resource",
            input: {
              resource: "birch_log",
              count,
              commitmentId: null,
            },
          },
        ],
      },
    ],
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
      "gather_and_store",
      "store_logs",
      "register_delivery_target",
      "get_delivery_targets",
      "forget_delivery_target",
      "observe_status",
      "observe_surroundings",
      "plan_safe_action",
      "select_safe_resource",
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
  it("executes every bounded plan step without a second owner prompt", async () => {
    const calls: string[] = [];
    const toolContext = context();
    toolContext.game.say = async (message) => {
      calls.push(`say:${message}`);
    };
    toolContext.game.gatherResource = async () => {
      calls.push("gather_resource");
      return {
        before: status,
        after: status,
        outcome: "completed",
        summary: "原木を収集して戻りました。",
      };
    };
    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "collect_resource",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        candidateId: "collect-birch",
        completedSteps: [{ tool: "say" }, { tool: "gather_resource" }],
      },
    });
    expect(calls).toEqual(["say:安全な候補を選びました。", "gather_resource"]);
  });

  it("consumes an owner bounded authorization after one plan invocation", async () => {
    const toolContext = context();
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "シラカバの原木を2個集めて",
      allowedResources: ["birch_log"],
      targetItem: "birch_log",
      targetCount: 2,
      maxCount: 16,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 2,
      consumed: false,
    };
    toolContext.game.findSafeActionCandidates = async ({ count }) => [
      {
        id: "authorized-birch",
        label: "観測済みのシラカバ",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        operationClass: "natural_resource",
        resourceName: "birch_log",
        goalItem: "birch_log",
        requestedCount: count,
        steps: [
          {
            tool: "gather_resource",
            input: { resource: "birch_log", count, commitmentId: null },
          },
        ],
      },
    ];
    let gatherCalls = 0;
    toolContext.game.gatherResource = async (resource, count) => {
      gatherCalls += 1;
      return {
        before: status,
        after: status,
        outcome: "completed",
        confirmedState: {
          resource,
          requestedCount: count,
          collectedCount: count,
        },
        summary: "シラカバを収集しました。",
      };
    };

    const request = JSON.stringify({
      goal: "collect_resource",
      count: 1,
      mode: "delegated",
      candidateId: null,
    });
    const first = await new ToolExecutor().execute(
      "plan_safe_action",
      request,
      toolContext,
    );
    const second = await new ToolExecutor().execute(
      "plan_safe_action",
      request,
      toolContext,
    );

    expect(first).toMatchObject({ success: true, data: { completedCount: 2 } });
    expect(second).toMatchObject({
      success: false,
      error: { code: "SAFE_ACTION_AUTHORIZATION_INVALID" },
    });
    expect(toolContext.safeActionAuthorizationUsage).toEqual({
      remainingCount: 0,
      consumed: true,
    });
    expect(gatherCalls).toBe(1);
  });

  it("reobserves and replans a bounded multi-block goal without another prompt", async () => {
    const observedCounts: number[] = [];
    const mined: string[] = [];
    const toolContext = context();
    toolContext.game.findSafeActionCandidates = async ({ count }) => {
      observedCounts.push(count);
      return [
        {
          id: `mine-oak-${String(observedCounts.length)}`,
          label: "観測済みの原木",
          action: "gather_resource",
          observed: true,
          purposeFit: "direct",
          permission: "allowed",
          safety: "allowed",
          reversible: true,
          impact: "low",
          operationClass: "natural_resource",
          resourceName: "oak_log",
          requestedCount: 1,
          steps: [
            {
              tool: "gather_resource",
              input: { resource: "oak_log", count: 1, commitmentId: null },
            },
          ],
        },
      ];
    };
    toolContext.game.gatherResource = async () => {
      mined.push("oak_log");
      return {
        before: status,
        after: status,
        outcome: "completed",
        confirmedState: {
          resource: "oak_log",
          requestedCount: 1,
          collectedCount: 1,
        },
        summary: "原木を1個収集しました。",
      };
    };

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "collect_resource",
        count: 3,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        completedCount: 3,
        targetCount: 3,
        planRounds: 3,
      },
    });
    expect(observedCounts).toEqual([3, 2, 1]);
    expect(mined).toHaveLength(3);
  });

  it("aborts an in-flight step at the plan deadline and skips later steps", async () => {
    const toolContext = context();
    toolContext.limits.maxSafeActionDurationMs = 25;
    const laterSteps: string[] = [];
    let receivedSignal: AbortSignal | undefined;
    toolContext.game.findSafeActionCandidates = async () => [
      {
        id: "deadline-plan",
        label: "期限付きの採取",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        operationClass: "natural_resource",
        resourceName: "oak_log",
        requestedCount: 1,
        steps: [
          {
            tool: "gather_resource",
            input: { resource: "oak_log", count: 1, commitmentId: null },
          },
          { tool: "say", input: { message: "後続" } },
        ],
      },
    ];
    toolContext.game.gatherResource = async (_resource, _count, signal) => {
      receivedSignal = signal;
      return new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () =>
            resolve({
              before: status,
              after: status,
              outcome: "cancelled",
              failureCategory: "cancelled",
              failureCode: "ACTION_CANCELLED",
              failureRetryable: false,
              failedAt: "gather_resource",
              summary: "採取を中断しました。",
            }),
          { once: true },
        );
      });
    };
    toolContext.game.say = async (message) => {
      laterSteps.push(message);
    };

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "collect_resource",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      success: false,
      error: {
        category: "timeout",
        code: "SAFE_ACTION_PLAN_TIMEOUT",
        confirmedState: { completedCount: 0, completedSteps: 0 },
      },
    });
    expect(laterSteps).toEqual([]);
  });

  it("does not report a late successful step as a completed plan", async () => {
    const toolContext = context();
    toolContext.limits.maxSafeActionDurationMs = 10;
    const laterSteps: string[] = [];
    let receivedSignal: AbortSignal | undefined;
    toolContext.game.findSafeActionCandidates = async () => [
      {
        id: "late-plan",
        label: "期限後に返る採取",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        operationClass: "natural_resource",
        resourceName: "oak_log",
        requestedCount: 1,
        steps: [
          {
            tool: "gather_resource",
            input: { resource: "oak_log", count: 1, commitmentId: null },
          },
          { tool: "say", input: { message: "後続" } },
        ],
      },
    ];
    toolContext.game.gatherResource = async (_resource, _count, signal) => {
      receivedSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        before: status,
        after: status,
        outcome: "completed",
        confirmedState: {
          resource: "oak_log",
          requestedCount: 1,
          collectedCount: 1,
        },
        summary: "期限後に採取結果が返りました。",
      };
    };
    toolContext.game.say = async (message) => {
      laterSteps.push(message);
    };

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "collect_resource",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      success: false,
      error: {
        category: "timeout",
        code: "SAFE_ACTION_PLAN_TIMEOUT",
        confirmedState: {
          completedCount: 0,
          partialProgress: { completedCount: 1, requestedCount: 1 },
        },
      },
    });
    expect(laterSteps).toEqual([]);
  });

  it("returns only confirmed partial progress after an owner stop", async () => {
    const stopController = new AbortController();
    const toolContext = context();
    toolContext.signal = stopController.signal;
    const laterSteps: string[] = [];
    let receivedSignal: AbortSignal | undefined;
    toolContext.game.findSafeActionCandidates = async () => [
      {
        id: "cancelled-plan",
        label: "停止された採取",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        operationClass: "natural_resource",
        resourceName: "oak_log",
        requestedCount: 1,
        steps: [
          {
            tool: "gather_resource",
            input: { resource: "oak_log", count: 1, commitmentId: null },
          },
          { tool: "say", input: { message: "後続" } },
        ],
      },
    ];
    toolContext.game.gatherResource = async (_resource, _count, signal) => {
      receivedSignal = signal;
      stopController.abort(new Error("OWNER_STOP_REQUESTED"));
      return {
        before: status,
        after: status,
        outcome: "completed",
        confirmedState: {
          resource: "oak_log",
          requestedCount: 1,
          collectedCount: 1,
        },
        summary: "停止直前に採取結果を確認しました。",
      };
    };
    toolContext.game.say = async (message) => {
      laterSteps.push(message);
    };

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "collect_resource",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      success: false,
      error: {
        category: "cancelled",
        code: "SAFE_ACTION_PLAN_CANCELLED",
        confirmedState: {
          completedCount: 0,
          completedSteps: 1,
          partialProgress: { completedCount: 1, requestedCount: 1 },
        },
      },
    });
    expect(laterSteps).toEqual([]);
  });

  it("stops a plan at the first failed step and does not run later steps", async () => {
    const calls: string[] = [];
    const toolContext = context();
    toolContext.game.findSafeActionCandidates = async () => [
      {
        id: "two-step",
        label: "二段階の作業",
        action: "say",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        steps: [
          { tool: "say", input: { message: "開始" } },
          {
            tool: "gather_resource",
            input: { resource: "oak_log", count: 1, commitmentId: null },
          },
          { tool: "say", input: { message: "後続" } },
        ],
      },
    ];
    toolContext.game.say = async (message) => {
      calls.push(message);
    };
    toolContext.game.gatherResource = async () => ({
      before: status,
      after: status,
      outcome: "failed",
      failureCategory: "resource",
      failureCode: "RESOURCE_NOT_FOUND",
      failureRetryable: false,
      summary: "安全に採取できる対象を確認できませんでした。",
    });

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "collect_resource",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "SAFE_ACTION_STEP_FAILED",
        failedAt: "gather_resource",
        confirmedState: { completedSteps: 1, stepCode: "RESOURCE_NOT_FOUND" },
      },
    });
    expect(calls).toEqual(["開始"]);
  });

  it("does not replan a remaining quantity without an authoritative progress delta", async () => {
    let gatherCalls = 0;
    const toolContext = context();
    toolContext.game.findSafeActionCandidates = async () => [
      {
        id: "one-block-without-progress",
        label: "数量証跡のない採取",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        operationClass: "natural_resource",
        resourceName: "oak_log",
        requestedCount: 1,
        steps: [
          {
            tool: "gather_resource",
            input: { resource: "oak_log", count: 1, commitmentId: null },
          },
        ],
      },
    ];
    toolContext.game.gatherResource = async () => {
      gatherCalls += 1;
      return {
        before: status,
        after: status,
        outcome: "completed",
        summary: "採取操作を完了しました。",
      };
    };

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "collect_resource",
        count: 2,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "SAFE_ACTION_PROGRESS_UNCONFIRMED" },
    });
    expect(gatherCalls).toBe(1);
  });

  it("rejects progress that changes the provider-requested quantity", async () => {
    const toolContext = context();
    toolContext.game.findSafeActionCandidates = async () => [
      {
        id: "one-block-with-inflated-progress",
        label: "数量が一致しない採取",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        operationClass: "natural_resource",
        resourceName: "oak_log",
        requestedCount: 1,
        steps: [
          {
            tool: "gather_resource",
            input: { resource: "oak_log", count: 1, commitmentId: null },
          },
        ],
      },
    ];
    toolContext.game.gatherResource = async () => ({
      before: status,
      after: status,
      outcome: "completed",
      confirmedState: {
        resource: "oak_log",
        requestedCount: 64,
        collectedCount: 64,
      },
      summary: "採取結果を確認しました。",
    });

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "collect_resource",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "SAFE_ACTION_PROGRESS_INVALID" },
    });
  });

  it("does not treat intermediate material as the requested final inventory item", async () => {
    const toolContext = context();
    toolContext.game.findSafeActionCandidates = async () => [
      {
        id: "ore-before-ingot",
        label: "鉄インゴットの材料",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        operationClass: "natural_resource",
        resourceName: "iron_ore",
        goalItem: "iron_ingot",
        requestedCount: 1,
        steps: [
          {
            tool: "gather_resource",
            input: { resource: "oak_log", count: 1, commitmentId: null },
          },
        ],
      },
    ];
    toolContext.game.gatherResource = async () => ({
      before: status,
      after: status,
      outcome: "completed",
      confirmedState: {
        item: "raw_iron",
        requestedCount: 1,
        collectedCount: 1,
      },
      summary: "材料を収集しました。",
    });

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "collect_resource",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "SAFE_ACTION_PROGRESS_INVALID" },
    });
  });

  it("carries verified intermediate material into the next plan round", async () => {
    let round = 0;
    const toolContext = context();
    toolContext.game.findSafeActionCandidates = async () => {
      round += 1;
      return [
        {
          id: `iron-stage-${String(round)}`,
          label: "鉄インゴットの段階計画",
          action: "gather_resource",
          observed: true,
          purposeFit: "direct",
          permission: "allowed",
          safety: "allowed",
          reversible: true,
          impact: "low",
          operationClass: "natural_resource",
          resourceName: "iron_ore",
          goalItem: "iron_ingot",
          intermediateItems: ["raw_iron"],
          requestedCount: 1,
          steps: [
            {
              tool: "gather_resource",
              input: { resource: "oak_log", count: 1, commitmentId: null },
            },
          ],
        },
      ];
    };
    toolContext.game.gatherResource = async () => ({
      before: status,
      after: status,
      outcome: "completed",
      confirmedState: {
        item: round === 1 ? "raw_iron" : "iron_ingot",
        requestedCount: 1,
        collectedCount: 1,
      },
      summary:
        round === 1 ? "raw_ironを確認しました。" : "iron_ingotを確認しました。",
    });

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "make_iron_ingot",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: true,
      data: { completedCount: 1, targetCount: 1, planRounds: 2 },
    });
  });

  it("stops repeated intermediate progress at the bounded target count", async () => {
    let round = 0;
    const toolContext = context();
    toolContext.game.findSafeActionCandidates = async () => {
      round += 1;
      return [
        {
          id: `repeated-intermediate-${String(round)}`,
          label: "繰り返し報告された中間素材",
          action: "gather_resource",
          observed: true,
          purposeFit: "direct",
          permission: "allowed",
          safety: "allowed",
          reversible: true,
          impact: "low",
          operationClass: "natural_resource",
          resourceName: "iron_ore",
          goalItem: "iron_ingot",
          intermediateItems: ["raw_iron"],
          requestedCount: 1,
          steps: [
            {
              tool: "gather_resource",
              input: { resource: "oak_log", count: 1, commitmentId: null },
            },
          ],
        },
      ];
    };
    toolContext.game.gatherResource = async () => ({
      before: status,
      after: status,
      outcome: "completed",
      confirmedState: {
        item: "raw_iron",
        requestedCount: 1,
        collectedCount: 1,
      },
      summary: "raw_ironを確認しました。",
    });

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "make_iron_ingot",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "SAFE_ACTION_INTERMEDIATE_LIMIT",
        confirmedState: { intermediateCount: 2, intermediateLimit: 1 },
      },
    });
    expect(round).toBe(2);
  });

  it("stops once at the owner boundary for an unverified output", async () => {
    let observations = 0;
    const toolContext = context();
    toolContext.safeActionClarification =
      "mystery_oreの最終アイテム名を指定してください。";
    toolContext.game.findSafeActionCandidates = async () => {
      observations += 1;
      return [];
    };

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "mystery_ore",
        count: 4,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "OWNER_GOAL_CLARIFICATION_REQUIRED" },
    });
    expect(observations).toBe(0);
  });

  it("does not start another action while the owner quantity is pending", async () => {
    const toolContext = context();
    toolContext.safeActionClarification =
      "鉄の数量を指定してください（上限64個）。";

    const result = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({ resource: "oak_log", count: 1, commitmentId: null }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "OWNER_GOAL_CLARIFICATION_REQUIRED",
        category: "authorization",
      },
    });
  });

  it("allows an explicit stop while a goal clarification is pending", async () => {
    const toolContext = context();
    toolContext.safeActionClarification =
      "鉄の数量を指定してください（上限64個）。";

    const result = await new ToolExecutor().execute(
      "stop_current_action",
      JSON.stringify({ reason: "利用者の停止指示" }),
      toolContext,
    );

    expect(result).toMatchObject({ success: true });
  });

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

  it("selects the nearest observed and protection-checked resource without asking again", async () => {
    const toolContext = context();
    const result = await new ToolExecutor().execute(
      "select_safe_resource",
      JSON.stringify({ count: 1 }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        resource: "birch_log",
        count: 1,
        selectedDistance: 2,
      },
    });
    expect(result.success && result.userSummary).toContain("最も近い");
  });

  it("returns a concrete question when delegated selection has no observed candidate", async () => {
    const toolContext = context();
    toolContext.game.findSafeResourceCandidates = async () => [];
    const result = await new ToolExecutor().execute(
      "select_safe_resource",
      JSON.stringify({ count: 1 }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "CHOICE_NOT_OBSERVED",
        category: "resource",
      },
    });
    if (!result.success) {
      expect(result.error.userSummary).toContain("観測");
      expect(result.error.userSummary).not.toContain("MAIN_TASK_BUSY");
    }
  });

  it("fails closed when the adapter cannot provide the protected candidate observation", async () => {
    const toolContext = context();
    delete toolContext.game.findSafeResourceCandidates;
    const result = await new ToolExecutor().execute(
      "select_safe_resource",
      JSON.stringify({ count: 1 }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "SAFE_RESOURCE_OBSERVATION_UNAVAILABLE" },
    });
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
