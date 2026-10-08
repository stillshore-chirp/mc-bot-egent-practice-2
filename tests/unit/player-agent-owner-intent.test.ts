import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Response } from "openai/resources/responses/responses.js";

import { McSkillRepository } from "../../src/mc-skills/index.js";
import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";
import type {
  PlayerBody,
  PlayerBodyObservation,
  PlayerKnowledge,
} from "../../src/minecraft/player-body.js";
import type {
  OwnerProposal,
  PlayerGoal,
  PlayerMemoryPort,
  PlayerRuntimeSnapshot,
} from "../../src/player/contracts.js";
import {
  compactSnapshot,
  conversationReplyNeedsRefresh,
  PlayerConversationAgent,
  PlayerPurposeAgent,
  playerOperationCatalog,
} from "../../src/player/agents.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import {
  projectSafePlayerAgentActivityTail,
  type PlayerAgentCallResult,
  type PlayerAgentRoundActivity,
  type PlayerResponsesClient,
} from "../../src/player/responses.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("player owner intent context", () => {
  it("uses registry prerequisites and Body results to continue the same owner goal", async () => {
    let observation = observationWithInventory([
      itemStack(0, 17, "oak_log", 1),
      itemStack(1, 35, "white_wool", 3),
    ]);
    const knowledgeQueries: string[] = [];
    const fixture = openPurposeFixture(
      createMemoryPort(),
      [],
      undefined,
      async () => observation,
      (query) => {
        knowledgeQueries.push(query);
        if (query === "white_bed")
          return knowledgeFixture(
            query,
            1,
            true,
            [
              { name: "white_wool", count: 3 },
              { name: "oak_planks", count: 3 },
            ],
            false,
          );
        if (query === "oak_planks")
          return knowledgeFixture(
            query,
            4,
            false,
            [{ name: "oak_log", count: 1 }],
            true,
          );
        if (query === "crafting_table")
          return knowledgeFixture(
            query,
            1,
            false,
            [{ name: "oak_planks", count: 4 }],
            true,
          );
        throw new Error("UNEXPECTED_KNOWLEDGE_QUERY");
      },
    );
    const savedGoal = fixture.mind.commitGoalState({
      expectedRevision: fixture.mind.snapshot().revision,
      goal: {
        id: "owner-bed-goal",
        title: "Make a white bed",
        status: "active",
        priority: 3,
        changeReason: "The owner asked for a bed.",
        source: "owner",
      },
    });
    expect(savedGoal.accepted).toBe(true);
    try {
      fixture.mind.recordOutcome({
        evidence: {
          operationId: "failed-direct-bed-craft",
          kind: "craft",
          status: "failed",
          summary:
            "failure=no_recipe_for_current_inventory_and_surface; bed materials or surface were missing",
          observedAt: "2026-10-08T00:00:00.000Z",
        },
      });
      fixture.responses.push(
        functionCallResponse("bed-recipe", "ask_body_knowledge", {
          query: "white_bed",
        }),
        functionCallResponse("plank-recipe", "ask_body_knowledge", {
          query: "oak_planks",
        }),
        functionCallResponse(
          "prepare-planks",
          "commit_action_decision",
          craftActionArguments("owner-bed-goal", "oak_planks"),
        ),
      );
      const prepared = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(prepared).toMatchObject({
        accepted: true,
        decision: {
          kind: "act",
          operation: { kind: "craft", item: "oak_planks", count: 1 },
        },
      });
      expect(knowledgeQueries).toEqual(["white_bed", "oak_planks"]);
      const initialRequest = record(fixture.requests[0]);
      expect(JSON.stringify(initialRequest.input)).toContain(
        "failure=no_recipe_for_current_inventory_and_surface",
      );
      const instructions = String(initialRequest.instructions);
      expect(instructions).toContain("ownerから新しい依頼がない時も");
      expect(instructions).toContain("同じownerの意図への催促・言い換え");
      expect(JSON.stringify(initialRequest.tools)).toContain(
        "currentlyCraftableは作業台がある前提",
      );
      const firstKnowledge = functionCallOutputs(fixture.requests.slice(0, 3));
      expect(firstKnowledge).toContain('"assessedCount":1');
      expect(firstKnowledge).toContain('"craftingTableNearby":false');
      expect(firstKnowledge).toContain(
        '"materialAvailabilityWithTable":"insufficient"',
      );
      expect(firstKnowledge).toContain('"count":4');
      const firstDecision = prepared.decision;
      if (firstDecision?.kind !== "act")
        throw new Error("TEST_PREPARATION_ACTION_MISSING");

      observation = observationWithInventory([
        itemStack(0, 5, "oak_planks", 4),
        itemStack(1, 35, "white_wool", 3),
      ]);
      fixture.mind.recordOutcome({
        evidence: {
          operationId: firstDecision.operationId,
          kind: "craft",
          status: "successful",
          summary:
            "craft successful; the fresh inventory contains four oak planks",
          observedAt: "2026-10-08T00:00:05.000Z",
          expectedOutcome: firstDecision.expectedOutcome,
        },
      });
      fixture.responses.push(
        functionCallResponse("table-recipe", "ask_body_knowledge", {
          query: "crafting_table",
        }),
        functionCallResponse(
          "continue-bed-goal",
          "commit_action_decision",
          craftActionArguments("owner-bed-goal", "crafting_table"),
        ),
      );
      const continued = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(continued).toMatchObject({
        accepted: true,
        decision: {
          kind: "act",
          operation: { kind: "craft", item: "crafting_table", count: 1 },
        },
      });
      expect(knowledgeQueries).toEqual([
        "white_bed",
        "oak_planks",
        "crafting_table",
      ]);
      const continuedKnowledge = functionCallOutputs(fixture.requests.slice(3));
      expect(continuedKnowledge).toContain('"craftingTableNearby":false');
      expect(continuedKnowledge).toContain(
        '"materialAvailabilityWithTable":"sufficient"',
      );
      const continuationRequest = record(fixture.requests[3]);
      expect(JSON.stringify(continuationRequest.input)).toContain(
        "craft successful; the fresh inventory contains four oak planks",
      );
      if (!Array.isArray(continuationRequest.input))
        throw new Error("TEST_EXPECTED_RESPONSES_INPUT_ITEMS");
      const continuationPayload = JSON.parse(
        String(record(continuationRequest.input[0]).content),
      ) as {
        observation: {
          self: {
            inventory: readonly { name: string; count: number }[];
          };
        };
      };
      expect(continuationPayload.observation.self.inventory).toContainEqual(
        expect.objectContaining({ name: "oak_planks", count: 4 }),
      );
      expect(
        fixture.mind
          .snapshot()
          .goals.filter(({ source }) => source === "owner"),
      ).toEqual([
        expect.objectContaining({
          id: "owner-bed-goal",
          title: "Make a white bed",
          status: "active",
        }),
      ]);
    } finally {
      fixture.close();
    }
  });

  it.each(["body_outcome", "owner_proposal"] as const)(
    "keeps completed response usage and skips stale purpose tools and rounds when %s arrives",
    async (staleKind) => {
      const fixture = openPurposeFixture(createMemoryPort());
      let markRequestStarted!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
      });
      let resolveResponse!: (response: Response) => void;
      const pendingResponse = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      fixture.responses.push(() => {
        markRequestStarted();
        return pendingResponse;
      });

      try {
        const thought = fixture.agent.think({
          snapshot: fixture.mind.snapshot(),
          events: [],
          shouldStopAfterResponse: () =>
            fixture.mind
              .pendingEvents(32)
              .some(({ kind }) => kind === staleKind),
        });
        await requestStarted;

        if (staleKind === "owner_proposal") {
          fixture.mind.addProposal({
            title: "Meet at the bridge",
            reason: "The owner requested a new destination.",
          });
        } else {
          fixture.mind.enqueueEvent("body_outcome", "test body result arrived");
        }
        resolveResponse(
          functionCallResponse(
            "stale-description",
            "describe_operation",
            { kind: "dig" },
            responseUsage(19, 7),
          ),
        );
        const result = await thought;

        expect(result.accepted).toBe(false);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.calls).toHaveLength(1);
        expect(fixture.calls[0]).toMatchObject({
          calls: 1,
          inputTokens: 19,
          outputTokens: 7,
        });
        expect(
          fixture.mind.snapshot().recentAgentActivity.at(-1),
        ).toMatchObject({
          responseStatus: "completed",
          processingStatus: "interrupted",
          inputTokens: 19,
          outputTokens: 7,
          functionCallCount: 1,
          toolCalls: [],
        });
      } finally {
        fixture.close();
      }
    },
  );

  it("cancels a read-only body observation wait after an owner proposal", async () => {
    let observationCount = 0;
    let markToolObservationStarted!: () => void;
    const toolObservationStarted = new Promise<void>((resolve) => {
      markToolObservationStarted = resolve;
    });
    let resolvePendingObservation!: (
      observation: PlayerBodyObservation,
    ) => void;
    const pendingObservation = new Promise<PlayerBodyObservation>((resolve) => {
      resolvePendingObservation = resolve;
    });
    const fixture = openPurposeFixture(
      createMemoryPort(),
      [],
      undefined,
      async () => {
        observationCount += 1;
        if (observationCount === 1)
          throw new Error("INITIAL_OBSERVATION_UNAVAILABLE");
        markToolObservationStarted();
        return pendingObservation;
      },
    );
    fixture.responses.push(
      functionCallResponse(
        "owner-proposal-observe",
        "observe_body",
        {},
        responseUsage(19, 7),
      ),
    );
    const controller = new AbortController();
    const requestStates: boolean[] = [];
    let usageRecordedBeforeRequestSettled = false;

    try {
      const thought = fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
        signal: controller.signal,
        shouldStopAfterResponse: () => controller.signal.aborted,
        onResponsesRequestState: (active) => {
          requestStates.push(active);
          if (!active) {
            const recordedCall = fixture.calls.at(0);
            usageRecordedBeforeRequestSettled =
              recordedCall?.inputTokens === 19 &&
              recordedCall.outputTokens === 7;
          }
        },
      });
      await toolObservationStarted;
      fixture.mind.addProposal({
        title: "Return to the owner",
        reason: "The owner requested a new destination.",
      });
      controller.abort(new Error("owner_proposal_preempted_thought"));

      await expect(thought).rejects.toThrow("owner_proposal_preempted_thought");
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0]).toMatchObject({
        inputTokens: 19,
        outputTokens: 7,
      });
      expect(requestStates).toEqual([true, false]);
      expect(usageRecordedBeforeRequestSettled).toBe(true);
      expect(fixture.mind.snapshot().recentAgentActivity.at(-1)).toMatchObject({
        responseStatus: "completed",
        processingStatus: "interrupted",
      });
    } finally {
      resolvePendingObservation(bodyObservationFixture());
      fixture.close();
    }
  });

  it("records owner proposal settlement timeout as unknown usage with its cause", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const controller = new AbortController();
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    fixture.responses.push((_request, options) => {
      markRequestStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = options?.signal;
        const rejectAbortedRequest = (): void => {
          const reason: unknown = signal?.reason;
          reject(
            reason instanceof Error ? reason : new Error("request_aborted"),
          );
        };
        if (signal?.aborted) {
          rejectAbortedRequest();
          return;
        }
        signal?.addEventListener("abort", rejectAbortedRequest, {
          once: true,
        });
      });
    });

    try {
      const thought = fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
        signal: controller.signal,
      });
      await requestStarted;
      controller.abort(new Error("owner_proposal_settlement_timeout"));

      await expect(thought).rejects.toThrow(
        "owner_proposal_settlement_timeout",
      );
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0]).toMatchObject({
        calls: 1,
        inputTokens: 0,
        outputTokens: 0,
        usageUnknown: true,
        usageUnknownReason: "request_error",
      });
      expect(fixture.mind.snapshot().recentAgentActivity.at(-1)).toMatchObject({
        responseStatus: "request_error",
        processingStatus: "interrupted",
        requestErrorCause: "owner_proposal",
      });
    } finally {
      fixture.close();
    }
  });

  it("rechecks a body outcome from the completed-round callback before another request", async () => {
    let bodyOutcomeQueued = false;
    const fixture = openPurposeFixture(createMemoryPort(), [], (activity) => {
      if (
        !bodyOutcomeQueued &&
        activity.round === 1 &&
        activity.processingStatus === "complete"
      ) {
        bodyOutcomeQueued = true;
        fixture.mind.enqueueEvent("body_outcome", "test body result arrived");
      }
    });
    fixture.responses.push(
      functionCallResponse("stale-description", "describe_operation", {
        kind: "dig",
      }),
    );

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
        shouldStopAfterResponse: () =>
          fixture.mind
            .pendingEvents(32)
            .some(({ kind }) => kind === "body_outcome"),
      });

      expect(result.accepted).toBe(false);
      expect(bodyOutcomeQueued).toBe(true);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.mind.snapshot().recentAgentActivity.at(-1)).toMatchObject({
        processingStatus: "complete",
        functionCallCount: 1,
        toolCalls: [{ name: "describe_operation" }],
      });
    } finally {
      fixture.close();
    }
  });

  it("grounds capability answers in the current public operation catalog", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const messages: string[] = [];
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      say: async (message) => {
        messages.push(message);
      },
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    fixture.responses.push(terminalResponse("digは使えます。"));

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "digは使えますか？",
        turn: conversation.nextTurn(),
      });

      const request = record(fixture.requests[0]);
      expect(String(request.instructions)).toContain(
        "能力や実行条件の相談では必要に応じてdescribe_operationを呼び",
      );
      expect(String(request.instructions)).toContain(
        "operation manualを根拠に答えてください",
      );
      expect(JSON.stringify(request.tools)).toContain(
        '"name":"describe_operation"',
      );
      expect(String(request.instructions)).toContain(playerOperationCatalog);
      expect(request.tool_choice).toBe("auto");
      expect(messages).toEqual(["digは使えます。"]);
      expect(fixture.mind.snapshot().proposals).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  it("grounds nearby-enemy answers in a bounded current-view body observation", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const baseObservation = bodyObservationFixture();
    const entities: PlayerBodyObservation["perception"]["entities"] = [
      ...Array.from({ length: 9 }, (_, index) => ({
        id: 300000 + index,
        name: "item",
        kind: "item",
        category: null,
        position: {
          x: index,
          y: 64,
          z: -0.5,
          dimension: "overworld",
        },
        distance: 0.5 + index,
        health: null,
        isPlayer: false,
      })),
      {
        id: 314159,
        name: "zombie",
        kind: "zombie",
        category: "Hostile mobs",
        position: { x: 4, y: 64, z: -3, dimension: "overworld" },
        distance: 5.02,
        health: 13.4,
        isPlayer: false,
        equipment: { mainHand: "iron_sword", offHand: null, head: null },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: 314160 + index,
        name: index === 0 ? "skeleton" : `hostile_${index}`,
        kind: index === 0 ? "skeleton" : `hostile_${index}`,
        category: "Hostile mobs",
        position: {
          x: 20 + index,
          y: 64,
          z: -3,
          dimension: "overworld",
        },
        distance: 10 + index,
        health: null,
        isPlayer: false,
      })),
      {
        id: 314999,
        name: "private-player-name",
        kind: "player",
        category: null,
        position: { x: 1, y: 64, z: -1, dimension: "overworld" },
        distance: 1.5,
        health: 20,
        isPlayer: true,
        username: "private-player-name",
      },
    ];
    const observation: PlayerBodyObservation = {
      ...baseObservation,
      perception: {
        ...baseObservation.perception,
        candidateSearchMayBeTruncated: true,
        omittedEntityCandidates: 2,
        entities,
        nearbyHostiles: {
          source: "client_received_unoccluded_nearby_hostiles",
          observedAt: baseObservation.observedAt,
          maxDistance: 16,
          entityOutputLimit: 16,
          omittedEntityCandidates: 2,
          candidateSearchMayBeTruncated: true,
          aggregate: {
            source: "client_received_hostile_entity_candidates",
            countScope: "client_entity_table_within_max_distance",
            maxDistance: 16,
            clientReceivedHostileCount: 100,
            worldAbsenceEstablished: false,
            directionFrame: "minecraft_cardinal_from_self_position",
            relativeOffsetFrame: "entity_position_minus_self_position",
            relativeOffsetBounds: {
              min: { x: -10, y: -3, z: -8 },
              max: { x: 12, y: 4, z: 15 },
            },
            byKind: [
              { name: "zombie", count: 70 },
              { name: "skeleton", count: 30 },
            ],
            omittedKindGroupCount: 0,
            omittedKindEntityCount: 0,
            byDirection: (
              [
                "north",
                "northeast",
                "east",
                "southeast",
                "south",
                "southwest",
                "west",
                "northwest",
                "coincident",
              ] as const
            ).map((direction) => ({
              direction,
              count: direction === "north" ? 60 : 0,
              nearestDistance: direction === "north" ? 2.2 : null,
              farthestDistance: direction === "north" ? 15 : null,
              relativeOffsetBounds:
                direction === "north"
                  ? {
                      min: { x: -4, y: -1, z: -14 },
                      max: { x: 3, y: 2, z: -1 },
                    }
                  : null,
            })),
            occlusionCheck: {
              method: "raycast_entity_body_point",
              candidateLimit: 16,
              candidatesChecked: 16,
              unoccludedCandidates: 10,
              occludedCandidates: 6,
              uncheckedCandidates: 84,
              detailOutputLimit: 16,
              omittedUnoccludedDetails: 0,
            },
          },
          entities: [
            ...entities.slice(9, 10),
            {
              id: 315000,
              name: "skeleton",
              kind: "skeleton",
              category: "Hostile mobs",
              position: { x: 0, y: 64, z: 4, dimension: "overworld" },
              distance: 4,
              health: 20,
              isPlayer: false,
              equipment: { mainHand: "bow", feet: null },
            },
          ],
        },
      },
    };
    const messages: string[] = [];
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      observeBody: async () => observation,
      say: async (message) => {
        messages.push(message);
      },
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    fixture.responses.push(
      conversationFunctionCallResponse(
        "observe-enemies",
        "observe_body",
        {},
        "周りの候補を確かめるね。",
      ),
      terminalResponse("視界内にゾンビがいます。"),
    );

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "近くの敵の種類や装備は？",
        turn: conversation.nextTurn(),
      });

      const initialRequest = record(fixture.requests[0]);
      expect(String(initialRequest.instructions)).toContain(
        "敵など現在の周辺情報を尋ねられたらobserve_bodyを使います",
      );
      expect(String(initialRequest.instructions)).toContain(
        "aggregate.byKind/byDirection/relativeOffsetBoundsは出力上限前の候補の種類・方角・相対分布",
      );
      expect(JSON.stringify(initialRequest.tools)).toContain(
        '"name":"observe_body"',
      );
      const continuation = record(fixture.requests[1]);
      if (!Array.isArray(continuation.input))
        throw new Error("TEST_EXPECTED_RESPONSES_INPUT_ITEMS");
      const toolOutput = continuation.input
        .map(record)
        .find(({ type }) => type === "function_call_output");
      const output = JSON.parse(String(toolOutput?.output)) as unknown;
      const serializedOutput = JSON.stringify(output);
      expect(record(output).visibleEntities).toHaveLength(8);
      expect(serializedOutput).toContain('"name":"zombie"');
      expect(serializedOutput).toContain('"kind":"zombie"');
      expect(serializedOutput).toContain('"distance":5');
      expect(serializedOutput).toContain('"relativeDirection":"ahead_right"');
      expect(serializedOutput).toContain('"health":13.4');
      expect(serializedOutput).toContain('"mainHand":"iron_sword"');
      expect(serializedOutput).toContain('"offHand":null');
      expect(serializedOutput).toContain('"feet":"unknown"');
      expect(serializedOutput).toContain(
        '"coverage":"visible_non_player_subset"',
      );
      expect(serializedOutput).toContain('"omittedVisibleCandidates":true');
      expect(serializedOutput).toContain(
        '"candidateSearchMayBeTruncated":true',
      );
      expect(serializedOutput).toContain('"worldAbsenceEstablished":false');
      expect(serializedOutput).toContain('"observedVisibleEntityCount":18');
      const nearbySummary = record(output).nearbyHostiles;
      expect(nearbySummary).toMatchObject({
        available: true,
        source: "client_received_unoccluded_nearby_hostiles",
        observedAt: baseObservation.observedAt,
        coverage: "client_received_hostile_candidates",
        detailCoverage: "raycast_unoccluded_hostile_details",
        maxDistance: 16,
        entityOutputLimit: 16,
        observedHostileCountLowerBound: 2,
        frontViewOverlapEntityCount: 1,
        omittedEntityCandidates: 2,
        candidateSearchMayBeTruncated: true,
        worldAbsenceEstablished: false,
      });
      expect(nearbySummary).toMatchObject({
        aggregate: {
          source: "client_received_hostile_entity_candidates",
          countScope: "client_entity_table_within_max_distance",
          maxDistance: 16,
          clientReceivedHostileCount: 100,
          worldAbsenceEstablished: false,
          directionFrame: "minecraft_cardinal_from_self_position",
          relativeOffsetFrame: "entity_position_minus_self_position",
          relativeOffsetBounds: {
            min: { x: -10, y: -3, z: -8 },
            max: { x: 12, y: 4, z: 15 },
          },
          byKind: [
            { name: "zombie", count: 70 },
            { name: "skeleton", count: 30 },
          ],
          omittedKindGroupCount: 0,
          omittedKindEntityCount: 0,
          occlusionCheck: {
            method: "raycast_entity_body_point",
            candidateLimit: 16,
            candidatesChecked: 16,
            unoccludedCandidates: 10,
            occludedCandidates: 6,
            uncheckedCandidates: 84,
            detailOutputLimit: 16,
            omittedUnoccludedDetails: 0,
          },
        },
      });
      const aggregate = record(record(nearbySummary).aggregate);
      const directionCounts = z
        .array(
          z.object({
            direction: z.string(),
            count: z.number(),
            nearestDistance: z.number().nullable(),
            farthestDistance: z.number().nullable(),
          }),
        )
        .parse(aggregate.byDirection);
      expect(
        directionCounts.some(
          (entry) =>
            entry.direction === "north" &&
            entry.count === 60 &&
            entry.nearestDistance === 2.2 &&
            entry.farthestDistance === 15,
        ),
      ).toBe(true);
      expect(
        directionCounts.some(
          (entry) => entry.direction === "coincident" && entry.count === 0,
        ),
      ).toBe(true);
      const nearbyEntities = record(nearbySummary).entities as Record<
        string,
        unknown
      >[];
      expect(nearbyEntities).toHaveLength(1);
      expect(nearbyEntities[0]).toMatchObject({
        name: "skeleton",
        kind: "skeleton",
        distance: 4,
        relativeDirection: "behind",
        equipment: {
          mainHand: "bow",
          offHand: "unknown",
        },
      });
      expect(record(output).visibleEntities).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "zombie" })]),
      );
      expect(serializedOutput).not.toContain('"name":"item"');
      expect(serializedOutput).not.toContain("private-player-name");
      expect(serializedOutput).not.toContain('"position"');
      expect(serializedOutput).not.toContain('"id"');
      expect(messages).toEqual([
        "周りの候補を確かめるね。",
        "視界内にゾンビがいます。",
      ]);
    } finally {
      fixture.close();
    }
  });

  it("retries one failed conversation observation with a fresh bounded read", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const observation = bodyObservationFixture();
    let attempts = 0;
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      observeBody: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("TRANSIENT_OBSERVATION_FAILURE");
        return observation;
      },
      say: async () => undefined,
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    fixture.responses.push(
      conversationFunctionCallResponse(
        "retry-observation",
        "observe_body",
        {},
        "周りの状態を確認するね。",
      ),
      terminalResponse("I checked again and have a fresh view."),
    );

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "近くの状況を見て。",
        turn: conversation.nextTurn(),
      });

      expect(attempts).toBe(2);
      const continuation = record(fixture.requests[1]);
      if (!Array.isArray(continuation.input))
        throw new Error("TEST_EXPECTED_RESPONSES_INPUT_ITEMS");
      const toolOutput = continuation.input
        .map(record)
        .find(({ type }) => type === "function_call_output");
      const output = JSON.parse(String(toolOutput?.output)) as unknown;
      expect(record(output)).toMatchObject({
        available: true,
        attempts: 2,
        freshRetryUsed: true,
        observedAt: observation.observedAt,
      });
    } finally {
      fixture.close();
    }
  });

  it("routes an actionable request to Purpose without spending Conversation rounds on observations", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const messages: string[] = [];
    let attempts = 0;
    let proposalWakeups = 0;
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      observeBody: async () => {
        attempts += 1;
        throw new Error("OBSERVATION_UNAVAILABLE");
      },
      say: async (message) => {
        messages.push(message);
      },
      onProposal: () => {
        proposalWakeups += 1;
      },
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    fixture.responses.push(
      conversationFunctionCallResponse(
        "continue-owner-intent",
        "propose_goal_change",
        {
          title: "Gather the wood the owner meant",
          reason:
            "The owner asked me to gather the wood discussed earlier; Purpose can use a fresh observation and choose the first step.",
          priority: 4,
        },
        "頼まれた木を目指して、まず今の目標に反映するね。",
      ),
    );

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "あの木、ちゃんと集めて。さっき周りを見れてなかったよ。",
        turn: conversation.nextTurn(),
      });

      expect(attempts).toBe(0);
      expect(proposalWakeups).toBe(1);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.mind.snapshot().proposals).toContainEqual(
        expect.objectContaining({
          title: "Gather the wood the owner meant",
          status: "pending",
        }),
      );
      expect(messages).toEqual([
        "頼まれた木を目指して、まず今の目標に反映するね。",
      ]);
    } finally {
      fixture.close();
    }
  });

  it("routes owner feedback to current-purpose reassessment without making another goal", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const messages: string[] = [];
    const reassessmentReasons: string[] = [];
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      say: async (message) => {
        messages.push(message);
      },
      onProposal: () => undefined,
      onPurposeReassessment: (reason) => {
        reassessmentReasons.push(reason);
        return true;
      },
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    const reason =
      "The route keeps returning to the blocked entrance; reconsider how to reach the existing collection goal.";
    fixture.responses.push(
      conversationFunctionCallResponse(
        "reassess-current-plan",
        "reassess_my_current_plan",
        { reason },
        "同じ行き止まりを避ける方法を見直すね。",
      ),
      terminalResponse(
        "That route is stuck. I will check the area again and try another way.",
      ),
    );
    const turn = conversation.nextTurn();

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "It keeps looping at that entrance. Rethink the route.",
        turn,
      });

      expect(reassessmentReasons).toEqual([reason]);
      expect(fixture.mind.snapshot().goals).toEqual([]);
      expect(fixture.mind.snapshot().proposals).toEqual([]);
      expect(messages).toEqual(["同じ行き止まりを避ける方法を見直すね。"]);
      expect(fixture.requests).toHaveLength(1);
      expect(String(record(fixture.requests[0]).instructions)).toContain(
        "reassess_my_current_plan",
      );
    } finally {
      conversation.finishTurn(turn);
      fixture.close();
    }
  });

  it("rejects stale and stopped current-purpose reassessment requests", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    let wakeCount = 0;
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      say: async () => undefined,
      onProposal: () => undefined,
      onPurposeReassessment: () => {
        wakeCount += 1;
        return true;
      },
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let resolveResponse!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    fixture.responses.push(
      () => {
        markRequestStarted();
        return pendingResponse;
      },
      conversationFunctionCallResponse(
        "stopped-reassessment",
        "reassess_my_current_plan",
        { reason: "Owner feedback asks me to reconsider the current route." },
        "今の進め方を見直すね。",
      ),
      terminalResponse("I heard you."),
    );
    const staleTurn = conversation.nextTurn();
    const staleRequest = conversation.handleOwnerMessage({
      username: "owner",
      message: "Rethink the route.",
      turn: staleTurn,
    });
    let currentTurn: number | undefined;

    try {
      await requestStarted;
      currentTurn = conversation.nextTurn();
      resolveResponse(
        functionCallResponse("stale-reassessment", "reassess_my_current_plan", {
          reason: "Owner feedback asks me to reconsider the current route.",
        }),
      );
      await staleRequest;
      expect(wakeCount).toBe(0);
      expect(fixture.requests).toHaveLength(1);

      fixture.mind.stop();
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "Rethink the route.",
        turn: currentTurn,
      });
      expect(wakeCount).toBe(0);
      expect(fixture.requests).toHaveLength(3);
      const stoppedContinuation = record(fixture.requests[2]);
      if (!Array.isArray(stoppedContinuation.input))
        throw new Error("TEST_EXPECTED_RESPONSES_INPUT_ITEMS");
      const toolOutput = stoppedContinuation.input
        .map(record)
        .find(({ type }) => type === "function_call_output");
      expect(JSON.parse(String(toolOutput?.output))).toMatchObject({
        ok: false,
        code: "STOPPED_OR_STALE",
      });
    } finally {
      if (currentTurn !== undefined) conversation.finishTurn(currentTurn);
      fixture.close();
    }
  });

  it("delivers an overlong reply without spending another provider call", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const messages: string[] = [];
    let admittedCalls = 0;
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      beforeCall: () => {
        admittedCalls += 1;
      },
      say: async (message) => {
        messages.push(message);
      },
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    const draft = "長い回答".repeat(61);
    fixture.responses.push(terminalResponse(draft));

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "どんな操作ができますか？",
        turn: conversation.nextTurn(),
      });

      const initialRequest = record(fixture.requests[0]);
      expect(initialRequest.tool_choice).toBe("auto");
      expect(fixture.requests).toHaveLength(1);
      expect(admittedCalls).toBe(1);
      expect(messages.join("")).toBe(draft);
      expect(messages).toHaveLength(2);
      expect(messages.every((message) => message.length <= 240)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it.each([
    {
      name: "a committed owner proposal",
      ownerMessage: "近くの木を集めてください。",
      response: conversationFunctionCallResponse(
        "gather-proposal",
        "propose_goal_change",
        {
          title: "Gather nearby wood",
          reason: "The owner asked me to gather wood.",
          priority: 3,
        },
        "近くの木を集める目的に反映するね。",
      ),
      expectedRequests: 1,
      expectedReply: "近くの木を集める目的に反映するね。",
    },
    {
      name: "a saved owner fact",
      ownerMessage: "次回から短い文章で答えてください。",
      response: conversationFunctionCallResponse(
        "save-owner-fact",
        "remember_owner_fact",
        { summary: "The owner prefers concise replies" },
        "次から読みやすく答えられるよう覚えておくね。",
      ),
      expectedRequests: 2,
      expectedReply: "次から読みやすく答えられるよう覚えておくね。",
    },
    {
      name: "a committed stop request",
      ownerMessage: "自律行動を止めてください。",
      response: conversationFunctionCallResponse(
        "stop-autonomy",
        "stop_autonomy",
        { reason: "The owner requested a pause." },
        "自律行動を止めるね。",
      ),
      expectedRequests: 1,
      expectedReply: "自律行動を止めるね。",
    },
  ])(
    "delivers intent before tool work and limits follow-up to $name",
    async ({ ownerMessage, response, expectedRequests, expectedReply }) => {
      const fixture = openPurposeFixture(createMemoryPort());
      const messages: string[] = [];
      const conversation = new PlayerConversationAgent({
        client: scriptedClient(fixture.responses, fixture.requests),
        apiKey: "test-only",
        model: "test-model",
        ownerUsername: "owner",
        mind: fixture.mind,
        memory: createMemoryPort(),
        logger: pino({ level: "silent" }),
        say: async (message) => {
          messages.push(message);
        },
        onProposal: () => undefined,
        onStop: async () => undefined,
        onResume: () => undefined,
      });
      const draft = "長い回答".repeat(61);
      fixture.responses.push(response, terminalResponse(draft));

      try {
        await conversation.handleOwnerMessage({
          username: "owner",
          message: ownerMessage,
          turn: conversation.nextTurn(),
        });

        expect(fixture.requests).toHaveLength(expectedRequests);
        expect(messages[0]).toBe(expectedReply);
        const initialRequest = record(fixture.requests[0]);
        expect(initialRequest.tool_choice).toBe("auto");
        if (expectedRequests === 2) {
          const followup = record(fixture.requests[1]);
          expect(followup.tool_choice).toBe("auto");
          const followupInput = Array.isArray(followup.input)
            ? followup.input
            : [];
          const toolOutputs = followupInput
            .map((item) => record(item))
            .filter(({ type }) => type === "function_call_output");
          expect(toolOutputs).toHaveLength(1);
          expect(messages.slice(1).join("")).toBe(draft);
          expect(messages.length).toBeGreaterThan(2);
          expect(messages.every((message) => message.length <= 240)).toBe(true);
        } else {
          if (ownerMessage === "自律行動を止めてください。")
            expect(fixture.mind.snapshot().stopped).toBe(true);
          expect(messages).toEqual([expectedReply]);
        }
      } finally {
        fixture.close();
      }
    },
  );

  it("carries bounded owner chat context into a short follow-up proposal", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const memory = createMemoryPort();
    const messages: string[] = [];
    let proposalWakeups = 0;
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory,
      logger: pino({ level: "silent" }),
      say: async (message) => {
        messages.push(message);
      },
      onProposal: () => {
        proposalWakeups += 1;
      },
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    const priorFoodMessage = "I have cooked pork chops in my inventory.";
    const followUp = "Eat one now, please.";
    fixture.responses.push(terminalResponse("I can check what is available."));

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: priorFoodMessage,
        turn: conversation.nextTurn(),
      });

      fixture.responses.push(
        conversationFunctionCallResponse(
          "meal-proposal",
          "propose_goal_change",
          {
            title: "Eat one of the foods the owner mentioned",
            reason:
              "The owner is now asking me to eat one of the foods from the recent conversation.",
            priority: 3,
          },
          "I understand you want me to eat one now. I will check what is available before deciding how to proceed.",
        ),
      );
      await conversation.handleOwnerMessage({
        username: "owner",
        message: followUp,
        turn: conversation.nextTurn(),
      });

      const secondRequest = record(fixture.requests[1]);
      expect(JSON.stringify(secondRequest.input)).toContain(priorFoodMessage);
      expect(JSON.stringify(secondRequest.input)).toContain(followUp);
      expect(JSON.stringify(secondRequest.input)).toContain(
        "I can check what is available.",
      );
      expect(String(secondRequest.instructions)).toContain(
        "直近4件までのowner会話",
      );
      expect(String(secondRequest.instructions)).toContain(
        "質問、否定、引用、他者を対象にした発話",
      );
      expect(String(secondRequest.instructions)).toContain(
        "あなたはMinecraft世界でownerと過ごす一人のAIプレイヤーです",
      );
      expect(String(secondRequest.instructions)).toContain(
        "propose_goal_changeの結果がpendingなら、active goalはまだ更新されていません",
      );
      expect(String(secondRequest.instructions)).toContain(
        "owner向け進捗では内部案の提出・共有ではなく、理解した具体的な条件と自分がまず試すことを一人称の未来の意向として伝えます",
      );
      expect(messages[1]).not.toContain("Purposeが");
      expect(messages[1]).not.toContain("Purposeへ");
      expect(proposalWakeups).toBe(1);
      expect(fixture.requests).toHaveLength(2);
      expect(secondRequest.tool_choice).toBe("auto");
      expect(fixture.mind.snapshot().goals).toEqual([]);
      expect(fixture.mind.snapshot().proposals).toContainEqual(
        expect.objectContaining({
          title: "Eat one of the foods the owner mentioned",
          status: "pending",
        }),
      );
      expect(fixture.mind.snapshot().stateFacts).toHaveLength(0);
      expect(messages).toHaveLength(2);
      expect(messages[1]).toBe(
        "I understand you want me to eat one now. I will check what is available before deciding how to proceed.",
      );
    } finally {
      fixture.close();
    }
  });

  it("refreshes a drafted reply only when current goals or action results changed", () => {
    const fixture = openPurposeFixture(createMemoryPort());
    try {
      const initial = fixture.mind.snapshot();
      const pendingProposal: OwnerProposal = {
        id: "pending-only",
        title: "Gather a few logs",
        reason: "The owner asked for logs.",
        createdAt: "2026-10-08T00:00:00.000Z",
        priorityPreference: 2,
        status: "pending",
      };
      const passiveUpdate: PlayerRuntimeSnapshot = {
        ...initial,
        revision: initial.revision + 1,
        pendingEventKinds: ["state_changed"],
        proposals: [...initial.proposals, pendingProposal],
      };

      expect(conversationReplyNeedsRefresh(initial, passiveUpdate)).toBe(false);
      expect(
        conversationReplyNeedsRefresh(initial, {
          ...passiveUpdate,
          actionRevision: initial.actionRevision + 1,
        }),
      ).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it("discards a stale draft and makes one response-only pass from resolved goal state", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const proposal = fixture.mind.addProposal({
      title: "Gather a few logs",
      reason: "The owner wants logs for the shelter.",
      priority: 3,
    });
    const observation = bodyObservationFixture();
    const observedAt = "2026-10-08T00:00:01.000Z";
    const observationWithDrop: PlayerBodyObservation = {
      ...observation,
      observedAt,
      self: {
        ...observation.self,
        inventory: [
          {
            slot: 0,
            itemId: 297,
            name: "bread",
            count: 2,
            metadata: 0,
            durability: null,
            maxDurability: null,
            customName: null,
            enchantments: [],
          },
        ],
      },
      perception: {
        ...observation.perception,
        entities: [
          {
            id: 44,
            name: "item",
            kind: "item",
            category: "Item",
            position: { x: 2, y: 64, z: 0, dimension: "overworld" },
            distance: 2,
            health: null,
            isPlayer: false,
            droppedItem: { name: "golden_apple", count: 1 },
          },
        ],
      },
    };
    const messages: string[] = [];
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      observeBody: async () => observationWithDrop,
      say: async (message) => {
        messages.push(message);
      },
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    fixture.responses.push(
      conversationFunctionCallResponse(
        "refresh-observe",
        "observe_body",
        {},
        "まず周囲を確認してから考えるね。",
      ),
      async () => {
        const current = fixture.mind.snapshot();
        const changed = fixture.mind.commitGoalState({
          expectedRevision: current.revision,
          goal: {
            title: "Gather a few logs for the shelter",
            status: "active",
            priority: 3,
            changeReason: "The current situation supports this goal.",
            source: "owner",
          },
          proposalResolution: {
            proposalId: proposal.id,
            disposition: "adopted",
            resolution: "I will gather them after checking what is nearby.",
          },
        });
        expect(changed.accepted).toBe(true);
        return terminalResponse("I will start the pending plan now.");
      },
      terminalResponse("I have taken the shelter logs as my active goal."),
    );

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "What do you want to do?",
        turn: conversation.nextTurn(),
      });

      expect(fixture.requests).toHaveLength(3);
      expect(messages).toEqual([
        "まず周囲を確認してから考えるね。",
        "I have taken the shelter logs as my active goal.",
      ]);
      const refreshedRequest = record(fixture.requests[2]);
      const initialRequest = record(fixture.requests[0]);
      const refreshedInputText = Array.isArray(refreshedRequest.input)
        ? refreshedRequest.input
            .map((item) => {
              const content = record(item).content;
              return typeof content === "string" ? content : "";
            })
            .join("\n")
        : String(refreshedRequest.input);
      expect(refreshedRequest.tools).toEqual([]);
      expect(refreshedRequest.tool_choice).toBe("none");
      expect(String(initialRequest.instructions)).toContain(
        "『何が欲しい』『何をしたい』",
      );
      expect(String(initialRequest.instructions)).toContain(
        "状態質問には必要ならinspect_player_statusやobserve_body",
      );
      expect(refreshedInputText).toContain("Gather a few logs for the shelter");
      expect(refreshedInputText).toContain(observedAt);
      expect(refreshedInputText).toContain('"name":"golden_apple"');
      expect(refreshedInputText).toContain('"count":1');
      expect(refreshedInputText).not.toContain('"id":44');
      expect(refreshedInputText).not.toContain('"x":2');
      expect(refreshedInputText).not.toContain(
        "I will start the pending plan now.",
      );
      expect(String(refreshedRequest.instructions)).toContain(
        "snapshot以降の実行状況が不明なら",
      );
    } finally {
      fixture.close();
    }
  });

  it("sends an honest fallback when a changed-state reply refresh fails", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const messages: string[] = [];
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      say: async (message) => {
        messages.push(message);
      },
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    fixture.responses.push(
      async () => {
        const current = fixture.mind.snapshot();
        const changed = fixture.mind.commitGoalState({
          expectedRevision: current.revision,
          goal: {
            title: "Find shelter wood",
            status: "active",
            priority: 2,
            changeReason: "The current goal changed while I was replying.",
            source: "owner",
          },
        });
        expect(changed.accepted).toBe(true);
        return terminalResponse("The previous goal is still active.");
      },
      () => {
        throw new Error("REFRESH_PROVIDER_UNAVAILABLE");
      },
    );

    try {
      await expect(
        conversation.handleOwnerMessage({
          username: "owner",
          message: "What goal are you working on?",
          turn: conversation.nextTurn(),
        }),
      ).rejects.toThrow("REFRESH_PROVIDER_UNAVAILABLE");

      expect(fixture.requests).toHaveLength(2);
      expect(messages).toEqual([
        "返事が途中で止まってしまった。今は確認できた結果として伝えられることがないので、もう一度頼んで。",
      ]);
      expect(messages).not.toContain("The previous goal is still active.");
    } finally {
      fixture.close();
    }
  });

  it("uses a freshly inspected player snapshot as the drafted reply baseline", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const messages: string[] = [];
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      say: async (message) => {
        messages.push(message);
      },
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    fixture.responses.push(async () => {
      const current = fixture.mind.snapshot();
      const changed = fixture.mind.commitGoalState({
        expectedRevision: current.revision,
        goal: {
          title: "Find shelter wood",
          status: "active",
          priority: 2,
          changeReason: "The owner asked for current intent.",
          source: "owner",
        },
      });
      expect(changed.accepted).toBe(true);
      return conversationFunctionCallResponse(
        "inspect-current-status",
        "inspect_player_status",
        {},
        "今の目標を確認するね。",
      );
    }, terminalResponse("I am working toward finding shelter wood."));

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "What goal are you working on?",
        turn: conversation.nextTurn(),
      });

      expect(fixture.requests).toHaveLength(2);
      expect(messages).toEqual([
        "今の目標を確認するね。",
        "I am working toward finding shelter wood.",
      ]);
    } finally {
      fixture.close();
    }
  });

  it("does not refresh or deliver a conversation draft after its turn becomes stale", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const messages: string[] = [];
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      say: async (message) => {
        messages.push(message);
      },
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    fixture.responses.push(async () => {
      conversation.nextTurn();
      return terminalResponse("This belongs to an older owner turn.");
    });

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "What do you want to do?",
        turn: conversation.nextTurn(),
      });

      expect(fixture.requests).toHaveLength(1);
      expect(messages).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("gives ordinary owner proposal resolutions a concrete first-person shape", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const proposal = fixture.mind.addProposal({
      title: "Gather three birch logs",
      reason: "The owner wants three birch logs.",
      priority: 3,
    });
    fixture.responses.push(
      terminalResponse("I will check the nearby trees and begin with one cut."),
    );

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(result.accepted).toBe(false);
      const request = record(fixture.requests[0]);
      const instructions = String(request.instructions);
      expect(instructions).toContain(
        "proposalDispositionはstate保存用のenumです",
      );
      expect(instructions).toContain("一人称の短い会話で伝えます");
      expect(instructions).toContain("希望された具体的な対象・数量・条件");
      expect(instructions).toContain("これから自分が試す一手");
      expect(instructions).not.toContain("priority 4以上の新しいowner提案");
      expect(fixture.mind.snapshot().proposals).toContainEqual(
        expect.objectContaining({ id: proposal.id, status: "pending" }),
      );
    } finally {
      fixture.close();
    }
  });

  it.each([
    {
      name: "an ordinary reply whose send fails",
      ownerMessage: "Could you check this?",
      response: terminalResponse("This answer was not delivered."),
      reply: "This answer was not delivered.",
      rejectFirstSend: true,
      retainReply: false,
    },
    {
      name: "an ordinary reply whose send succeeds",
      ownerMessage: "Could you check this?",
      response: terminalResponse("This answer reached the owner."),
      reply: "This answer reached the owner.",
      rejectFirstSend: false,
      retainReply: true,
    },
    {
      name: "an owner-fact refusal whose send fails",
      ownerMessage: "Remember this for next time",
      response: conversationFunctionCallResponse(
        "verbatim-fact-summary",
        "remember_owner_fact",
        { summary: "Remember this for next time" },
        "次にも役立つように、内容を短くして覚えるね。",
      ),
      reply:
        "記憶の保存を確認できませんでした。必要ならもう一度頼んでください。",
      rejectFirstSend: true,
      retainReply: false,
    },
    {
      name: "an owner-fact refusal whose send succeeds",
      ownerMessage: "Remember this for next time",
      response: conversationFunctionCallResponse(
        "verbatim-fact-summary",
        "remember_owner_fact",
        { summary: "Remember this for next time" },
        "次にも役立つように、内容を短くして覚えるね。",
      ),
      reply:
        "記憶の保存を確認できませんでした。必要ならもう一度頼んでください。",
      rejectFirstSend: false,
      retainReply: true,
    },
  ])(
    "records $name in owner context only after successful delivery",
    async ({ ownerMessage, response, reply, rejectFirstSend, retainReply }) => {
      const fixture = openPurposeFixture(createMemoryPort());
      const sentMessages: string[] = [];
      let firstSend = true;
      const conversation = new PlayerConversationAgent({
        client: scriptedClient(fixture.responses, fixture.requests),
        apiKey: "test-only",
        model: "test-model",
        ownerUsername: "owner",
        mind: fixture.mind,
        memory: createMemoryPort(),
        logger: pino({ level: "silent" }),
        say: async (message) => {
          if (firstSend) {
            firstSend = false;
            if (rejectFirstSend) throw new Error("TEST_CHAT_SEND_FAILED");
          }
          sentMessages.push(message);
        },
        onProposal: () => undefined,
        onStop: async () => undefined,
        onResume: () => undefined,
      });
      fixture.responses.push(response, terminalResponse("Follow-up response."));

      try {
        const firstReply = conversation.handleOwnerMessage({
          username: "owner",
          message: ownerMessage,
          turn: conversation.nextTurn(),
        });
        if (rejectFirstSend)
          await expect(firstReply).rejects.toThrow("TEST_CHAT_SEND_FAILED");
        else await expect(firstReply).resolves.toBeUndefined();

        await conversation.handleOwnerMessage({
          username: "owner",
          message: "How should I proceed?",
          turn: conversation.nextTurn(),
        });
        const followUpRequest = record(fixture.requests[1]);
        const serializedInput = JSON.stringify(followUpRequest.input);
        expect(serializedInput).toContain(ownerMessage);
        if (retainReply) expect(serializedInput).toContain(reply);
        else expect(serializedInput).not.toContain(reply);
        expect(sentMessages).toContain("Follow-up response.");
      } finally {
        fixture.close();
      }
    },
  );

  it("grounds a meal refusal in the fresh food observation without guessing", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const proposal = fixture.mind.addProposal({
      title: "Eat something now",
      reason: "The owner asked the bot to eat.",
      priority: 4,
    });

    try {
      fixture.responses.push(
        functionCallResponse(
          "decline-meal",
          "commit_action_decision",
          actionArguments(
            proposalResolutionArguments(proposal, "declined"),
            "wait",
          ),
        ),
      );
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [
          {
            id: "owner-meal-proposal",
            kind: "owner_proposal",
            summary: "The owner asked the bot to eat.",
            createdAt: "2026-09-27T00:00:00.000Z",
          },
        ],
      });

      expect(result).toMatchObject({
        accepted: true,
        decision: { kind: "wait" },
      });
      const request = record(fixture.requests[0]);
      if (!Array.isArray(request.input))
        throw new Error("TEST_EXPECTED_RESPONSES_INPUT_ITEMS");
      const firstItem = record(request.input[0]);
      const purposeInput = JSON.parse(String(firstItem.content)) as {
        observation: {
          self: {
            food: number | null;
            foodSaturation: number | null;
            inventory: readonly unknown[];
          };
        };
      };
      expect(purposeInput.observation.self).toMatchObject({
        food: 20,
        foodSaturation: 5,
        inventory: [],
      });
      expect(String(request.instructions)).toContain(
        "現在観測したfood・inventoryを使い",
      );
      expect(String(request.instructions)).toContain(
        "consume対象は現在のregistryが食料と認識する所持品だけです",
      );
      expect(fixture.mind.snapshot().proposals).toContainEqual(
        expect.objectContaining({
          id: proposal.id,
          status: "declined",
        }),
      );
    } finally {
      fixture.close();
    }
  });

  it("does not turn guest chat or a prior request into current owner authorization", async () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const conversation = new PlayerConversationAgent({
      client: scriptedClient(fixture.responses, fixture.requests),
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind: fixture.mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      say: async () => undefined,
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    fixture.responses.push(
      terminalResponse("I understand that you have bread."),
      terminalResponse("That sounds like a question about your guest."),
      terminalResponse("I will wait until you ask me to do something."),
      terminalResponse("I will not act on the earlier request by itself."),
    );

    try {
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "I have bread in my inventory.",
        turn: conversation.nextTurn(),
      });
      await conversation.handleOwnerMessage({
        username: "guest",
        message: "Please eat the bread.",
        turn: conversation.nextTurn(),
      });
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "Should my guest eat it?",
        turn: conversation.nextTurn(),
      });
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "Do not eat it yet.",
        turn: conversation.nextTurn(),
      });

      expect(fixture.requests).toHaveLength(3);
      const lastRequest = record(fixture.requests[2]);
      expect(JSON.stringify(lastRequest.input)).toContain(
        "I have bread in my inventory.",
      );
      expect(JSON.stringify(lastRequest.input)).toContain("Do not eat it yet.");
      expect(JSON.stringify(lastRequest.input)).not.toContain(
        "Please eat the bread.",
      );
      expect(JSON.stringify(lastRequest.tools)).toContain(
        "propose_goal_change",
      );
      expect(fixture.mind.snapshot().proposals).toHaveLength(0);

      fixture.mind.stop();
      fixture.responses.push(terminalResponse("Autonomy is still stopped."));
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "Is autonomy still stopped?",
        turn: conversation.nextTurn(),
      });
      const afterStopRequest = record(fixture.requests[3]);
      expect(JSON.stringify(afterStopRequest.input)).not.toContain(
        "I have bread in my inventory.",
      );
      expect(fixture.mind.snapshot().stopped).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it("keeps a compromised owner intent after a self subgoal completes", async () => {
    const persistedGoalSnapshots: (readonly PlayerGoal[])[] = [];
    const memory = createMemoryPort();
    memory.persistGoals = (goals) => persistedGoalSnapshots.push(goals);
    const fixture = openPurposeFixture(memory);
    const proposal = fixture.mind.addProposal({
      title: "Retrieve the requested item",
      reason: "Please find the item and bring it back.",
      priority: 4,
    });

    try {
      fixture.responses.push(
        functionCallResponse(
          "resolve-proposal",
          "commit_goal_state",
          proposalResolutionArguments(proposal, "compromised"),
        ),
        functionCallResponse(
          "start-subgoal",
          "commit_action_decision",
          actionArguments(
            goalArguments({
              title: "Inspect the visible area",
              status: "active",
              source: "self",
              reason: "Check what can be seen before choosing how to search.",
            }),
          ),
        ),
      );
      const started = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });
      expect(started.accepted).toBe(true);

      let afterStart = fixture.mind.snapshot();
      const ownerGoal = afterStart.goals.find(
        ({ ownerProposalId }) => ownerProposalId === proposal.id,
      );
      const selfGoal = afterStart.goals.find(
        ({ title }) => title === "Inspect the visible area",
      );
      if (selfGoal === undefined)
        throw new Error("TEST_SELF_SUBGOAL_NOT_CREATED");
      expect(ownerGoal).toEqual(
        expect.objectContaining({
          title: proposal.title,
          source: "owner",
          status: "active",
          ownerProposalId: proposal.id,
        }),
      );
      expect(selfGoal.status).toBe("active");
      expect(afterStart.proposals).toContainEqual(
        expect.objectContaining({
          id: proposal.id,
          status: "compromised",
          resolution:
            "I will first inspect the area, then choose a way to proceed.",
        }),
      );
      expect(persistedGoalSnapshots[0]).toContainEqual(
        expect.objectContaining({
          ownerProposalId: proposal.id,
          status: "active",
        }),
      );
      for (let index = 0; index < 12; index += 1) {
        const saved = fixture.mind.commitGoalState({
          expectedRevision: afterStart.revision,
          goal: {
            title: `Newer self goal ${index}`,
            status: "active",
            priority: 1,
            changeReason: "A newer independent purpose was considered.",
            source: "self",
          },
        });
        expect(saved.accepted).toBe(true);
        afterStart = saved.snapshot;
      }
      expect(afterStart.goals.slice(-12)).not.toContainEqual(
        expect.objectContaining({ ownerProposalId: proposal.id }),
      );

      fixture.responses.push(
        functionCallResponse(
          "complete-subgoal",
          "commit_action_decision",
          actionArguments(
            goalArguments({
              id: selfGoal.id,
              title: "Inspect the visible area",
              status: "completed",
              source: "self",
              reason: "The visible area has been inspected.",
            }),
            "wait",
          ),
        ),
      );
      const completed = await fixture.agent.think({
        snapshot: afterStart,
        events: [],
      });
      expect(completed.accepted).toBe(true);
      const afterCompletion = fixture.mind.snapshot();
      expect(
        afterCompletion.goals.find(
          ({ ownerProposalId }) => ownerProposalId === proposal.id,
        )?.status,
      ).toBe("active");
      expect(
        afterCompletion.goals.find(
          ({ title }) => title === "Inspect the visible area",
        )?.status,
      ).toBe("completed");

      fixture.responses.push(
        functionCallResponse(
          "follow-owner-intent",
          "commit_action_decision",
          actionArguments(undefined, "wait"),
        ),
      );
      const next = await fixture.agent.think({
        snapshot: afterCompletion,
        events: [],
      });
      expect(next.accepted).toBe(true);
      const nextRequest = record(fixture.requests[3]);
      expect(String(nextRequest.instructions)).toContain(
        "途中のself goalを完了してもowner intentは完了しません",
      );
      if (!Array.isArray(nextRequest.input))
        throw new Error("TEST_EXPECTED_RESPONSES_INPUT_ITEMS");
      const inputItems = nextRequest.input;
      const userItem = record(inputItems[0]);
      const purposeInput = JSON.parse(String(userItem.content)) as {
        runtime: {
          goals: readonly PlayerGoal[];
          proposals: readonly OwnerProposal[];
        };
      };
      expect(purposeInput.runtime.goals).toContainEqual(
        expect.objectContaining({
          ownerProposalId: proposal.id,
          title: proposal.title,
          source: "owner",
          status: "active",
        }),
      );
      expect(purposeInput.runtime.proposals).toContainEqual(
        expect.objectContaining({
          id: proposal.id,
          title: proposal.title,
          reason: proposal.reason,
          status: "compromised",
          resolution:
            "I will first inspect the area, then choose a way to proceed.",
        }),
      );
    } finally {
      fixture.close();
    }
  });

  it("keeps a paused linked owner intent beyond the recent-goal window", () => {
    const fixture = openPurposeFixture(createMemoryPort());
    const proposal = fixture.mind.addProposal({
      title: "Retrieve the requested item",
      reason: "Please find the item and bring it back.",
      priority: 4,
    });

    try {
      let snapshot = resolveProposal(
        fixture.mind,
        fixture.mind.snapshot(),
        proposal,
        "compromised",
      );
      const linkedGoal = snapshot.goals.find(
        ({ ownerProposalId }) => ownerProposalId === proposal.id,
      );
      if (linkedGoal === undefined)
        throw new Error("TEST_LINKED_OWNER_GOAL_NOT_CREATED");

      const paused = fixture.mind.commitGoalState({
        expectedRevision: snapshot.revision,
        goal: {
          id: linkedGoal.id,
          title: linkedGoal.title,
          status: "paused",
          priority: linkedGoal.priority,
          changeReason: "Pause while considering another approach.",
          source: "owner",
        },
      });
      expect(paused.accepted).toBe(true);
      snapshot = paused.snapshot;

      for (let index = 0; index < 13; index += 1) {
        const added = fixture.mind.commitGoalState({
          expectedRevision: snapshot.revision,
          goal: {
            title: `Newer self goal ${index}`,
            status: "active",
            priority: 1,
            changeReason: "A newer independent purpose was considered.",
            source: "self",
          },
        });
        expect(added.accepted).toBe(true);
        snapshot = added.snapshot;
      }

      expect(snapshot.goals.slice(-12)).not.toContainEqual(
        expect.objectContaining({ ownerProposalId: proposal.id }),
      );
      const compacted = record(compactSnapshot(snapshot));
      expect(compacted.goals).toContainEqual(
        expect.objectContaining({
          ownerProposalId: proposal.id,
          title: proposal.title,
          source: "owner",
          status: "paused",
        }),
      );
      expect(compacted.proposals).toContainEqual(
        expect.objectContaining({
          id: proposal.id,
          title: proposal.title,
          reason: proposal.reason,
          status: "compromised",
          resolution:
            "Resolve the owner intent based on the current situation.",
        }),
      );

      expect(
        fixture.mind
          .snapshot()
          .goals.find(({ ownerProposalId }) => ownerProposalId === proposal.id)
          ?.status,
      ).toBe("paused");
    } finally {
      fixture.close();
    }
  });

  it("allows owner-position observation only for pending or active linked intents", async () => {
    const ownerPositionExceptions: boolean[] = [];
    const fixture = openPurposeFixture(
      createMemoryPort(),
      ownerPositionExceptions,
    );
    const pending = fixture.mind.addProposal({
      title: "Pending owner request",
      reason: "The owner asked for help.",
      priority: 3,
    });
    const adopted = fixture.mind.addProposal({
      title: "Adopted owner request",
      reason: "The owner asked for help.",
      priority: 3,
    });
    const compromised = fixture.mind.addProposal({
      title: "Compromised owner request",
      reason: "The owner asked for help.",
      priority: 3,
    });
    const declined = fixture.mind.addProposal({
      title: "Declined owner request",
      reason: "The owner asked for help.",
      priority: 3,
    });
    const completed = fixture.mind.addProposal({
      title: "Completed owner request",
      reason: "The owner asked for help.",
      priority: 3,
    });
    let snapshot: PlayerRuntimeSnapshot = fixture.mind.snapshot();

    try {
      snapshot = resolveProposal(fixture.mind, snapshot, adopted, "adopted");
      snapshot = resolveProposal(
        fixture.mind,
        snapshot,
        compromised,
        "compromised",
      );
      snapshot = resolveProposal(fixture.mind, snapshot, declined, "declined");
      snapshot = resolveProposal(fixture.mind, snapshot, completed, "adopted");
      const completedGoal = snapshot.goals.find(
        ({ ownerProposalId }) => ownerProposalId === completed.id,
      );
      if (completedGoal === undefined)
        throw new Error("TEST_LINKED_GOAL_NOT_CREATED");
      const markedComplete = fixture.mind.commitGoalState({
        expectedRevision: snapshot.revision,
        goal: {
          id: completedGoal.id,
          title: completedGoal.title,
          status: "completed",
          priority: completedGoal.priority,
          changeReason: "The owner intent was explicitly completed.",
          source: "owner",
        },
      });
      expect(markedComplete.accepted).toBe(true);
      snapshot = markedComplete.snapshot;

      const allowedAndRejected = [
        pending,
        adopted,
        compromised,
        declined,
        completed,
      ];
      for (let index = 0; index < allowedAndRejected.length; index += 1) {
        const proposal = allowedAndRejected[index];
        if (proposal === undefined) continue;
        fixture.responses.push(
          functionCallResponse(`locate-${index}`, "locate_owner", {
            proposalId: proposal.id,
            purpose: "Check whether approaching the owner fits this intent.",
          }),
          functionCallResponse(
            `wait-${index}`,
            "commit_action_decision",
            actionArguments(undefined, "wait"),
          ),
        );
        const result = await fixture.agent.think({ snapshot, events: [] });
        expect(result.accepted).toBe(true);
        snapshot = fixture.mind.snapshot();
      }
      expect(ownerPositionExceptions).toEqual([true, true, true]);
    } finally {
      fixture.close();
    }
  });

  it("keeps GOAL_CAPACITY as a fixed safe tool-result code", () => {
    const projected = projectSafePlayerAgentActivityTail([
      {
        runSequence: 1,
        role: "purpose",
        round: 2,
        responseStatus: "completed",
        processingStatus: "complete",
        inputTokens: 40,
        outputTokens: 4,
        latencyMs: 12,
        requestInputChars: 800,
        initialInputChars: 400,
        instructionsChars: 300,
        toolSchemaChars: 100,
        initialObservationChars: 0,
        responseOutputChars: 200,
        functionCallCount: 1,
        compactionItemPresent: false,
        toolCalls: [
          {
            name: "commit_goal_state",
            resultClass: "rejected",
            resultCode: "GOAL_CAPACITY",
            outputChars: 80,
            privateText: "must not be retained",
          },
        ],
      },
    ]);
    expect(projected[0]?.toolCalls[0]?.resultCode).toBe("GOAL_CAPACITY");
    expect(JSON.stringify(projected)).not.toContain("must not be retained");
  });
});

interface ScriptedRequestOptions {
  readonly signal?: AbortSignal;
}
type ScriptedResponse =
  | Response
  | ((
      request: unknown,
      options?: ScriptedRequestOptions,
    ) => Response | Promise<Response>);

interface PurposeFixture {
  readonly agent: PlayerPurposeAgent;
  readonly mind: PlayerMindStore;
  readonly requests: unknown[];
  readonly responses: ScriptedResponse[];
  readonly calls: Omit<PlayerAgentCallResult, "text">[];
  close(): void;
}

function openPurposeFixture(
  memory: PlayerMemoryPort,
  ownerPositionExceptions: boolean[] = [],
  onRoundActivity?: (activity: PlayerAgentRoundActivity) => void,
  observeBody?: PlayerBody["observe"],
  knowledgeBody?: PlayerBody["knowledge"],
): PurposeFixture {
  const directory = mkdtempSync(join(tmpdir(), "player-owner-intent-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "player.sqlite");
  const mind = PlayerMindStore.open(databasePath);
  const skills = McSkillRepository.open({
    databasePath,
    exchangeDirectory: join(directory, "skills"),
    allowedOperationNames: playerOperationNames,
  });
  const requests: unknown[] = [];
  const responses: ScriptedResponse[] = [];
  const calls: Omit<PlayerAgentCallResult, "text">[] = [];
  const body = {
    observe: async (options?: { ownerPositionException?: boolean }) => {
      if (observeBody !== undefined) return observeBody(options);
      const observation = bodyObservationFixture();
      if (options?.ownerPositionException === true) {
        ownerPositionExceptions.push(true);
        return {
          ...observation,
          perception: {
            ...observation.perception,
            ownerPositionException: {
              username: "owner",
              position: { x: 0, y: 64, z: 1, dimension: "overworld" },
              source: "owner_position_exception",
              currentlyVisible: false,
            },
          },
        };
      }
      return observation;
    },
    knowledge: (query: string) => {
      if (knowledgeBody === undefined)
        throw new Error("TEST_BODY_KNOWLEDGE_NOT_CONFIGURED");
      return knowledgeBody(query);
    },
  } as unknown as PlayerBody;
  const agent = new PlayerPurposeAgent({
    client: scriptedClient(responses, requests),
    apiKey: "test-only",
    model: "test-model",
    body,
    skills,
    mind,
    memory,
    ownerPlayerId: "test-owner",
    logger: pino({ level: "silent" }),
    onRoundActivity: (activity) => {
      mind.recordAgentActivity(activity);
      onRoundActivity?.(activity);
    },
    onCall: (metrics) => calls.push(metrics),
    onCommitted: () => undefined,
  });
  return {
    agent,
    mind,
    requests,
    responses,
    calls,
    close: () => {
      skills.close();
      mind.close();
    },
  };
}

function bodyObservationFixture(): PlayerBodyObservation {
  return {
    observedAt: "2026-09-27T00:00:00.000Z",
    source: "minecraft",
    gameVersion: "test",
    dimension: "overworld",
    time: { day: 1, timeOfDay: 5_000, isDay: true, raining: false },
    self: {
      username: "bot",
      position: { x: 0, y: 64, z: 0, dimension: "overworld" },
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0,
      velocity: { x: 0, y: 0, z: 0 },
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygen: 20,
      inWater: false,
      inLava: false,
      onFire: false,
      suffocating: false,
      sleeping: false,
      mountedEntityId: null,
      gameMode: "survival",
      experience: { level: 0, points: 0, progress: 0 },
      inventory: [],
      equipment: {},
    },
    perception: {
      horizontalFieldOfViewDegrees: 90,
      verticalFieldOfViewDegrees: 60,
      maxDistance: 12,
      coverage: "visible_subset",
      blockCountLimit: 64,
      entityCountLimit: 16,
      blockCandidateLimit: 128,
      entityCandidateLimit: 32,
      omittedBlockCandidates: 0,
      omittedEntityCandidates: 0,
      candidateSearchMayBeTruncated: false,
      blocks: [],
      placementCandidateLimit: 24,
      omittedPlacementCandidates: 0,
      placementCandidatesMayBeTruncated: false,
      placementCandidates: [],
      entities: [],
    },
    window: null,
  };
}

function observationWithInventory(
  inventory: PlayerBodyObservation["self"]["inventory"],
  observedAt = "2026-10-08T00:00:01.000Z",
): PlayerBodyObservation {
  const observation = bodyObservationFixture();
  return {
    ...observation,
    observedAt,
    self: { ...observation.self, inventory },
  };
}

function itemStack(
  slot: number,
  itemId: number,
  name: string,
  count: number,
): PlayerBodyObservation["self"]["inventory"][number] {
  return {
    slot,
    itemId,
    name,
    count,
    metadata: 0,
    durability: null,
    maxDurability: null,
    customName: null,
    enchantments: [],
  };
}

function knowledgeFixture(
  query: string,
  outputCount: number,
  requiresTable: boolean,
  ingredients: readonly { readonly name: string; readonly count: number }[],
  craftable: boolean,
): PlayerKnowledge {
  return {
    source: "minecraft_registry",
    gameVersion: "test",
    registryVersion: "test",
    observedAt: "2026-10-08T00:00:02.000Z",
    query,
    facts: [
      {
        kind: "recipe",
        result: { id: 1, name: query, count: outputCount },
        requiresTable,
        ingredients: ingredients.map((ingredient, id) => ({
          id,
          ...ingredient,
        })),
      },
    ],
    inferences: [
      {
        kind: "craftability",
        itemName: query,
        currentlyCraftable: craftable,
        assessedCount: 1,
        recipeStatus: "known",
        tableRequirement: requiresTable ? "required" : "not_required",
        craftingTableNearby: false,
        craftableWithCurrentSurface: craftable,
        materialAvailabilityWithTable: craftable
          ? "sufficient"
          : "insufficient",
        basis: [
          craftable
            ? "Materials support one recipe."
            : "Materials are insufficient.",
        ],
      },
    ],
    truncated: false,
  };
}

function createMemoryPort(): PlayerMemoryPort {
  return {
    context: () => ({
      persona: "",
      ownerUsername: "owner",
      relationship: {},
      lifeState: {},
      recalled: [],
    }),
    recall: () => [],
    persistGoals: () => undefined,
    recordEpisode: () => undefined,
  };
}

function scriptedClient(
  responses: ScriptedResponse[],
  requests: unknown[],
): PlayerResponsesClient {
  return {
    responses: {
      create: async (request: unknown, options?: ScriptedRequestOptions) => {
        requests.push(request);
        const response = responses.shift();
        if (response === undefined)
          throw new Error("TEST_RESPONSE_QUEUE_EMPTY");
        return typeof response === "function"
          ? await response(request, options)
          : response;
      },
    },
  } as unknown as PlayerResponsesClient;
}

function functionCallResponse(
  callId: string,
  name: string,
  argumentsValue: unknown,
  usage: NonNullable<Response["usage"]> = responseUsage(1, 1),
): Response {
  const argumentsWithPlan =
    name === "commit_action_decision" &&
    typeof argumentsValue === "object" &&
    argumentsValue !== null &&
    !Array.isArray(argumentsValue)
      ? {
          actionPlanId: "",
          actionPlanPurpose: "",
          actionPlanGoalId: "",
          continuationSteps: [],
          ...(argumentsValue as Record<string, unknown>),
        }
      : argumentsValue;
  return {
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: callId,
        name,
        arguments: JSON.stringify(argumentsWithPlan),
      },
    ],
    output_text: "",
    usage,
  } as unknown as Response;
}

function conversationFunctionCallResponse(
  callId: string,
  name: string,
  argumentsValue: Record<string, unknown>,
  ownerReply: string,
): Response {
  return functionCallResponse(callId, name, {
    ...argumentsValue,
    ownerReply,
  });
}

function responseUsage(
  inputTokens: number,
  outputTokens: number,
): NonNullable<Response["usage"]> {
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
}

function terminalResponse(outputText: string): Response {
  return {
    status: "completed",
    output: [],
    output_text: outputText,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Response;
}

function proposalResolutionArguments(
  proposal: OwnerProposal,
  disposition: "adopted" | "compromised" | "declined",
): Record<string, unknown> {
  return {
    proposalId: proposal.id,
    proposalDisposition: disposition,
    resolution: "I will first inspect the area, then choose a way to proceed.",
    goalId: "",
    goalTitle: "",
    goalStatus: "none",
    goalPriority: proposal.priorityPreference,
    changeReason: "",
    goalSource: "none",
  };
}

function goalArguments(input: {
  readonly id?: string;
  readonly title: string;
  readonly status: PlayerGoal["status"];
  readonly source: PlayerGoal["source"];
  readonly reason: string;
}): Record<string, unknown> {
  return {
    proposalId: "",
    proposalDisposition: "none",
    resolution: "",
    goalId: input.id ?? "",
    goalTitle: input.title,
    goalStatus: input.status,
    goalPriority: 2,
    changeReason: input.reason,
    goalSource: input.source,
  };
}

function actionArguments(
  goalState: Record<string, unknown> | undefined,
  kind: "act" | "wait" = "act",
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    kind,
    purpose: "Keep considering the owner intent.",
    operationJson:
      kind === "act"
        ? JSON.stringify({
            kind: "look",
            target: { x: 1, y: 64, z: 1 },
          })
        : "",
    expectedOutcome: "The current view informs the next choice.",
    skillId: "",
    skillVersion: 0,
    reason: "Wait until a meaningful update is available.",
    wakeOn: kind === "wait" ? ["state_changed"] : [],
    wakeAt: "",
    stateUpdates:
      goalState === undefined ? null : { goalState, understanding: null },
  };
  return args;
}

function craftActionArguments(
  goalId: string,
  item: string,
): Record<string, unknown> {
  const args = actionArguments(
    goalArguments({
      id: goalId,
      title: "Make a white bed",
      status: "active",
      source: "owner",
      reason: "Continue the same owner goal through a prerequisite.",
    }),
  );
  args.operationJson = JSON.stringify({ kind: "craft", item, count: 1 });
  args.purpose = `Prepare ${item} as the next step toward the existing bed goal.`;
  args.expectedOutcome = `Observe the result of crafting ${item}.`;
  args.reason = "The current recipe facts and inventory support this step.";
  return args;
}

function resolveProposal(
  mind: PlayerMindStore,
  snapshot: PlayerRuntimeSnapshot,
  proposal: OwnerProposal,
  disposition: "adopted" | "compromised" | "declined",
): PlayerRuntimeSnapshot {
  const result = mind.commitGoalState({
    expectedRevision: snapshot.revision,
    proposalResolution: {
      proposalId: proposal.id,
      disposition,
      resolution: "Resolve the owner intent based on the current situation.",
    },
  });
  if (!result.accepted) throw new Error("TEST_PROPOSAL_RESOLUTION_REJECTED");
  return result.snapshot;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("TEST_EXPECTED_OBJECT");
  return value as Record<string, unknown>;
}

function functionCallOutputs(requests: readonly unknown[]): string {
  return requests
    .flatMap((request) => {
      const input = record(request).input;
      return Array.isArray(input)
        ? input
            .filter((item) => record(item).type === "function_call_output")
            .map((item) => record(item).output)
        : [];
    })
    .filter((output): output is string => typeof output === "string")
    .join("\n");
}
