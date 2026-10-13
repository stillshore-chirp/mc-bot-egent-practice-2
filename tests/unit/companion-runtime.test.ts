import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
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
  PlayerHomePoiScan,
} from "../../src/minecraft/player-body.js";
import type {
  BodyItemStack,
  BodyVisibleBlock,
  BodyWindowSnapshot,
  PlayerBodyLookSweep,
} from "../../src/minecraft/player-body-observation.js";
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
  vi.useRealTimers();
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

function makeHomePoiScan(dimension = "overworld"): PlayerHomePoiScan {
  const observedAt = "2026-10-10T00:00:00.000Z";
  return {
    source: "loaded_home_poi_scan",
    observedAt,
    dimension,
    center: { x: 0, y: 64, z: 0 },
    radius: 128,
    coverage: "loaded_blocks_only",
    candidateLimit: 8,
    omittedCandidatesAtLeast: 0,
    candidateSearchMayBeTruncated: false,
    worldAbsenceEstablished: false,
    homes: [
      {
        bedName: "minecraft:white_bed",
        bedHead: { x: 8, y: 64, z: 4 },
        observedAt,
        doorRelationStatus: "unknown",
        doorRelationReason: "no_supported_closed_wood_door_boundary",
        connectedRoomCellCount: 0,
        roomSearchTruncated: false,
        doorSearchMayBeTruncated: false,
        doors: [],
      },
    ],
  };
}

function failStopPersistence(store: CompanionStore): void {
  store.stop = () => {
    throw new Error("Synthetic store failure");
  };
}

function makeObservation(
  options: {
    readonly health?: number | null;
    readonly food?: number | null;
    readonly inLava?: boolean | null;
    readonly onFire?: boolean | null;
    readonly suffocating?: boolean | null;
    readonly inventory?: readonly BodyItemStack[];
    readonly equipment?: PlayerBodyObservation["self"]["equipment"];
    readonly blocks?: readonly BodyVisibleBlock[];
    readonly entities?: PlayerBodyObservation["perception"]["entities"];
    readonly nearbyHostiles?: PlayerBodyObservation["perception"]["nearbyHostiles"];
    readonly nearbyDroppedItems?: PlayerBodyObservation["perception"]["nearbyDroppedItems"];
    readonly window?: BodyWindowSnapshot | null;
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
      food: options.food === undefined ? 20 : options.food,
      foodSaturation: 5,
      oxygen: 20,
      inWater: false,
      inLava: options.inLava === undefined ? false : options.inLava,
      onFire: options.onFire === undefined ? false : options.onFire,
      suffocating:
        options.suffocating === undefined ? false : options.suffocating,
      sleeping: false,
      mountedEntityId: null,
      gameMode: "survival",
      experience: { level: 0, points: 0, progress: 0 },
      inventory: options.inventory ?? [],
      equipment: {
        hand: gearItem("wooden_sword", 0),
        "off-hand": null,
        head: gearItem("leather_helmet", 5),
        torso: gearItem("leather_chestplate", 6),
        legs: gearItem("leather_leggings", 7),
        feet: gearItem("leather_boots", 8),
        ...options.equipment,
      },
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
      blocks: options.blocks ?? [],
      placementCandidateLimit: 24,
      omittedPlacementCandidates: 0,
      placementCandidatesMayBeTruncated: false,
      placementCandidates: [],
      entities: options.entities ?? [],
      ...(options.nearbyHostiles === undefined
        ? {}
        : { nearbyHostiles: options.nearbyHostiles }),
      ...(options.nearbyDroppedItems === undefined
        ? {}
        : { nearbyDroppedItems: options.nearbyDroppedItems }),
    },
    window: options.window ?? null,
  };
}

function gearItem(name: string, slot: number, durability = 100): BodyItemStack {
  return {
    slot,
    itemId: 1,
    name,
    count: 1,
    metadata: 0,
    durability,
    maxDurability: 100,
    customName: null,
    enchantments: [],
  };
}

function foodItem(name: string, slot: number, count = 1): BodyItemStack {
  return {
    slot,
    itemId: 2,
    name,
    count,
    metadata: 0,
    durability: null,
    maxDurability: null,
    customName: null,
    enchantments: [],
  };
}

function chestWindow(
  chestItem: BodyItemStack | null,
  inventoryItem: BodyItemStack | null = null,
): BodyWindowSnapshot {
  return {
    id: 7,
    type: "minecraft:generic_9x3",
    title: "Chest",
    inventoryStart: 27,
    inventoryEnd: 63,
    selectedItem: null,
    slots: [
      chestItem,
      ...Array<BodyItemStack | null>(26).fill(null),
      inventoryItem,
      ...Array<BodyItemStack | null>(35).fill(null),
    ],
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

function makeNearbyDroppedItems(
  entities: PlayerBodyObservation["perception"]["entities"],
  maxDistance = 64,
): NonNullable<PlayerBodyObservation["perception"]["nearbyDroppedItems"]> {
  return {
    source: "client_received_dropped_items",
    observedAt: new Date().toISOString(),
    maxDistance,
    entityOutputLimit: 64,
    omittedEntityCandidates: 0,
    candidateSearchMayBeTruncated: false,
    entities,
  };
}

function hostileEntity(id: number, x: number) {
  return {
    ...visibleEntity(id, x),
    name: "zombie",
    category: "Hostile mobs",
  } as const;
}

function equipmentChestBlock(
  x: number,
  distance = Math.abs(x),
): BodyVisibleBlock {
  return {
    name: "minecraft:chest",
    stateId: 1,
    position: { x, y: 64, z: 0, dimension: "overworld" },
    distance,
    properties: {},
  };
}

function emptyLookSweep(): PlayerBodyLookSweep {
  const view: PlayerBodyLookSweep["current"] = {
    directionIndex: null,
    yawDegrees: 0,
    pitchDegrees: -25,
    dimension: "overworld",
    visibleBlocks: [],
    visibleEntities: [],
    omittedBlockCandidates: 0,
    omittedEntityCandidates: 0,
    candidateSearchMayBeTruncated: false,
  };
  return {
    current: view,
    directions: Array.from({ length: 8 }, (_, directionIndex) => ({
      ...view,
      directionIndex,
    })),
    plannedDirectionCount: 8,
    complete: true,
    candidateSearchMayBeTruncated: false,
    worldAbsenceEstablished: false,
  };
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
    ownerMessageDisposition: null,
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

function ownerGoalDecision(
  operations: readonly PlayerOperation[],
  title: string,
): CompanionDecision {
  return companionDecisionSchema.parse({
    ...makeDecision(operations),
    goal: {
      title,
      successCondition: "The requested observation is confirmed by Body.",
      source: "owner",
    },
  });
}

function interleavedReplyDecision(
  speech: string | null,
  disposition: "answer_only" | "update_goal",
): CompanionDecision {
  return companionDecisionSchema.parse({
    ...emptyDecision(),
    speech,
    ownerMessageDisposition: disposition,
    goal: null,
    plan: null,
    memoryUpdates: [],
    relationshipSummary: null,
    knowledgeQuery: null,
  });
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

async function eventuallyWithFakeTimers(
  predicate: () => boolean,
  maxTimerAdvances = 512,
): Promise<void> {
  for (let attempt = 0; attempt < maxTimerAdvances; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
    if (vi.getTimerCount() === 0) await vi.advanceTimersByTimeAsync(1);
    else await vi.advanceTimersToNextTimerAsync();
  }
  if (!predicate()) throw new Error("Condition did not become true.");
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
  readonly results: PlayerOperationResult[] = [];
  readonly bodyResultIds: string[] = [];
  readonly runtimeMarkerIds: string[] = [];
  readonly listeners = new Set<(event: PlayerBodyEvent) => void>();
  readonly observeOptions: (PlayerBodyObservationOptions | undefined)[] = [];
  observeCalls = 0;
  observation = makeObservation();
  executeHandler: ExecuteHandler | undefined;
  observeHandler: ((body: FakeBody) => Promise<void> | void) | undefined;
  stopActiveCalls = 0;
  knowledgeCalls: string[] = [];
  readonly foodNames = new Set<string>();

  public constructor(private readonly store: CompanionStore) {}

  public async observe(
    options?: PlayerBodyObservationOptions,
  ): Promise<PlayerBodyObservation> {
    this.observeCalls += 1;
    this.observeOptions.push(options);
    await this.observeHandler?.(this);
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
      facts: this.foodNames.has(query)
        ? [
            {
              kind: "item",
              id: 2,
              name: query,
              displayName: query,
              stackSize: 64,
              maxDurability: null,
              enchantCategories: [],
              food: { foodPoints: 4, saturation: 1.2 },
            },
          ]
        : [],
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
    before: PlayerBodyObservation = this.observation,
    sameLife = true,
  ): PlayerOperationResult {
    const now = new Date().toISOString();
    const result = {
      operationId,
      operation,
      status,
      startedAt: now,
      completedAt: now,
      before,
      after,
      sameLife,
      recoveryRequired: false,
    };
    this.results.push(result);
    return result;
  }
}

function createRuntime(
  store: CompanionStore,
  body: FakeBody,
  agent: FakeAgent,
  say: (text: string) => Promise<void> = async () => undefined,
  minWaitMs = 1_000,
): CompanionRuntime {
  const runtime = new CompanionRuntime({
    ownerUsername: "Builder",
    body,
    store,
    agent,
    say,
    minWaitMs,
    memoryContextLimit: 7,
  });
  runtimes.push(runtime);
  return runtime;
}

const look = playerOperationSchema.parse({ kind: "look_sweep" });
const scanHome = playerOperationSchema.parse({ kind: "scan_home" });
const jump = playerOperationSchema.parse({
  kind: "control",
  controls: { jump: true },
  ticks: 40,
});

describe("CompanionRuntime", () => {
  it("persists declared purpose and allowlisted pre-action observation before Body dispatch", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const purpose =
      "Find the shoreline and confirm whether the path is flooded.";
    const base = makeDecision([look]);
    const decision = companionDecisionSchema.parse({
      ...base,
      plan: { ...base.plan, purpose },
    });
    const agent = new FakeAgent([decision]);
    const runtime = createRuntime(store, body, agent);
    body.observation = {
      ...makeObservation(),
      observedAt: "2026-10-10T00:00:00.000Z",
      self: { ...makeObservation().self, inWater: true, oxygen: 7 },
    };
    body.executeHandler = async (operation, _signal, fakeBody) => {
      expect(store.snapshot().activeOperation).toMatchObject({
        operation,
        purpose,
        preActionObservation: {
          source: "minecraft",
          observedAt: "2026-10-10T00:00:00.000Z",
          inWater: true,
          oxygen: 7,
        },
      });
      return fakeBody.result(
        operation,
        "synthetic-purpose-result",
        "successful",
        fakeBody.observation,
      );
    };

    await runtime.receiveChat("Builder", "周囲を確認して");

    expect(store.snapshot().lastOutcome).toMatchObject({
      purpose,
      preActionObservation: {
        observedAt: "2026-10-10T00:00:00.000Z",
        inWater: true,
        oxygen: 7,
      },
      bodyEvidence: { source: "body_result" },
    });
    expect(store.snapshot().lastOutcome?.bodyEvidence?.startedAt).toBe(
      body.results[0]?.startedAt,
    );
  });

  it("persists a successful HOME scan and supplies it to a later Agent decision", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([makeDecision([scanHome]), emptyDecision()]);
    const runtime = createRuntime(store, body, agent);
    const scan = makeHomePoiScan();
    body.executeHandler = async (operation, _signal, fakeBody) => ({
      ...fakeBody.result(
        operation,
        "synthetic-home-scan",
        "successful",
        fakeBody.observation,
      ),
      homePoiScan: scan,
    });

    await runtime.receiveChat("Builder", "近くのベッドを探して");

    expect(body.executed).toEqual([{ kind: "scan_home" }]);
    expect(store.latestObservedHomePois()).toHaveLength(1);
    expect(agent.inputs[0]?.homePoiMemories).toEqual([]);

    await runtime.receiveChat("Builder", "前に記録したベッドの場所を教えて");

    expect(agent.inputs.at(-1)?.homePoiMemories).toHaveLength(1);
    expect(agent.inputs.at(-1)?.homePoiMemories?.[0]?.metadata).toMatchObject({
      homeMemory: {
        dimension: "overworld",
        home: {
          bedName: "minecraft:white_bed",
          bedHead: { x: 8, y: 64, z: 4 },
        },
      },
    });
  });

  it("does not persist a late successful HOME scan after owner stop", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([makeDecision([scanHome]), emptyDecision()]);
    const pendingResult = deferred<PlayerOperationResult>();
    body.executeHandler = async () => pendingResult.promise;
    const runtime = createRuntime(store, body, agent);

    const ownerTurn = runtime.receiveChat("Builder", "近くのベッドを探して");
    await eventually(() => body.executed.length === 1);
    const stopping = runtime.stop("Builder");
    await eventually(() => runtime.status().stopped);
    expect(store.snapshot().stopped).toBe(true);

    pendingResult.resolve({
      ...body.result(
        scanHome,
        "late-owner-stopped-home-scan",
        "successful",
        body.observation,
      ),
      homePoiScan: makeHomePoiScan(),
    });
    await Promise.all([ownerTurn, stopping]);

    expect(body.executed).toEqual([scanHome]);
    expect(store.latestObservedHomePois()).toHaveLength(0);
    expect(store.snapshot().stopped).toBe(true);
    await runtime.shutdown();
  });

  it("does not persist HOME evidence when the before and after dimensions differ", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after: PlayerBodyObservation = {
        ...before,
        dimension: "nether",
        self: {
          ...before.self,
          position: { ...before.self.position, dimension: "nether" },
        },
      };
      return {
        ...fakeBody.result(
          operation,
          "dimension-changed-home-scan",
          "successful",
          after,
          before,
        ),
        homePoiScan: makeHomePoiScan(before.dimension),
      };
    };
    const runtime = createRuntime(
      store,
      body,
      new FakeAgent([makeDecision([scanHome]), emptyDecision()]),
    );

    await runtime.receiveChat("Builder", "近くのベッドを探して");

    expect(body.executed).toEqual([scanHome]);
    expect(store.latestObservedHomePois()).toHaveLength(0);
    await runtime.shutdown();
  });

  it("provides declared purpose and post-action evidence to a later question after synthetic respawn", async () => {
    const { store } = freshStore();
    const before = {
      source: "minecraft" as const,
      observedAt: "2026-10-10T00:00:00.000Z",
      dimension: "overworld",
      position: { x: 12, y: 64, z: 4 },
      yaw: 0,
      pitch: 0,
      health: 20,
      food: 20,
      oxygen: 20,
      inWater: false,
      inLava: false,
      onFire: false,
      suffocating: false,
      sleeping: false,
    };
    store.recordOutcome({
      operationId: "synthetic-water-purpose",
      operation: look,
      status: "successful",
      summary: "Body observed a water entry after the movement attempt.",
      expectedOutcome: "Reach the shoreline and inspect the route.",
      observedAt: "2026-10-10T00:00:02.000Z",
      purpose: "Reach the shoreline to inspect the underwater entrance.",
      preActionObservation: before,
      bodyEvidence: {
        source: "body_result",
        startedAt: "2026-10-10T00:00:00.500Z",
        completedAt: "2026-10-10T00:00:02.000Z",
        sameLife: true,
        recoveryRequired: false,
        reasonCode: null,
        before,
        after: {
          ...before,
          observedAt: "2026-10-10T00:00:02.000Z",
          inWater: true,
        },
      },
    });
    const answer = companionDecisionSchema.parse({
      speech:
        "記録された実行前の目的は水中の入口を調べることだったよ。実行前の観測では水中ではなく、Body結果では水中が観測されたよ。今は水中ではないよ。水へ入ったさらに前の理由は記録されていないよ。",
      ownerMessageDisposition: null,
      goal: null,
      plan: null,
      memoryUpdates: [],
      relationshipSummary: null,
      waitMs: 5_000,
      knowledgeQuery: null,
    });
    const body = new FakeBody(store);
    const agent = new FakeAgent([emptyDecision(), emptyDecision(), answer]);
    const say = vi.fn(async () => undefined);
    const runtime = createRuntime(store, body, agent, say);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);
    await eventually(() => !runtime.status().thinking);
    body.emit({ type: "bot_death", at: "2026-10-10T00:00:03.000Z" });
    body.observation = {
      ...body.observation,
      observedAt: "2026-10-10T00:00:04.000Z",
      self: { ...body.observation.self, inWater: false, oxygen: 20 },
    };
    await eventually(() => agent.inputs.length === 2);
    await eventually(() => !runtime.status().thinking);

    await runtime.receiveChat("Builder", "復活した今、なぜ水へ行ったの？");

    expect(agent.inputs[2]?.recentOutcomes?.[0]).toMatchObject({
      purpose: "Reach the shoreline to inspect the underwater entrance.",
      preActionObservation: { inWater: false },
      bodyEvidence: { after: { inWater: true } },
    });
    expect(agent.inputs[2]?.observation.self.inWater).toBe(false);
    expect(say).toHaveBeenCalledWith(answer.speech);
  });

  it("prioritizes confirmed life history for a later question alongside current health and owner reports", async () => {
    const { store, path } = freshStore();
    const ownerReport = "前に洞窟で死亡したと報告した";
    store.remember(
      [
        {
          kind: "fact",
          content: ownerReport,
          importance: 4,
          ownerQuote: ownerReport,
        },
      ],
      { ownerMessage: ownerReport },
    );
    expect(store.latestObservedLifeMemory()).toBeNull();
    const body = new FakeBody(store);
    body.observation = {
      ...body.observation,
      self: { ...body.observation.self, health: 20 },
    };
    const answer = companionDecisionSchema.parse({
      ...emptyDecision(),
      speech:
        "Minecraftで確認した過去の死亡と復活は記録にあるよ。今の体力は現在の観測だよ。洞窟での死亡はownerからの報告として分けているよ。",
    });
    const agent = new FakeAgent([emptyDecision(), emptyDecision(), answer]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);
    await eventually(() => !runtime.status().thinking);
    body.emit({ type: "bot_death", at: "2026-10-10T00:00:03.000Z" });
    await eventually(() => agent.inputs.length === 2);
    await eventually(() => !runtime.status().thinking);
    body.emit({
      type: "bot_respawn",
      at: "2026-10-10T00:00:04.000Z",
      deathAt: "2026-10-10T00:00:03.000Z",
    });

    await runtime.shutdown();
    store.close();
    const reopened = CompanionStore.open(path, { ownerUsername: "Builder" });
    stores.push(reopened);
    const laterBody = new FakeBody(reopened);
    laterBody.observation = {
      ...laterBody.observation,
      self: { ...laterBody.observation.self, health: 20 },
    };
    const laterAgent = new FakeAgent([answer]);
    const laterRuntime = createRuntime(reopened, laterBody, laterAgent);

    await laterRuntime.receiveChat("Builder", "前の死亡と復活について教えて");

    const input = laterAgent.inputs[0];
    const lifeMemory = input?.memories.find((memory) => memory.kind === "life");
    const ownerMemory = input?.memories.find(
      (memory) => memory.source === "player_stated",
    );
    expect(input?.observation.self.health).toBe(20);
    expect(lifeMemory?.source).toBe("minecraft_observed");
    expect(lifeMemory?.content).toContain("2026-10-10T00:00:03.000Z");
    expect(lifeMemory?.content).toContain("2026-10-10T00:00:04.000Z");
    expect(lifeMemory?.content).toContain("死因: 未確認");
    expect(ownerMemory).toMatchObject({
      source: "player_stated",
      content: ownerReport,
    });
  });

  it("records observed life events during durable owner stop without waking or dispatching", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);
    await eventually(() => !runtime.status().thinking);
    await runtime.stop("Builder");
    body.emit({ type: "bot_death", at: "2026-10-10T00:00:03.000Z" });
    body.emit({
      type: "bot_respawn",
      at: "2026-10-10T00:00:04.000Z",
      deathAt: "2026-10-10T00:00:03.000Z",
    });

    expect(store.snapshot()).toMatchObject({ stopped: true, plan: null });
    expect(store.latestObservedLifeMemory()?.content).toContain(
      "Minecraftで確認 (2026-10-10T00:00:04.000Z)",
    );
    expect(agent.inputs).toHaveLength(1);
    expect(body.executed).toEqual([]);
  });

  it("does not wake or dispatch when observed life-event persistence fails", async () => {
    const { store, path } = freshStore();
    const database = new Database(path);
    try {
      database.exec(`
        CREATE TRIGGER reject_observed_life_memory
        BEFORE INSERT ON companion_memories
        WHEN NEW.kind = 'life' AND NEW.source = 'minecraft_observed'
        BEGIN
          SELECT RAISE(FAIL, 'synthetic life memory write failure');
        END;
      `);
    } finally {
      database.close();
    }
    const body = new FakeBody(store);
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);
    await eventually(() => !runtime.status().thinking);
    body.emit({ type: "bot_death", at: "2026-10-10T00:00:03.000Z" });

    expect(agent.inputs).toHaveLength(1);
    expect(body.executed).toEqual([]);
    expect(store.snapshot()).toMatchObject({
      stopped: false,
      activeOperation: null,
    });
    expect(store.latestObservedLifeMemory()).toBeNull();
  });

  it("does not dispatch when active-marker save throws after committing; reopen records unknown completion without replay", async () => {
    const { store, path } = freshStore();
    const originalSave = store.save.bind(store);
    store.save = (patch) => {
      const updated = originalSave(patch);
      if (patch.activeOperation !== undefined && patch.activeOperation !== null)
        throw new Error("Synthetic post-commit marker failure");
      return updated;
    };
    const body = new FakeBody(store);
    const base = makeDecision([look]);
    const purpose = "Inspect the path before choosing a route.";
    const agent = new FakeAgent([
      companionDecisionSchema.parse({
        ...base,
        plan: { ...base.plan, purpose },
      }),
    ]);
    const runtime = createRuntime(store, body, agent);

    await runtime.receiveChat("Builder", "周囲を確認して");

    expect(body.executed).toHaveLength(0);
    expect(store.snapshot().activeOperation).toMatchObject({ purpose });
    await runtime.shutdown();
    store.close();
    const reopened = CompanionStore.open(path, { ownerUsername: "Builder" });
    stores.push(reopened);
    expect(reopened.snapshot().activeOperation).toBeNull();
    expect(reopened.snapshot().lastOutcome).toMatchObject({
      purpose,
      status: "unverified",
      preActionObservation: { source: "minecraft" },
      bodyEvidence: { source: "process_restart", startedAt: null },
    });
    expect(body.executed).toHaveLength(0);
  });

  it("saves only a successful chest window's container slots as past observation", async () => {
    const { store } = freshStore();
    const chest: BodyVisibleBlock = {
      name: "minecraft:trapped_chest",
      stateId: 1,
      position: { x: 1, y: 64, z: 0, dimension: "overworld" },
      distance: 1,
      properties: {},
    };
    const chestItem = gearItem("diamond", 0);
    const playerSlotItem = gearItem("gold_ingot", 27);
    const openedAt = new Date().toISOString();
    const body = new FakeBody(store);
    const agent = new FakeAgent([
      makeDecision([
        playerOperationSchema.parse({
          kind: "open_window",
          target: { kind: "block", position: { x: 1, y: 64, z: 0 } },
        }),
      ]),
    ]);
    const runtime = createRuntime(store, body, agent);
    body.observation = makeObservation({ blocks: [chest] });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after = {
        ...before,
        observedAt: openedAt,
        window: chestWindow(chestItem, playerSlotItem),
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "observed-chest-open",
        "successful",
        after,
        before,
      );
    };

    await runtime.receiveChat("Builder", "チェストの中身を確認して");

    expect(body.executed).toHaveLength(1);
    const location = store.latestObservedChestLocation();
    expect(location).toMatchObject({
      source: "minecraft_observed",
      metadata: {
        chestMemory: {
          kind: "location",
          dimension: "overworld",
          position: { x: 1, y: 64, z: 0 },
        },
      },
    });
    const contentMemories = store
      .recall("diamond", 8)
      .filter(
        (memory) =>
          memory.source === "minecraft_observed" &&
          typeof memory.metadata === "object" &&
          memory.metadata !== null &&
          "chestMemory" in memory.metadata &&
          typeof memory.metadata.chestMemory === "object" &&
          memory.metadata.chestMemory !== null &&
          "kind" in memory.metadata.chestMemory &&
          memory.metadata.chestMemory.kind === "contents",
      );
    expect(contentMemories).toHaveLength(1);
    expect(contentMemories[0]?.metadata).toMatchObject({
      chestMemory: {
        observedAt: openedAt,
        contents: [{ slot: 0, name: "diamond", count: 1 }],
      },
    });
    expect(JSON.stringify(contentMemories[0]?.metadata)).not.toContain(
      "gold_ingot",
    );
  });

  it("passes a remembered chest location into an ownerless autonomous move decision", async () => {
    const { store } = freshStore();
    const position = { x: 12, y: 64, z: -3 };
    store.rememberObservedChest({
      dimension: "overworld",
      position,
      observedAt: "2026-10-10T00:00:00.000Z",
    });
    const move = playerOperationSchema.parse({
      kind: "move_to",
      position,
      range: 2.5,
    });
    const body = new FakeBody(store);
    const agent = new FakeAgent([makeDecision([move])]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 1);

    expect(agent.inputs[0]?.ownerMessage).toBeUndefined();
    expect(agent.inputs[0]?.observation.perception.blocks).toEqual([]);
    const rememberedLocation = agent.inputs[0]?.memories.find(
      (memory) => memory.source === "minecraft_observed",
    );
    expect(rememberedLocation?.metadata).toMatchObject({
      chestMemory: { kind: "location", position },
    });
    expect(body.executed[0]).toEqual(move);
  });

  it("blocks the next plan wake after outcome persistence reports a post-commit failure and keeps owner stop available", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([
      makeDecision([look, jump]),
      makeDecision([jump]),
    ]);
    const runtime = createRuntime(store, body, agent);
    const recordOutcome = store.recordOutcome.bind(store);
    let failAfterCommit = true;
    store.recordOutcome = (input) => {
      const committed = recordOutcome(input);
      if (failAfterCommit) {
        failAfterCommit = false;
        throw new Error("Synthetic post-commit store response failure");
      }
      return committed;
    };

    await runtime.start();
    await eventually(
      () =>
        body.executed.length === 1 &&
        store.snapshot().activeOperation === null &&
        store.snapshot().plan?.steps[0]?.operation.kind === "control" &&
        !runtime.status().thinking,
    );
    const committedHistory = store.readOutcomeHistory({
      from: "2000-01-01T00:00:00.000Z",
      to: "2100-01-01T00:00:00.000Z",
      limit: 10,
    });
    expect(committedHistory.records[0]).toMatchObject({
      purpose: "Inspect the area and continue from observed results.",
      bodyEvidence: {
        source: "body_result",
        reasonCode: null,
        before: {
          source: "minecraft",
          position: { x: 0, y: 64, z: 0 },
          health: 20,
          food: 20,
          oxygen: 20,
        },
        after: { source: "minecraft", position: { x: 0, y: 64, z: 0 } },
      },
    });
    expect(JSON.stringify(committedHistory.records[0])).not.toContain(
      '"username"',
    );
    expect(JSON.stringify(committedHistory.records[0])).not.toContain(
      '"inventory"',
    );

    body.emit({ type: "reconnected", at: new Date().toISOString() });
    await eventually(
      () =>
        runtime.status().wakeReason ===
        "Body reconnected; observe before acting",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(agent.inputs).toHaveLength(1);
    expect(body.executed).toHaveLength(1);
    expect(store.snapshot().plan?.steps[0]?.operation.kind).toBe("control");

    expect(await runtime.stop("Builder")).toBe(true);
    expect(store.snapshot()).toMatchObject({
      stopped: true,
      plan: null,
      activeOperation: null,
    });
  });

  it("records bed locations only from the current visible Body block subset", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const observedAt = "2026-10-10T00:00:00.000Z";
    const ordinaryBlock: BodyVisibleBlock = {
      name: "minecraft:stone",
      stateId: 1,
      position: { x: 1, y: 64, z: 0, dimension: "overworld" },
      distance: 1,
      properties: {},
    };
    const visibleBed: BodyVisibleBlock = {
      name: "minecraft:white_bed",
      stateId: 2,
      position: { x: 2, y: 64, z: 0, dimension: "overworld" },
      distance: 2,
      properties: {},
    };
    body.observation = {
      ...makeObservation({ blocks: [ordinaryBlock, visibleBed] }),
      observedAt,
    };
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);

    expect(store.latestObservedBedLocation()).toMatchObject({
      kind: "world",
      source: "minecraft_observed",
      metadata: {
        bedMemory: {
          kind: "location",
          dimension: "overworld",
          position: { x: 2, y: 64, z: 0 },
          observedAt,
        },
      },
    });
  });

  it("uses a remembered bed location for an out-of-sight move input", async () => {
    const { store } = freshStore();
    const position = { x: 12, y: 64, z: -3 };
    store.rememberObservedBedLocation({
      dimension: "overworld",
      position,
      observedAt: "2026-10-10T00:00:00.000Z",
    });
    const move = playerOperationSchema.parse({
      kind: "move_to",
      position,
      range: 1,
    });
    const body = new FakeBody(store);
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after = {
        ...before,
        self: {
          ...before.self,
          position: {
            ...before.self.position,
            ...position,
          },
        },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "bed-move",
        "successful",
        after,
        before,
      );
    };
    const agent = new FakeAgent([makeDecision([move])]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 1);

    expect(agent.inputs[0]?.observation.perception.blocks).toEqual([]);
    expect(agent.inputs[0]?.observation.dimension).toBe("overworld");
    expect(
      agent.inputs[0]?.memories.find(
        (memory) => memory.id === store.latestObservedBedLocation()?.id,
      )?.metadata,
    ).toMatchObject({
      bedMemory: { kind: "location", dimension: "overworld", position },
    });
    expect(body.observation.self.position).toMatchObject(position);
    expect(body.executed[0]).toEqual(move);
  });

  it("passes the latest 24 chronological owner and companion messages to judgment", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "owner" : "companion",
      text: `synthetic-message-${index + 1}`,
    }));
    for (const message of messages) {
      store.recordMessage(message.role, message.text);
    }

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);

    const recentMessages = agent.inputs[0]?.messages ?? [];
    expect(recentMessages).toHaveLength(24);
    expect(recentMessages.map(({ role, text }) => ({ role, text }))).toEqual(
      messages.slice(6),
    );
  });

  it("autonomously equips a better item after an inventory observation changes", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);
    const equipped = gearItem("iron_helmet", 5, 60);
    const candidate = gearItem("diamond_helmet", 9);

    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after = {
        ...before,
        self: {
          ...before.self,
          inventory: [],
          equipment: {
            ...before.self.equipment,
            head: { ...candidate, slot: 5 },
          },
        },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "automatic-equipment-upgrade",
        "successful",
        after,
        before,
      );
    };

    await runtime.start();
    await eventually(() => runtime.status().nextWakeAt !== null);
    body.observation = makeObservation({
      inventory: [candidate],
      equipment: { ...body.observation.self.equipment, head: equipped },
    });
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "inventory",
    });

    await eventually(() => body.executed.length === 1, 4_000);
    expect(body.executed).toEqual([
      { kind: "equip", item: "diamond_helmet", destination: "head" },
    ]);
    expect(body.results[0]?.before?.self.equipment.head?.name).toBe(
      "iron_helmet",
    );
    expect(body.results[0]?.after?.self.equipment.head?.name).toBe(
      "diamond_helmet",
    );
    expect(agent.inputs).toHaveLength(1);
  });

  it("autonomously retrieves and equips armor when surrounding danger is unknown", async () => {
    const { store } = freshStore();
    const block: BodyVisibleBlock = {
      name: "minecraft:chest",
      stateId: 1,
      position: { x: 1, y: 64, z: 0, dimension: "overworld" },
      distance: 1,
      properties: {},
    };
    const current = gearItem("iron_chestplate", 5, 60);
    const candidate = gearItem("diamond_chestplate", 0);
    const body = new FakeBody(store);
    const agent = new FakeAgent([]);
    const runtime = createRuntime(store, body, agent);
    body.observation = makeObservation({
      inLava: null,
      onFire: null,
      suffocating: null,
      blocks: [block],
      equipment: { torso: current },
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      let after: PlayerBodyObservation;
      switch (operation.kind) {
        case "open_window":
          after = { ...before, window: chestWindow(candidate) };
          break;
        case "window_transfer": {
          const owned = gearItem(candidate.name, 9);
          after = {
            ...before,
            self: { ...before.self, inventory: [owned] },
            window: chestWindow(null, owned),
          };
          break;
        }
        case "window_close":
          after = { ...before, window: null };
          break;
        case "equip": {
          const owned = before.self.inventory.find(
            (item) => item.name === operation.item,
          );
          if (owned === undefined)
            throw new Error("Expected chest armor in inventory");
          after = {
            ...before,
            self: {
              ...before.self,
              inventory: before.self.inventory.filter(
                (item) => item.name !== operation.item,
              ),
              equipment: {
                ...before.self.equipment,
                [operation.destination]: { ...owned, slot: 5 },
              },
            },
          };
          break;
        }
        default:
          throw new Error(`Unexpected operation: ${operation.kind}`);
      }
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `unknown-hazard-equipment-${fakeBody.executed.length}`,
        "successful",
        after,
        before,
      );
    };

    await runtime.start();
    await eventually(() => body.executed.length === 4, 4_000);

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "open_window",
      "window_transfer",
      "window_close",
      "equip",
    ]);
    expect(body.results[0]?.before?.self).toMatchObject({
      health: 20,
      inLava: null,
      onFire: null,
      suffocating: null,
    });
    expect(body.results[0]?.before?.perception.nearbyHostiles).toBeUndefined();
    expect(body.results[3]?.after?.self.equipment.torso?.name).toBe(
      "diamond_chestplate",
    );
    expect(agent.inputs).toHaveLength(0);
  });

  it("uses all directions from one automatic sweep to acquire and equip a chest upgrade", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([]);
    const runtime = createRuntime(store, body, agent);
    const candidate = gearItem("diamond_helmet", 0);
    const chest = equipmentChestBlock(3);
    const emptySweep = emptyLookSweep();
    const lookSweep: PlayerBodyLookSweep = {
      ...emptySweep,
      directions: emptySweep.directions.map((view, directionIndex) => ({
        ...view,
        visibleBlocks:
          directionIndex === 0
            ? [
                {
                  name: chest.name,
                  position: {
                    x: chest.position.x,
                    y: chest.position.y,
                    z: chest.position.z,
                  },
                  distance: chest.distance,
                },
              ]
            : [],
      })),
    };
    body.observation = makeObservation({
      equipment: { head: null },
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      let after = before;
      switch (operation.kind) {
        case "look_sweep":
          return {
            ...fakeBody.result(
              operation,
              `automatic-equipment-sweep-${fakeBody.executed.length}`,
              "successful",
              after,
              before,
            ),
            lookSweep,
          };
        case "look":
          after = {
            ...before,
            perception: { ...before.perception, blocks: [chest] },
          };
          break;
        case "open_window":
          after = { ...before, window: chestWindow(candidate) };
          break;
        case "window_transfer": {
          const owned = gearItem(candidate.name, 9);
          after = {
            ...before,
            self: { ...before.self, inventory: [owned] },
            window: chestWindow(null, owned),
          };
          break;
        }
        case "window_close":
          after = { ...before, window: null };
          break;
        case "equip": {
          const owned = before.self.inventory.find(
            (item) => item.name === operation.item,
          );
          if (owned === undefined)
            throw new Error("Expected chest helmet in inventory");
          after = {
            ...before,
            self: {
              ...before.self,
              inventory: before.self.inventory.filter(
                (item) => item.name !== operation.item,
              ),
              equipment: {
                ...before.self.equipment,
                head: { ...owned, slot: 5 },
              },
            },
          };
          break;
        }
        default:
          throw new Error(`Unexpected operation: ${operation.kind}`);
      }
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `automatic-equipment-operation-${fakeBody.executed.length}`,
        "successful",
        after,
        before,
      );
    };

    await runtime.start();
    await eventually(() => body.executed.length > 0 || agent.inputs.length > 0);

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "look_sweep",
      "look",
      "open_window",
      "window_transfer",
      "window_close",
      "equip",
    ]);
    expect(body.executed[1]).toEqual({
      kind: "look",
      target: { x: 3.5, y: 64.5, z: 0.5 },
    });
    expect(body.observation.window).toBeNull();
    expect(body.observation.self.equipment.head?.name).toBe("diamond_helmet");
    expect(agent.inputs).toHaveLength(0);
  });

  it.each([
    ["empty hand", null],
    ["broken known weapon", gearItem("wooden_sword", 0, 0)],
  ] as const)(
    "starts a bounded sweep for an unowned weapon with complete armor (%s)",
    async (_gap, hand) => {
      const { store } = freshStore();
      const body = new FakeBody(store);
      const agent = new FakeAgent([]);
      const runtime = createRuntime(store, body, agent);
      body.observation = makeObservation({ equipment: { hand } });
      body.executeHandler = async (operation, _signal, fakeBody) => {
        if (operation.kind !== "look_sweep")
          throw new Error(`Unexpected operation: ${operation.kind}`);
        return {
          ...fakeBody.result(
            operation,
            "unowned-weapon-equipment-sweep",
            "successful",
            fakeBody.observation,
            fakeBody.observation,
          ),
          lookSweep: emptyLookSweep(),
        };
      };

      await runtime.start();
      await eventually(() => body.executed.length > 0);

      expect(body.executed).toEqual([{ kind: "look_sweep" }]);
      expect(agent.inputs).toHaveLength(1);
    },
  );

  it("keeps a held tool out of the automatic equipment-gap sweep", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([]);
    const runtime = createRuntime(store, body, agent);
    body.observation = makeObservation({
      equipment: { hand: gearItem("diamond_pickaxe", 0) },
    });
    body.executeHandler = async (operation) => {
      throw new Error(`Unexpected operation: ${operation.kind}`);
    };

    await runtime.start();
    await eventually(() => agent.inputs.length > 0);

    expect(body.executed).toEqual([]);
  });

  it("fences repeated automatic miss sweeps but processes a newly visible gear drop immediately", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([{ ...emptyDecision(), waitMs: 60_000 }]);
    const runtime = createRuntime(store, body, agent);
    const candidate = gearItem("diamond_helmet", 9);
    body.observation = makeObservation({ equipment: { head: null } });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      let after = before;
      if (operation.kind === "look_sweep") {
        return {
          ...fakeBody.result(
            operation,
            `equipment-miss-sweep-${fakeBody.executed.length}`,
            "successful",
            after,
            before,
          ),
          lookSweep: emptyLookSweep(),
        };
      }
      if (operation.kind === "collect_item") {
        after = {
          ...before,
          self: { ...before.self, inventory: [candidate] },
          perception: {
            ...before.perception,
            entities: [],
            nearbyDroppedItems: makeNearbyDroppedItems([]),
          },
        };
      } else if (operation.kind === "equip") {
        after = {
          ...before,
          self: {
            ...before.self,
            inventory: before.self.inventory.filter(
              (item) => item.name !== operation.item,
            ),
            equipment: {
              ...before.self.equipment,
              head: { ...candidate, slot: 5 },
            },
          },
        };
      } else {
        throw new Error(`Unexpected operation: ${operation.kind}`);
      }
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `equipment-miss-operation-${fakeBody.executed.length}`,
        "successful",
        after,
        before,
      );
    };

    await runtime.start();
    await eventuallyWithFakeTimers(
      () => body.executed.length === 1 && agent.inputs.length === 1,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(body.executed).toEqual([{ kind: "look_sweep" }]);

    const drop = droppedItemEntity(91, 2, "diamond_helmet");
    body.observation = makeObservation({
      equipment: { head: null },
      entities: [drop],
      nearbyDroppedItems: makeNearbyDroppedItems([drop]),
    });
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "entities",
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await eventuallyWithFakeTimers(() => body.executed.length === 3);

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "look_sweep",
      "collect_item",
      "equip",
    ]);
    expect(body.observation.self.equipment.head?.name).toBe("diamond_helmet");
    expect(agent.inputs).toHaveLength(1);
  });

  it("aborts an automatic equipment sweep immediately on owner stop", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([]);
    const runtime = createRuntime(store, body, agent);
    body.observation = makeObservation({ equipment: { head: null } });
    let sweepSignal: AbortSignal | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      if (operation.kind !== "look_sweep")
        throw new Error(`Unexpected operation: ${operation.kind}`);
      sweepSignal = signal;
      return await new Promise((resolve) => {
        const finish = (): void =>
          resolve(
            fakeBody.result(
              operation,
              "stopped-equipment-sweep",
              "failed",
              fakeBody.observation,
            ),
          );
        if (signal?.aborted) finish();
        else signal?.addEventListener("abort", finish, { once: true });
      });
    };

    await runtime.start();
    await eventually(() => body.executed.length === 1);
    await runtime.stop("Builder");

    expect(sweepSignal?.aborted).toBe(true);
    expect(body.executed).toEqual([{ kind: "look_sweep" }]);
    expect(store.snapshot().stopped).toBe(true);
    expect(agent.inputs).toHaveLength(0);
  });

  it("lets owner follow supersede a periodic equipment sweep before a found chest is rechecked", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([{ ...emptyDecision(), waitMs: 60_000 }]);
    const runtime = createRuntime(store, body, agent, undefined, 60_000);
    const pendingSweep = deferred<PlayerOperationResult>();
    let sweepSignal: AbortSignal | undefined;
    let sweepReleased = false;
    const emptySweep = emptyLookSweep();
    const candidateSweep: PlayerBodyLookSweep = {
      ...emptySweep,
      directions: emptySweep.directions.map((view, index) =>
        index === 2
          ? { ...view, visibleBlocks: [equipmentChestBlock(3, 3)] }
          : view,
      ),
    };
    const releaseSweep = (): void => {
      if (sweepReleased) return;
      sweepReleased = true;
      pendingSweep.resolve({
        ...body.result(
          { kind: "look_sweep" },
          "periodic-owner-race-sweep",
          "successful",
          body.observation,
        ),
        lookSweep: candidateSweep,
      });
    };
    body.executeHandler = async (operation, signal, fakeBody) => {
      if (operation.kind === "look_sweep") {
        sweepSignal = signal;
        return pendingSweep.promise;
      }
      if (operation.kind === "follow_owner")
        return fakeBody.result(
          operation,
          "periodic-owner-race-follow",
          "successful",
          fakeBody.observation,
        );
      return fakeBody.result(
        operation,
        `unexpected-periodic-owner-race-${fakeBody.executed.length}`,
        "failed",
        null,
      );
    };

    try {
      await runtime.start();
      await eventuallyWithFakeTimers(
        () => agent.inputs.length === 1 && !runtime.status().thinking,
      );
      body.observation = makeObservation({ equipment: { head: null } });
      await vi.advanceTimersByTimeAsync(5_000);
      await eventuallyWithFakeTimers(
        () => body.executed[0]?.kind === "look_sweep",
      );

      const ownerTurn = runtime.receiveChat("Builder", "こっち来て");
      expect(sweepSignal?.aborted).toBe(true);
      releaseSweep();
      await ownerTurn;
      await eventuallyWithFakeTimers(() =>
        body.executed.some((operation) => operation.kind === "follow_owner"),
      );

      expect(body.executed.map((operation) => operation.kind)).toEqual([
        "look_sweep",
        "follow_owner",
      ]);
      expect(
        body.executed.some((operation) =>
          ["open_window", "window_transfer", "equip"].includes(operation.kind),
        ),
      ).toBe(false);
      expect(agent.inputs).toHaveLength(1);
    } finally {
      releaseSweep();
    }
  });

  it("lets owner follow interrupt a periodic food drop collection", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.foodNames.add("bread");
    const agent = new FakeAgent([{ ...emptyDecision(), waitMs: 60_000 }]);
    const runtime = createRuntime(store, body, agent, undefined, 60_000);
    let collectSignal: AbortSignal | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      if (operation.kind === "collect_item") {
        collectSignal = signal;
        return await new Promise<PlayerOperationResult>((resolve) => {
          const interrupted = (): void =>
            resolve(
              fakeBody.result(
                operation,
                "periodic-food-collection-interrupted",
                "interrupted",
                null,
              ),
            );
          if (signal?.aborted) interrupted();
          else signal?.addEventListener("abort", interrupted, { once: true });
        });
      }
      if (operation.kind === "follow_owner")
        return fakeBody.result(
          operation,
          "periodic-food-owner-follow",
          "successful",
          fakeBody.observation,
        );
      return fakeBody.result(
        operation,
        `unexpected-periodic-food-${fakeBody.executed.length}`,
        "failed",
        null,
      );
    };

    await runtime.start();
    await eventuallyWithFakeTimers(
      () => agent.inputs.length === 1 && !runtime.status().thinking,
    );
    body.observation = makeObservation({
      food: 12,
      nearbyDroppedItems: makeNearbyDroppedItems([
        droppedItemEntity(31, 1, "bread"),
      ]),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await eventuallyWithFakeTimers(() =>
      body.executed.some((operation) => operation.kind === "collect_item"),
    );

    const ownerTurn = runtime.receiveChat("Builder", "こっち来て");
    expect(collectSignal?.aborted).toBe(true);
    await ownerTurn;

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "collect_item",
      "follow_owner",
    ]);
    expect(agent.inputs).toHaveLength(1);
    expect(store.snapshot().goal?.title).toBe("オーナーに追従する");
  });

  it("does not start autonomous equipment upkeep when self health is unknown", async () => {
    const { store } = freshStore();
    const block: BodyVisibleBlock = {
      name: "minecraft:chest",
      stateId: 1,
      position: { x: 1, y: 64, z: 0, dimension: "overworld" },
      distance: 1,
      properties: {},
    };
    const body = new FakeBody(store);
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);
    body.observation = makeObservation({ health: null, blocks: [block] });

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);

    expect(body.executed).toHaveLength(0);
  });

  it("samples Body every five seconds during an active operation and stops polling on owner stop", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    const pending = deferred<PlayerOperationResult>();
    body.executeHandler = async () => pending.promise;
    const agent = new FakeAgent([
      { ...emptyDecision(), plan: makeDecision([look]).plan, waitMs: 60_000 },
      { ...emptyDecision(), waitMs: 60_000 },
    ]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventuallyWithFakeTimers(() => body.executed.length === 1);
    const observationsBeforeTick = body.observeCalls;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(body.observeCalls).toBeGreaterThan(observationsBeforeTick);
    expect(body.executed).toHaveLength(1);
    expect(agent.inputs).toHaveLength(1);
    expect(agent.signals[0]?.aborted).toBe(false);

    const operation = body.executed[0];
    if (operation === undefined) throw new Error("Expected active operation");
    pending.resolve(
      body.result(operation, "active-look", "successful", body.observation),
    );
    await eventuallyWithFakeTimers(
      () => runtime.status().currentOperation === null,
    );
    await runtime.stop("Builder");
    const observationsAfterStop = body.observeCalls;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(body.observeCalls).toBe(observationsAfterStop);
    expect(await runtime.resume("Impostor")).toBe(false);
    expect(await runtime.resume("Builder")).toBe(true);
    const observationsAfterResume = body.observeCalls;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(body.observeCalls).toBeGreaterThan(observationsAfterResume);
    expect(agent.inputs).toHaveLength(2);
  });

  it("consumes known inventory food below full hunger and avoids model judgment", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.foodNames.add("bread");
    body.observation = makeObservation({
      food: 12,
      inventory: [foodItem("bread", 9, 2)],
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      if (operation.kind !== "consume")
        throw new Error("Expected one food consume operation");
      const before = fakeBody.observation;
      const after = {
        ...before,
        self: {
          ...before.self,
          food: 16,
          inventory: [foodItem("bread", 9, 1)],
        },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "food-consume",
        "successful",
        after,
        before,
      );
    };
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.results.length === 1);

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "consume",
    ]);
    expect(body.observation.self.food).toBe(16);
    expect(body.observation.self.inventory[0]?.count).toBe(1);
    expect(agent.inputs).toHaveLength(0);
  });

  it("collects a nearby known food drop before consuming it", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const apple = droppedItemEntity(98, 2, "apple", 1);
    body.foodNames.add("apple");
    body.observation = makeObservation({
      food: 12,
      entities: [apple],
      nearbyDroppedItems: makeNearbyDroppedItems([apple]),
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after =
        operation.kind === "collect_item"
          ? {
              ...before,
              self: {
                ...before.self,
                inventory: [foodItem("apple", 9)],
              },
              perception: {
                ...before.perception,
                entities: [],
                nearbyDroppedItems: makeNearbyDroppedItems([]),
              },
            }
          : operation.kind === "consume"
            ? {
                ...before,
                self: {
                  ...before.self,
                  food: 16,
                  inventory: [],
                },
              }
            : undefined;
      if (after === undefined)
        throw new Error(`Unexpected operation: ${operation.kind}`);
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `food-drop-${fakeBody.executed.length}`,
        "successful",
        after,
        before,
      );
    };
    const agent = new FakeAgent([]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 2);

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "collect_item",
      "consume",
    ]);
    expect(body.observation.self.food).toBe(16);
    expect(agent.inputs).toHaveLength(0);
    await runtime.stop("Builder");
  });

  it("searches ordinary food before consuming held rotten flesh", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const rotten = foodItem("rotten_flesh", 9);
    const appleDrop = droppedItemEntity(98, 2, "apple", 1);
    body.foodNames.add("rotten_flesh");
    body.foodNames.add("apple");
    body.observation = makeObservation({
      food: 12,
      inventory: [rotten],
      entities: [appleDrop],
      nearbyDroppedItems: makeNearbyDroppedItems([appleDrop]),
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      let after: PlayerBodyObservation;
      if (operation.kind === "collect_item") {
        after = {
          ...before,
          self: {
            ...before.self,
            inventory: [rotten, foodItem("apple", 10)],
          },
          perception: {
            ...before.perception,
            entities: [],
            nearbyDroppedItems: makeNearbyDroppedItems([]),
          },
        };
      } else if (operation.kind === "consume") {
        after = {
          ...before,
          self: { ...before.self, food: 16, inventory: [rotten] },
        };
      } else {
        throw new Error(`Unexpected operation: ${operation.kind}`);
      }
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `food-rotten-drop-${fakeBody.executed.length}`,
        "successful",
        after,
        before,
      );
    };
    const runtime = createRuntime(store, body, new FakeAgent([]));

    await runtime.start();
    await eventually(() => body.results.length === 2);

    expect(body.executed).toEqual([
      { kind: "collect_item", entityId: 98 },
      { kind: "consume" },
    ]);
    expect(body.observation.self.food).toBe(16);
    expect(body.observation.self.inventory).toContainEqual(rotten);
    await runtime.stop("Builder");
  });

  it("uses held rotten flesh only after a bounded low-hunger search and records why", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const rotten = foodItem("rotten_flesh", 9);
    body.foodNames.add("rotten_flesh");
    body.observation = makeObservation({ food: 6, inventory: [rotten] });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after = {
        ...before,
        self: { ...before.self, food: 10, inventory: [] },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "rotten-last-resort",
        "successful",
        after,
        before,
      );
    };
    const runtime = createRuntime(store, body, new FakeAgent([]));

    await runtime.start();
    await eventually(() => body.results.length === 1);

    expect(body.executed).toEqual([{ kind: "consume", item: "rotten_flesh" }]);
    expect(store.snapshot().lastOutcome?.expectedOutcome).toContain(
      "bounded ordinary-food search",
    );
    expect(store.snapshot().lastOutcome?.expectedOutcome).toContain("food=6");
    expect(store.snapshot().lastOutcome?.expectedOutcome).toContain(
      "health=20",
    );
    expect(store.snapshot().lastOutcome?.expectedOutcome).toContain(
      "truncated=false",
    );
    await runtime.stop("Builder");
  });

  it.each(["water", "low oxygen", "above threshold"] as const)(
    "does not use held rotten flesh with %s",
    async (condition) => {
      const { store } = freshStore();
      const body = new FakeBody(store);
      body.foodNames.add("rotten_flesh");
      const base = makeObservation({
        food: condition === "above threshold" ? 7 : 6,
        inventory: [foodItem("rotten_flesh", 9)],
      });
      body.observation = {
        ...base,
        self: {
          ...base.self,
          ...(condition === "water"
            ? { inWater: true }
            : condition === "low oxygen"
              ? { oxygen: 5 }
              : {}),
        },
      };
      const agent = new FakeAgent([emptyDecision()]);
      const runtime = createRuntime(store, body, agent);

      await runtime.start();
      await eventually(() => agent.inputs.length === 1);

      expect(body.executed).toEqual([]);
      await runtime.stop("Builder");
    },
  );

  it("uses the shared reachable-chest path to acquire and consume food", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const apple = foodItem("apple", 0);
    const rotten = foodItem("rotten_flesh", 9);
    body.foodNames.add("apple");
    body.foodNames.add("rotten_flesh");
    body.observation = makeObservation({
      food: 12,
      inventory: [rotten],
      blocks: [equipmentChestBlock(1)],
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      let after: PlayerBodyObservation;
      switch (operation.kind) {
        case "open_window":
          after = { ...before, window: chestWindow(apple) };
          break;
        case "window_transfer": {
          const owned = foodItem("apple", 9);
          after = {
            ...before,
            self: { ...before.self, inventory: [rotten, owned] },
            window: chestWindow(null, owned),
          };
          break;
        }
        case "window_close":
          after = { ...before, window: null };
          break;
        case "consume":
          after = {
            ...before,
            self: {
              ...before.self,
              food: 16,
              inventory: [rotten],
            },
          };
          break;
        default:
          throw new Error(`Unexpected operation: ${operation.kind}`);
      }
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `food-chest-${fakeBody.executed.length}`,
        "successful",
        after,
        before,
      );
    };
    const agent = new FakeAgent([]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 4);

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "open_window",
      "window_transfer",
      "window_close",
      "consume",
    ]);
    expect(body.observation.window).toBeNull();
    expect(body.observation.self.food).toBe(16);
    expect(body.observation.self.inventory).toContainEqual(rotten);
    expect(agent.inputs).toHaveLength(0);
    await runtime.stop("Builder");
  });

  it("stops food upkeep when chest cleanup is unconfirmed, then retries after a fresh closed-window observation", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const apple = foodItem("apple", 0);
    body.foodNames.add("apple");
    body.observation = makeObservation({
      food: 12,
      blocks: [equipmentChestBlock(1)],
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      let after = before;
      let status: "successful" | "failed" = "successful";
      switch (operation.kind) {
        case "open_window":
          after = { ...before, window: chestWindow(apple) };
          break;
        case "window_transfer": {
          const owned = foodItem("apple", 9);
          after = {
            ...before,
            self: { ...before.self, inventory: [owned] },
            window: chestWindow(null, owned),
          };
          break;
        }
        case "window_close":
          status = "failed";
          break;
        case "consume":
          after = {
            ...before,
            self: { ...before.self, food: 16, inventory: [] },
            window: null,
          };
          break;
        default:
          throw new Error(`Unexpected operation: ${operation.kind}`);
      }
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `food-cleanup-${fakeBody.executed.length}`,
        status,
        after,
        before,
      );
    };
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(
      () => body.executed.length >= 4 && !runtime.status().thinking,
    );

    expect(
      body.executed.filter(
        (operation) =>
          operation.kind === "collect_item" || operation.kind === "consume",
      ),
    ).toEqual([]);
    expect(body.observation.window).not.toBeNull();
    expect(body.observation.self.inventory).toContainEqual(
      foodItem("apple", 9),
    );

    body.observation = { ...body.observation, window: null };
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "inventory",
    });
    await eventually(
      () => body.executed.some((operation) => operation.kind === "consume"),
      5_000,
    );

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "open_window",
      "window_transfer",
      "window_close",
      "window_close",
      "consume",
    ]);
    expect(body.observation.self.food).toBe(16);
    expect(body.observation.window).toBeNull();
    await runtime.stop("Builder");
  });

  it("tries the sixth food drop after five visible targets fail once", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    const drops = Array.from({ length: 6 }, (_, index) =>
      droppedItemEntity(301 + index, index + 1, "apple"),
    );
    const visibleDrops = [...drops, droppedItemEntity(399, 0.25, "stone")];
    body.foodNames.add("apple");
    body.observation = makeObservation({
      food: 12,
      entities: visibleDrops,
      nearbyDroppedItems: makeNearbyDroppedItems(visibleDrops),
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      if (operation.kind === "collect_item" && operation.entityId !== 306)
        return fakeBody.result(
          operation,
          `food-drop-failed-${operation.entityId}`,
          "failed",
          before,
          before,
        );
      let after: PlayerBodyObservation;
      if (operation.kind === "collect_item") {
        const remaining = drops.filter(
          (drop) => drop.id !== operation.entityId,
        );
        after = {
          ...before,
          self: { ...before.self, inventory: [foodItem("apple", 9)] },
          perception: {
            ...before.perception,
            entities: remaining,
            nearbyDroppedItems: makeNearbyDroppedItems(remaining),
          },
        };
      } else if (operation.kind === "consume") {
        after = {
          ...before,
          self: { ...before.self, food: 16, inventory: [] },
        };
      } else {
        throw new Error(`Unexpected operation: ${operation.kind}`);
      }
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `food-drop-${fakeBody.executed.length}`,
        "successful",
        after,
        before,
      );
    };
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent, undefined, 10_000);

    await runtime.start();
    const collectedIds = () =>
      body.executed
        .filter((operation) => operation.kind === "collect_item")
        .map((operation) => operation.entityId);
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (collectedIds().length >= 6 && !runtime.status().thinking) break;
      await Promise.resolve();
    }
    expect(collectedIds()).toEqual([301, 302, 303, 304, 305, 399]);

    await vi.advanceTimersByTimeAsync(5_000);
    await eventuallyWithFakeTimers(() => collectedIds().includes(306));

    expect(collectedIds()).toEqual([301, 302, 303, 304, 305, 399, 306]);
    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "collect_item",
      "collect_item",
      "collect_item",
      "collect_item",
      "collect_item",
      "collect_item",
      "collect_item",
      "consume",
    ]);
    expect(body.observation.self.food).toBe(16);
    await runtime.stop("Builder");
  });

  it("schedules the normal wake after startup food upkeep without model polling", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.foodNames.add("bread");
    body.observation = makeObservation({
      food: 12,
      inventory: [foodItem("bread", 9)],
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after = {
        ...before,
        self: { ...before.self, food: 16, inventory: [] },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "food-wake",
        "successful",
        after,
        before,
      );
    };
    const agent = new FakeAgent([{ ...emptyDecision(), waitMs: 20_000 }]);
    const runtime = createRuntime(store, body, agent, undefined, 10_000);

    await runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 100 && body.results.length === 0; attempt++)
      await Promise.resolve();
    expect(body.results).toHaveLength(1);
    expect(runtime.status().wakeReason).toBe(
      "food upkeep completed; continue after a fresh observation",
    );
    expect(agent.inputs).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(agent.inputs).toHaveLength(0);
    expect(body.executed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await eventuallyWithFakeTimers(() => agent.inputs.length === 1);

    expect(agent.inputs).toHaveLength(1);
    await runtime.stop("Builder");
  });

  it("preserves the pending normal wake across periodic food maintenance", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.foodNames.add("bread");
    body.observation = makeObservation({
      food: 20,
      inventory: [foodItem("bread", 9)],
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after = {
        ...before,
        self: { ...before.self, food: 16, inventory: [] },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "periodic-food-wake",
        "successful",
        after,
        before,
      );
    };
    const agent = new FakeAgent([
      { ...emptyDecision(), waitMs: 20_000 },
      emptyDecision(),
    ]);
    const runtime = createRuntime(store, body, agent, undefined, 10_000);

    await runtime.start();
    await eventuallyWithFakeTimers(
      () =>
        agent.inputs.length === 1 &&
        !runtime.status().thinking &&
        runtime.status().nextWakeAt !== null,
    );
    const originalWakeAt = runtime.status().nextWakeAt;
    if (originalWakeAt === null) throw new Error("Expected scheduled wake");
    body.observation = makeObservation({
      food: 12,
      inventory: [foodItem("bread", 9)],
    });

    await vi.advanceTimersByTimeAsync(5_000);
    for (let attempt = 0; attempt < 100 && body.results.length === 0; attempt++)
      await Promise.resolve();
    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "consume",
    ]);
    expect(agent.inputs).toHaveLength(1);
    expect(runtime.status().nextWakeAt).toBe(originalWakeAt);

    const remainingWait = Date.parse(originalWakeAt) - Date.now();
    await vi.advanceTimersByTimeAsync(Math.max(0, remainingWait - 1));
    expect(agent.inputs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await eventuallyWithFakeTimers(() => agent.inputs.length === 2);
    expect(agent.inputs).toHaveLength(2);
    await runtime.stop("Builder");
  });

  it("preserves the pending normal wake across periodic equipment maintenance", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    const current = gearItem("iron_helmet", 5, 60);
    const upgrade = gearItem("diamond_helmet", 9);
    body.observation = makeObservation({
      food: 20,
      equipment: { ...body.observation.self.equipment, head: current },
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      if (operation.kind !== "equip")
        throw new Error(`Unexpected operation: ${operation.kind}`);
      const after = {
        ...before,
        self: {
          ...before.self,
          inventory: [],
          equipment: {
            ...before.self.equipment,
            head: { ...upgrade, slot: 5 },
          },
        },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "periodic-equipment-wake",
        "successful",
        after,
        before,
      );
    };
    const agent = new FakeAgent([
      { ...emptyDecision(), waitMs: 20_000 },
      emptyDecision(),
    ]);
    const runtime = createRuntime(store, body, agent, undefined, 10_000);

    await runtime.start();
    await eventuallyWithFakeTimers(
      () =>
        agent.inputs.length === 1 &&
        !runtime.status().thinking &&
        runtime.status().nextWakeAt !== null,
    );
    const originalWakeAt = runtime.status().nextWakeAt;
    if (originalWakeAt === null) throw new Error("Expected scheduled wake");
    body.observation = makeObservation({
      food: 20,
      inventory: [upgrade],
      equipment: { ...body.observation.self.equipment, head: current },
    });

    await vi.advanceTimersByTimeAsync(5_000);
    for (let attempt = 0; attempt < 100 && body.results.length === 0; attempt++)
      await Promise.resolve();
    expect(body.executed.map((operation) => operation.kind)).toEqual(["equip"]);
    expect(agent.inputs).toHaveLength(1);
    expect(runtime.status().nextWakeAt).toBe(originalWakeAt);

    const remainingWait = Date.parse(originalWakeAt) - Date.now();
    await vi.advanceTimersByTimeAsync(Math.max(0, remainingWait - 1));
    expect(agent.inputs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await eventuallyWithFakeTimers(() => agent.inputs.length === 2);
    expect(agent.inputs).toHaveLength(2);
    await runtime.stop("Builder");
  });

  it("defers periodic actions while a coalesced world-change wake is pending", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.foodNames.add("bread");
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after = {
        ...before,
        self: { ...before.self, food: 20, inventory: [] },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "coalesced-world-food",
        "successful",
        after,
        before,
      );
    };
    const agent = new FakeAgent([{ ...emptyDecision(), waitMs: 30_000 }]);
    const runtime = createRuntime(store, body, agent, undefined, 10_000);

    await runtime.start();
    await eventuallyWithFakeTimers(
      () =>
        agent.inputs.length === 1 &&
        !runtime.status().thinking &&
        runtime.status().nextWakeAt !== null,
    );
    const normalWakeAt = runtime.status().nextWakeAt;
    if (normalWakeAt === null) throw new Error("Expected scheduled wake");
    const observationsBeforeRace = body.observeCalls;

    await vi.advanceTimersByTimeAsync(4_900);
    body.observation = makeObservation({
      food: 5,
      inventory: [foodItem("bread", 10)],
    });
    const worldChangeObservedAt = Date.now();
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "inventory",
    });
    await vi.advanceTimersByTimeAsync(100);
    for (let attempt = 0; attempt < 100; attempt++) await Promise.resolve();

    expect(body.observeCalls).toBeGreaterThan(observationsBeforeRace);
    expect(body.executed).toHaveLength(0);
    expect(agent.inputs).toHaveLength(1);
    expect(runtime.status().nextWakeAt).toBe(normalWakeAt);

    await vi.advanceTimersByTimeAsync(1_399);
    expect(agent.inputs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    for (let attempt = 0; attempt < 100; attempt++) await Promise.resolve();
    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "consume",
    ]);
    expect(body.observation.self.food).toBeGreaterThan(5);
    expect(body.observation.self.inventory).toHaveLength(0);
    expect(Date.now() - worldChangeObservedAt).toBeLessThanOrEqual(1_500);
    expect(Date.now()).toBeLessThan(Date.parse(normalWakeAt));
    expect(agent.inputs).toHaveLength(1);
    await runtime.stop("Builder");
  });

  it("keeps one periodic food action fenced across ticks and requires fresh hunger increase", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.foodNames.add("bread");
    body.observation = makeObservation();
    const pending = deferred<PlayerOperationResult>();
    body.executeHandler = async () => pending.promise;
    const agent = new FakeAgent([{ ...emptyDecision(), waitMs: 60_000 }]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventuallyWithFakeTimers(
      () => agent.inputs.length === 1 && !runtime.status().thinking,
    );
    await Promise.resolve();
    await Promise.resolve();
    body.observation = makeObservation({
      food: 12,
      inventory: [foodItem("bread", 9, 2)],
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await eventuallyWithFakeTimers(() => body.executed.length === 1);
    const observationCount = body.observeCalls;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(body.observeCalls).toBeGreaterThan(observationCount);
    expect(body.executed).toHaveLength(1);
    expect(agent.inputs).toHaveLength(1);

    const operation = body.executed[0];
    if (operation === undefined) throw new Error("Expected food action");
    const before = body.observation;
    const after = {
      ...before,
      self: {
        ...before.self,
        inventory: [foodItem("bread", 9, 1)],
      },
    };
    body.observation = after;
    pending.resolve(
      body.result(
        operation,
        "food-no-hunger-change",
        "successful",
        after,
        before,
      ),
    );
    await eventuallyWithFakeTimers(
      () => runtime.status().currentOperation === null,
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(body.executed).toHaveLength(1);
    expect(agent.inputs).toHaveLength(1);
  });

  it("does not consume at full hunger and suppresses an unchanged failed food attempt", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.foodNames.add("bread");
    body.observation = makeObservation({
      food: 20,
      inventory: [foodItem("bread", 9)],
    });
    const agent = new FakeAgent([
      { ...emptyDecision(), waitMs: 60_000 },
      { ...emptyDecision(), waitMs: 60_000 },
    ]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventuallyWithFakeTimers(() => agent.inputs.length === 1);
    expect(body.executed).toHaveLength(0);

    body.observation = makeObservation({
      food: 12,
      inventory: [foodItem("bread", 9)],
    });
    body.executeHandler = async (operation, _signal, fakeBody) =>
      fakeBody.result(
        operation,
        "failed-food-consume",
        "failed",
        fakeBody.observation,
      );
    const chat = runtime.receiveChat("Builder", "check once");
    await eventuallyWithFakeTimers(() => agent.inputs.length === 2);
    await chat;
    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "consume",
    ]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(body.executed).toHaveLength(1);
    expect(agent.inputs).toHaveLength(2);
  });

  it("suppresses an unconfirmed gear candidate until equipment state changes", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);
    const firstCandidate = gearItem("diamond_helmet", 9);
    const improvedCandidate = gearItem("netherite_helmet", 10);
    body.observation = makeObservation({
      inventory: [firstCandidate],
      equipment: {
        "off-hand": null,
        head: gearItem("iron_helmet", 5),
        torso: null,
        legs: null,
        feet: null,
      },
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      if (operation.kind !== "equip")
        throw new Error("Expected equipment candidate");
      const after = {
        ...before,
        self: { ...before.self, health: 19 },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `failed-gear-${fakeBody.executed.length}`,
        "failed",
        after,
        before,
      );
    };

    await runtime.start();
    await eventuallyWithFakeTimers(() => agent.inputs.length === 1);

    expect(body.executed).toHaveLength(1);
    expect(body.executed[0]).toMatchObject({
      kind: "equip",
      item: "diamond_helmet",
    });
    expect(agent.inputs[0]?.observation.self.inventory).toContainEqual(
      firstCandidate,
    );
    expect(agent.inputs[0]?.observation.self.health).toBe(19);

    body.observation = makeObservation({
      inventory: [improvedCandidate],
      equipment: body.observation.self.equipment,
    });
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "inventory",
    });
    await eventuallyWithFakeTimers(() => body.executed.length === 2);

    expect(body.executed[1]).toMatchObject({
      kind: "equip",
      item: "netherite_helmet",
    });
    expect(agent.inputs).toHaveLength(1);
  });

  it("keeps an owner-latched stop effective after inventory changes and gear requests", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);
    const equipped = gearItem("iron_helmet", 5);
    const candidate = gearItem("diamond_helmet", 9);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);
    await runtime.stop("Builder");
    body.observation = makeObservation({
      inventory: [candidate],
      equipment: { head: equipped },
    });
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "inventory",
    });
    await runtime.receiveChat("Builder", "装備を探して");

    expect(store.snapshot().stopped).toBe(true);
    expect(runtime.status().stopped).toBe(true);
    expect(body.executed).toHaveLength(0);
    expect(agent.inputs).toHaveLength(1);
  });

  it("searches a visible chest, withdraws one upgrade, closes it, then equips without the agent", async () => {
    const { store } = freshStore();
    const block: BodyVisibleBlock = {
      name: "minecraft:chest",
      stateId: 1,
      position: { x: 1, y: 64, z: 0, dimension: "overworld" },
      distance: 1,
      properties: {},
    };
    const candidate = gearItem("diamond_helmet", 0);
    const body = new FakeBody(store);
    const agent = new FakeAgent([]);
    const messages: string[] = [];
    const runtime = createRuntime(store, body, agent, async (message) => {
      messages.push(message);
    });
    body.observation = makeObservation({ blocks: [block] });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      let after: PlayerBodyObservation;
      switch (operation.kind) {
        case "open_window":
          after = { ...before, window: chestWindow(candidate) };
          break;
        case "window_transfer": {
          const owned = gearItem(candidate.name, 9);
          after = {
            ...before,
            self: { ...before.self, inventory: [owned] },
            window: chestWindow(null, owned),
          };
          break;
        }
        case "window_close":
          after = { ...before, window: null };
          break;
        case "equip": {
          const owned = before.self.inventory.find(
            (item) => item.name === operation.item,
          );
          if (owned === undefined)
            throw new Error("Expected chest item in inventory");
          after = {
            ...before,
            self: {
              ...before.self,
              inventory: before.self.inventory.filter(
                (item) => item.name !== operation.item,
              ),
              equipment: {
                ...before.self.equipment,
                [operation.destination]: { ...owned, slot: 5 },
              },
            },
          };
          break;
        }
        default:
          throw new Error(`Unexpected operation: ${operation.kind}`);
      }
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `equipment-operation-${fakeBody.executed.length}`,
        "successful",
        after,
        before,
      );
    };

    await runtime.receiveChat("Builder", "装備を自分で探して");

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "open_window",
      "window_transfer",
      "window_close",
      "equip",
    ]);
    expect(body.executed[1]).toMatchObject({
      item: "diamond_helmet",
      count: 1,
      direction: "window_to_inventory",
    });
    expect(body.results.every((result) => result.status === "successful")).toBe(
      true,
    );
    expect(
      body.results.find((result) => result.operation.kind === "equip")?.after
        ?.self.equipment.head?.name,
    ).toBe("diamond_helmet");
    expect(body.observation.window).toBeNull();
    expect(agent.inputs).toHaveLength(0);
    expect(messages.some((message) => message.includes("diamond_helmet"))).toBe(
      true,
    );
  });

  it("does not treat an equipment question or negation as a direct command", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([emptyDecision(), emptyDecision()]);
    const runtime = createRuntime(store, body, agent);

    await runtime.receiveChat("Builder", "装備を探してもいい？");
    await runtime.receiveChat("Builder", "装備を探さないで");

    expect(body.executed).toHaveLength(0);
    expect(agent.inputs).toHaveLength(2);
  });

  it("does not dispatch chest cleanup after an owner stop changes the generation", async () => {
    const { store } = freshStore();
    const block: BodyVisibleBlock = {
      name: "minecraft:chest",
      stateId: 1,
      position: { x: 1, y: 64, z: 0, dimension: "overworld" },
      distance: 1,
      properties: {},
    };
    const candidate = gearItem("diamond_helmet", 0);
    const body = new FakeBody(store);
    const agent = new FakeAgent([]);
    const messages: string[] = [];
    const runtime = createRuntime(store, body, agent, async (message) => {
      messages.push(message);
    });
    let stopping: Promise<boolean> | undefined;
    body.observation = makeObservation({ blocks: [block] });
    body.observeHandler = (fakeBody) => {
      if (fakeBody.observation.window !== null && stopping === undefined)
        stopping = runtime.stop("Builder");
    };
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after =
        operation.kind === "open_window"
          ? { ...before, window: chestWindow(candidate) }
          : operation.kind === "window_close"
            ? { ...before, window: null }
            : before;
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `cleanup-operation-${fakeBody.executed.length}`,
        "successful",
        after,
        before,
      );
    };

    await runtime.receiveChat("Builder", "装備を探して");
    await stopping;

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "open_window",
    ]);
    expect(body.observation.window).not.toBeNull();
    expect(store.snapshot().stopped).toBe(true);
    expect(store.snapshot().plan).toBeNull();
    expect(
      messages.some((message) => message.startsWith("装備を更新したよ")),
    ).toBe(false);
    expect(agent.inputs).toHaveLength(0);
  });

  it("does not reopen an inspected empty chest after it leaves and re-enters view", async () => {
    const { store } = freshStore();
    const block: BodyVisibleBlock = {
      name: "minecraft:chest",
      stateId: 1,
      position: { x: 1, y: 64, z: 0, dimension: "overworld" },
      distance: 1,
      properties: {},
    };
    const body = new FakeBody(store);
    const agent = new FakeAgent([emptyDecision(), emptyDecision()]);
    const runtime = createRuntime(store, body, agent);
    body.observation = makeObservation({ blocks: [block] });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after =
        operation.kind === "open_window"
          ? { ...before, window: chestWindow(null) }
          : operation.kind === "window_close"
            ? { ...before, window: null }
            : before;
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `empty-chest-operation-${fakeBody.executed.length}`,
        "successful",
        after,
        before,
      );
    };

    await runtime.start();
    await eventually(() => body.executed.length === 2);
    body.observation = makeObservation();
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "blocks",
    });
    await eventually(() => agent.inputs.length === 1);
    body.observation = makeObservation({ blocks: [block] });
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "blocks",
    });
    await eventually(() => agent.inputs.length === 2);

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "open_window",
      "window_close",
    ]);
  });

  it("does not report an unobserved transfer as success when chest cleanup also fails", async () => {
    const { store } = freshStore();
    const block: BodyVisibleBlock = {
      name: "minecraft:chest",
      stateId: 1,
      position: { x: 1, y: 64, z: 0, dimension: "overworld" },
      distance: 1,
      properties: {},
    };
    const candidate = gearItem("diamond_helmet", 0);
    const body = new FakeBody(store);
    const agent = new FakeAgent([]);
    const messages: string[] = [];
    const runtime = createRuntime(store, body, agent, async (message) => {
      messages.push(message);
    });
    body.observation = makeObservation({ blocks: [block] });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after =
        operation.kind === "open_window"
          ? { ...before, window: chestWindow(candidate) }
          : before;
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `unconfirmed-operation-${fakeBody.executed.length}`,
        operation.kind === "window_close" ? "failed" : "successful",
        after,
        before,
      );
    };

    await runtime.receiveChat("Builder", "装備を探して");

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "open_window",
      "window_transfer",
      "window_close",
      "window_close",
    ]);
    const history = store.readOutcomeHistory({
      from: "2000-01-01T00:00:00.000Z",
      to: "2100-01-01T00:00:00.000Z",
      limit: 10,
    });
    const closeOutcomes = history.records.filter(
      (record) => record.operation.kind === "window_close",
    );
    expect(closeOutcomes).toHaveLength(2);
    expect(closeOutcomes[1]).toMatchObject({
      purpose:
        "Close the equipment window after inspection and record the cleanup Body result.",
      status: "failed",
      bodyEvidence: { source: "body_result" },
    });
    expect(body.observation.window).not.toBeNull();
    expect(
      messages.some((message) => message.includes("成功とは言えない")),
    ).toBe(false);
    expect(
      messages.some((message) => message.includes("成功は報告できない")),
    ).toBe(true);
    expect(
      messages.some((message) => message.startsWith("装備を更新したよ")),
    ).toBe(false);
    expect(agent.inputs).toHaveLength(0);
  });

  it("does not retry fallback cleanup after a post-commit close outcome failure", async () => {
    const { store } = freshStore();
    const block: BodyVisibleBlock = {
      name: "minecraft:chest",
      stateId: 1,
      position: { x: 1, y: 64, z: 0, dimension: "overworld" },
      distance: 1,
      properties: {},
    };
    const candidate = gearItem("diamond_helmet", 0);
    const body = new FakeBody(store);
    const agent = new FakeAgent([]);
    const runtime = createRuntime(store, body, agent);
    body.observation = makeObservation({ blocks: [block] });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      let after = before;
      let status: PlayerOperationResult["status"] = "successful";
      switch (operation.kind) {
        case "open_window":
          after = { ...before, window: chestWindow(candidate) };
          break;
        case "window_transfer": {
          const owned = gearItem(candidate.name, 9);
          after = {
            ...before,
            self: { ...before.self, inventory: [owned] },
            window: chestWindow(null, owned),
          };
          break;
        }
        case "window_close":
          status = "failed";
          break;
        default:
          throw new Error(`Unexpected operation: ${operation.kind}`);
      }
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `post-commit-cleanup-${fakeBody.executed.length}`,
        status,
        after,
        before,
      );
    };
    const recordOutcome = store.recordOutcome.bind(store);
    let failCloseAfterCommit = true;
    store.recordOutcome = (input) => {
      const committed = recordOutcome(input);
      if (input.operation.kind === "window_close" && failCloseAfterCommit) {
        failCloseAfterCommit = false;
        throw new Error("Synthetic post-commit cleanup response failure");
      }
      return committed;
    };

    await runtime.receiveChat("Builder", "装備を自分で探して");

    expect(body.executed.map((operation) => operation.kind)).toEqual([
      "open_window",
      "window_transfer",
      "window_close",
    ]);
    expect(body.runtimeMarkerIds).toHaveLength(3);
    expect(store.snapshot().activeOperation).toBeNull();
    const history = store.readOutcomeHistory({
      from: "2000-01-01T00:00:00.000Z",
      to: "2100-01-01T00:00:00.000Z",
      limit: 10,
    });
    expect(
      history.records.filter(
        (record) => record.operation.kind === "window_close",
      ),
    ).toHaveLength(1);
    expect(agent.inputs).toHaveLength(0);
  });

  it("skips nearby rotten flesh and collects a normal visible drop autonomously", async () => {
    const { store } = freshStore();
    store.save({
      goal: {
        title: "Gather nearby supplies",
        successCondition: "Pick up useful nearby items.",
        source: "owner",
      },
    });
    const body = new FakeBody(store);
    const rotten = droppedItemEntity(30, 1, "rotten_flesh", 1);
    const item = droppedItemEntity(31, 2, "oak_log", 1);
    body.observation = makeObservation({ entities: [rotten, item] });
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

  it("collects a received drop outside the view and then equips its armor", async () => {
    const { store } = freshStore();
    const current = gearItem("iron_helmet", 5, 60);
    const candidate = gearItem("diamond_helmet", 9);
    const body = new FakeBody(store);
    body.observation = makeObservation({
      equipment: {
        "off-hand": null,
        head: current,
      },
      entities: [],
      nearbyDroppedItems: makeNearbyDroppedItems([
        droppedItemEntity(41, 12, "diamond_helmet", 1),
      ]),
    });
    const agent = new FakeAgent([]);
    const runtime = createRuntime(store, body, agent);
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      if (operation.kind === "collect_item") {
        const after = {
          ...before,
          self: { ...before.self, inventory: [candidate] },
          perception: {
            ...before.perception,
            nearbyDroppedItems: makeNearbyDroppedItems([]),
          },
        };
        fakeBody.observation = after;
        return fakeBody.result(
          operation,
          "received-drop-collected",
          "successful",
          after,
          before,
        );
      }
      if (operation.kind === "equip") {
        const owned = before.self.inventory.find(
          (item) => item.name === operation.item,
        );
        if (owned === undefined)
          throw new Error("Expected collected armor in inventory");
        const after = {
          ...before,
          self: {
            ...before.self,
            inventory: before.self.inventory.filter(
              (item) => item.name !== operation.item,
            ),
            equipment: {
              ...before.self.equipment,
              [operation.destination]: { ...owned, slot: 5 },
            },
          },
        };
        fakeBody.observation = after;
        return fakeBody.result(
          operation,
          "collected-armor-equipped",
          "successful",
          after,
          before,
        );
      }
      throw new Error(`Unexpected operation: ${operation.kind}`);
    };

    await runtime.start();
    await eventually(
      () => body.executed.length === 2 && !runtime.status().thinking,
      4_000,
    );

    expect(body.executed).toEqual([
      { kind: "collect_item", entityId: 41 },
      { kind: "equip", item: "diamond_helmet", destination: "head" },
    ]);
    expect(agent.inputs).toHaveLength(0);
    expect(body.observation.self.inventory).toHaveLength(0);
    expect(body.observation.self.equipment.head?.name).toBe("diamond_helmet");
  });

  it.each([25, 32])(
    "prioritizes a nearby equipment drop at %i blocks over a chest and ordinary drops",
    async (dropDistance) => {
      const { store } = freshStore();
      const candidate = gearItem("diamond_helmet", 9);
      const body = new FakeBody(store);
      body.observation = makeObservation({
        equipment: {
          ...body.observation.self.equipment,
          head: gearItem("iron_helmet", 5, 60),
        },
        blocks: [equipmentChestBlock(20)],
        nearbyDroppedItems: makeNearbyDroppedItems([
          droppedItemEntity(71, dropDistance, "diamond_helmet", 1),
          droppedItemEntity(72, 1, "oak_log", 1),
        ]),
      });
      const runtime = createRuntime(store, body, new FakeAgent([]));
      body.executeHandler = async (operation, _signal, fakeBody) => {
        const before = fakeBody.observation;
        let after: PlayerBodyObservation;
        switch (operation.kind) {
          case "collect_item":
            after = {
              ...before,
              self: { ...before.self, inventory: [candidate] },
              perception: {
                ...before.perception,
                nearbyDroppedItems: makeNearbyDroppedItems(
                  before.perception.nearbyDroppedItems?.entities.filter(
                    (entity) => entity.id !== operation.entityId,
                  ) ?? [],
                ),
              },
            };
            break;
          case "equip":
            after = {
              ...before,
              self: {
                ...before.self,
                inventory: [],
                equipment: {
                  ...before.self.equipment,
                  [operation.destination]: { ...candidate, slot: 5 },
                },
              },
            };
            break;
          case "move_to":
            after = {
              ...before,
              self: {
                ...before.self,
                position: { x: 18, y: 64, z: 0, dimension: "overworld" },
              },
              perception: {
                ...before.perception,
                blocks: [equipmentChestBlock(20, 2)],
              },
            };
            break;
          case "open_window":
            after = { ...before, window: chestWindow(null) };
            break;
          case "window_close":
            after = { ...before, window: null };
            break;
          default:
            throw new Error(`Unexpected operation: ${operation.kind}`);
        }
        fakeBody.observation = after;
        return fakeBody.result(
          operation,
          `equipment-priority-${fakeBody.executed.length}`,
          "successful",
          after,
          before,
        );
      };

      await runtime.start();
      await eventually(() => body.executed.length >= 4, 4_000);

      expect(body.executed.slice(0, 2)).toEqual([
        { kind: "collect_item", entityId: 71 },
        { kind: "equip", item: "diamond_helmet", destination: "head" },
      ]);
      expect(
        body.executed.some(
          (operation) =>
            operation.kind === "collect_item" && operation.entityId === 72,
        ),
      ).toBe(false);
      expect(body.observation.self.equipment.head?.name).toBe("diamond_helmet");
      expect(body.results[1]?.after?.self.equipment.head?.name).toBe(
        "diamond_helmet",
      );
    },
  );

  it.each([20, 32])(
    "approaches a nearby chest at %i blocks and verifies it before searching ahead of distant equipment",
    async (chestDistance) => {
      const { store } = freshStore();
      const candidate = gearItem("diamond_helmet", 0);
      const distantDrop = droppedItemEntity(73, -50, "netherite_sword", 1);
      const body = new FakeBody(store);
      body.observation = makeObservation({
        equipment: {
          ...body.observation.self.equipment,
          head: gearItem("iron_helmet", 5, 60),
        },
        blocks: [equipmentChestBlock(chestDistance)],
        nearbyDroppedItems: makeNearbyDroppedItems([distantDrop]),
      });
      const runtime = createRuntime(store, body, new FakeAgent([]));
      let openPositionX: number | undefined;
      let openChestDistance: number | undefined;
      body.executeHandler = async (operation, _signal, fakeBody) => {
        const before = fakeBody.observation;
        let after: PlayerBodyObservation;
        switch (operation.kind) {
          case "move_to":
            after = {
              ...before,
              self: {
                ...before.self,
                position: {
                  x: chestDistance - 2,
                  y: 64,
                  z: 0,
                  dimension: "overworld",
                },
              },
              perception: {
                ...before.perception,
                blocks: [equipmentChestBlock(chestDistance, 2)],
                nearbyDroppedItems: makeNearbyDroppedItems([
                  { ...distantDrop, distance: chestDistance + 48 },
                ]),
              },
            };
            break;
          case "open_window":
            openPositionX = before.self.position.x;
            openChestDistance = before.perception.blocks[0]?.distance;
            after = { ...before, window: chestWindow(candidate) };
            break;
          case "window_transfer": {
            const owned = gearItem(candidate.name, 9);
            after = {
              ...before,
              self: { ...before.self, inventory: [owned] },
              window: chestWindow(null, owned),
            };
            break;
          }
          case "window_close":
            after = { ...before, window: null };
            break;
          case "equip": {
            const owned = before.self.inventory.find(
              (item) => item.name === operation.item,
            );
            if (owned === undefined)
              throw new Error("Expected chest equipment in inventory");
            after = {
              ...before,
              self: {
                ...before.self,
                inventory: [],
                equipment: {
                  ...before.self.equipment,
                  [operation.destination]: { ...owned, slot: 5 },
                },
              },
            };
            break;
          }
          default:
            throw new Error(`Unexpected operation: ${operation.kind}`);
        }
        fakeBody.observation = after;
        return fakeBody.result(
          operation,
          `chest-priority-${fakeBody.executed.length}`,
          "successful",
          after,
          before,
        );
      };

      await runtime.start();
      await eventually(() => body.executed.length === 5, 4_000);

      expect(body.executed).toEqual([
        {
          kind: "move_to",
          position: { x: chestDistance, y: 64, z: 0 },
          range: 2.5,
        },
        {
          kind: "open_window",
          target: {
            kind: "block",
            position: { x: chestDistance, y: 64, z: 0 },
          },
        },
        {
          kind: "window_transfer",
          item: "diamond_helmet",
          count: 1,
          direction: "window_to_inventory",
        },
        { kind: "window_close" },
        { kind: "equip", item: "diamond_helmet", destination: "head" },
      ]);
      expect(openPositionX).toBe(chestDistance - 2);
      expect(openChestDistance).toBe(2);
      expect(body.observation.self.equipment.head?.name).toBe("diamond_helmet");
    },
  );

  it("collects equipment at 50 blocks before a chest beyond the 32-block priority range", async () => {
    const { store } = freshStore();
    const candidate = gearItem("diamond_helmet", 9);
    const body = new FakeBody(store);
    body.observation = makeObservation({
      equipment: {
        ...body.observation.self.equipment,
        head: gearItem("iron_helmet", 5, 60),
      },
      blocks: [equipmentChestBlock(33)],
      nearbyDroppedItems: makeNearbyDroppedItems([
        droppedItemEntity(74, 50, "diamond_helmet", 1),
      ]),
    });
    const runtime = createRuntime(store, body, new FakeAgent([]));
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      let after: PlayerBodyObservation;
      switch (operation.kind) {
        case "collect_item":
          after = {
            ...before,
            self: { ...before.self, inventory: [candidate] },
            perception: {
              ...before.perception,
              nearbyDroppedItems: makeNearbyDroppedItems([]),
            },
          };
          break;
        case "equip":
          after = {
            ...before,
            self: {
              ...before.self,
              inventory: [],
              equipment: {
                ...before.self.equipment,
                [operation.destination]: { ...candidate, slot: 5 },
              },
            },
          };
          break;
        default:
          throw new Error(`Unexpected operation: ${operation.kind}`);
      }
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `far-equipment-priority-${fakeBody.executed.length}`,
        "successful",
        after,
        before,
      );
    };

    await runtime.start();
    await eventually(
      () => body.executed.length === 2 && !runtime.status().thinking,
      4_000,
    );

    expect(body.executed).toEqual([
      { kind: "collect_item", entityId: 74 },
      { kind: "equip", item: "diamond_helmet", destination: "head" },
    ]);
    expect(body.observation.self.equipment.head?.name).toBe("diamond_helmet");
  });

  it("does not open a chest when the owner stops during its approach", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.observation = makeObservation({ blocks: [equipmentChestBlock(20)] });
    const runtime = createRuntime(store, body, new FakeAgent([]));
    let moveSignal: AbortSignal | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      if (operation.kind !== "move_to")
        throw new Error(`Unexpected operation: ${operation.kind}`);
      moveSignal = signal;
      return await new Promise<PlayerOperationResult>((resolve) => {
        const finish = (): void =>
          resolve(
            fakeBody.result(
              operation,
              "chest-approach-stopped",
              "interrupted",
              null,
            ),
          );
        if (signal?.aborted) finish();
        else signal?.addEventListener("abort", finish, { once: true });
      });
    };

    await runtime.start();
    await eventually(() => body.executed.length === 1);
    await runtime.stop("Builder");

    expect(moveSignal?.aborted).toBe(true);
    expect(body.executed).toEqual([
      { kind: "move_to", position: { x: 20, y: 64, z: 0 }, range: 2.5 },
    ]);
    expect(store.snapshot().stopped).toBe(true);
  });

  it("does not collect a candidate beyond the observation range", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.observation = makeObservation({
      entities: [],
      nearbyDroppedItems: makeNearbyDroppedItems(
        [droppedItemEntity(42, 65, "oak_log", 1)],
        64,
      ),
    });
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);

    expect(body.executed).toHaveLength(0);
  });

  it("continues ordinary judgment when no client-received drop is in range", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.observation = makeObservation({
      entities: [droppedItemEntity(32, 65, "oak_log", 1)],
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

  it("caps visible failed targets and reuses a cleared slot for a new drop", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    const visibleDrops = Array.from({ length: 33 }, (_, index) =>
      droppedItemEntity(100 + index, (index + 1) / 10, "oak_log", 1),
    );
    body.observation = makeObservation({ entities: visibleDrops });
    const agent = new FakeAgent([]);
    body.executeHandler = async (operation, _signal, fakeBody) => {
      if (operation.kind === "collect_item" && operation.entityId === 133) {
        const after = {
          ...fakeBody.observation,
          self: {
            ...fakeBody.observation.self,
            inventory: [
              {
                slot: 36,
                itemId: 17,
                name: "apple",
                count: 1,
                metadata: 0,
                durability: null,
                maxDurability: null,
                customName: null,
                enchantments: [],
              },
            ],
          },
          perception: {
            ...fakeBody.observation.perception,
            entities: fakeBody.observation.perception.entities.filter(
              (entity) => entity.id !== 133,
            ),
          },
        };
        fakeBody.observation = after;
        return fakeBody.result(operation, "new-drop", "successful", after);
      }
      return fakeBody.result(operation, "unavailable-drop", "failed", null);
    };
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventuallyWithFakeTimers(() => body.results.length === 32, 2_500);
    for (let attempt = 0; attempt < 100; attempt++) await Promise.resolve();
    const attemptedItemIds = body.executed.flatMap((operation) =>
      operation.kind === "collect_item" ? [operation.entityId] : [],
    );
    expect(attemptedItemIds).toHaveLength(32);
    expect(agent.inputs).toHaveLength(0);
    expect(new Set(attemptedItemIds).size).toBe(32);

    const newDrop = droppedItemEntity(133, 0.1, "apple", 1);
    body.observation = makeObservation({
      entities: [...visibleDrops.slice(1), newDrop],
    });
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "entities",
    });
    await eventuallyWithFakeTimers(() => body.executed.length === 33);

    expect(body.executed[32]).toEqual({ kind: "collect_item", entityId: 133 });
    expect(store.snapshot().lastOutcome).toMatchObject({
      status: "successful",
      operation: { kind: "collect_item", entityId: 133 },
    });
    expect(agent.inputs).toHaveLength(0);
  });

  it("lets authenticated owner input supersede an automatic pickup", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.observation = makeObservation({
      entities: [droppedItemEntity(35, 2, "apple", 1)],
    });
    const agent = new FakeAgent([
      interleavedReplyDecision(null, "update_goal"),
      emptyDecision(),
    ]);
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
    expect(agent.inputs).toHaveLength(2);
    expect(agent.inputs[0]).toMatchObject({
      ownerMessage: "少し待って",
      ownerReplyContext: { pendingOwnerRequest: null },
    });
    expect(agent.inputs[1]?.ownerMessage).toBe("少し待って");
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
    await eventually(
      () => !runtime.status().thinking && runtime.status().nextWakeAt !== null,
    );
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
    const agent = new FakeAgent([
      interleavedReplyDecision("今の状態を確認しているよ。", "answer_only"),
    ]);
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
    expect(followSignals[0]?.aborted).toBe(false);
    expect(agent.inputs).toHaveLength(1);
    expect(say).toHaveBeenCalledWith("今の状態を確認しているよ。");

    await runtime.receiveChat("Builder", "ついてきて");
    await runtime.receiveChat("Impostor", "緊急停止命令");
    expect(followSignals[0]?.aborted).toBe(false);
    await runtime.receiveChat("Builder", "緊急停止命令");

    expect(followSignals[0]?.aborted).toBe(true);
    expect(store.snapshot().stopped).toBe(true);
    expect(agent.inputs).toHaveLength(1);
    expect(body.executed.map(({ kind }) => kind)).toEqual(["follow_owner"]);
  });

  it("accepts kana approach wording and active same-purpose follow nudges", async () => {
    for (const command of ["こっちきて", "こっち来て！"]) {
      const { store } = freshStore();
      const body = new FakeBody(store);
      const say = vi.fn(async () => undefined);
      const agent = new FakeAgent([
        interleavedReplyDecision(null, "update_goal"),
        ownerGoalDecision([], "石を集める"),
      ]);
      const followSignals: AbortSignal[] = [];
      body.executeHandler = async (operation, signal, fakeBody) => {
        if (operation.kind !== "follow_owner")
          throw new Error(`Unexpected operation: ${operation.kind}`);
        if (signal !== undefined) followSignals.push(signal);
        return await new Promise<PlayerOperationResult>((resolve) => {
          const finish = (): void =>
            resolve(
              fakeBody.result(
                operation,
                `follow-${fakeBody.executed.length}`,
                "interrupted",
                null,
              ),
            );
          if (signal?.aborted) finish();
          else signal?.addEventListener("abort", finish, { once: true });
        });
      };
      const runtime = createRuntime(store, body, agent, say);

      await runtime.receiveChat("Builder", command);
      await eventually(() => body.executed.length === 1);
      expect(body.executed[0]).toEqual({ kind: "follow_owner" });
      expect(agent.inputs).toHaveLength(0);

      for (const reminder of [
        "こっちきて。",
        "早く来て！",
        "はやくきて",
        "早く",
        "急いで。",
      ]) {
        await runtime.receiveChat("Builder", reminder);
        expect(body.executed).toHaveLength(1);
        expect(followSignals[0]?.aborted).toBe(false);
        expect(agent.inputs).toHaveLength(0);
      }
      expect(say).toHaveBeenCalledTimes(1);

      await runtime.receiveChat("Builder", "早く石を集めて");
      expect(followSignals[0]?.aborted).toBe(true);
      expect(agent.inputs).toHaveLength(2);
      expect(agent.inputs[0]?.ownerMessage).toBe("早く石を集めて");
      expect(agent.inputs[0]?.ownerReplyContext).toEqual({
        pendingOwnerRequest: null,
      });
      expect(agent.inputs[1]?.ownerMessage).toBe("早く石を集めて");
      expect(body.executed).toHaveLength(1);
      expect(store.snapshot().goal?.title).toBe("石を集める");

      await runtime.shutdown();
    }
  });

  it("gives an empty owner decision one fallback and does not repeat it on a timer wake", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    const say = vi.fn(async () => undefined);
    const agent = new FakeAgent([
      companionDecisionSchema.parse({ ...emptyDecision(), waitMs: 5_000 }),
      emptyDecision(),
    ]);
    const runtime = createRuntime(store, body, agent, say, 1_000);

    await runtime.receiveChat("Builder", "今の様子を教えて");

    expect(say).toHaveBeenCalledExactlyOnceWith(
      "現在の状況は確認したけれど、返答を確定できなかったよ。詳しい理由はまだ分からないよ。",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(agent.inputs).toHaveLength(2);
    expect(agent.inputs[1]?.ownerMessage).toBeUndefined();
    expect(say).toHaveBeenCalledTimes(1);
  });

  it("keeps an unknown send attached to its original question and never auto-retries it", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    let sayCalls = 0;
    const say = vi.fn(async (_text: string) => {
      sayCalls += 1;
      if (sayCalls === 1) throw new Error("synthetic say rejection");
    });
    const agent = new FakeAgent([emptyDecision(), emptyDecision()]);
    const runtime = createRuntime(store, body, agent, say, 1_000);

    await runtime.receiveChat("Builder", "周囲を確認して");

    const originalSequence = store
      .snapshot()
      .replyLifecycle.at(-1)?.ownerMessageSequence;
    expect(originalSequence).toBeDefined();
    expect(store.messageBySequence(originalSequence ?? -1)?.text).toBe(
      "周囲を確認して",
    );
    expect(
      store.replyLifecycleFor(originalSequence ?? -1)?.events.at(-1),
    ).toMatchObject({
      state: "send_unknown",
      reasonCode: "say_call_rejected",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(agent.inputs).toHaveLength(2);
    expect(agent.inputs[1]?.ownerMessage).toBeUndefined();
    expect(agent.inputs[1]?.pendingOwnerRequest).toBeUndefined();
    expect(say).toHaveBeenCalledTimes(1);

    await runtime.receiveChat("Builder", "返事が来なかった理由を教えて。");
    expect(agent.inputs).toHaveLength(2);
    expect(say).toHaveBeenCalledTimes(2);
    expect(say.mock.calls[1]?.[0]).toContain("もう一度依頼して");
    expect(store.messageBySequence(originalSequence ?? -1)?.text).toBe(
      "周囲を確認して",
    );
  });

  it("does not feed an unknown prior reply into a later goal-turn answer", async () => {
    const { store } = freshStore();
    store.save({
      goal: {
        title: "Continue the synthetic task",
        successCondition: "Observe the current area.",
        source: "owner",
      },
      plan: {
        purpose: "Keep the active task context for a separate owner question.",
        steps: [{ operation: look, expectedOutcome: "The area is observed." }],
      },
      activeOperation: {
        operationId: "synthetic-active-operation",
        operation: look,
        expectedOutcome: "The area is observed.",
      },
    });
    const body = new FakeBody(store);
    let sayCalls = 0;
    const say = vi.fn(async () => {
      sayCalls += 1;
      if (sayCalls === 1) throw new Error("synthetic say rejection");
    });
    const agent = new FakeAgent([
      interleavedReplyDecision("最初の返信", "answer_only"),
      interleavedReplyDecision("次の質問への返信", "answer_only"),
    ]);
    const runtime = createRuntime(store, body, agent, say);

    await runtime.receiveChat("Builder", "最初の質問");
    const originalSequence = store
      .snapshot()
      .replyLifecycle.at(-1)?.ownerMessageSequence;
    expect(
      store.replyLifecycleFor(originalSequence ?? -1)?.events.at(-1)?.state,
    ).toBe("send_unknown");

    await runtime.receiveChat("Builder", "次の質問");
    expect(agent.inputs[1]?.ownerReplyContext).toEqual({
      pendingOwnerRequest: null,
    });
    expect(agent.inputs[1]?.pendingOwnerRequest).toBeUndefined();
    expect(say).toHaveBeenCalledTimes(2);
  });

  it("does not repeat speech when persisting a resolved send fails", async () => {
    vi.useFakeTimers();
    const { store } = freshStore();
    const body = new FakeBody(store);
    const say = vi.fn(async () => undefined);
    const agent = new FakeAgent([emptyDecision(), emptyDecision()]);
    const recordLifecycleEvent = store.recordReplyLifecycleEvent.bind(store);
    store.recordReplyLifecycleEvent = (sequence, state, reasonCode) => {
      if (state === "send_call_resolved")
        throw new Error("synthetic lifecycle persistence failure");
      return recordLifecycleEvent(sequence, state, reasonCode);
    };
    const runtime = createRuntime(store, body, agent, say, 1_000);

    await runtime.receiveChat("Builder", "合成の確認依頼");
    expect(say).toHaveBeenCalledTimes(1);
    expect(store.snapshot().replyLifecycle.at(-1)?.events.at(-1)?.state).toBe(
      "send_started",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(agent.inputs).toHaveLength(2);
    expect(agent.inputs[1]?.pendingOwnerRequest).toBeUndefined();
    expect(say).toHaveBeenCalledTimes(1);
  });

  it("does not treat generic why, reply, or water-reason questions as reply-status requests", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const say = vi.fn(async (_text: string) => undefined);
    const agent = new FakeAgent([]);
    const runtime = createRuntime(store, body, agent, say);

    for (const message of ["なぜ？", "返事", "水の中に行った理由は？"]) {
      await runtime.receiveChat("Builder", message);
    }
    expect(agent.inputs.map(({ ownerMessage }) => ownerMessage)).toEqual([
      "なぜ？",
      "返事",
      "水の中に行った理由は？",
    ]);

    const decisionsBeforeReplyStatus = agent.inputs.length;
    await runtime.receiveChat("Builder", "返事が来なかった理由を教えて。");
    expect(agent.inputs).toHaveLength(decisionsBeforeReplyStatus);
    expect(say.mock.calls.at(-1)?.[0]).toContain("say呼び出しが戻った");

    for (const message of [
      "返事が遅い理由を教えて",
      "返信が遅れたのはなぜ？",
    ]) {
      await runtime.receiveChat("Builder", message);
      expect(agent.inputs).toHaveLength(decisionsBeforeReplyStatus);
      expect(say.mock.calls.at(-1)?.[0]).toContain(
        "元の質問は履歴に残っているよ",
      );
    }
  });

  it("diagnoses the newest owner question after an older send completes late", async () => {
    const { store } = freshStore();
    const olderSequence = store.recordMessage(
      "owner",
      "synthetic older request",
    );
    store.recordReplyLifecycleEvent(olderSequence, "received");
    store.recordReplyLifecycleEvent(olderSequence, "generation_started");
    store.recordReplyLifecycleEvent(olderSequence, "generated");
    store.recordReplyLifecycleEvent(olderSequence, "send_started");

    const newestSequence = store.recordMessage(
      "owner",
      "synthetic newer request",
    );
    store.recordReplyLifecycleEvent(newestSequence, "received");
    store.recordReplyLifecycleEvent(newestSequence, "generation_started");
    store.recordReplyLifecycleEvent(newestSequence, "generated");
    store.recordReplyLifecycleEvent(
      newestSequence,
      "send_unknown",
      "say_call_rejected",
    );
    store.recordReplyLifecycleEvent(olderSequence, "send_call_resolved");

    const say = vi.fn(async (_text: string) => undefined);
    const runtime = createRuntime(
      store,
      new FakeBody(store),
      new FakeAgent([]),
      say,
    );

    await runtime.receiveChat("Builder", "返信が遅れたのはなぜ？");

    expect(store.latestReplyLifecycle()?.ownerMessageSequence).toBe(
      newestSequence,
    );
    expect(say.mock.calls.at(-1)?.[0]).toContain(
      "say呼び出しの失敗が記録されているよ",
    );
  });

  it("explains a recorded generated result separately from an unresolved generation restart", async () => {
    const { store, path } = freshStore();
    const sequence = store.recordMessage(
      "owner",
      "synthetic generated request",
    );
    store.recordReplyLifecycleEvent(sequence, "received");
    store.recordReplyLifecycleEvent(sequence, "generation_started");
    store.recordReplyLifecycleEvent(sequence, "generated");
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = CompanionStore.open(path, { ownerUsername: "Builder" });
    stores.push(reopened);
    const say = vi.fn(async (_text: string) => undefined);
    const runtime = createRuntime(
      reopened,
      new FakeBody(reopened),
      new FakeAgent([]),
      say,
    );

    await runtime.receiveChat("Builder", "返事が来なかった理由を教えて。");

    expect(say.mock.calls.at(-1)?.[0]).toContain(
      "再起動前に返答生成の完了を記録しているよ",
    );
    expect(say.mock.calls.at(-1)?.[0]).toContain(
      "送信開始とゲーム内表示は未確認",
    );
    expect(say.mock.calls.at(-1)?.[0]).toContain("再起動の原因も分からないよ");
    expect(say.mock.calls.at(-1)?.[0]).not.toContain("生成完了の記録がない");
  });

  it("does not speak a late owner reply after durable stop and resumes only on an explicit owner command", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const pending = deferred<CompanionDecision>();
    const say = vi.fn(async () => undefined);
    const agent = new FakeAgent([() => pending.promise, makeDecision([look])]);
    const runtime = createRuntime(store, body, agent, say);

    const ownerTurn = runtime.receiveChat("Builder", "周囲を見て");
    await eventually(() => runtime.status().thinking);
    const sequence = store
      .snapshot()
      .replyLifecycle.at(-1)?.ownerMessageSequence;
    const stopping = runtime.stop("Builder");
    expect(store.snapshot().stopped).toBe(true);
    pending.resolve(makeDecision([look]));
    await stopping;
    await ownerTurn;

    expect(store.replyLifecycleFor(sequence ?? -1)?.events.at(-1)?.state).toBe(
      "durable_stop",
    );
    expect(say).not.toHaveBeenCalled();
    expect(body.executed).toHaveLength(0);

    await runtime.receiveChat("Builder", "再開して");
    expect(store.snapshot().stopped).toBe(false);
    const resumedSequence = store
      .snapshot()
      .replyLifecycle.at(-1)?.ownerMessageSequence;
    expect(store.messageBySequence(resumedSequence ?? -1)?.text).toBe(
      "再開して",
    );
    expect(agent.inputs.at(-1)?.ownerMessage).toBe("再開して");
    expect(body.executed).toEqual([look]);
    expect(say).toHaveBeenCalled();
    expect(
      store.replyLifecycleFor(resumedSequence ?? -1)?.events.at(-1)?.state,
    ).toBe("send_call_resolved");
    expect(store.replyLifecycleFor(sequence ?? -1)?.events.at(-1)?.state).toBe(
      "durable_stop",
    );
  });

  it("explains the unfinished pre-stop question after quiet status inquiry and explicit resume", async () => {
    const { store } = freshStore();
    const originalSequence = store.recordMessage("owner", "元の未完了依頼");
    store.recordReplyLifecycleEvent(originalSequence, "received");
    store.recordReplyLifecycleEvent(originalSequence, "generation_started");
    const body = new FakeBody(store);
    const say = vi.fn(async (_text: string) => undefined);
    const agent = new FakeAgent([emptyDecision()]);
    const runtime = createRuntime(store, body, agent, say);

    await runtime.receiveChat("Builder", "緊急停止命令");
    expect(
      store.replyLifecycleFor(originalSequence)?.events.at(-1)?.state,
    ).toBe("durable_stop");
    const stoppedSpeechCount = say.mock.calls.length;

    await runtime.receiveChat("Builder", "返事が来なかった理由を教えて。");
    expect(agent.inputs).toHaveLength(0);
    expect(body.executed).toHaveLength(0);
    expect(say).toHaveBeenCalledTimes(stoppedSpeechCount);

    await runtime.receiveChat("Builder", "再開して");
    expect(runtime.status().stopped).toBe(false);
    expect(agent.inputs).toHaveLength(1);
    const resumeSequence = store
      .snapshot()
      .replyLifecycle.at(-1)?.ownerMessageSequence;
    expect(store.messageBySequence(resumeSequence ?? -1)?.text).toBe(
      "再開して",
    );

    await runtime.receiveChat("Builder", "返事が来なかった理由を教えて。");

    expect(say.mock.calls.at(-1)?.[0]).toContain(
      "永続停止で元の返答処理を止めた記録があるよ",
    );
    expect(agent.inputs).toHaveLength(1);
    expect(body.executed).toHaveLength(0);
  });

  it("gives an owner a fixed reply when the Agent fails", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const say = vi.fn(async (_text: string) => undefined);
    const agent = new FakeAgent([
      async () => {
        throw new Error("synthetic decision failure");
      },
    ]);
    const runtime = createRuntime(store, body, agent, say);

    await runtime.receiveChat("Builder", "いま何をしているの？");

    expect(say).toHaveBeenCalledExactlyOnceWith(
      "依頼は受け取ったけれど、現在の状態と返答は確認できていないよ。詳しい原因はまだ分からないよ。",
    );
    expect(runtime.status().recentErrors).toHaveLength(1);
    expect(store.snapshot().replyLifecycle.at(-1)?.events).toMatchObject([
      { state: "received" },
      { state: "generation_started" },
      { state: "generation_failed", reasonCode: "judgment_failed" },
      { state: "send_started" },
      { state: "send_call_resolved" },
    ]);
  });

  it("describes an observed plan step without claiming its larger goal was achieved", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const say = vi.fn(async () => undefined);
    const planDecision = makeDecision([look]);
    const decision = companionDecisionSchema.parse({
      ...planDecision,
      speech: null,
      goal: {
        title: "Gather 64 oak logs",
        successCondition: "The inventory contains 64 oak logs.",
        source: "owner",
      },
    });
    const runtime = createRuntime(store, body, new FakeAgent([decision]), say);

    await runtime.receiveChat("Builder", "Gather 64 oak logs");

    expect(body.executed).toEqual([{ kind: "look_sweep" }]);
    expect(body.observation.self.inventory).toEqual([]);
    expect(store.snapshot().goal?.title).toBe("Gather 64 oak logs");
    expect(say).toHaveBeenNthCalledWith(
      1,
      "依頼を受け取ったよ。結果を確認してから伝えるね。",
    );
    expect(say).toHaveBeenNthCalledWith(
      2,
      "いま実行した操作の結果を確認できたよ。",
    );
    expect(say).not.toHaveBeenCalledWith("64本集められたよ。");
  });

  it("speaks planned owner replies only after confirmation and falls back when results are unconfirmed", async () => {
    for (const outcome of [
      "successful",
      "failed",
      "fresh-observation-failed",
    ] as const) {
      const { store } = freshStore();
      const body = new FakeBody(store);
      const say = vi.fn(async () => undefined);
      const decision = companionDecisionSchema.parse({
        ...makeDecision([look]),
        speech: "もう完了したよ。",
      });
      const agent = new FakeAgent([decision]);
      const runtime = createRuntime(store, body, agent, say);
      let observations = 0;
      if (outcome === "fresh-observation-failed") {
        body.observeHandler = async () => {
          observations += 1;
          if (observations === 2)
            throw new Error("synthetic observation failure");
        };
      }
      const result = deferred<PlayerOperationResult>();
      body.executeHandler = async () => result.promise;

      const ownerTurn = runtime.receiveChat("Builder", "周囲を確認して");
      await eventually(() => body.executed.length === 1);
      expect(say).toHaveBeenCalledExactlyOnceWith(
        "依頼を受け取ったよ。結果を確認してから伝えるね。",
      );
      expect(say).not.toHaveBeenCalledWith("もう完了したよ。");

      const operation = body.executed[0];
      if (operation === undefined) throw new Error("Expected a Body operation");
      result.resolve(
        body.result(
          operation,
          `synthetic-${outcome}`,
          outcome === "failed" ? "failed" : "successful",
          outcome === "failed" ? null : body.observation,
        ),
      );
      await ownerTurn;

      if (outcome === "successful") {
        expect(say).toHaveBeenCalledTimes(2);
        expect(say).toHaveBeenNthCalledWith(
          1,
          "依頼を受け取ったよ。結果を確認してから伝えるね。",
        );
        expect(say).toHaveBeenNthCalledWith(2, "もう完了したよ。");
      } else {
        expect(say).toHaveBeenCalledTimes(2);
        expect(say).toHaveBeenNthCalledWith(
          1,
          "依頼を受け取ったよ。結果を確認してから伝えるね。",
        );
        expect(say).toHaveBeenNthCalledWith(
          2,
          "行動結果はまだ確認できず、完了とは言えないよ。詳しい原因はまだ分からないよ。",
        );
        expect(say).not.toHaveBeenCalledWith("もう完了したよ。");
      }
    }
  });

  it("defers a dream while the original owner request is still pending", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const say = vi.fn(async () => undefined);
    const originalDecision = deferred<CompanionDecision>();
    const agent = new FakeAgent([
      () => originalDecision.promise,
      async () =>
        interleavedReplyDecision(
          "その夢は今の依頼の後に一緒に考えよう。まず周囲を確認するね。",
          "answer_only",
        ),
      async () =>
        interleavedReplyDecision("依頼を続けているよ。", "answer_only"),
    ]);
    const runtime = createRuntime(store, body, agent, say);

    const originalTurn = runtime.receiveChat("Builder", "周囲を確認して");
    try {
      await eventually(() => agent.inputs.length === 1);
      expect(agent.inputs[0]?.ownerMessage).toBe("周囲を確認して");
      expect(agent.signals[0]?.aborted).toBe(false);

      await runtime.receiveChat(
        "Builder",
        "いつか海辺に灯台を作りたい。今の依頼の後に考えられる？",
      );
      await runtime.receiveChat("Builder", "元の依頼は進んでいる？");

      expect(agent.inputs).toHaveLength(3);
      expect(agent.inputs[1]).toMatchObject({
        ownerMessage: "いつか海辺に灯台を作りたい。今の依頼の後に考えられる？",
        ownerReplyContext: { pendingOwnerRequest: "周囲を確認して" },
      });
      expect(agent.inputs[2]).toMatchObject({
        ownerMessage: "元の依頼は進んでいる？",
        ownerReplyContext: { pendingOwnerRequest: "周囲を確認して" },
      });
      expect(agent.signals[0]?.aborted).toBe(false);
      expect(body.executed).toHaveLength(0);
      expect(store.snapshot().goal).toBeNull();
      expect(say).toHaveBeenNthCalledWith(
        1,
        "その夢は今の依頼の後に一緒に考えよう。まず周囲を確認するね。",
      );
      expect(say).toHaveBeenNthCalledWith(2, "依頼を続けているよ。");

      originalDecision.resolve(ownerGoalDecision([look], "周囲を確認する"));
      await originalTurn;

      expect(agent.inputs).toHaveLength(3);
      expect(agent.signals[0]?.aborted).toBe(false);
      expect(body.executed).toEqual([look]);
      expect(store.snapshot().goal?.title).toBe("周囲を確認する");
      expect(say).toHaveBeenCalledWith(
        "依頼を受け取ったよ。結果を確認してから伝えるね。",
      );
    } finally {
      originalDecision.resolve(ownerGoalDecision([look], "周囲を確認する"));
      await originalTurn;
    }
  });

  it("keeps an unfinished owner goal for factual and dream replies", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const say = vi.fn(async () => undefined);
    const move = playerOperationSchema.parse({
      kind: "move_to",
      position: { x: 8, y: 64, z: 8 },
      range: 2,
    });
    const agent = new FakeAgent([
      ownerGoalDecision([look], "周囲を確認する"),
      interleavedReplyDecision("いま確認中だよ。", "answer_only"),
      interleavedReplyDecision(
        "その大きな目標は、周囲の確認が終わってから一緒に考えよう。",
        "answer_only",
      ),
      interleavedReplyDecision(null, "update_goal"),
      ownerGoalDecision([move], "木を集める"),
    ]);
    let originalBodySignal: AbortSignal | undefined;
    body.executeHandler = async (operation, signal, fakeBody) =>
      fakeBody.executed.length > 1
        ? fakeBody.result(
            operation,
            "synthetic-new-goal-operation",
            "successful",
            fakeBody.observation,
          )
        : await new Promise<PlayerOperationResult>((resolve) => {
            originalBodySignal = signal;
            const interrupted = (): void =>
              resolve(
                fakeBody.result(
                  operation,
                  "synthetic-replaced-operation",
                  "interrupted",
                  null,
                ),
              );
            if (signal?.aborted) interrupted();
            else signal?.addEventListener("abort", interrupted, { once: true });
          });
    const runtime = createRuntime(store, body, agent, say);

    const originalTurn = runtime.receiveChat("Builder", "周囲を確認して");
    await eventually(() => body.executed.length === 1);
    const originalGoal = store.snapshot().goal;
    const originalOperation = store.snapshot().activeOperation;
    expect(originalGoal?.title).toBe("周囲を確認する");
    expect(originalOperation).not.toBeNull();

    await runtime.receiveChat("Builder", "いまはどこを見ている？");
    await runtime.receiveChat(
      "Builder",
      "いつか大きな目標に挑戦したい。一緒に考えてくれる？",
    );
    expect(originalBodySignal?.aborted).toBe(false);
    expect(store.snapshot().goal).toEqual(originalGoal);
    expect(store.snapshot().activeOperation).toEqual(originalOperation);
    expect(body.executed).toHaveLength(1);

    await runtime.receiveChat("Builder", "木を集めて");
    await originalTurn;

    expect(originalBodySignal?.aborted).toBe(true);
    expect(agent.inputs[1]).toMatchObject({
      ownerMessage: "いまはどこを見ている？",
      ownerReplyContext: { pendingOwnerRequest: null },
    });
    expect(agent.inputs[2]).toMatchObject({
      ownerMessage: "いつか大きな目標に挑戦したい。一緒に考えてくれる？",
      ownerReplyContext: { pendingOwnerRequest: null },
      snapshot: {
        goal: originalGoal,
        activeOperation: originalOperation,
      },
    });
    expect(agent.inputs[3]).toMatchObject({
      ownerMessage: "木を集めて",
      ownerReplyContext: { pendingOwnerRequest: null },
    });
    expect(agent.inputs[4]?.ownerMessage).toBe("木を集めて");
    expect(agent.inputs).toHaveLength(5);
    expect(body.executed).toEqual([look, move]);
    expect(store.snapshot().goal?.title).toBe("木を集める");
    expect(say).toHaveBeenCalledWith("いま確認中だよ。");
    expect(say).toHaveBeenCalledWith(
      "その大きな目標は、周囲の確認が終わってから一緒に考えよう。",
    );
  });

  it("promotes an unblocked dream through update-goal and a fresh normal judgment", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const title = "海辺に灯台を作る";
    const successCondition = "灯台の完成をBody観測で確かめる";
    const dreamDecision = (): CompanionDecision =>
      companionDecisionSchema.parse({
        ...ownerGoalDecision([look], title),
        goal: { title, successCondition, source: "owner" },
        plan: {
          purpose:
            "海辺の場所を確認し、資材を集めて灯台を建て、Body観測で完成を確かめる。まず現在の観測から候補地を調べ、結果を見て次の段階を決める。",
          steps: [
            {
              operation: look,
              expectedOutcome: "新しいBody観測で周囲の候補地を確認する",
            },
          ],
        },
        waitMs: 5_000,
      });
    const agent = new FakeAgent([
      (_input, signal) =>
        new Promise<CompanionDecision>((_resolve, reject) => {
          const abort = (): void => reject(new Error("aborted"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        }),
      interleavedReplyDecision(null, "update_goal"),
      dreamDecision(),
      dreamDecision(),
    ]);
    const runtime = createRuntime(store, body, agent);
    let observationNumber = 0;
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      observationNumber += 1;
      const after = {
        ...before,
        observedAt: `2026-10-12T00:00:0${observationNumber}.000Z`,
        time: { ...before.time, timeOfDay: 7_000 + observationNumber * 1_000 },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `dream-flow-${observationNumber}`,
        "successful",
        after,
        before,
      );
    };

    await runtime.start();
    await eventually(() => agent.inputs.length === 1);
    expect(agent.inputs[0]?.ownerMessage).toBeUndefined();
    expect(agent.inputs[0]?.snapshot.goal).toBeNull();

    const dreamQuestion =
      "いつか海辺に灯台を作りたい。大きな目標にできるかな？";
    await runtime.receiveChat("Builder", dreamQuestion);

    expect(agent.signals[0]?.aborted).toBe(true);
    expect(agent.inputs[1]).toMatchObject({
      ownerMessage: dreamQuestion,
      ownerReplyContext: { pendingOwnerRequest: null },
      snapshot: { goal: null, activeOperation: null },
    });
    expect(agent.inputs[2]?.ownerMessage).toBe(dreamQuestion);
    expect(store.snapshot().goal).toMatchObject({
      title,
      successCondition,
      source: "owner",
    });
    await eventually(() => body.executed.length === 1);
    expect(body.executed).toEqual([look]);
    expect(body.results[0]?.after?.time.timeOfDay).toBe(8_000);

    body.emit({
      type: "state_changed",
      at: "2026-10-12T00:00:02.000Z",
      reason: "position",
    });
    await eventually(() => agent.inputs.length === 4, 4_000);

    expect(agent.inputs[3]?.snapshot.goal).toMatchObject({
      title,
      successCondition,
      source: "owner",
    });
    expect(agent.inputs[3]?.observation.time.timeOfDay).toBe(8_000);
    await eventually(() => body.executed.length === 2);
    expect(store.snapshot().goal).toMatchObject({ title, successCondition });
  });

  it("suppresses a superseded or stopped interleaved reply", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const say = vi.fn(async () => undefined);
    const supersededReply = deferred<CompanionDecision>();
    const stoppedReply = deferred<CompanionDecision>();
    const agent = new FakeAgent([
      ownerGoalDecision([look], "周囲を確認する"),
      () => supersededReply.promise,
      interleavedReplyDecision("最新の質問に答えたよ。", "answer_only"),
      () => stoppedReply.promise,
    ]);
    body.executeHandler = async (operation, signal, fakeBody) =>
      await new Promise<PlayerOperationResult>((resolve) => {
        const interrupted = (): void =>
          resolve(
            fakeBody.result(
              operation,
              "synthetic-stopped-operation",
              "interrupted",
              null,
            ),
          );
        if (signal?.aborted) interrupted();
        else signal?.addEventListener("abort", interrupted, { once: true });
      });
    const runtime = createRuntime(store, body, agent, say);
    const originalTurn = runtime.receiveChat("Builder", "周囲を確認して");
    await eventually(() => body.executed.length === 1);

    const staleTurn = runtime.receiveChat("Builder", "古い質問");
    await eventually(() => agent.inputs.length === 2);
    const staleSignal = agent.signals[1];
    await runtime.receiveChat("Builder", "新しい質問");
    expect(staleSignal?.aborted).toBe(true);
    expect(say).toHaveBeenCalledWith("最新の質問に答えたよ。");
    supersededReply.resolve(
      interleavedReplyDecision("古い返事を出さないで", "answer_only"),
    );
    await staleTurn;
    expect(say).not.toHaveBeenCalledWith("古い返事を出さないで");

    const stoppedTurn = runtime.receiveChat("Builder", "停止前の質問");
    await eventually(() => agent.inputs.length === 4);
    const stoppedSignal = agent.signals[3];
    await runtime.stop("Builder");
    expect(stoppedSignal?.aborted).toBe(true);
    stoppedReply.resolve(
      interleavedReplyDecision("停止後の古い返事", "answer_only"),
    );
    await stoppedTurn;
    await originalTurn;
    expect(say).not.toHaveBeenCalledWith("古い返事を出さないで");
    expect(say).not.toHaveBeenCalledWith("停止後の古い返事");
    expect(runtime.status().stopped).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["invalid", "unexpected"],
  ] as const)(
    "keeps active work and uses an unknown fallback for a %s reply disposition",
    async (_caseName, disposition) => {
      const { store } = freshStore();
      const body = new FakeBody(store);
      const say = vi.fn(async () => undefined);
      const undecidedReply = {
        ...interleavedReplyDecision("誤って確定した返答", "answer_only"),
        ownerMessageDisposition: disposition,
      } as unknown as CompanionDecision;
      const agent = new FakeAgent([
        ownerGoalDecision([look], "周囲を確認する"),
        undecidedReply,
      ]);
      let originalBodySignal: AbortSignal | undefined;
      body.executeHandler = async (operation, signal, fakeBody) =>
        await new Promise<PlayerOperationResult>((resolve) => {
          originalBodySignal = signal;
          const interrupted = (): void =>
            resolve(
              fakeBody.result(
                operation,
                "synthetic-unknown-reply-interruption",
                "interrupted",
                null,
              ),
            );
          if (signal?.aborted) interrupted();
          else signal?.addEventListener("abort", interrupted, { once: true });
        });
      const runtime = createRuntime(store, body, agent, say);
      const originalTurn = runtime.receiveChat("Builder", "周囲を確認して");
      await eventually(() => body.executed.length === 1);
      const originalGoal = store.snapshot().goal;
      const originalOperation = store.snapshot().activeOperation;

      await runtime.receiveChat("Builder", "いま何が見える？");

      expect(originalBodySignal?.aborted).toBe(false);
      expect(store.snapshot().goal).toEqual(originalGoal);
      expect(store.snapshot().activeOperation).toEqual(originalOperation);
      expect(body.executed).toHaveLength(1);
      expect(say).toHaveBeenCalledWith(
        "依頼は受け取ったけれど、現在の状態と返答は確認できていないよ。詳しい原因はまだ分からないよ。",
      );

      await runtime.shutdown();
      await originalTurn;
    },
  );

  it("keeps idle nudges, new goals, and quoted questions in the owner-message path", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([]);
    const runtime = createRuntime(store, body, agent);

    for (const message of [
      "早く",
      "急いで",
      "早く石を集めて",
      "『こっちきて』の意味は？",
    ]) {
      await runtime.receiveChat("Builder", message);
      expect(agent.inputs.at(-1)?.ownerMessage).toBe(message);
      expect(body.executed).toHaveLength(0);
    }
    expect(agent.inputs).toHaveLength(4);

    await runtime.shutdown();
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

  it("continues a natural owner goal from a fresh Body observation", async () => {
    const { store } = freshStore();
    const title = "海辺に灯台を作る";
    const successCondition =
      "安全な海辺の場所を見つけ、灯台の完成をBody観測で確かめる";
    const dreamDecision = (): CompanionDecision =>
      companionDecisionSchema.parse({
        ...ownerGoalDecision([look], title),
        goal: { title, successCondition, source: "owner" },
        plan: {
          purpose: "まず周囲を確認し、観測後に同じ目標を続ける",
          steps: [
            {
              operation: look,
              expectedOutcome: "周囲の状態をBody観測で確認する",
            },
          ],
        },
        waitMs: 5_000,
      });
    const body = new FakeBody(store);
    const agent = new FakeAgent([dreamDecision(), dreamDecision()]);
    const runtime = createRuntime(store, body, agent);
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const observationNumber = fakeBody.executed.length;
      if (observationNumber === 1) {
        expect(store.snapshot().goal).toMatchObject({
          title,
          successCondition,
          source: "owner",
        });
        expect(store.snapshot().plan).toMatchObject({
          purpose: "まず周囲を確認し、観測後に同じ目標を続ける",
          steps: [
            {
              operation: look,
              expectedOutcome: "周囲の状態をBody観測で確認する",
            },
          ],
        });
      }
      const timeOfDay = observationNumber === 1 ? 8_000 : 10_000;
      const after = {
        ...before,
        observedAt:
          observationNumber === 1
            ? "2026-10-11T00:00:01.000Z"
            : "2026-10-11T00:00:03.000Z",
        time: { ...before.time, timeOfDay },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        `dream-step-${observationNumber}`,
        "successful",
        after,
        before,
      );
    };

    const ownerMessage =
      "いつか海辺に灯台を作りたい。安全な場所を見つけて、完成したか確かめたい。";
    await runtime.receiveChat("Builder", ownerMessage);

    expect(agent.inputs).toHaveLength(1);
    expect(agent.inputs[0]?.ownerMessage).toBe(ownerMessage);
    expect(store.snapshot().goal).toMatchObject({
      title,
      successCondition,
      source: "owner",
    });
    expect(body.results[0]?.after?.time.timeOfDay).toBe(8_000);

    body.emit({
      type: "state_changed",
      at: "2026-10-11T00:00:02.000Z",
      reason: "position",
    });
    await eventually(() => agent.inputs.length === 2, 4_000);

    expect(agent.inputs[1]?.snapshot.goal).toMatchObject({
      title,
      successCondition,
      source: "owner",
    });
    expect(agent.inputs[1]?.observation.time.timeOfDay).toBe(8_000);
    await eventually(() => body.executed.length === 2);
    expect(body.results[1]?.after?.time.timeOfDay).toBe(10_000);
    expect(store.snapshot().goal).toMatchObject({ title, successCondition });
  });

  it("continues a plan to collect a received drop outside the visible entity list", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const drop = droppedItemEntity(43, 12, "oak_log", 1);
    body.observation = makeObservation({
      entities: [],
      nearbyDroppedItems: makeNearbyDroppedItems([drop]),
    });
    const collect = playerOperationSchema.parse({
      kind: "collect_item",
      entityId: drop.id,
    });
    store.save({
      plan: {
        purpose: "Protect the received drop while choosing the next action.",
        steps: [
          {
            operation: look,
            expectedOutcome: "The current observation is refreshed.",
          },
          {
            operation: collect,
            expectedOutcome: "The received drop is collected.",
          },
        ],
      },
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      if (operation.kind === "collect_item") {
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
          perception: {
            ...before.perception,
            nearbyDroppedItems: makeNearbyDroppedItems([]),
          },
        };
        fakeBody.observation = after;
        return fakeBody.result(
          operation,
          "planned-drop-collected",
          "successful",
          after,
          before,
        );
      }
      return fakeBody.result(
        operation,
        "plan-observation-refreshed",
        "successful",
        before,
        before,
      );
    };
    const agent = new FakeAgent([makeDecision([look, collect])]);
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 2);

    expect(body.executed).toEqual([
      look,
      { kind: "collect_item", entityId: drop.id },
    ]);
    expect(agent.inputs).toHaveLength(1);
    expect(store.snapshot().plan).toBeNull();
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
    await eventually(
      () => !runtime.status().thinking && runtime.status().nextWakeAt !== null,
    );
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
    await runtime.receiveChat("Impostor", "緊急停止命令");
    expect(runtime.status().stopped).toBe(false);

    const stopping = runtime.receiveChat("Builder", "緊急停止命令");
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
    await runtime.receiveChat("Builder", "緊急停止命令");

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
      interleavedReplyDecision(null, "update_goal"),
      ownerGoalDecision([look], "安全な場所へ戻る"),
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

    expect(agent.inputs).toHaveLength(3);
    expect(agent.inputs[1]).toMatchObject({
      ownerMessage: "今は戻ろう",
      ownerReplyContext: { pendingOwnerRequest: null },
    });
    expect(agent.inputs[2]?.ownerMessage).toBe("今は戻ろう");
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

  it("explains a damage interruption once without blocking the reflex action", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const interruptionReply =
      "ダメージ対応を優先して、元の返答を中断したよ。元の返答はまだ届けられておらず、実行中の操作があれば結果も未確認だよ。";
    const pendingSpeech = deferred<undefined>();
    const damageAction = deferred<PlayerOperationResult>();
    const say = vi.fn(async (text: string) => {
      if (text === interruptionReply) await pendingSpeech.promise;
    });
    const agent = new FakeAgent([
      companionDecisionSchema.parse({
        ...makeDecision([look]),
        speech: "依頼は完了したよ。",
      }),
    ]);
    body.executeHandler = async (operation, signal, fakeBody) => {
      if (fakeBody.executed.length === 1)
        return await new Promise<PlayerOperationResult>((resolve) => {
          const interrupted = (): void =>
            resolve(
              fakeBody.result(
                operation,
                "synthetic-owner-action-interrupted",
                "interrupted",
                null,
              ),
            );
          if (signal?.aborted) interrupted();
          else signal?.addEventListener("abort", interrupted, { once: true });
        });
      return damageAction.promise;
    };
    const runtime = createRuntime(store, body, agent, say);

    const ownerTurn = runtime.receiveChat("Builder", "周囲を確認して");
    await eventually(() => body.executed.length === 1);
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(() => body.executed.length === 2);

    expect(say).toHaveBeenCalledWith(
      "依頼を受け取ったよ。結果を確認してから伝えるね。",
    );
    expect(say).toHaveBeenCalledWith(interruptionReply);
    expect(say).toHaveBeenCalledTimes(2);
    expect(say).not.toHaveBeenCalledWith("依頼は完了したよ。");

    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    expect(body.executed).toHaveLength(2);
    expect(say).toHaveBeenCalledTimes(2);

    pendingSpeech.resolve(undefined);
    await eventually(() =>
      store
        .recentMessages(24)
        .some((message) => message.text === interruptionReply),
    );
    const damageOperation = body.executed[1];
    if (damageOperation === undefined)
      throw new Error("Expected a damage-reflex operation");
    damageAction.resolve(
      body.result(
        damageOperation,
        "synthetic-damage-action",
        "successful",
        body.observation,
      ),
    );
    await ownerTurn;

    expect(say).toHaveBeenCalledTimes(2);
    expect(
      store
        .recentMessages(24)
        .filter((message) => message.text === interruptionReply),
    ).toHaveLength(1);
    await runtime.shutdown();
  });

  it.each(["new owner message", "owner stop"] as const)(
    "suppresses a pending damage interruption explanation after %s supersedes it",
    async (supersedingAction) => {
      const { store } = freshStore();
      const body = new FakeBody(store);
      const say = vi.fn(async () => undefined);
      const agent = new FakeAgent([
        companionDecisionSchema.parse({
          ...makeDecision([look]),
          speech: "前の依頼は完了したよ。",
        }),
        interleavedReplyDecision("最新の質問へ返答したよ。", "answer_only"),
      ]);
      const pendingDamageObservation = deferred<undefined>();
      body.observeHandler = async (fakeBody) => {
        if (fakeBody.observeCalls === 2) await pendingDamageObservation.promise;
      };
      body.executeHandler = async (operation, signal, fakeBody) => {
        if (fakeBody.executed.length > 1)
          return fakeBody.result(
            operation,
            "synthetic-damage-reflex",
            "successful",
            fakeBody.observation,
          );
        return await new Promise<PlayerOperationResult>((resolve) => {
          const interrupted = (): void =>
            resolve(
              fakeBody.result(
                operation,
                "synthetic-superseded-owner-action",
                "interrupted",
                null,
              ),
            );
          if (signal?.aborted) interrupted();
          else signal?.addEventListener("abort", interrupted, { once: true });
        });
      };
      const runtime = createRuntime(store, body, agent, say);

      const ownerTurn = runtime.receiveChat("Builder", "周囲を確認して");
      await eventually(() => body.executed.length === 1);
      body.emit({
        type: "bot_damaged",
        at: new Date().toISOString(),
        source: null,
        confidence: "unknown",
      });
      await eventually(() => body.observeCalls === 2);

      const supersedingTurn =
        supersedingAction === "new owner message"
          ? runtime.receiveChat("Builder", "いま何が見える？")
          : runtime.receiveChat("Builder", "緊急停止命令");
      if (supersedingAction === "owner stop")
        await eventually(() => runtime.status().stopped);
      pendingDamageObservation.resolve(undefined);
      await Promise.all([ownerTurn, supersedingTurn]);

      expect(say).not.toHaveBeenCalledWith(
        "ダメージ対応を優先して、元の返答を中断したよ。元の返答はまだ届けられておらず、実行中の操作があれば結果も未確認だよ。",
      );
      if (supersedingAction === "new owner message") {
        expect(agent.inputs.at(-1)?.ownerMessage).toBe("いま何が見える？");
        expect(say).toHaveBeenCalledWith("最新の質問へ返答したよ。");
        expect(body.executed).toHaveLength(2);
        expect(store.snapshot().lastOutcome?.status).toBe("successful");
      } else {
        expect(runtime.status().stopped).toBe(true);
        expect(agent.inputs).toHaveLength(1);
        expect(body.executed).toHaveLength(1);
      }

      await runtime.shutdown();
    },
  );

  it("records a single dry recovery frame as unverified and remembers the interrupted goal", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const move: Extract<PlayerOperation, { kind: "move_to" }> = {
      kind: "move_to",
      position: { x: 8, y: 64, z: 8 },
      range: 2,
    };
    body.observation = {
      ...body.observation,
      self: { ...body.observation.self, inWater: true, oxygen: 4 },
    };
    const initial: CompanionDecision = {
      ...makeDecision([move]),
      goal: {
        title: "Collect wood for the cabin",
        successCondition: "Gather enough wood to continue building.",
        source: "owner" as const,
      },
      plan: {
        purpose: "Reach the trees and collect wood for the cabin.",
        steps: [
          {
            operation: move,
            expectedOutcome: "Reach the work area before collecting wood.",
          },
        ],
      },
    };
    const agent = new FakeAgent([initial]);
    let moveSignal: AbortSignal | undefined;
    let recoverySignal: AbortSignal | undefined;
    let finishRecovery: (() => void) | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      if (operation.kind === "move_to") {
        moveSignal = signal;
        return await new Promise<PlayerOperationResult>((resolve) => {
          signal?.addEventListener(
            "abort",
            () =>
              resolve(
                fakeBody.result(
                  operation,
                  "move-interrupted",
                  "interrupted",
                  null,
                ),
              ),
            { once: true },
          );
        });
      }
      if (operation.kind === "control") {
        recoverySignal = signal;
        return await new Promise<PlayerOperationResult>((resolve) => {
          finishRecovery = () => {
            const before = fakeBody.observation;
            const after = {
              ...before,
              self: { ...before.self, inWater: false, oxygen: 20 },
            };
            fakeBody.observation = after;
            resolve(
              fakeBody.result(
                operation,
                "water-recovery",
                "successful",
                after,
                before,
              ),
            );
          };
          signal?.addEventListener(
            "abort",
            () =>
              resolve(
                fakeBody.result(
                  operation,
                  "recovery-interrupted",
                  "interrupted",
                  null,
                ),
              ),
            { once: true },
          );
        });
      }
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
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(() => body.executed.length === 2);
    expect(moveSignal?.aborted).toBe(true);
    expect(body.executed).toEqual([move, jump]);
    expect(recoverySignal?.aborted).toBe(false);

    for (let index = 0; index < 3; index += 1) {
      body.emit({
        type: "bot_damaged",
        at: new Date().toISOString(),
        source: null,
        confidence: "unknown",
      });
    }
    expect(recoverySignal?.aborted).toBe(false);
    expect(body.executed).toHaveLength(2);
    finishRecovery?.();
    await eventually(
      () =>
        store.snapshot().lastOutcome?.operation.kind === "control" &&
        store.snapshot().lastOutcome?.status === "unverified",
    );
    expect(store.snapshot().lastOutcome?.summary).toContain(
      "water_recovery:dry_observed",
    );

    await runtime.receiveChat("Builder", "水の中に行った理由は？");

    const recalled = agent.inputs[1]?.memories ?? [];
    expect(
      recalled.some(
        (memory) =>
          memory.source === "bot_inferred" &&
          memory.kind === "episode" &&
          memory.content.includes("Collect wood for the cabin") &&
          memory.content.includes("Reach the trees and collect wood"),
      ),
    ).toBe(true);
    expect(body.executed).toEqual([move, jump]);
  });

  it("does not count post-respawn dry observation as same-life recovery", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.observation = {
      ...body.observation,
      self: { ...body.observation.self, inWater: true, oxygen: 4 },
    };
    body.executeHandler = async (operation, _signal, fakeBody) => {
      const before = fakeBody.observation;
      const after = {
        ...before,
        self: { ...before.self, inWater: false, oxygen: 20 },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "synthetic-post-respawn-dry",
        "successful",
        after,
        before,
        false,
      );
    };
    const runtime = createRuntime(
      store,
      body,
      new FakeAgent([emptyDecision()]),
    );

    await runtime.start();
    await eventually(() => runtime.status().nextWakeAt !== null);
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(
      () => store.snapshot().lastOutcome?.operation.kind === "control",
    );

    expect(body.executed).toEqual([jump]);
    expect(store.snapshot().lastOutcome?.status).toBe("unverified");
    expect(store.snapshot().lastOutcome?.summary).toContain(
      "water_recovery:unresolved",
    );
    expect(store.snapshot().lastOutcome?.summary).not.toContain(
      "water_recovery:surface_reached",
    );
    await runtime.shutdown();
  });

  it.each(
    [
      "stale timestamp",
      "unknown water state",
      "different dimension",
      "different life",
      "vertical movement",
      "nonpositive health",
      "low oxygen",
      "unstable height",
    ].map((caseName) => ({ caseName })),
  )(
    "does not reset a water recovery attempt from a dry candidate with $caseName evidence",
    async ({ caseName }) => {
      const { store } = freshStore();
      const body = new FakeBody(store);
      body.observation = {
        ...body.observation,
        self: { ...body.observation.self, inWater: true, oxygen: 4 },
      };
      body.executeHandler = async (operation, _signal, fakeBody) => {
        if (operation.kind !== "control" || operation.controls.jump !== true)
          return fakeBody.result(
            operation,
            `dry-candidate-${fakeBody.executed.length}`,
            "successful",
            fakeBody.observation,
          );
        const before = fakeBody.observation;
        const after = {
          ...before,
          observedAt: new Date(Date.now() - 3_500).toISOString(),
          self: { ...before.self, inWater: false, oxygen: 20 },
        };
        fakeBody.observation = after;
        return fakeBody.result(
          operation,
          "dry-candidate-recovery",
          "successful",
          after,
          before,
        );
      };
      const runtime = createRuntime(
        store,
        body,
        new FakeAgent([emptyDecision(), emptyDecision(), emptyDecision()]),
      );
      const emitAndWaitForObservation = async (event: PlayerBodyEvent) => {
        const previousObserveCalls = body.observeCalls;
        body.emit(event);
        await eventually(() => body.observeCalls > previousObserveCalls);
        await eventually(() => !runtime.status().thinking);
      };

      await runtime.start();
      await eventually(() => runtime.status().nextWakeAt !== null);
      body.emit({
        type: "bot_damaged",
        at: new Date().toISOString(),
        source: null,
        confidence: "unknown",
      });
      await eventually(
        () => store.snapshot().lastOutcome?.operation.kind === "control",
      );
      await eventually(() => !runtime.status().thinking);

      await emitAndWaitForObservation({
        type: "bot_damaged",
        at: new Date().toISOString(),
        source: null,
        confidence: "unknown",
      });

      if (caseName === "stale timestamp") {
        body.observation = {
          ...body.observation,
          observedAt: new Date(Date.now() - 12_000).toISOString(),
        };
      } else if (caseName === "unknown water state") {
        body.observation = {
          ...body.observation,
          observedAt: new Date().toISOString(),
          self: { ...body.observation.self, inWater: null, oxygen: 20 },
        };
      } else if (caseName === "different dimension") {
        body.observation = {
          ...body.observation,
          observedAt: new Date().toISOString(),
          dimension: "nether",
          self: {
            ...body.observation.self,
            position: {
              ...body.observation.self.position,
              dimension: "nether",
            },
          },
        };
      } else if (caseName === "vertical movement") {
        body.observation = {
          ...body.observation,
          observedAt: new Date().toISOString(),
          self: {
            ...body.observation.self,
            velocity: { ...body.observation.self.velocity, y: 0.051 },
          },
        };
      } else if (caseName === "nonpositive health") {
        body.observation = {
          ...body.observation,
          observedAt: new Date().toISOString(),
          self: { ...body.observation.self, health: 0 },
        };
      } else if (caseName === "low oxygen") {
        body.observation = {
          ...body.observation,
          observedAt: new Date().toISOString(),
          self: { ...body.observation.self, oxygen: 5 },
        };
      } else if (caseName === "unstable height") {
        body.observation = {
          ...body.observation,
          observedAt: new Date().toISOString(),
          self: {
            ...body.observation.self,
            position: {
              ...body.observation.self.position,
              y: body.observation.self.position.y + 0.11,
            },
          },
        };
      } else {
        body.observation = {
          ...body.observation,
          observedAt: new Date().toISOString(),
        };
      }
      await emitAndWaitForObservation(
        caseName === "different life"
          ? { type: "bot_death", at: new Date().toISOString() }
          : {
              type: "bot_damaged",
              at: new Date().toISOString(),
              source: null,
              confidence: "unknown",
            },
      );

      body.observation = {
        ...body.observation,
        observedAt: new Date().toISOString(),
        self: { ...body.observation.self, inWater: true, oxygen: 4 },
      };
      await emitAndWaitForObservation({
        type: "bot_damaged",
        at: new Date().toISOString(),
        source: null,
        confidence: "unknown",
      });

      expect(
        body.executed.filter(
          (operation) =>
            operation.kind === "control" && operation.controls.jump === true,
        ),
      ).toHaveLength(1);
      await runtime.shutdown();
    },
  );

  it("keeps owner stop immediate during bounded water recovery", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    body.observation = {
      ...body.observation,
      self: { ...body.observation.self, inWater: true, oxygen: 4 },
    };
    const agent = new FakeAgent([emptyDecision()]);
    let recoverySignal: AbortSignal | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      recoverySignal = signal;
      return await new Promise<PlayerOperationResult>((resolve) => {
        signal?.addEventListener(
          "abort",
          () =>
            resolve(
              fakeBody.result(
                operation,
                "recovery-stopped",
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
    await eventually(() => runtime.status().nextWakeAt !== null);
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(() => body.executed.length === 1);

    await runtime.stop("Builder");

    expect(recoverySignal?.aborted).toBe(true);
    expect(body.executed).toEqual([jump]);
    expect(runtime.status().stopped).toBe(true);
  });

  it("preserves queued damage context when an older reflex is superseded", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const move: Extract<PlayerOperation, { kind: "move_to" }> = {
      kind: "move_to",
      position: { x: 8, y: 64, z: 8 },
      range: 2,
    };
    const agent = new FakeAgent([makeDecision([move])]);
    let finishOldReflex: (() => void) | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      if (operation.kind === "move_to") {
        return await new Promise<PlayerOperationResult>((resolve) => {
          signal?.addEventListener(
            "abort",
            () =>
              resolve(
                fakeBody.result(
                  operation,
                  "move-interrupted",
                  "interrupted",
                  null,
                ),
              ),
            { once: true },
          );
        });
      }
      if (operation.kind === "look_sweep") {
        return await new Promise<PlayerOperationResult>((resolve) => {
          finishOldReflex = () =>
            resolve(
              fakeBody.result(
                operation,
                "old-reflex-interrupted",
                "interrupted",
                null,
              ),
            );
        });
      }
      return fakeBody.result(
        operation,
        "queued-water-recovery",
        "successful",
        fakeBody.observation,
      );
    };
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 1);
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(
      () => body.executed.length === 2 && finishOldReflex !== undefined,
    );

    body.emit({ type: "bot_death", at: new Date().toISOString() });
    body.observation = {
      ...body.observation,
      self: { ...body.observation.self, inWater: true, oxygen: 4 },
    };
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    finishOldReflex?.();

    await eventually(() => body.executed.length === 3);
    await eventually(
      () =>
        store.snapshot().lastOutcome?.operation.kind === "control" &&
        store.snapshot().lastOutcome?.status === "unverified",
    );
    expect(store.snapshot().lastOutcome?.summary).toContain(
      "water_recovery:unresolved",
    );
    const recalled = store.recall("水の中に行った理由は？", 7);

    expect(body.executed).toEqual([move, look, jump]);
    expect(
      recalled.some((memory) =>
        memory.content.includes(
          "plan.purpose=React once to damage using fresh Body-visible information.",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    { label: "oxygen unknown", inWater: true, oxygen: null },
    { label: "not in water", inWater: false, oxygen: 4 },
  ] as const)(
    "keeps the existing damage reflex when recovery evidence is incomplete ($label)",
    async ({ inWater, oxygen }) => {
      const { store } = freshStore();
      const body = new FakeBody(store);
      body.observation = {
        ...body.observation,
        self: { ...body.observation.self, inWater, oxygen },
      };
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

      expect(body.executed).toEqual([look]);
    },
  );

  it.each([
    { label: "unchanged water observation", afterWater: true },
    { label: "unknown post-recovery water state", afterWater: null },
  ] as const)(
    "reobserves after bounded jump and leaves $label unresolved",
    async ({ afterWater }) => {
      const { store } = freshStore();
      const body = new FakeBody(store);
      body.observation = {
        ...body.observation,
        self: { ...body.observation.self, inWater: true, oxygen: 4 },
      };
      body.executeHandler = async (operation, _signal, fakeBody) => {
        const before = fakeBody.observation;
        const after = {
          ...before,
          self: { ...before.self, inWater: afterWater },
        };
        return fakeBody.result(
          operation,
          "water-recovery-unresolved",
          "successful",
          after,
          before,
        );
      };
      const agent = new FakeAgent([emptyDecision(), emptyDecision()]);
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
        () => store.snapshot().lastOutcome?.operation.kind === "control",
      );
      await runtime.receiveChat("Builder", "状況を教えて");

      expect(agent.inputs).toHaveLength(2);
      expect(agent.inputs[1]?.observation.self).toMatchObject({
        inWater: true,
        oxygen: 4,
      });
      expect(body.executed).toEqual([jump]);
      expect(store.snapshot().lastOutcome?.status).toBe("unverified");
      expect(store.snapshot().lastOutcome?.summary).toContain(
        "water_recovery:unresolved",
      );
      expect(store.snapshot().lastOutcome?.expectedOutcome).toContain(
        "does not establish surfacing",
      );
      expect(store.snapshot().lastOutcome?.expectedOutcome).toContain(
        "continued water or low oxygen as unresolved",
      );
    },
  );

  it("keeps the failed target blocked after a transient dry frame and stable escape", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const target = 44;
    const collect: PlayerOperation = { kind: "collect_item", entityId: target };
    const otherTarget = 48;
    const goal = {
      title: "Collect the submerged item",
      successCondition: "Bring the item to safety.",
      source: "owner" as const,
    };
    const rewordedGoal = {
      title: "Gather the oak log",
      successCondition: "Add the oak log to inventory.",
      source: "self" as const,
    };
    body.observation = {
      ...body.observation,
      self: { ...body.observation.self, inWater: true, oxygen: 7 },
    };
    const initial = {
      ...makeDecision([collect]),
      goal,
      plan: {
        purpose: "Collect the requested item.",
        steps: [
          {
            operation: collect,
            expectedOutcome: "The observed item is collected.",
          },
        ],
      },
    };
    const agent = new FakeAgent([
      initial,
      { ...makeDecision([collect]), goal: rewordedGoal },
      { ...makeDecision([collect]), goal: rewordedGoal },
      ownerGoalDecision([collect], "Collect the submerged item again"),
    ]);
    let finishRecovery: (() => void) | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      const before = fakeBody.observation;
      if (operation.kind === "collect_item") {
        const count = fakeBody.executed.filter(
          (candidate) => candidate.kind === "collect_item",
        ).length;
        if (count > 1)
          return fakeBody.result(
            operation,
            `later-${fakeBody.executed.length}`,
            "successful",
            fakeBody.observation,
            before,
          );
        return await new Promise<PlayerOperationResult>((resolve) => {
          signal?.addEventListener(
            "abort",
            () =>
              resolve(
                fakeBody.result(
                  operation,
                  "water-collection-interrupted",
                  "interrupted",
                  fakeBody.observation,
                  before,
                ),
              ),
            { once: true },
          );
        });
      }
      if (operation.kind === "control")
        return await new Promise<PlayerOperationResult>((resolve) => {
          finishRecovery = () => {
            const after = {
              ...fakeBody.observation,
              observedAt: new Date().toISOString(),
              self: {
                ...fakeBody.observation.self,
                oxygen: 20,
                inWater: false,
              },
            };
            fakeBody.observation = after;
            resolve(
              fakeBody.result(
                operation,
                "water-recovery-progress",
                "successful",
                after,
                before,
              ),
            );
          };
        });
      return fakeBody.result(
        operation,
        `later-${fakeBody.executed.length}`,
        "successful",
        fakeBody.observation,
        fakeBody.observation,
      );
    };
    const runtime = createRuntime(store, body, agent, undefined, 10_000);

    await runtime.start();
    await eventually(() => body.executed.length === 1);
    body.observation = {
      ...body.observation,
      self: { ...body.observation.self, inWater: true, oxygen: 4 },
    };
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "vitals",
    });
    await eventually(() => body.executed.length === 2);
    await eventually(
      () => store.snapshot().lastOutcome?.operation.kind === "collect_item",
    );
    expect(store.snapshot().lastOutcome?.status).toBe("interrupted");
    expect(store.snapshot().lastOutcome?.summary).toContain(
      "water_recovery:acquisition_interrupted; trigger=inWater:true,oxygen:4",
    );
    expect(body.executed[1]).toEqual(jump);

    finishRecovery?.();
    await eventually(
      () =>
        store.snapshot().lastOutcome?.operation.kind === "control" &&
        store
          .snapshot()
          .lastOutcome?.summary.includes("water_recovery:dry_observed") ===
          true,
    );
    expect(store.snapshot().lastOutcome?.status).toBe("unverified");
    expect(store.snapshot().lastOutcome?.summary).toContain(
      "stable escape remains unconfirmed",
    );

    const sameTarget = droppedItemEntity(target, 1, "oak_log");
    body.observation = {
      ...body.observation,
      observedAt: new Date().toISOString(),
      self: { ...body.observation.self, inWater: true, oxygen: 20 },
      perception: {
        ...body.observation.perception,
        entities: [sameTarget],
        nearbyDroppedItems: makeNearbyDroppedItems([sameTarget]),
      },
    };
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "entities",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await eventually(() => agent.inputs.length >= 2);
    expect(agent.inputs[1]?.observation.self).toMatchObject({
      inWater: true,
      oxygen: 20,
    });
    expect(store.snapshot().goal).toEqual(rewordedGoal);
    expect(body.executed).toHaveLength(2);

    body.observation = {
      ...body.observation,
      observedAt: new Date().toISOString(),
      self: { ...body.observation.self, inWater: false, oxygen: 20 },
    };
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "position",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    await eventually(() => agent.inputs.length >= 3);
    expect(body.executed).toHaveLength(2);

    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const safeOtherTarget = droppedItemEntity(otherTarget, 2, "birch_log");
    body.observation = {
      ...body.observation,
      observedAt: new Date().toISOString(),
      perception: {
        ...body.observation.perception,
        entities: [sameTarget, safeOtherTarget],
        nearbyDroppedItems: makeNearbyDroppedItems([
          sameTarget,
          safeOtherTarget,
        ]),
      },
    };
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "entities",
    });
    await eventually(() => body.executed.length === 3);
    expect(body.executed[2]).toMatchObject({
      kind: "collect_item",
      entityId: otherTarget,
    });

    await eventually(() => !runtime.status().thinking);
    await runtime.receiveChat("Builder", "同じアイテムも回収して");
    await eventually(() => body.executed.length === 4);
    expect(body.executed[3]).toMatchObject({
      kind: "collect_item",
      entityId: target,
    });
    await eventually(() => {
      const outcome = store.snapshot().lastOutcome;
      return (
        outcome?.operation.kind === "collect_item" &&
        outcome.operation.entityId === target &&
        outcome.status === "successful"
      );
    });

    body.observation = {
      ...body.observation,
      observedAt: new Date().toISOString(),
      self: { ...body.observation.self, inWater: true, oxygen: 4 },
    };
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(
      () =>
        body.executed.filter(
          (operation) =>
            operation.kind === "control" && operation.controls.jump === true,
        ).length === 2,
    );
    finishRecovery?.();
    await eventually(() => {
      const outcome = store.snapshot().lastOutcome;
      return (
        outcome?.operation.kind === "control" &&
        outcome.summary.includes("water_recovery:dry_observed")
      );
    });
    await eventually(() => !runtime.status().thinking);
  });

  it("lets owner stop supersede a pending low-oxygen collection observation", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const collect: PlayerOperation = { kind: "collect_item", entityId: 45 };
    const agent = new FakeAgent([makeDecision([collect])]);
    let holdObservation = false;
    let releaseObservation: (() => void) | undefined;
    body.observeHandler = async () => {
      if (!holdObservation) return;
      await new Promise<void>((resolve) => {
        releaseObservation = resolve;
      });
    };
    body.executeHandler = async (operation, signal, fakeBody) =>
      await new Promise<PlayerOperationResult>((resolve) => {
        signal?.addEventListener(
          "abort",
          () =>
            resolve(
              fakeBody.result(
                operation,
                "owner-stopped-collection",
                "interrupted",
                null,
              ),
            ),
          { once: true },
        );
      });
    const runtime = createRuntime(store, body, agent);

    await runtime.start();
    await eventually(() => body.executed.length === 1);
    holdObservation = true;
    body.observation = {
      ...body.observation,
      self: { ...body.observation.self, inWater: true, oxygen: 4 },
    };
    body.emit({
      type: "state_changed",
      at: new Date().toISOString(),
      reason: "vitals",
    });
    await eventually(() => body.observeCalls >= 2);

    await runtime.stop("Builder");
    releaseObservation?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.status().stopped).toBe(true);
    expect(body.executed).toHaveLength(1);
    await runtime.shutdown();
  });

  it.each([
    { label: "water state unknown", inWater: null, oxygen: 4 },
    { label: "oxygen unknown", inWater: true, oxygen: null },
  ] as const)(
    "does not interrupt collection for incomplete water evidence ($label)",
    async ({ inWater, oxygen }) => {
      const { store } = freshStore();
      const body = new FakeBody(store);
      const agent = new FakeAgent([
        makeDecision([{ kind: "collect_item", entityId: 46 }]),
      ]);
      let collectSignal: AbortSignal | undefined;
      body.executeHandler = async (operation, signal, fakeBody) =>
        await new Promise<PlayerOperationResult>((resolve) => {
          collectSignal = signal;
          signal?.addEventListener(
            "abort",
            () =>
              resolve(
                fakeBody.result(
                  operation,
                  "incomplete-water-evidence",
                  "interrupted",
                  null,
                ),
              ),
            { once: true },
          );
        });
      const runtime = createRuntime(store, body, agent);

      await runtime.start();
      await eventually(() => body.executed.length === 1);
      body.observation = {
        ...body.observation,
        self: { ...body.observation.self, inWater, oxygen },
      };
      body.emit({
        type: "state_changed",
        at: new Date().toISOString(),
        reason: "vitals",
      });
      await eventually(() => body.observeCalls >= 2);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(collectSignal?.aborted).toBe(false);
      expect(body.executed).toHaveLength(1);
      await runtime.stop("Builder");
      expect(runtime.status().stopped).toBe(true);
    },
  );

  it("attacks one nearby unoccluded hostile from a fresh observation when damage source is unknown", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const owner = {
      ...visibleEntity(16, 1),
      name: "Builder",
      kind: "player",
      username: "Builder",
      isPlayer: true,
    };
    const nearest = hostileEntity(17, 2);
    const farther = hostileEntity(18, 3);
    body.observation = makeObservation({
      entities: [owner, nearest, farther],
      nearbyHostiles: makeNearbyHostiles([owner, nearest, farther]),
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

  it("equips the ranked owned weapon before retaliation and passes the observed hand to the next provider input", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const heldTool = gearItem("diamond_pickaxe", 36);
    const weapon = gearItem("iron_sword", 9);
    const target = hostileEntity(17, 2);
    body.observation = makeObservation({
      inventory: [weapon, heldTool],
      equipment: { ...body.observation.self.equipment, hand: heldTool },
      entities: [],
      nearbyHostiles: makeNearbyHostiles([target]),
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      if (operation.kind !== "equip")
        return fakeBody.result(
          operation,
          "retaliation-attack",
          "successful",
          fakeBody.observation,
        );
      const before = fakeBody.observation;
      const after = {
        ...before,
        self: {
          ...before.self,
          equipment: { ...before.self.equipment, hand: weapon },
        },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "retaliation-equip",
        "successful",
        after,
        before,
      );
    };
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
      { kind: "equip", item: "iron_sword", destination: "hand" },
      { kind: "attack", entityId: target.id },
    ]);
    expect(body.results[0]?.after?.self.equipment.hand?.name).toBe(
      "iron_sword",
    );
    expect(body.results[1]?.before?.self.equipment.hand?.name).toBe(
      "iron_sword",
    );
    expect(agent.inputs).toHaveLength(1);

    await runtime.receiveChat("Builder", "いま何を持っている？");

    expect(agent.inputs).toHaveLength(2);
    expect(agent.inputs[1]?.observation.self.equipment.hand?.name).toBe(
      "iron_sword",
    );
  });

  it("attacks directly when the best weapon is already held or no weapon is owned", async () => {
    for (const inventoryCase of ["best-held", "none"] as const) {
      const { store } = freshStore();
      const body = new FakeBody(store);
      const target = hostileEntity(17, 2);
      const heldWeapon = gearItem("netherite_sword", 36);
      body.observation = makeObservation({
        inventory:
          inventoryCase === "best-held"
            ? [heldWeapon, gearItem("iron_sword", 9)]
            : [gearItem("apple", 9)],
        equipment: {
          ...body.observation.self.equipment,
          hand: inventoryCase === "best-held" ? heldWeapon : null,
        },
        entities: [target],
        nearbyHostiles: makeNearbyHostiles([target]),
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

      expect(body.executed).toEqual(
        inventoryCase === "best-held"
          ? [{ kind: "attack", entityId: target.id }]
          : [{ kind: "look_sweep" }, { kind: "attack", entityId: target.id }],
      );
      expect(agent.inputs).toHaveLength(1);
    }
  });

  it("equips an owned enchanted sword through the bounded fallback before retaliation", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const heldTool = gearItem("stick", 36);
    const enchantedWeapon = {
      ...gearItem("diamond_sword", 9),
      enchantments: [{ name: "sharpness", level: 2 }],
    };
    const target = hostileEntity(17, 2);
    body.observation = makeObservation({
      inventory: [enchantedWeapon, heldTool],
      equipment: { ...body.observation.self.equipment, hand: heldTool },
      entities: [],
      nearbyHostiles: makeNearbyHostiles([target]),
    });
    body.executeHandler = async (operation, _signal, fakeBody) => {
      if (operation.kind !== "equip")
        return fakeBody.result(
          operation,
          "enchanted-retaliation-attack",
          "successful",
          fakeBody.observation,
        );
      const before = fakeBody.observation;
      const after = {
        ...before,
        self: {
          ...before.self,
          equipment: {
            ...before.self.equipment,
            hand: enchantedWeapon,
          },
        },
      };
      fakeBody.observation = after;
      return fakeBody.result(
        operation,
        "enchanted-retaliation-equip",
        "successful",
        after,
        before,
      );
    };
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
      { kind: "equip", item: "diamond_sword", destination: "hand" },
      { kind: "attack", entityId: target.id },
    ]);
    expect(body.results[0]?.after?.self.equipment.hand?.enchantments).toEqual([
      { name: "sharpness", level: 2 },
    ]);
    expect(agent.inputs).toHaveLength(1);
  });

  it("keeps the owner stop authoritative while retaliation weapon equip is in flight", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const heldTool = gearItem("diamond_pickaxe", 36);
    const weapon = gearItem("iron_sword", 9);
    const target = hostileEntity(17, 2);
    body.observation = makeObservation({
      inventory: [weapon, heldTool],
      equipment: { ...body.observation.self.equipment, hand: heldTool },
      entities: [],
      nearbyHostiles: makeNearbyHostiles([target]),
    });
    const agent = new FakeAgent([emptyDecision()]);
    let equipSignal: AbortSignal | undefined;
    body.executeHandler = async (operation, signal, fakeBody) => {
      equipSignal = signal;
      return await new Promise<PlayerOperationResult>((resolve) => {
        const finish = (): void =>
          resolve(
            fakeBody.result(
              operation,
              "retaliation-equip-stopped",
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
    await eventually(() => runtime.status().nextWakeAt !== null);
    body.emit({
      type: "bot_damaged",
      at: new Date().toISOString(),
      source: null,
      confidence: "unknown",
    });
    await eventually(() => body.executed.length === 1);
    await runtime.stop("Builder");

    expect(equipSignal?.aborted).toBe(true);
    expect(store.snapshot().stopped).toBe(true);
    expect(body.executed).toEqual([
      { kind: "equip", item: "iron_sword", destination: "hand" },
    ]);
    expect(agent.inputs).toHaveLength(1);
  });

  it("does not attack after weapon equip fails or the hostile is no longer attackable", async () => {
    for (const outcome of [
      "failed",
      "target-disappeared",
      "target-occluded",
      "target-far",
    ] as const) {
      const { store } = freshStore();
      const body = new FakeBody(store);
      const heldTool = gearItem("diamond_pickaxe", 36);
      const weapon = gearItem("iron_sword", 9);
      const target = hostileEntity(17, 2);
      body.observation = makeObservation({
        inventory: [weapon, heldTool],
        equipment: { ...body.observation.self.equipment, hand: heldTool },
        entities: [],
        nearbyHostiles: makeNearbyHostiles([target]),
      });
      body.executeHandler = async (operation, _signal, fakeBody) => {
        if (operation.kind !== "equip")
          return fakeBody.result(
            operation,
            "retaliation-attack",
            "successful",
            fakeBody.observation,
          );
        if (outcome === "failed")
          return fakeBody.result(
            operation,
            "retaliation-equip",
            "failed",
            null,
          );
        const updatedTarget = hostileEntity(
          target.id,
          outcome === "target-far" ? 4 : 2,
        );
        const after = makeObservation({
          inventory: [weapon, heldTool],
          equipment: {
            ...fakeBody.observation.self.equipment,
            hand: weapon,
          },
          entities: outcome === "target-disappeared" ? [] : [updatedTarget],
          nearbyHostiles:
            outcome === "target-disappeared"
              ? makeNearbyHostiles([])
              : outcome === "target-occluded"
                ? makeNearbyHostiles([], 1)
                : makeNearbyHostiles([updatedTarget]),
        });
        fakeBody.observation = after;
        return fakeBody.result(
          operation,
          "retaliation-equip",
          "successful",
          after,
        );
      };
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
      await eventually(() => body.executed.length === 1);
      if (outcome !== "failed")
        await eventually(() => runtime.status().nextWakeAt !== null);

      expect(body.executed).toEqual([
        { kind: "equip", item: "iron_sword", destination: "hand" },
      ]);
      expect(agent.inputs).toHaveLength(1);
      expect(store.snapshot().lastOutcome?.operation.kind).toBe("equip");
    }
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
    const agent = new FakeAgent([
      emptyDecision(),
      interleavedReplyDecision(null, "update_goal"),
      ownerGoalDecision([], "敵から離れる"),
    ]);
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
    await runtime.receiveChat("Builder", "この敵から離れて");

    expect(attackSignal?.aborted).toBe(true);
    expect(agent.inputs).toHaveLength(3);
    expect(agent.inputs[1]?.ownerMessage).toBe("この敵から離れて");
    expect(agent.inputs[2]?.ownerMessage).toBe("この敵から離れて");
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
    const agent = new FakeAgent([
      emptyDecision(),
      interleavedReplyDecision(null, "update_goal"),
      ownerGoalDecision([], "危険から離れる"),
    ]);
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
    await runtime.receiveChat("Builder", "危険から離れて");

    expect(reflexSignal?.aborted).toBe(true);
    expect(agent.inputs).toHaveLength(3);
    expect(agent.inputs[1]?.ownerMessage).toBe("危険から離れて");
    expect(agent.inputs[2]?.ownerMessage).toBe("危険から離れて");
    expect(store.snapshot().lastOutcome?.status).toBe("interrupted");
    expect(body.executed).toHaveLength(1);
  });
});

describe("owner stop command", () => {
  it("matches only the complete unmodified stop token", () => {
    expect(isImmediateStopCommand("緊急停止命令")).toBe(true);
    expect(isImmediateStopCommand(" 緊急停止命令 ")).toBe(false);
    expect(isImmediateStopCommand("『緊急停止命令』")).toBe(false);
    expect(isImmediateStopCommand("緊急停止命令！")).toBe(false);
    expect(isImmediateStopCommand("緊急停止命令の意味は？")).toBe(false);
    expect(isImmediateStopCommand("通常会話のあとに止まって")).toBe(false);
  });

  it("checks raw owner input before trimming or truncation", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const agent = new FakeAgent([]);
    const runtime = createRuntime(store, body, agent);
    const stopToken = "緊急停止命令";
    const longPrefix = `${stopToken}${" ".repeat(2_000 - stopToken.length)}x`;
    const ordinaryMessages = [
      ` ${stopToken} `,
      `『${stopToken}』`,
      `${stopToken}！`,
      `${stopToken}の意味は？`,
      longPrefix,
    ];

    await runtime.receiveChat("Impostor", stopToken);
    expect(runtime.status().stopped).toBe(false);
    expect(agent.inputs).toHaveLength(0);

    for (const message of ordinaryMessages) {
      await runtime.receiveChat("Builder", message);
      expect(runtime.status().stopped).toBe(false);
      expect(body.executed).toHaveLength(0);
      expect(agent.inputs.at(-1)?.ownerMessage).toBe(
        message.trim().slice(0, 2_000),
      );
    }
    expect(agent.inputs).toHaveLength(ordinaryMessages.length);

    await runtime.receiveChat("Builder", stopToken);
    expect(runtime.status().stopped).toBe(true);
    expect(agent.inputs).toHaveLength(ordinaryMessages.length);
    expect(
      store
        .recentMessages(100)
        .filter((entry) => entry.role === "owner")
        .at(-1)?.text,
    ).toBe(stopToken);
  });

  it("stores ordinary owner chat while stopped and wakes only for authenticated resume forms", async () => {
    const { store } = freshStore();
    const body = new FakeBody(store);
    const say = vi.fn(async () => undefined);
    const agent = new FakeAgent([
      companionDecisionSchema.parse({
        ...emptyDecision(),
        speech: "自律を再開したよ。",
      }),
      companionDecisionSchema.parse({
        ...emptyDecision(),
        speech: "自律を再開したよ。",
      }),
    ]);
    const runtime = createRuntime(store, body, agent, say);

    await runtime.receiveChat("Builder", "緊急停止命令");
    expect(runtime.status().stopped).toBe(true);
    expect(agent.inputs).toHaveLength(0);

    await runtime.receiveChat("Builder", "停止中に保存する通常メッセージ");
    expect(store.recentMessages(100).at(-1)).toMatchObject({
      role: "owner",
      text: "停止中に保存する通常メッセージ",
    });
    expect(agent.inputs).toHaveLength(0);
    expect(body.executed).toHaveLength(0);

    await runtime.receiveChat("Impostor", "再開しろ");
    expect(runtime.status().stopped).toBe(true);
    expect(agent.inputs).toHaveLength(0);

    await runtime.receiveChat("Builder", "再開しろ");
    expect(runtime.status().running).toBe(true);
    expect(agent.inputs[0]?.ownerMessage).toBe("再開しろ");
    expect(say).toHaveBeenCalledWith("自律を再開したよ。");
    expect(body.executed).toHaveLength(0);

    await runtime.receiveChat("Builder", "緊急停止命令");
    expect(runtime.status().stopped).toBe(true);
    await runtime.receiveChat("Builder", "再開して");
    expect(runtime.status().running).toBe(true);
    expect(agent.inputs[1]?.ownerMessage).toBe("再開して");
    expect(say).toHaveBeenCalledTimes(4);
    expect(body.executed).toHaveLength(0);
  });
});
