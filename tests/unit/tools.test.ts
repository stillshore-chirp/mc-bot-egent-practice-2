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
  observedAt: "2026-09-22T00:00:00.000Z",
  subject: "bot" as const,
  source: "minecraft" as const,
  requesterVitals: "unobserved" as const,
  connected: true,
  spawned: true,
  health: 20,
  food: 20,
  oxygen: 20,
  oxygenState: "not_applicable" as const,
  inWater: false,
  inLava: false,
  suffocating: false,
  position: { x: 0, y: 64, z: 0, dimension: "overworld" },
  inventory: {},
  activeTaskState: null,
};

function context(requesterUsername = "owner"): ToolContext {
  const game: GameController = {
    respondToHostiles: async () => ({
      before: null,
      after: null,
      outcome: "failed",
      summary: "対象なし",
    }),
    observeStatus: async () => status,
    observeSurroundings: async () => ({
      observedAt: status.observedAt,
      subject: status.subject,
      source: status.source,
      requesterVitals: status.requesterVitals,
      oxygen: status.oxygen,
      oxygenState: status.oxygenState,
      inWater: status.inWater,
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
    observeActionCandidates: async () => [],
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
    mineBlock: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "採掘しました。",
    }),
    collectItem: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "回収しました。",
    }),
    craftItem: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "クラフトしました。",
    }),
    placeBlock: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "設置しました。",
    }),
    smeltItem: async () => ({
      before: status,
      after: status,
      outcome: "completed",
      summary: "精錬しました。",
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
      "observe_action_candidates",
      "mine_block",
      "collect_item",
      "craft_item",
      "place_block",
      "smelt_item",
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

    const followDefinition = toolDefinitions.find(
      ({ name }) => name === "follow_player",
    );
    if (!followDefinition) throw new Error("follow_player definition missing");
    const followSchema = toOpenAIFunctionTool(followDefinition).parameters as {
      required?: string[];
      properties?: Record<string, { anyOf?: { type?: unknown }[] }>;
    };
    expect(followSchema.required).toEqual([
      "safeDistance",
      "maxDurationSeconds",
    ]);
    expect(followSchema.properties?.safeDistance?.anyOf).toEqual([
      { type: "number", minimum: 2, maximum: 16 },
      { type: "null" },
    ]);
    expect(followSchema.properties?.maxDurationSeconds?.anyOf).toEqual([
      { type: "integer", minimum: 1, maximum: 900 },
      { type: "null" },
    ]);
  });
});

describe("ToolExecutor", () => {
  it("chooses an observed ore when the model guesses an explicit candidate for the owner's goal", async () => {
    const toolContext = context();
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "石炭を1個集めて",
      allowedResources: ["coal_ore"],
      targetItem: "coal",
      targetCount: 1,
      maxCount: 8,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
    let held = 0;
    toolContext.game.observeStatus = async () => ({
      ...status,
      inventory: { coal: held },
    });
    toolContext.game.findSafeActionCandidates = async () => [
      {
        id: "mine_block:coal_ore:1:64:0",
        label: "観測した石炭鉱石",
        action: "mine_block",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: false,
        impact: "medium",
        operationClass: "natural_resource",
        requestedCount: 1,
        resourceName: "coal_ore",
        goalItem: "coal",
        distance: 1,
        steps: [
          {
            tool: "mine_block",
            input: { name: "coal_ore", position: { x: 1, y: 64, z: 0 } },
          },
        ],
      },
    ];
    toolContext.game.mineBlock = async () => {
      held = 1;
      return {
        before: status,
        after: { ...status, inventory: { coal: held } },
        outcome: "completed",
        confirmedState: {
          item: "coal",
          requestedCount: 1,
          collectedCount: 1,
          heldCount: held,
        },
        summary: "所持品の増加を確認しました。",
      };
    };

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "石炭を1個集めて",
        count: 1,
        mode: "explicit",
        candidateId: "coal_ore",
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: true,
      data: { completedCount: 1, candidateId: "mine_block:coal_ore:1:64:0" },
    });
  });

  it("searches once under an owner quantity contract and executes the newly observed log", async () => {
    const toolContext = context();
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "木の原木を1個集めて",
      allowedResources: ["birch_log", "oak_log"],
      targetItem: "*",
      targetCount: 1,
      maxCount: 16,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
    let observations = 0;
    let searches = 0;
    let gathers = 0;
    toolContext.game.findSafeActionCandidates = async () => {
      observations += 1;
      if (observations === 1) return [];
      return [
        {
          id: "gather_resource:birch_log",
          label: "シラカバの原木",
          action: "gather_resource",
          observed: true,
          purposeFit: "direct",
          permission: "allowed",
          safety: "allowed",
          reversible: false,
          impact: "medium",
          operationClass: "natural_resource",
          requestedCount: 1,
          resourceName: "birch_log",
          goalItem: "birch_log",
          distance: 2,
          steps: [
            {
              tool: "gather_resource",
              input: { resource: "birch_log", count: 1, commitmentId: null },
            },
          ],
        },
      ];
    };
    toolContext.game.searchSafeResourceCandidates = async () => {
      searches += 1;
      return {
        candidates: [{ resource: "birch_log", distance: 2 }],
        attemptedWaypoints: 2,
        blockedWaypoints: 1,
      };
    };
    toolContext.game.gatherResource = async () => {
      gathers += 1;
      return {
        before: status,
        after: status,
        outcome: "completed",
        confirmedState: {
          resource: "birch_log",
          requestedCount: 1,
          collectedCount: 1,
          heldCount: 1,
        },
        summary: "所持数の増加を確認しました。",
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
      data: { completedCount: 1, candidateId: "gather_resource:birch_log" },
    });
    expect({ observations, searches, gathers }).toEqual({
      observations: 2,
      searches: 1,
      gathers: 1,
    });
  });

  it("switches to another observed tree after a verified zero-progress path failure", async () => {
    const toolContext = context();
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "木の原木を1個集めて",
      allowedResources: ["birch_log", "oak_log"],
      targetItem: "*",
      targetCount: 1,
      maxCount: 16,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
    toolContext.game.findSafeActionCandidates = async () =>
      ["birch_log", "oak_log"].map((resourceName, order) => ({
        id: `gather_resource:${resourceName}`,
        label: resourceName,
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: false,
        impact: "medium",
        operationClass: "natural_resource",
        requestedCount: 1,
        resourceName,
        goalItem: resourceName,
        distance: order + 1,
        steps: [
          {
            tool: "gather_resource",
            input: { resource: resourceName, count: 1, commitmentId: null },
          },
        ],
      }));
    const gathered: string[] = [];
    toolContext.game.gatherResource = async (resource) => {
      gathered.push(resource);
      return resource === "birch_log"
        ? {
            before: status,
            after: status,
            outcome: "failed",
            failureCategory: "path",
            failureCode: "RESOURCE_PATHS_BLOCKED",
            failureRetryable: false,
            confirmedState: { collectedCount: 0, heldCount: 0 },
            summary: "安全な経路がありません。",
          }
        : {
            before: status,
            after: status,
            outcome: "completed",
            confirmedState: {
              resource: "oak_log",
              requestedCount: 1,
              collectedCount: 1,
              heldCount: 1,
            },
            summary: "オークの原木を1個確認しました。",
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
      data: { candidateId: "gather_resource:oak_log", completedCount: 1 },
    });
    expect(gathered).toEqual(["birch_log", "oak_log"]);
  });

  it.each([true, false])(
    "reconciles an uncertain mining pickup only when the goal item increased: %s",
    async (firstDropReachedInventory) => {
      const toolContext = context();
      toolContext.safeActionAuthorization = {
        kind: "owner_bounded_resource",
        goal: "石炭を2個集めて",
        allowedResources: ["coal_ore"],
        targetItem: "coal",
        targetCount: 2,
        maxCount: 8,
      };
      toolContext.safeActionAuthorizationUsage = {
        remainingCount: 2,
        consumed: false,
      };
      let held = 0;
      let attempts = 0;
      toolContext.game.observeStatus = async () => ({
        ...status,
        inventory: { coal: held },
      });
      toolContext.game.findSafeActionCandidates = async () =>
        [1, 2].map((index) => ({
          id: `coal-${String(index)}`,
          label: `石炭鉱石${String(index)}`,
          action: "mine_block" as const,
          observed: true as const,
          purposeFit: "direct" as const,
          permission: "allowed" as const,
          safety: "allowed" as const,
          reversible: false,
          impact: "medium" as const,
          operationClass: "natural_resource" as const,
          requestedCount: 1,
          resourceName: "coal_ore",
          goalItem: "coal",
          distance: index,
          order: index - 1,
          steps: [
            {
              tool: "mine_block",
              input: { name: "coal_ore", position: { x: index, y: 64, z: 0 } },
            },
          ],
        }));
      toolContext.game.mineBlock = async () => {
        attempts += 1;
        if (attempts === 1) {
          if (firstDropReachedInventory) held += 1;
          return {
            before: status,
            after: { ...status, inventory: { coal: held } },
            outcome: "failed",
            failureCategory: "inventory",
            failureCode: "DROP_NOT_COLLECTED",
            failureRetryable: true,
            summary: "回収の完了判定ができませんでした。",
          };
        }
        held += 1;
        return {
          before: status,
          after: { ...status, inventory: { coal: held } },
          outcome: "completed",
          confirmedState: {
            item: "coal",
            requestedCount: 1,
            collectedCount: 1,
            heldCount: held,
          },
          summary: "所持品の増加を確認しました。",
        };
      };

      const result = await new ToolExecutor().execute(
        "plan_safe_action",
        JSON.stringify({
          goal: "石炭を2個集めて",
          count: 2,
          mode: "delegated",
          candidateId: null,
        }),
        toolContext,
      );

      if (firstDropReachedInventory) {
        expect(result).toMatchObject({
          success: true,
          data: { completedCount: 2, inventoryReconciledCount: 1 },
        });
        expect(attempts).toBe(2);
      } else {
        expect(result).toMatchObject({
          success: false,
          error: { code: "SAFE_ACTION_STEP_FAILED" },
        });
        expect(attempts).toBe(1);
      }
    },
  );

  it("stops when an uncertain mining pickup exceeds the owner quantity", async () => {
    const toolContext = context();
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "石炭を1個集めて",
      allowedResources: ["coal_ore"],
      targetItem: "coal",
      targetCount: 1,
      maxCount: 8,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
    let attempts = 0;
    toolContext.game.observeStatus = async () => ({
      ...status,
      inventory: { coal: attempts === 0 ? 0 : 2 },
    });
    toolContext.game.findSafeActionCandidates = async () => [
      {
        id: "coal-ore",
        label: "石炭鉱石",
        action: "mine_block",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: false,
        impact: "medium",
        operationClass: "natural_resource",
        requestedCount: 1,
        resourceName: "coal_ore",
        goalItem: "coal",
        distance: 1,
        steps: [
          {
            tool: "mine_block",
            input: { name: "coal_ore", position: { x: 1, y: 64, z: 0 } },
          },
        ],
      },
    ];
    toolContext.game.mineBlock = async () => {
      attempts += 1;
      return {
        before: status,
        after: { ...status, inventory: { coal: 2 } },
        outcome: "failed",
        failureCategory: "inventory",
        failureCode: "DROP_NOT_COLLECTED",
        summary: "回収の完了判定ができませんでした。",
      };
    };

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "石炭を1個集めて",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "SAFE_ACTION_INVENTORY_EXCEEDS_BOUND",
        confirmedState: { observedIncrease: 2, authorizedCount: 1 },
      },
    });
    expect(attempts).toBe(1);
  });

  it("tries another observed ore after a verified pre-dig path failure", async () => {
    const toolContext = context();
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "石炭を1個集めて",
      allowedResources: ["coal_ore"],
      targetItem: "coal",
      targetCount: 1,
      maxCount: 8,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
    const attempted: number[] = [];
    toolContext.game.observeStatus = async () => ({
      ...status,
      inventory: { coal: attempted.includes(2) ? 1 : 0 },
    });
    toolContext.game.findSafeActionCandidates = async () =>
      [1, 2].map((index) => ({
        id: `ore-${String(index)}`,
        label: `石炭鉱石${String(index)}`,
        action: "mine_block" as const,
        observed: true as const,
        purposeFit: "direct" as const,
        permission: "allowed" as const,
        safety: "allowed" as const,
        reversible: false,
        impact: "medium" as const,
        operationClass: "natural_resource" as const,
        requestedCount: 1,
        resourceName: "coal_ore",
        goalItem: "coal",
        distance: index,
        steps: [
          {
            tool: "mine_block",
            input: {
              name: "coal_ore",
              position: { x: index, y: 64, z: 0 },
            },
          },
        ],
      }));
    toolContext.game.mineBlock = async (input) => {
      attempted.push(input.position.x);
      return input.position.x === 1
        ? {
            before: status,
            after: status,
            outcome: "failed",
            failureCategory: "path",
            failureCode: "MINE_APPROACH_PATH_BLOCKED",
            confirmedState: { blockMutationStarted: false },
            summary: "到達できませんでした。",
          }
        : {
            before: status,
            after: { ...status, inventory: { coal: 1 } },
            outcome: "completed",
            confirmedState: {
              item: "coal",
              requestedCount: 1,
              collectedCount: 1,
              heldCount: 1,
            },
            summary: "所持品の増加を確認しました。",
          };
    };

    const result = await new ToolExecutor().execute(
      "plan_safe_action",
      JSON.stringify({
        goal: "石炭を1個集めて",
        count: 1,
        mode: "delegated",
        candidateId: null,
      }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: true,
      data: { completedCount: 1, candidateId: "ore-2" },
    });
    expect(attempted).toEqual([1, 2]);
  });

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

  it("rejects repeated action steps before their cumulative quantity exceeds the candidate bound", async () => {
    const toolContext = context();
    let gatherCalls = 0;
    toolContext.game.findSafeActionCandidates = async () => [
      {
        id: "repeated-gather",
        label: "同じ原木を二重に採取する計画",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        requestedCount: 1,
        steps: [
          {
            tool: "gather_resource",
            input: { resource: "oak_log", count: 1, commitmentId: null },
          },
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
        confirmedState: {
          resource: "oak_log",
          requestedCount: 1,
          collectedCount: 1,
        },
        summary: "原木を収集しました。",
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
      success: false,
      error: { code: "SAFE_ACTION_STEP_COUNT_LIMIT" },
    });
    expect(gatherCalls).toBe(1);
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

  it("rejects goal progress without a verified inventory item", async () => {
    const toolContext = context();
    toolContext.game.findSafeActionCandidates = async () => [
      {
        id: "unidentified-output",
        label: "対象不明の採取",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: true,
        impact: "low",
        operationClass: "natural_resource",
        resourceName: "oak_log",
        goalItem: "oak_log",
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
        requestedCount: 1,
        collectedCount: 1,
      },
      summary: "対象itemを特定できない採取結果です。",
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

  it("stops repeated intermediate progress at the bounded target count", async () => {
    let round = 0;
    let gathers = 0;
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
    toolContext.game.gatherResource = async () => {
      gathers += 1;
      return {
        before: status,
        after: status,
        outcome: "completed",
        confirmedState: {
          item: "raw_iron",
          requestedCount: 1,
          collectedCount: 1,
        },
        summary: "raw_ironを確認しました。",
      };
    };

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
        confirmedState: { intermediateCount: 1, intermediateLimit: 1 },
      },
    });
    expect(round).toBe(2);
    expect(gathers).toBe(1);
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

  it("binds a direct gather to the trusted resource and remaining quantity", async () => {
    const toolContext = context();
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "オークの原木を1本集めて",
      allowedResources: ["oak_log"],
      targetItem: "oak_log",
      targetCount: 1,
      maxCount: 16,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
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
        summary: "原木を収集しました。",
      };
    };

    const wrongResource = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({ resource: "spruce_log", count: 1, commitmentId: null }),
      toolContext,
    );
    const wrongCount = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({ resource: "oak_log", count: 2, commitmentId: null }),
      toolContext,
    );
    expect(wrongResource).toMatchObject({
      success: false,
      error: { code: "SAFE_ACTION_AUTHORIZATION_INVALID" },
    });
    expect(wrongCount).toMatchObject({
      success: false,
      error: { code: "SAFE_ACTION_AUTHORIZATION_INVALID" },
    });
    expect(gatherCalls).toBe(0);

    const first = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({ resource: "oak_log", count: 1, commitmentId: null }),
      toolContext,
    );
    const replay = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({ resource: "oak_log", count: 1, commitmentId: null }),
      toolContext,
    );
    expect(first).toMatchObject({ success: true });
    expect(replay).toMatchObject({
      success: false,
      error: { code: "SAFE_ACTION_AUTHORIZATION_INVALID" },
    });
    expect(toolContext.safeActionAuthorizationUsage).toEqual({
      remainingCount: 0,
      consumed: false,
    });
    expect(gatherCalls).toBe(1);
  });

  it.each([
    [
      "different item",
      { item: "spruce_log", requestedCount: 1, collectedCount: 1 },
      "SAFE_ACTION_PROGRESS_INVALID",
    ],
    [
      "changed request",
      { item: "oak_log", requestedCount: 2, collectedCount: 1 },
      "SAFE_ACTION_PROGRESS_INVALID",
    ],
    [
      "excess pickup",
      { item: "oak_log", requestedCount: 1, collectedCount: 2 },
      "SAFE_ACTION_PROGRESS_INVALID",
    ],
    [
      "missing progress",
      { item: "oak_log" },
      "SAFE_ACTION_PROGRESS_UNCONFIRMED",
    ],
  ])("stops a direct gather after %s", async (_case, confirmedState, code) => {
    const toolContext = context();
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "オークの原木を1本集めて",
      allowedResources: ["oak_log"],
      targetItem: "oak_log",
      targetCount: 1,
      maxCount: 16,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
    let calls = 0;
    toolContext.game.gatherResource = async () => {
      calls += 1;
      return {
        before: status,
        after: status,
        outcome: "completed",
        confirmedState,
        summary: "採取結果を観測しました。",
      };
    };
    const request = JSON.stringify({
      resource: "oak_log",
      count: 1,
      commitmentId: null,
    });

    const result = await new ToolExecutor().execute(
      "gather_resource",
      request,
      toolContext,
    );
    const replay = await new ToolExecutor().execute(
      "gather_resource",
      request,
      toolContext,
    );
    expect(result).toMatchObject({ success: false, error: { code } });
    expect(replay).toMatchObject({
      success: false,
      error: { code: "SAFE_ACTION_AUTHORIZATION_INVALID" },
    });
    expect(toolContext.safeActionAuthorizationUsage.consumed).toBe(true);
    expect(calls).toBe(1);
  });

  it("consumes a confirmed partial direct gather before allowing the remainder", async () => {
    const toolContext = context();
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "オークの原木を3本集めて",
      allowedResources: ["oak_log"],
      targetItem: "oak_log",
      targetCount: 3,
      maxCount: 16,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 3,
      consumed: false,
    };
    let gatherCalls = 0;
    toolContext.game.gatherResource = async (resource, count) => {
      gatherCalls += 1;
      if (gatherCalls === 1) {
        return {
          before: status,
          after: status,
          outcome: "failed",
          failureCategory: "internal",
          failureCode: "GATHER_INTERRUPTED",
          failureRetryable: true,
          confirmedState: {
            resource,
            requestedCount: count,
            collectedCount: 2,
          },
          summary: "2個を確認したところで採取を中断しました。",
        };
      }
      return {
        before: status,
        after: status,
        outcome: "completed",
        confirmedState: {
          resource,
          requestedCount: count,
          collectedCount: count,
        },
        summary: "残りを収集しました。",
      };
    };

    const partial = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({ resource: "oak_log", count: 3, commitmentId: null }),
      toolContext,
    );
    expect(partial).toMatchObject({
      success: false,
      error: { code: "GATHER_INTERRUPTED" },
    });
    expect(toolContext.safeActionAuthorizationUsage).toEqual({
      remainingCount: 1,
      consumed: false,
    });

    const remainder = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({ resource: "oak_log", count: 1, commitmentId: null }),
      toolContext,
    );
    expect(remainder).toMatchObject({ success: true });
    expect(gatherCalls).toBe(2);
  });

  it("uses bounded defaults when follow distance and duration are omitted", async () => {
    const toolContext = context();
    let received: { distance: number; duration: number } | undefined;
    toolContext.game.followOwner = async (distance, duration) => {
      received = { distance, duration };
      return {
        before: status,
        after: status,
        outcome: "completed",
        summary: "追従しました。",
      };
    };

    const result = await new ToolExecutor().execute(
      "follow_player",
      JSON.stringify({ safeDistance: null, maxDurationSeconds: null }),
      toolContext,
    );

    expect(result).toMatchObject({ success: true });
    expect(received).toEqual({ distance: 3, duration: 60 });
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

  it("searches for an owner-authorized tree before asking for its species", async () => {
    const toolContext = context();
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "木を1本切って",
      allowedResources: ["birch_log", "oak_log"],
      targetItem: "*",
      selectionRequired: true,
      targetCount: 1,
      maxCount: 16,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
    toolContext.game.findSafeResourceCandidates = async () => [];
    let searches = 0;
    toolContext.game.searchSafeResourceCandidates = async () => {
      searches += 1;
      return {
        candidates: [{ resource: "birch_log", distance: 3 }],
        attemptedWaypoints: 1,
        blockedWaypoints: 0,
      };
    };

    const result = await new ToolExecutor().execute(
      "select_safe_resource",
      JSON.stringify({ count: 1 }),
      toolContext,
    );

    expect(result).toMatchObject({
      success: true,
      data: { resource: "birch_log", count: 1 },
    });
    expect(searches).toBe(1);
    expect(toolContext.safeActionAuthorization).toMatchObject({
      targetItem: "birch_log",
      allowedResources: ["birch_log"],
    });
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

  it("blocks persistent memory writes while a stopped goal remains read-only", async () => {
    const stopped = context();
    stopped.allowActionTools = false;
    for (const [name, argumentsJson] of [
      [
        "remember_player_fact",
        JSON.stringify({ subject: "利用者", predicate: "希望", value: "桜" }),
      ],
      ["forget_delivery_target", JSON.stringify({ kind: "chest" })],
    ] as const) {
      const result = await new ToolExecutor().execute(
        name,
        argumentsJson,
        stopped,
      );
      expect(result).toMatchObject({
        success: false,
        error: { code: "STOPPED_GOAL_ACTION_NOT_ALLOWED" },
      });
    }
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
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "オークの原木を1本集めて",
      allowedResources: ["oak_log"],
      targetItem: "oak_log",
      targetCount: 1,
      maxCount: 16,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
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

  it("rejects an unbound gather while still allowing an explicit stop", async () => {
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

    expect(unbound).toMatchObject({
      success: false,
      error: { code: "SAFE_ACTION_AUTHORIZATION_INVALID" },
    });
    expect(stopped.success).toBe(true);
    expect(toolContext.executionEvidence.verifiedActionReceipts).toEqual([]);
  });

  it("does not treat an active commitment as an owner gather grant", async () => {
    const toolContext = context();
    let gatherCalls = 0;
    toolContext.game.gatherResource = async () => {
      gatherCalls += 1;
      throw new Error("unexpected gather");
    };
    const result = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({
        resource: "oak_log",
        count: 1,
        commitmentId: "commitment",
      }),
      toolContext,
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: "SAFE_ACTION_AUTHORIZATION_INVALID" },
    });
    expect(gatherCalls).toBe(0);
  });

  it("does not issue a receipt when gather input differs from typed fulfillment", async () => {
    const toolContext = context();
    toolContext.safeActionAuthorization = {
      kind: "owner_bounded_resource",
      goal: "シラカバの原木を1本集めて",
      allowedResources: ["birch_log"],
      targetItem: "birch_log",
      targetCount: 1,
      maxCount: 16,
    };
    toolContext.safeActionAuthorizationUsage = {
      remainingCount: 1,
      consumed: false,
    };
    const unrelated = await new ToolExecutor().execute(
      "gather_resource",
      JSON.stringify({
        resource: "birch_log",
        count: 1,
        commitmentId: "commitment",
      }),
      toolContext,
    );

    expect(unrelated).toMatchObject({
      success: false,
      error: { code: "SAFE_ACTION_AUTHORIZATION_INVALID" },
    });
    expect(toolContext.executionEvidence.verifiedActionReceipts).toEqual([]);
  });
});
