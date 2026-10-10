import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompanionRuntime,
  type CompanionDecisionPort,
} from "../../src/player/runtime.js";
import {
  companionDecisionSchema,
  type CompanionDecision,
  type CompanionDecisionInput,
} from "../../src/player/agent.js";
import {
  playerOperationSchema,
  type PlayerOperation,
} from "../../src/minecraft/player-body-schema.js";
import type {
  PlayerBody,
  PlayerBodyEvent,
  PlayerBodyObservation,
  PlayerBodyObservationOptions,
  PlayerKnowledge,
  PlayerOperationResult,
} from "../../src/minecraft/player-body.js";
import { CompanionStore } from "../../src/player/store.js";
import { isImmediateStopCommand } from "../../src/player/stop-command.js";

const temporaryDirectories: string[] = [];
const runtimes: CompanionRuntime[] = [];
const stores: CompanionStore[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function freshStore(): {
  readonly store: CompanionStore;
  readonly path: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "companion-runtime-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "companion.sqlite3");
  const store = CompanionStore.open(path, { ownerUsername: "Builder" });
  stores.push(store);
  return { store, path };
}

function failStopPersistence(store: CompanionStore): void {
  store.stop = () => {
    throw new Error("Synthetic store failure");
  };
}

function makeObservation(
  options: {
    readonly health?: number | null;
    readonly entities?: PlayerBodyObservation["perception"]["entities"];
    readonly nearbyHostiles?: PlayerBodyObservation["perception"]["nearbyHostiles"];
  } = {},
): PlayerBodyObservation {
  const health = options.health === undefined ? 20 : options.health;
  return {
    observedAt: new Date().toISOString(),
    source: "minecraft",
    gameVersion: "1.21.4",
    dimension: "overworld",
    time: { day: 1, timeOfDay: 6000, isDay: true, raining: false },
    self: {
      username: "Mori",
      position: { x: 0, y: 64, z: 0, dimension: "overworld" },
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0,
      velocity: { x: 0, y: 0, z: 0 },
      health,
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
      horizontalFieldOfViewDegrees: 110,
      verticalFieldOfViewDegrees: 70,
      maxDistance: 64,
      coverage: "visible_subset",
      blockCountLimit: 32,
      entityCountLimit: 20,
      blockCandidateLimit: 100,
      entityCandidateLimit: 100,
      omittedBlockCandidates: 0,
      omittedEntityCandidates: 0,
      candidateSearchMayBeTruncated: false,
      blocks: [],
      placementCandidateLimit: 24,
      omittedPlacementCandidates: 0,
      placementCandidatesMayBeTruncated: false,
      placementCandidates: [],
      entities: options.entities ?? [],
      ...(options.nearbyHostiles === undefined
        ? {}
        : { nearbyHostiles: options.nearbyHostiles }),
    },
    window: null,
  };
}

function visibleEntity(id: number, x: number) {
  return {
    id,
    name: "cow",
    kind: "mob",
    category: "passive",
    position: { x, y: 64, z: 0, dimension: "overworld" },
    distance: Math.abs(x),
    health: 10,
    isPlayer: false,
  } as const;
}

function droppedItemEntity(
  id: number,
  x: number,
  name = "oak_log",
  count = 1,
): PlayerBodyObservation["perception"]["entities"][number] {
  return {
    ...visibleEntity(id, x),
    name: "item",
    kind: "object",
    droppedItem: { name, count },
  };
}

function hostileEntity(id: number, x: number) {
  return {
    ...visibleEntity(id, x),
    name: "zombie",
    category: "Hostile mobs",
  } as const;
}

function makeNearbyHostiles(
  entities: PlayerBodyObservation["perception"]["entities"],
  occludedCount = 0,
): NonNullable<PlayerBodyObservation["perception"]["nearbyHostiles"]> {
  const candidateCount = entities.length + occludedCount;
  return {
    source: "client_received_unoccluded_nearby_hostiles",
    observedAt: new Date().toISOString(),
    maxDistance: 16,
    entityOutputLimit: 8,
    omittedEntityCandidates: 0,
    candidateSearchMayBeTruncated: false,
    entities,
    aggregate: {
      source: "client_received_hostile_entity_candidates",
      countScope: "client_entity_table_within_max_distance",
      maxDistance: 16,
      clientReceivedHostileCount: candidateCount,
      worldAbsenceEstablished: false,
      directionFrame: "minecraft_cardinal_from_self_position",
      relativeOffsetFrame: "entity_position_minus_self_position",
      relativeOffsetBounds: null,
      byKind:
        candidateCount === 0 ? [] : [{ name: "zombie", count: candidateCount }],
      omittedKindGroupCount: 0,
      omittedKindEntityCount: 0,
      byDirection: [],
      occlusionCheck: {
        method: "raycast_entity_body_point",
        candidateLimit: 8,
        candidatesChecked: candidateCount,
        unoccludedCandidates: entities.length,
        occludedCandidates: occludedCount,
        uncheckedCandidates: 0,
        detailOutputLimit: 8,
        omittedUnoccludedDetails: 0,
      },
    },
  };
}

function makeDecision(
  operations: readonly PlayerOperation[] = [],
  relationshipSummary: string | null = null,
): CompanionDecision {
  return companionDecisionSchema.parse({
    speech: null,
    goal: {
      title: "Look around the nearby forest",
      successCondition: "Check the surrounding area safely.",
      source: "self",
    },
    plan:
      operations.length === 0
        ? null
        : {
            purpose: "Inspect the area and continue from observed results.",
            steps: operations.map((operation, index) => ({
              operation,
              expectedOutcome: `Step ${index + 1} is confirmed by observation.`,
            })),
          },
    memoryUpdates: [],
    relationshipSummary,
    waitMs: 5_000,
    knowledgeQuery: null,
  });
}

function emptyDecision(): CompanionDecision {
  return makeDecision();
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Condition did not become true.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type DecisionReply =
  | CompanionDecision
  | ((
      input: CompanionDecisionInput,
      signal?: AbortSignal,
    ) => Promise<CompanionDecision>);

class FakeAgent implements CompanionDecisionPort {
  readonly inputs: CompanionDecisionInput[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];

  public constructor(private readonly replies: DecisionReply[]) {}

  public async decide(
    input: CompanionDecisionInput,
    signal?: AbortSignal,
  ): Promise<CompanionDecision> {
    this.inputs.push(input);
    this.signals.push(signal);
    const reply = this.replies.shift();
    if (reply === undefined) return emptyDecision();
    return typeof reply === "function" ? reply(input, signal) : reply;
  }
}

type ExecuteHandler = (
  operation: PlayerOperation,
  signal: AbortSignal | undefined,
  body: FakeBody,
) => Promise<PlayerOperationResult>;

class FakeBody implements PlayerBody {
  readonly executed: PlayerOperation[] = [];
  readonly bodyResultIds: string[] = [];
  readonly runtimeMarkerIds: string[] = [];
  readonly listeners = new Set<(event: PlayerBodyEvent) => void>();
  readonly observeOptions: (PlayerBodyObservationOptions | undefined)[] = [];
  observation = makeObservation();
  executeHandler: ExecuteHandler | undefined;
  stopActiveCalls = 0;
  knowledgeCalls: string[] = [];

  public constructor(private readonly store: CompanionStore) {}

  public async observe(
    options?: PlayerBodyObservationOptions,
  ): Promise<PlayerBodyObservation> {
    this.observeOptions.push(options);
    return this.observation;
  }

  public async execute(
    operation: PlayerOperation,
    signal?: AbortSignal,
  ): Promise<PlayerOperationResult> {
    this.executed.push(operation);
    const bodyId = `body-operation-${this.executed.length}`;
    this.bodyResultIds.push(bodyId);
    const marker = this.store.snapshot().activeOperation?.operationId;
    if (marker !== undefined) this.runtimeMarkerIds.push(marker);
    if (this.executeHandler !== undefined)
      return this.executeHandler(operation, signal, this);
    return this.result(operation, bodyId, "successful", this.observation);
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }

  public async stopActiveOperation(): Promise<void> {
    this.stopActiveCalls += 1;
  }

  public knowledge(query: string): PlayerKnowledge {
    this.knowledgeCalls.push(query);
    return {
      source: "minecraft_registry",
      gameVersion: "1.21.4",
      registryVersion: "test",
      observedAt: new Date().toISOString(),
      query,
      facts: [],
      inferences: [],
      truncated: false,
    };
  }

  public onEvent(listener: (event: PlayerBodyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public emit(event: PlayerBodyEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  public result(
    operation: PlayerOperation,
    operationId: string,
    status: PlayerOperationResult["status"],
    after: PlayerBodyObservation | null,
  ): PlayerOperationResult {
    const now = new Date().toISOString();
    return {
      operationId,
      operation,
      status,
      startedAt: now,
      completedAt: now,
      before: this.observation,
      after,
      sameLife: true,
      recoveryRequired: false,
    };
  }
}

function createRuntime(
  store: CompanionStore,
  body: FakeBody,
  agent: FakeAgent,
  say: (text: string) => Promise<void> = async () => undefined,
): CompanionRuntime {
  const runtime = new CompanionRuntime({
    ownerUsername: "Builder",
    body,
    store,
    agent,
    say,
    minWaitMs: 1_000,
    memoryContextLimit: 7,
  });
  runtimes.push(runtime);
  return runtime;
}

const look = playerOperationSchema.parse({ kind: "look_sweep" });

describe("CompanionRuntime", () => {
  it("collects one nearby visible drop without a fresh owner instruction", async () => {
    const { store } = freshStore();
    store.save({
      goal: {
        title: "Gather nearby supplies",
        successCondition: "Pick up useful nearby items.",
        source: "owner",
      },
    });
    const body = new FakeBody(store);
    const item = droppedItemEntity(31, 2, "oak_log", 1);
    body.observation = makeObservation({ entities: [item] });
    const agent = new FakeAgent([emptyDecision()]);
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after = {
        ...before,
        self: {
          ...before.self,
          inventory: [
            {
              slot: 36,
              itemId: 17,
              name: "oak_log",
              count: 1,
              metadata: 0,
              durability: null,
              maxDurability: null,
              customName: null,
              enchantments: [],
            },
          ],
        },
        perception: { ...before.perception, entities: [] },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "automatic-pickup",
        "successful",
        after,
      );
    };
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(
      () => store.snapshot().lastOutcome?.operation.kind === "collect_item",
    );

    expect(body.executed).toEqual([{ kind: "collect_item", entityId: 31 }]);
    expect(body.observation.self.inventory).toHaveLength(1);
    expect(body.observation.perception.entities).toHaveLength(0);
    expect(store.snapshot().lastOutcome).toMatchObject({
      status: "successful",
      summary: "Body observed the requested world effect.",
      operation: { kind: "collect_item", entityId: 31 },
    });
    expect(agent.inputs).toHaveLength(0);
  });

  it("continues ordinary judgment when no nearby dropped item is visible", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.observation = makeObservation({
      entities: [droppedItemEntity(32, 7, "oak_log", 1)],
    });
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);

    expect(body.executed).toHaveLength(0);
  });

  it("suppresses an unavailable drop on later wakes while collecting a new nearby drop", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const unavailable = droppedItemEntity(33, 1, "oak_log", 1);
    body.observation = makeObservation({ entities: [unavailable] });
    const agent = new FakeAgent([emptyDecision()]);
    body.executeHandler = async (operation, _signal, fakeBody) => {
      if (operation.kind === "collect_item" && operation.entityId === 33)
        return fakeBody.result(operation, "unavailable-drop", "failed", null);
      const after = makeObservation({ entities: [unavailable] });
      fakeBody.observation = after;
      return fakeBody.result(operation, "new-drop", "successful", after);
    };
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => store.snapshot().lastOutcome?.status === "failed");
    await eventually(() => !runtime.status().thinking);
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "entities",
    });
    await eventually(() => agent.inputs.length === 1, 4_000);
    expect(body.executed).toEqual([{ kind: "collect_item", entityId: 33 }]);

    const newItem = droppedItemEntity(34, 2, "apple", 1);
    body.observation = makeObservation({ entities: [unavailable, newItem] });
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "entities",
    });
    await eventually(() => body.executed.length === 2, 4_000);

    expect(body.executed[1]).toEqual({ kind: "collect_item", entityId: 34 });
  });

  it("lets authenticated owner input supersede an automatic pickup", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.observation = makeObservation({
      entities: [droppedItemEntity(35, 2, "apple", 1)],
    });
    const agent = new FakeAgent([emptyDecision()]);
    let pickupSignal: AbortSignal | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      pickupSignal = signal;
      return await new Promise<PlayerOperationResult>((resolve) => {
        const finish = (): void =>
          resolve(
            fakeBody.result(
              operation,
              "pickup-interrupted",
              "interrupted",
              null,
            ),
          );
        if (signal?.aborted) finish();
        else signal?.addEventListener("abort", finish, { once: true });
      });
    };
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 1);
    await runtime.receiveChat("Builder", "少し待って");

    expect(pickupSignal?.aborted).toBe(true);
    expect(body.executed).toHaveLength(1);
    expect(agent.inputs).toHaveLength(1);
    expect(agent.inputs[0]?.ownerMessage).toBe("少し待って");
    expect(store.snapshot().lastOutcome?.status).toBe("interrupted");
  });

  it("lets owner stop cancel an automatic pickup before it can continue", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.observation = makeObservation({
      entities: [droppedItemEntity(36, 2, "apple", 1)],
    });
    const agent = new FakeAgent([emptyDecision()]);
    let pickupSignal: AbortSignal | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      pickupSignal = signal;
      return await new Promise<PlayerOperationResult>((resolve) => {
        const finish = (): void =>
          resolve(
            fakeBody.result(operation, "pickup-stopped", "interrupted", null),
          );
        if (signal?.aborted) finish();
        else signal?.addEventListener("abort", finish, { once: true });
      });
    };
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 1);
    await runtime.stop("Builder");

    expect(pickupSignal?.aborted).toBe(true);
    expect(store.snapshot().stopped).toBe(true);
    expect(body.executed).toHaveLength(1);
    expect(agent.inputs).toHaveLength(0);
  });

  it("gives a damage reflex priority over an automatic pickup", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const target = hostileEntity(38, 2);
    body.observation = makeObservation({
      entities: [droppedItemEntity(37, 1, "apple", 1), target],
      nearbyHostiles: makeNearbyHostiles([target]),
    });
    const agent = new FakeAgent([emptyDecision()]);
    body.executeHandler = async (operation, signal, fakeBody) => {
      if (operation.kind === "collect_item")
        return await new Promise<PlayerOperationResult>((resolve) => {
          const finish = (): void =>
            resolve(
              fakeBody.result(operation, "pickup-damaged", "interrupted", null),
            );
          if (signal?.aborted) finish();
          else signal?.addEventListener("abort", finish, { once: true });
        });
      return fakeBody.result(
        operation,
        "damage-reflex",
        "successful",
        fakeBody.observation,
      );
    };
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 1);
    body.observation = makeObservation({
      health: 10,
      entities: [droppedItemEntity(37, 1, "apple", 1), target],
      nearbyHostiles: makeNearbyHostiles([target]),
    });
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(() => body.executed.length === 2);

    expect(body.executed[0]).toEqual({ kind: "collect_item", entityId: 37 });
    expect(body.executed[1]).toEqual({ kind: "attack", entityId: 38 });
    expect(agent.inputs).toHaveLength(0);
  });

  it("does not preempt a persisted plan with automatic item pickup", async () => {
    const { store } = freshStore();
    store.save({
      goal: {
        title: "Follow the current task",
        successCondition: "Complete the planned step.",
        source: "owner",
      },
      plan: {
        purpose: "Continue the explicit owner task after a fresh judgment.",
        steps: [
          {
            operation: look,
            expectedOutcome: "The current area is observed.",
          },
        ],
      },
    });
    const body = new FakeBody(store);
    body.observation = makeObservation({
      entities: [droppedItemEntity(39, 1, "apple", 1)],
    });
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);

    expect(body.executed).toHaveLength(0);
  });

  it("suppresses routine status speech while preserving replies to owner chat", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const say = vi.fn(async () => undefined);
    const agent = new FakeAgent([
      companionDecisionSchema.parse({
        ...emptyDecision(),
        speech: "周りを見ながら歩いているよ。",
      }),
      companionDecisionSchema.parse({
        ...emptyDecision(),
        speech: "うん、今の状況を確認するね。",
      }),
    ]);
    const runtime = createRuntime(store, body, agent, say);

    await runtime.start();
    await eventually(() => store.snapshot().waitUntil !== null);
    expect(say).not.toHaveBeenCalled();

    await runtime.receiveChat("Builder", "状況を教えて");

    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith("うん、今の状況を確認するね。");
    expect(body.observeOptions.length).toBeGreaterThan(0);
    expect(
      body.observeOptions.every(
        (options) => options?.ownerPositionException === true,
      ),
    ).toBe(true);
  });

  it("runs owner follow directly, ignores movement wakes, and keeps stop authenticated", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const say = vi.fn(async () => undefined);
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent, say);
    const followSignals: AbortSignal[] = [];
    body.executeHandler = async (operation, signal, fakeBody) => {
      if (operation.kind !== "follow_owner")
        return fakeBody.result(
          operation,
          `body-${fakeBody.executed.length}`,
          "successful",
          fakeBody.observation,
        );
      if (signal !== undefined) followSignals.push(signal);
      return await new Promise<PlayerOperationResult>((resolve) => {
        const finish = (): void =>
          resolve(
            fakeBody.result(
              operation,
              `body-follow-${fakeBody.executed.length}`,
              "interrupted",
              null,
            ),
          );
        if (signal?.aborted) finish();
        else signal?.addEventListener("abort", finish, { once: true });
      });
    };

    await runtime.receiveChat("Builder", "こっち来て");
    await eventually(() => body.executed.length === 1);
    expect(body.executed[0]).toEqual({ kind: "follow_owner" });
    expect(runtime.status().currentOperation?.kind).toBe("follow_owner");
    expect(agent.inputs).toHaveLength(0);

    await runtime.receiveChat("Builder", "ついてきて");
    expect(body.executed).toHaveLength(1);
    expect(say).toHaveBeenCalledTimes(1);

    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "position",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(agent.inputs).toHaveLength(0);

    await runtime.receiveChat("Builder", "状況を教えて");
    expect(followSignals[0]?.aborted).toBe(true);
    expect(agent.inputs).toHaveLength(1);

    await runtime.receiveChat("Builder", "ついてきて");
    await eventually(() => body.executed.length === 2);
    await runtime.receiveChat("Impostor", "止まって");
    expect(followSignals[1]?.aborted).toBe(false);
    await runtime.receiveChat("Builder", "止まって");

    expect(followSignals[1]?.aborted).toBe(true);
    expect(store.snapshot().stopped).toBe(true);
    expect(agent.inputs).toHaveLength(1);
    expect(body.executed.map(({ kind }) => kind)).toEqual([
      "follow_owner",
      "follow_owner",
    ]);
  });

  it("keeps an internal follow operation from a nonconforming Agent port out of Body", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const injected = {
      ...emptyDecision(),
      plan: {
        purpose: "Attempt to follow the owner.",
        steps: [
          {
            operation: playerOperationSchema.parse({ kind: "follow_owner" }),
            expectedOutcome: "The owner remains nearby.",
          },
        ],
      },
    } as unknown as CompanionDecision;
    const agent = new FakeAgent([injected]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => runtime.status().nextWakeAt !== null);

    expect(body.executed).toHaveLength(0);
    expect(store.snapshot().plan).toBeNull();
    expect(runtime.status().recentErrors).toHaveLength(0);
  });

  it("continues a verified two-step plan with one model call and correlates Body outcomes to runtime markers", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([makeDecision([look, look])]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 2);

    expect(agent.inputs).toHaveLength(1);
    expect(body.runtimeMarkerIds).toHaveLength(2);
    expect(body.runtimeMarkerIds[0]).not.toBe(body.bodyResultIds[0]);
    expect(body.runtimeMarkerIds[1]).not.toBe(body.bodyResultIds[1]);
    expect(store.snapshot().plan).toBeNull();
    expect(store.snapshot().lastOutcome?.operationId).toBe(
      body.runtimeMarkerIds[1],
    );
    expect(runtime.status().lastOutcome?.status).toBe("successful");
  });

  it("preserves the relationship summary on null and persists a meaningful update", async () => {
    const { store } = freshStore();
    store.save({ relationshipSummary: "以前から一緒に探索している。" });
    const body = new FakeBody(store);
    const agent = new FakeAgent([
      makeDecision(),
      makeDecision([], "森で迷った経験から、慎重な相談を大切にしている。"),
    ]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => store.snapshot().waitUntil !== null);
    expect(store.snapshot().relationshipSummary).toBe(
      "以前から一緒に探索している。",
    );

    await runtime.receiveChat("Builder", "あの森で一緒に迷ったね");
    expect(store.snapshot().relationshipSummary).toBe(
      "森で迷った経験から、慎重な相談を大切にしている。",
    );
  });

  it("uses one follow-up judgment only when registry information is needed", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([
      companionDecisionSchema.parse({
        ...emptyDecision(),
        knowledgeQuery: "oak planks",
      }),
      emptyDecision(),
    ]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => agent.inputs.length === 2);

    expect(agent.inputs).toHaveLength(2);
    expect(body.knowledgeCalls).toEqual(["oak planks"]);
    expect(agent.inputs[1]?.knowledge?.query).toBe("oak planks");
    expect(body.knowledgeCalls).toHaveLength(1);
  });

  it("clears a failed plan and waits for a new judgment instead of running its stale next step", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([makeDecision([look, look]), emptyDecision()]);
    body.executeHandler = async (operation, _signal, fakeBody) =>
      fakeBody.result(operation, "body-failed", "failed", fakeBody.observation);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => store.snapshot().lastOutcome?.status === "failed");
    expect(store.snapshot().plan).toBeNull();

    await runtime.receiveChat("Builder", "状況を教えて");

    expect(agent.inputs).toHaveLength(2);
    expect(body.executed).toHaveLength(1);
    expect(store.snapshot().plan).toBeNull();
  });

  it("durably stops across restart, fences a late model response, and authorizes resume only for the owner", async () => {
    const { store, path } = freshStore();
    const body = new FakeBody(store);
    const pending = deferred<CompanionDecision>();
    const agent = new FakeAgent([() => pending.promise]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);
    expect(await runtime.stop("Impostor")).toBe(false);
    const stopping = runtime.stop("Builder");
    expect(store.snapshot().stopped).toBe(true);
    pending.resolve(makeDecision([look]));
    await stopping;
    expect(body.executed).toHaveLength(0);
    await runtime.shutdown();
    store.close();

    const reopened = CompanionStore.open(path, { ownerUsername: "Builder" });
    stores.push(reopened);
    expect(reopened.snapshot().stopped).toBe(true);
    const resumedRuntime = createRuntime(
      reopened,
      new FakeBody(reopened),
      new FakeAgent([emptyDecision()]),
    );
    await resumedRuntime.receiveChat("Impostor", "再開");
    expect(reopened.snapshot().stopped).toBe(true);
    await resumedRuntime.receiveChat("Builder", "再開");
    expect(reopened.snapshot().stopped).toBe(false);
    expect(resumedRuntime.status().running).toBe(true);
  });

  it("prioritizes an authenticated stop over message persistence and stays paused when stop persistence fails", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const pending = deferred<CompanionDecision>();
    const agent = new FakeAgent([() => pending.promise]);
    const runtime = createRuntime(store, body, agent);
    failStopPersistence(store);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);
    await runtime.receiveChat("Impostor", "止まって");
    expect(runtime.status().stopped).toBe(false);

    const stopping = runtime.receiveChat("Builder", "止まって");
    await eventually(() => agent.signals[0]?.aborted === true);
    expect(runtime.status()).toMatchObject({ stopped: true, running: false });
    expect(store.snapshot().stopped).toBe(false);
    pending.resolve(emptyDecision());
    await stopping;

    await runtime.receiveChat("Builder", "続けて");
    expect(await runtime.resume("Builder", "再開")).toBe(false);
    expect(agent.inputs).toHaveLength(1);
    expect(body.executed).toHaveLength(0);
    expect(runtime.status().stopped).toBe(true);
    expect(runtime.status().recentErrors[0]?.code).toBe(
      "owner_stop_persistence_failed",
    );
  });

  it("cancels an active Body operation even when the durable stop transaction throws", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([makeDecision([look, look])]);
    let bodySignal: AbortSignal | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      bodySignal = signal;
      return await new Promise<PlayerOperationResult>((resolve) => {
        signal?.addEventListener(
          "abort",
          () =>
            resolve(
              fakeBody.result(
                operation,
                "body-cancelled-on-stop",
                "interrupted",
                null,
              ),
            ),
          { once: true },
        );
      });
    };
    const runtime = createRuntime(store, body, agent);
    failStopPersistence(store);

    await runtime.start();
    await eventually(() => body.executed.length === 1);
    await runtime.receiveChat("Builder", "自律行動を止めて");

    expect(bodySignal?.aborted).toBe(true);
    expect(body.stopActiveCalls).toBe(1);
    expect(body.executed).toHaveLength(1);
    expect(store.snapshot().stopped).toBe(false);
    expect(store.snapshot().activeOperation).toBeNull();
    expect(runtime.status()).toMatchObject({ stopped: true, running: false });
  });

  it("lets authenticated owner chat interrupt an active action and discards the old plan", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([
      makeDecision([look, look]),
      makeDecision([look]),
    ]);
    body.executeHandler = async (operation, signal, fakeBody) => {
      if (fakeBody.executed.length > 1)
        return fakeBody.result(
          operation,
          "body-new-intent",
          "successful",
          fakeBody.observation,
        );
      return await new Promise<PlayerOperationResult>((resolve) => {
        signal?.addEventListener(
          "abort",
          () =>
            resolve(
              fakeBody.result(
                operation,
                "body-interrupted",
                "interrupted",
                null,
              ),
            ),
          { once: true },
        );
      });
    };
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 1);
    expect(runtime.status().currentOperation?.kind).toBe("look_sweep");
    await runtime.receiveChat("Builder", "今は戻ろう");

    expect(agent.inputs).toHaveLength(2);
    expect(body.executed).toHaveLength(2);
    expect(store.snapshot().lastOutcome?.status).toBe("successful");
    expect(store.snapshot().plan).toBeNull();
  });

  it("coalesces benign events during judgment and tolerates incidental target movement", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const cow = visibleEntity(17, 1);
    body.observation = makeObservation({ entities: [cow] });
    const pending = deferred<CompanionDecision>();
    const agent = new FakeAgent([
      () => pending.promise,
      makeDecision([
        look,
        playerOperationSchema.parse({ kind: "attack", entityId: 17 }),
      ]),
    ]);
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const result = fakeBody.result(
        operation,
        `body-world-${fakeBody.executed.length}`,
        "successful",
        fakeBody.observation,
      );
      if (fakeBody.executed.length === 1)
        fakeBody.observation = makeObservation({
          entities: [visibleEntity(17, 4)],
        });
      return result;
    };
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "entities",
    });
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "blocks",
    });
    pending.resolve(
      makeDecision([
        look,
        playerOperationSchema.parse({ kind: "attack", entityId: 17 }),
      ]),
    );
    await eventually(() => body.executed.length === 2);

    expect(agent.inputs).toHaveLength(1);
    expect(body.executed[1]).toMatchObject({ kind: "attack", entityId: 17 });
  });

  it("reacts to damage from fresh Body information without a model rejudgment", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const pending = deferred<CompanionDecision>();
    const agent = new FakeAgent([
      async (_input, signal) => {
        signal?.addEventListener(
          "abort",
          () => pending.resolve(makeDecision([look])),
          {
            once: true,
          },
        );
        return pending.promise;
      },
      emptyDecision(),
    ]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);
    body.observation = makeObservation({ health: 10 });
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(() => body.executed.length === 1);

    expect(agent.inputs).toHaveLength(1);
    expect(body.executed[0]).toEqual({ kind: "look_sweep" });
    expect(store.snapshot().lastOutcome?.status).toBe("successful");
  });

  it("attacks one nearby unoccluded hostile from a fresh observation when damage source is unknown", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const nearest = hostileEntity(17, 2);
    const farther = hostileEntity(18, 3);
    body.observation = makeObservation({
      entities: [nearest, farther],
      nearbyHostiles: makeNearbyHostiles([nearest, farther]),
    });
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => runtime.status().nextWakeAt !== null);
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(
      () => store.snapshot().lastOutcome?.operation.kind === "attack",
    );

    expect(body.executed).toEqual([
      playerOperationSchema.parse({ kind: "attack", entityId: 17 }),
    ]);
    expect(agent.inputs).toHaveLength(1);
    expect(store.snapshot().lastOutcome?.status).toBe("successful");
  });

  it("uses one bounded sweep when only occluded or non-hostile nearby information is available", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.observation = makeObservation({
      entities: [visibleEntity(17, 1)],
      nearbyHostiles: makeNearbyHostiles([], 1),
    });
    body.executeHandler = async (operation, _signal, fakeBody) =>
      fakeBody.result(operation, "reflex-unverified", "unverified", null);
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => runtime.status().nextWakeAt !== null);
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(() => store.snapshot().lastOutcome !== null);

    expect(body.executed).toEqual([{ kind: "look_sweep" }]);
    expect(store.snapshot().lastOutcome?.status).toBe("unverified");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(agent.inputs).toHaveLength(1);
  });

  it("lets owner stop and ordinary authenticated owner input supersede a damage reflex", async () => {
    const stopped = freshStore();
    const stoppedBody = new FakeBody(stopped.store);
    const stoppedAgent = new FakeAgent([emptyDecision()]);
    const stoppedRuntime = createRuntime(
      stopped.store,
      stoppedBody,
      stoppedAgent,
    );
    await stoppedRuntime.start();
    await eventually(() => stoppedRuntime.status().nextWakeAt !== null);
    await stoppedRuntime.stop("Builder");
    stoppedBody.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    expect(stoppedBody.executed).toHaveLength(0);
    expect(stoppedAgent.inputs).toHaveLength(1);

    const { store } = freshStore();
    const body = new FakeBody(store);
    const attackTarget = hostileEntity(19, 2);
    body.observation = makeObservation({
      entities: [attackTarget],
      nearbyHostiles: makeNearbyHostiles([attackTarget]),
    });
    const agent = new FakeAgent([emptyDecision(), emptyDecision()]);
    const runtime = createRuntime(store, body, agent);
    let attackSignal: AbortSignal | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      attackSignal = signal;
      return await new Promise<PlayerOperationResult>((resolve) => {
        signal?.addEventListener(
          "abort",
          () =>
            resolve(
              fakeBody.result(
                operation,
                "reflex-cancelled",
                "interrupted",
                null,
              ),
            ),
          { once: true },
        );
      });
    };

    await runtime.start();
    await eventually(() => runtime.status().nextWakeAt !== null);
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(() => body.executed.length === 1);
    await runtime.receiveChat("Builder", "状況を教えて");

    expect(attackSignal?.aborted).toBe(true);
    expect(agent.inputs).toHaveLength(2);
    expect(store.snapshot().lastOutcome?.status).toBe("interrupted");
  });

  it("coalesces repeated damage while an attack is already running", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const target = hostileEntity(23, 2);
    body.observation = makeObservation({
      entities: [target],
      nearbyHostiles: makeNearbyHostiles([target]),
    });
    const agent = new FakeAgent([
      makeDecision([
        playerOperationSchema.parse({ kind: "attack", entityId: 23 }),
      ]),
    ]);
    let attackSignal: AbortSignal | undefined;
    let finishAttack: (() => void) | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      attackSignal = signal;
      return await new Promise<PlayerOperationResult>((resolve) => {
        finishAttack = () =>
          resolve(
            fakeBody.result(
              operation,
              "planned-attack",
              "successful",
              fakeBody.observation,
            ),
          );
      });
    };
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 1);
    for (let index = 0; index < 3; index += 1)
      body.emit({
        type: "bot_damaged",
        at: new Date().toISOString(),
        source: null,
        confidence: "unknown",
      });

    expect(attackSignal?.aborted).toBe(false);
    expect(agent.inputs).toHaveLength(1);
    finishAttack?.();
    await eventually(
      () => store.snapshot().lastOutcome?.status === "successful",
    );
    expect(body.executed).toHaveLength(1);
    expect(agent.inputs).toHaveLength(1);
  });

  it("preserves queued owner chat when a damage burst arrives as a reflex is cancelled", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);
    let reflexSignal: AbortSignal | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      reflexSignal = signal;
      return await new Promise<PlayerOperationResult>((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            for (let index = 0; index < 3; index += 1)
              body.emit({
                type: "bot_damaged",
                at: new Date().toISOString(),
                source: null,
                confidence: "unknown",
              });
            resolve(
              fakeBody.result(operation, "old-reflex", "interrupted", null),
            );
          },
          { once: true },
        );
      });
    };

    await runtime.start();
    await eventually(() => runtime.status().nextWakeAt !== null);
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(() => body.executed.length === 1);
    await runtime.receiveChat("Builder", "状況を教えて");

    expect(reflexSignal?.aborted).toBe(true);
    expect(agent.inputs).toHaveLength(2);
    expect(agent.inputs[1]?.ownerMessage).toBe("状況を教えて");
    expect(store.snapshot().lastOutcome?.status).toBe("interrupted");
    expect(body.executed).toHaveLength(1);
  });
});

describe("owner stop command", () => {
  it("detects direct commands without treating quotes, negation, questions, or future conditions as stops", () => {
    expect(isImmediateStopCommand("今どうなってる、止まって")).toBe(true);
    expect(isImmediateStopCommand("自律行動を止めてください")).toBe(true);
    expect(isImmediateStopCommand("止まらないで")).toBe(false);
    expect(isImmediateStopCommand("『止めて』って言ったよ")).toBe(false);
    expect(isImmediateStopCommand("止めていい？")).toBe(false);
    expect(isImmediateStopCommand("明日停止して")).toBe(false);
  });
});
