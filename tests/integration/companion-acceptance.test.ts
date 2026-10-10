import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type OpenAI from "openai";

import type {
  PlayerBody,
  PlayerBodyEvent,
  PlayerBodyObservation,
  PlayerKnowledge,
  PlayerOperation,
  PlayerOperationResult,
} from "../../src/minecraft/player-body.js";
import type { BodyItemStack } from "../../src/minecraft/player-body-observation.js";
import { CompanionAgent } from "../../src/player/agent.js";
import type { CompanionDecision } from "../../src/player/agent.js";
import { CompanionRuntime } from "../../src/player/runtime.js";
import { CompanionStore } from "../../src/player/store.js";

const temporaryDirectories: string[] = [];
const ownerUsername = "OwnerFixture";
const ownerMessage = "青い花が好きだよ。木を拾って板材を作ってみよう。";
const ownerQuote = "青い花が好きだよ";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("companion acceptance without paid services", () => {
  it("observes a Body plan, persists owner memory and stop across restart, and resumes only for the owner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "companion-acceptance-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "companion.sqlite3");
    const calls: { instructions: string; input: string }[] = [];
    const client = fakeResponsesClient(calls, [
      decision({
        speech: null,
        goal: {
          title: "木材を拾って板材を作る",
          successCondition: "木材を拾い、板材を4個作る",
          source: "owner",
        },
        plan: {
          purpose: "近くの木材を集めて板材を作る",
          steps: [
            {
              operation: {
                kind: "move_to",
                position: { x: 2, y: 64, z: 3 },
                range: 1,
              },
              expectedOutcome: "落ちた木材の近くまで移動した",
            },
            {
              operation: { kind: "collect_item", entityId: 7 },
              expectedOutcome: "木材を拾った",
            },
            {
              operation: { kind: "craft", item: "oak_planks", count: 4 },
              expectedOutcome: "板材を4個作った",
            },
          ],
        },
        memoryUpdates: [
          {
            kind: "preference",
            content: "owner likes blue flowers",
            importance: 4,
            ownerQuote,
          },
        ],
      }),
      decision({
        speech: null,
        goal: null,
        plan: null,
        memoryUpdates: [],
      }),
    ]);
    const body = new FixtureBody();
    const spoken: string[] = [];
    let store = CompanionStore.open(databasePath, { ownerUsername });
    const runtime = createRuntime(store, body, client, spoken);
    let restartedRuntime: CompanionRuntime | undefined;

    try {
      await runtime.receiveChat(ownerUsername, ownerMessage);

      expect(body.operations).toEqual(["move_to", "collect_item", "craft"]);
      expect(body.currentPosition).toEqual({ x: 2, y: 64, z: 3 });
      expect(body.oakLogCount).toBe(0);
      expect(body.oakPlankCount).toBe(4);
      expect(store.snapshot().lastOutcome?.status).toBe("successful");
      expect(store.snapshot().plan).toBeNull();
      const observedEffects = store
        .recall("", 12)
        .filter(
          (memory) =>
            memory.kind === "episode" && memory.source === "minecraft_observed",
        )
        .map((memory) => memory.content.split(":", 1)[0])
        .sort();
      expect(observedEffects).toEqual([
        "successful collect_item",
        "successful craft",
        "successful move_to",
      ]);
      const rememberedPreference = store
        .recall("青い花", 8)
        .find((memory) => memory.content.includes("blue flowers"));
      expect(rememberedPreference?.source).toBe("player_stated");
      expect(rememberedPreference?.metadata).toEqual({ ownerQuote });
      expect(calls).toHaveLength(1);
      const firstRequest = parseProviderInput(callAt(calls, 0).input);
      expect(firstRequest.ownerMessage).toBe(ownerMessage);
      expect(firstRequest.recentMessages).not.toContainEqual(
        expect.objectContaining({ role: "owner", text: ownerMessage }),
      );

      await runtime.receiveChat("OtherFixture", "止めて");
      expect(store.snapshot().stopped).toBe(false);
      expect(calls).toHaveLength(1);

      await runtime.receiveChat(ownerUsername, "止めて");
      expect(store.snapshot().stopped).toBe(true);
      expect(store.snapshot().plan).toBeNull();
      expect(calls).toHaveLength(1);
      await runtime.shutdown();
      store.close();

      store = CompanionStore.open(databasePath, { ownerUsername });
      restartedRuntime = createRuntime(store, body, client, spoken);
      await restartedRuntime.start();
      await restartedRuntime.receiveChat("OtherFixture", "再開");
      expect(store.snapshot().stopped).toBe(true);
      expect(calls).toHaveLength(1);
      expect(body.operations).toHaveLength(3);

      await restartedRuntime.receiveChat(ownerUsername, "再開");
      expect(store.snapshot().stopped).toBe(false);
      expect(calls).toHaveLength(2);
      const resumedCall = callAt(calls, 1);
      const resumedInput = parseProviderInput(resumedCall.input);
      expect(resumedInput.memories).toContainEqual(
        expect.objectContaining({
          content: "owner likes blue flowers",
          source: "player_stated",
        }),
      );
      expect(resumedInput.ownerMessage).toBe("再開");
      expect(resumedInput.recentMessages).toContainEqual(
        expect.objectContaining({ role: "owner", text: ownerMessage }),
      );
      expect(resumedInput.recentMessages).toContainEqual(
        expect.objectContaining({ role: "owner", text: "止めて" }),
      );
      expect(resumedCall.instructions).toContain("コンパニオン「ミナ");
      expect(body.operations).toHaveLength(3);
    } finally {
      await runtime.shutdown();
      await restartedRuntime?.shutdown();
      await body.stop();
      store.close();
    }
  });

  it("acts under uncertain visibility for the explicit owner priority and stops before the next move", async () => {
    const directory = mkdtempSync(join(tmpdir(), "companion-risk-priority-"));
    temporaryDirectories.push(directory);
    const store = CompanionStore.open(join(directory, "companion.sqlite3"), {
      ownerUsername,
    });
    const calls: { instructions: string; input: string }[] = [];
    const spoken: string[] = [];
    const priorityMessage =
      "今回は無謀に動くことを最優先して。危険が分からなくても棒立ちせず、見える範囲で探索を始めて。";
    const body = new FixtureBody();
    body.blockOperationNumber = 2;
    const client = {
      responses: {
        create: async (request: { instructions: string; input: string }) => {
          calls.push({
            instructions: request.instructions,
            input: request.input,
          });
          const input = JSON.parse(request.input) as {
            ownerMessage?: string | null;
            observation: {
              perception: { coverage: string; maxDistance: number };
            };
          };
          const policyApplied =
            request.instructions.includes(
              "既定のゲームプレイ方針は、ゲーム内のリスクや失敗を引き受けて能動的に動くことを最優先にすることです。",
            ) &&
            request.instructions.includes(
              "その優先度を慎重さへ読み替えず実行可能な行動に反映してください。",
            );
          const requestPreserved =
            input.ownerMessage === priorityMessage &&
            input.observation.perception.coverage === "visible_subset" &&
            input.observation.perception.maxDistance === 24;
          const output =
            policyApplied && requestPreserved
              ? decision({
                  speech: "了解。まず近くを探索するね。",
                  goal: {
                    title: "見える範囲を探索する",
                    successCondition: "近くへ移動して周囲を調べる",
                    source: "owner",
                  },
                  plan: {
                    purpose: "不確実な危険だけで立ち止まらず、探索を始める。",
                    steps: [
                      {
                        operation: {
                          kind: "move_to",
                          position: { x: 4, y: 64, z: 0 },
                          range: 1,
                        },
                        expectedOutcome:
                          "近くへ移動したことをBody結果で確認する。",
                      },
                      {
                        operation: {
                          kind: "move_to",
                          position: { x: 8, y: 64, z: 0 },
                          range: 1,
                        },
                        expectedOutcome: "次の探索地点へ移動する。",
                      },
                    ],
                  },
                })
              : decision({
                  speech: "周囲の危険が分からないので、ここで待つね。",
                });
          return {
            status: "completed",
            output_text: JSON.stringify(output),
          };
        },
      },
    } as unknown as Pick<OpenAI, "responses">;
    const runtime = createRuntime(store, body, client, spoken);

    try {
      const ownerTurn = runtime.receiveChat(ownerUsername, priorityMessage);
      await waitUntil(() => body.operations.length === 2 || calls.length > 0);
      expect(calls).toHaveLength(1);
      expect(body.operations).toEqual(["move_to", "move_to"]);
      expect(body.currentPosition).toEqual({ x: 4, y: 64, z: 0 });
      expect(store.snapshot().lastOutcome?.status).toBe("successful");

      const request = callAt(calls, 0);
      const sentInput = parseProviderInput(request.input);
      expect(sentInput.ownerMessage).toBe(priorityMessage);
      expect(request.instructions).toContain(
        "既定のゲームプレイ方針は、ゲーム内のリスクや失敗を引き受けて能動的に動くことを最優先にすることです。",
      );
      expect(request.instructions).toContain(
        "その優先度を慎重さへ読み替えず実行可能な行動に反映してください。",
      );
      expect(spoken).not.toContain(
        "周囲の危険が分からないので、ここで待つね。",
      );

      await runtime.receiveChat(ownerUsername, "自律行動を止めて");
      await ownerTurn;

      expect(store.snapshot().stopped).toBe(true);
      expect(store.snapshot().lastOutcome?.status).toBe("interrupted");
      expect(body.operations).toHaveLength(2);
      expect(calls).toHaveLength(1);
    } finally {
      await runtime.shutdown();
      await body.stop();
      store.close();
    }
  });
});

function decision(overrides: Partial<CompanionDecision>): CompanionDecision {
  return {
    speech: null,
    goal: null,
    plan: null,
    memoryUpdates: [],
    relationshipSummary: null,
    waitMs: 300_000,
    knowledgeQuery: null,
    ...overrides,
  };
}

interface CapturedProviderInput {
  readonly ownerMessage?: string | null;
  readonly memories: { readonly content: string; readonly source: string }[];
  readonly recentMessages: { readonly role: string; readonly text: string }[];
}

function callAt(
  calls: readonly { instructions: string; input: string }[],
  index: number,
): { instructions: string; input: string } {
  const call = calls[index];
  if (call === undefined) throw new Error("Expected fixture provider call.");
  return call;
}

function parseProviderInput(input: string): CapturedProviderInput {
  return JSON.parse(input) as CapturedProviderInput;
}

function fakeResponsesClient(
  calls: { instructions: string; input: string }[],
  decisions: readonly CompanionDecision[],
): Pick<OpenAI, "responses"> {
  let index = 0;
  return {
    responses: {
      create: async (request: { instructions: string; input: string }) => {
        calls.push({
          instructions: request.instructions,
          input: request.input,
        });
        const responseDecision = decisions[index++];
        if (responseDecision === undefined)
          throw new Error("Fake Responses fixture exhausted.");
        return {
          status: "completed",
          output_text: JSON.stringify(responseDecision),
        };
      },
    },
  } as unknown as Pick<OpenAI, "responses">;
}

function createRuntime(
  store: CompanionStore,
  body: FixtureBody,
  client: Pick<OpenAI, "responses">,
  spoken: string[],
): CompanionRuntime {
  const agent = new CompanionAgent({
    client,
    model: "offline-fixture",
    persona: {
      version: 1,
      name: "ミナ",
      speakingStyle: "穏やかで率直に話す。",
      values: ["共有した経験を大切にする。"],
      operatingPrinciples: ["観測した結果を確かめてから伝える。"],
      prohibitions: ["永続停止を迂回しない。"],
    },
  });
  return new CompanionRuntime({
    ownerUsername,
    body,
    store,
    agent,
    say: async (text) => {
      spoken.push(text);
    },
    minWaitMs: 300_000,
  });
}

class FixtureBody implements PlayerBody {
  public readonly operations: string[] = [];
  public currentPosition = { x: 0, y: 64, z: 0 };
  public oakLogCount = 0;
  public oakPlankCount = 0;
  public blockOperationNumber: number | undefined;
  #itemVisible = true;
  #listener: ((event: PlayerBodyEvent) => void) | undefined;
  #observationSequence = 0;

  public async observe(): Promise<PlayerBodyObservation> {
    this.#observationSequence += 1;
    const inventory: BodyItemStack[] = [];
    if (this.oakLogCount > 0)
      inventory.push(itemStack(0, 17, "oak_log", this.oakLogCount));
    if (this.oakPlankCount > 0)
      inventory.push(itemStack(1, 5, "oak_planks", this.oakPlankCount));
    const entity = {
      id: 7,
      name: "item",
      kind: "item",
      category: null,
      position: {
        ...this.currentPosition,
        dimension: "overworld",
      },
      distance: 1,
      health: null,
      isPlayer: false,
      droppedItem: { name: "oak_log", count: 1 },
    };
    return {
      observedAt: new Date(
        Date.now() + this.#observationSequence,
      ).toISOString(),
      source: "minecraft",
      gameVersion: "fixture",
      dimension: "overworld",
      time: { day: 0, timeOfDay: 6000, isDay: true, raining: false },
      self: {
        username: "CompanionFixture",
        position: { ...this.currentPosition, dimension: "overworld" },
        eyeHeight: 1.62,
        yaw: 0,
        pitch: 0,
        velocity: { x: 0, y: 0, z: 0 },
        health: 20,
        food: 20,
        foodSaturation: 5,
        oxygen: 300,
        inWater: false,
        inLava: false,
        onFire: false,
        suffocating: false,
        sleeping: false,
        mountedEntityId: null,
        gameMode: "survival",
        experience: { level: 0, points: 0, progress: 0 },
        inventory,
        equipment: {},
      },
      perception: {
        horizontalFieldOfViewDegrees: 110,
        verticalFieldOfViewDegrees: 70,
        maxDistance: 24,
        coverage: "visible_subset",
        blockCountLimit: 32,
        entityCountLimit: 20,
        blockCandidateLimit: 256,
        entityCandidateLimit: 128,
        omittedBlockCandidates: 0,
        omittedEntityCandidates: 0,
        candidateSearchMayBeTruncated: false,
        blocks: [],
        placementCandidateLimit: 24,
        omittedPlacementCandidates: 0,
        placementCandidatesMayBeTruncated: false,
        placementCandidates: [],
        entities: this.#itemVisible ? [entity] : [],
      },
      window: null,
    };
  }

  public async execute(
    operation: PlayerOperation,
    signal?: AbortSignal,
  ): Promise<PlayerOperationResult> {
    signal?.throwIfAborted();
    const before = await this.observe();
    this.operations.push(operation.kind);
    if (this.blockOperationNumber === this.operations.length) {
      return await new Promise<PlayerOperationResult>((resolve) => {
        const interrupt = (): void => {
          const at = new Date().toISOString();
          resolve({
            operationId: `fixture-${this.operations.length}`,
            operation,
            status: "interrupted",
            startedAt: at,
            completedAt: at,
            before,
            after: null,
            sameLife: true,
            recoveryRequired: false,
          });
        };
        if (signal?.aborted) interrupt();
        else signal?.addEventListener("abort", interrupt, { once: true });
      });
    }
    switch (operation.kind) {
      case "move_to":
        this.currentPosition = {
          x: operation.position.x,
          y: operation.position.y,
          z: operation.position.z,
        };
        break;
      case "collect_item":
        if (!this.#itemVisible || operation.entityId !== 7)
          throw new Error("Fixture item is unavailable.");
        this.#itemVisible = false;
        this.oakLogCount += 1;
        break;
      case "craft":
        if (operation.item !== "oak_planks" || this.oakLogCount < 1)
          throw new Error("Fixture recipe is unavailable.");
        this.oakLogCount -= 1;
        this.oakPlankCount += 4;
        break;
      default:
        throw new Error("Unexpected operation in companion fixture.");
    }
    const after = await this.observe();
    const at = new Date().toISOString();
    return {
      operationId: `fixture-${this.operations.length}`,
      operation,
      status: "successful",
      startedAt: at,
      completedAt: at,
      before,
      after,
      sameLife: true,
      recoveryRequired: false,
    };
  }

  public async stop(): Promise<void> {
    this.#listener = undefined;
  }

  public stopActiveOperation(): Promise<void> {
    return Promise.resolve();
  }

  public knowledge(query: string): PlayerKnowledge {
    return {
      source: "minecraft_registry",
      gameVersion: "fixture",
      registryVersion: "fixture",
      observedAt: new Date().toISOString(),
      query,
      facts: [],
      inferences: [],
      truncated: false,
    };
  }

  public onEvent(listener: (event: PlayerBodyEvent) => void): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Expected fixture state was not reached.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function itemStack(
  slot: number,
  itemId: number,
  name: string,
  count: number,
): BodyItemStack {
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
