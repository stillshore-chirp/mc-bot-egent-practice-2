import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import type { Window } from "prismarine-windows";
import { AppError } from "../../src/domain/errors.js";
import { MineflayerClient } from "../../src/minecraft/mineflayer-client.js";
import {
  MineflayerPlayerBody,
  playerOperationNames,
  playerOperationDescriptions,
  playerOperationSchema,
  type PlayerBodyEvent,
  type PlayerOperationResult,
} from "../../src/minecraft/player-body.js";
import { observePlayerBody } from "../../src/minecraft/player-body-observation.js";

interface FakeBlock {
  name: string;
  type: number;
  stateId: number;
  position: Vec3;
  boundingBox: string;
  getProperties(): Record<string, unknown>;
  getSignText(): [string, string?];
}

function makeBlock(name: string, stateId: number, position: Vec3): FakeBlock {
  return {
    name,
    type: stateId,
    stateId,
    position,
    boundingBox: name === "air" ? "empty" : "block",
    getProperties: () => ({}),
    getSignText: () => [""],
  };
}

function pathUpdateListenerCount(bot: Bot): number {
  return (bot as unknown as EventEmitter).listenerCount("path_update");
}

function addItemEntity(
  bot: Bot,
  id = 2,
  position = new Vec3(0, 64, -5),
  droppedItem: { readonly name: string; readonly count: number } | null = {
    name: "emerald",
    count: 1,
  },
): Entity {
  const item = {
    id,
    name: "item",
    type: "other",
    position,
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    height: 0.25,
    metadata: [],
    getDroppedItem: () => droppedItem,
  } as unknown as Entity;
  (bot.entities as Record<number, Entity>)[id] = item;
  return item;
}

function removeItemEntity(bot: Bot, id: number): void {
  Reflect.deleteProperty(bot.entities, id);
}

function addItemToInventory(
  fake: ReturnType<typeof makeFakeBot>,
  name: string,
  count: number,
): void {
  const inventory = fake.inventory as EventEmitter & {
    slots: (Record<string, unknown> | null)[];
  };
  const existingIndex = inventory.slots.findIndex(
    (item) => item?.name === name,
  );
  const slot =
    existingIndex >= 0
      ? existingIndex
      : inventory.slots.findIndex(
          (item, index) => index >= 9 && index <= 44 && item === null,
        );
  if (slot < 0) return;
  const previous = inventory.slots[slot] ?? null;
  const next = {
    type: 1,
    name,
    count: Number(previous?.count ?? 0) + count,
    metadata: 0,
    durabilityUsed: null,
    maxDurability: null,
    customName: null,
    enchants: [],
    nbt: null,
  };
  inventory.slots[slot] = next;
  inventory.emit("updateSlot", slot, previous, next);
}

function installFakeArmorEquip(fake: ReturnType<typeof makeFakeBot>) {
  const inventory = fake.inventory as EventEmitter & {
    slots: (Record<string, unknown> | null)[];
  };
  const equip = vi.fn(async (item: Item, destination: string) => {
    const slot = fake.bot.getEquipmentDestSlot(destination);
    const previous = inventory.slots[slot] ?? null;
    inventory.slots[slot] = item as unknown as Record<string, unknown>;
    inventory.emit("updateSlot", slot, previous, item);
  });
  Object.assign(fake.bot, { equip });
  return equip;
}

function emitItemPickup(
  fake: ReturnType<typeof makeFakeBot>,
  collected: Entity,
  updateInventory = true,
): void {
  (fake.bot as unknown as EventEmitter).emit(
    "playerCollect",
    fake.bot.entity,
    collected,
  );
  if (!updateInventory) return;
  const item = collected.getDroppedItem();
  if (item !== null) addItemToInventory(fake, item.name, item.count);
}

function makeWindow(id = 3): Window & EventEmitter {
  const window = new EventEmitter() as Window & EventEmitter;
  Object.assign(window, {
    id,
    type: "minecraft:brewing_stand",
    title: "Brewing Stand",
    inventoryStart: 5,
    inventoryEnd: 41,
    selectedItem: null,
    slots: Array.from({ length: 41 }, () => null),
  });
  return window;
}

function makeFakeBot(
  options: {
    deferInventory?: boolean;
    deferWindowOpen?: boolean;
  } = {},
): {
  bot: Bot;
  inventory: EventEmitter;
  initializeInventory(): void;
  blocks: Map<string, FakeBlock>;
  candidates: Vec3[];
  hiddenBlockKeys: Set<string>;
  findBlockSearches: { count: number; resultCount: number }[];
  setCrosshairRaycastResult(result: unknown): void;
  setPlacementRaycastBlocker(targetPosition: Vec3, blockerPosition: Vec3): void;
  setWindow(window: Window): void;
  emitWindowOpen(): void;
  resumeWindowOpen(): void;
} {
  const botEvents = new EventEmitter();
  const client = new EventEmitter() as EventEmitter & {
    write: (event: string, packet: unknown) => void;
  };
  const blocks = new Map<string, FakeBlock>();
  const candidates: Vec3[] = [];
  const hiddenBlockKeys = new Set<string>();
  const findBlockSearches: { count: number; resultCount: number }[] = [];
  let crosshairRaycastResult: unknown = null;
  let placementRaycastBlocker:
    { targetPosition: Vec3; block: FakeBlock } | undefined;
  let pendingWindow: (Window & EventEmitter) | undefined;
  let deferWindowOpen = options.deferWindowOpen === true;
  const key = (position: Vec3): string =>
    `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
  const inventorySlots: (Record<string, unknown> | null)[] = Array.from(
    { length: 46 },
    () => null,
  );
  const inventory = new EventEmitter() as EventEmitter & {
    slots: (Record<string, unknown> | null)[];
    items: () => Record<string, unknown>[];
  };
  Object.assign(inventory, {
    slots: inventorySlots,
    items: () =>
      inventorySlots.filter(
        (item): item is Record<string, unknown> => item !== null,
      ),
  });
  const entity = {
    id: 1,
    name: "player",
    type: "player",
    position: new Vec3(0, 64, 0),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    height: 1.8,
    eyeHeight: 1.62,
  };
  const airAt = (position: Vec3): FakeBlock =>
    makeBlock("air", 0, position.floored());
  const bot = Object.assign(botEvents, {
    username: "bot",
    version: "1.21.4",
    entity,
    entities: { 1: entity },
    players: {},
    game: { dimension: "overworld", gameMode: "survival" },
    time: { day: 1, timeOfDay: 5_000, isDay: true },
    isRaining: false,
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    isSleeping: false,
    experience: { level: 0, points: 0, progress: 0 },
    inventory,
    quickBarSlot: 0,
    currentWindow: null as (Window & EventEmitter) | null,
    _client: client,
    registry: {
      blocksByStateId: {
        0: { name: "air" },
        1: { name: "stone" },
        2: { name: "brewing_stand" },
      },
      blocksByName: {
        stone: { id: 1, name: "stone" },
        brewing_stand: { id: 2, name: "brewing_stand" },
      },
      items: {},
      itemsByName: {},
      itemsArray: [],
      blocksArray: [],
      entitiesArray: [],
      entitiesByName: {},
      enchantmentsArray: [],
      enchantmentsByName: {},
      foodsByName: {},
      particlesByName: {},
    },
    world: {
      raycast: (
        origin: Vec3,
        direction: Vec3,
        range: number,
        matching?: (block: FakeBlock) => boolean,
      ) => {
        if (placementRaycastBlocker !== undefined) {
          const targetCenter = placementRaycastBlocker.targetPosition.offset(
            0.5,
            0.5,
            0.5,
          );
          const targetOffset = targetCenter.minus(origin);
          const targetDistance = targetOffset.norm();
          const targetDirection = targetOffset.scaled(1 / targetDistance);
          if (direction.minus(targetDirection).norm() < 0.001) {
            const blockerCenter = placementRaycastBlocker.block.position.offset(
              0.5,
              0.5,
              0.5,
            );
            const blockerOffset = blockerCenter.minus(origin);
            const blockerDistance = blockerOffset.dot(direction);
            const lateralDistance = blockerOffset
              .minus(direction.scaled(blockerDistance))
              .norm();
            if (
              blockerDistance > 0 &&
              blockerDistance < range &&
              lateralDistance < 0.75 &&
              (matching === undefined ||
                matching(placementRaycastBlocker.block))
            )
              return placementRaycastBlocker.block;
          }
        }
        if (matching === undefined) return crosshairRaycastResult;
        return direction.x > 0.2
          ? makeBlock("stone", 1, new Vec3(1, 64, -2))
          : null;
      },
    },
    pathfinder: {
      goto: vi.fn(async () => undefined),
      setGoal: vi.fn(),
    },
    supportFeature: (feature: string) => feature === "blockPlaceHasInsideBlock",
    findBlocks: ({
      matching,
      maxDistance = Number.POSITIVE_INFINITY,
      count = Number.POSITIVE_INFINITY,
      point = entity.position,
    }: {
      matching: (block: FakeBlock) => boolean;
      maxDistance?: number;
      count?: number;
      point?: Vec3;
    }) => {
      const results = candidates
        .filter(
          (candidate) =>
            point.distanceTo(candidate) <= maxDistance &&
            matching(blocks.get(key(candidate)) ?? airAt(candidate)),
        )
        .slice(0, count);
      findBlockSearches.push({ count, resultCount: results.length });
      return results;
    },
    findBlock: () => null,
    blockAt: (point: Vec3) => blocks.get(key(point)) ?? airAt(point),
    canSeeBlock: (block: FakeBlock) =>
      !hiddenBlockKeys.has(key(block.position)),
    getEquipmentDestSlot: (destination: string) =>
      ({
        hand: 36,
        "off-hand": 45,
        head: 5,
        torso: 6,
        legs: 7,
        feet: 8,
      })[destination] ?? 36,
    lookAt: vi.fn(async (point: Vec3) => {
      const delta = point.minus(entity.position.offset(0, 1.62, 0));
      entity.yaw = Math.atan2(-delta.x, -delta.z);
      entity.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
      setTimeout(() => bot.emit("physicsTick"), 0);
    }),
    clearControlStates: vi.fn(),
    deactivateItem: vi.fn(),
    stopDigging: vi.fn(),
    moveVehicle: vi.fn(),
    activateItem: vi.fn(),
    attack: vi.fn(),
    heldItem: null,
    swingArm: vi.fn(),
    closeWindow: vi.fn(async (window: Window) => {
      if (bot.currentWindow === window) bot.currentWindow = null;
    }),
    dig: vi.fn(async () => undefined),
    clickWindow: vi.fn(async () => undefined),
    recipesAll: () => [],
    recipesFor: () => [],
    isABed: () => false,
  });
  if (options.deferInventory === true) {
    Object.defineProperty(bot, "inventory", {
      configurable: true,
      value: undefined,
      writable: true,
    });
  }
  client.write = (event, packet) => {
    if (event !== "block_place" && event !== "use_entity") return;
    if (event === "block_place") {
      const location = (packet as { location?: Vec3 }).location;
      if (location === undefined) return;
    }
    const window = pendingWindow;
    if (window !== undefined && !deferWindowOpen) {
      bot.currentWindow = window;
      pendingWindow = undefined;
      queueMicrotask(() => bot.emit("windowOpen", window));
    }
  };
  return {
    bot: bot as unknown as Bot,
    inventory,
    initializeInventory: () => {
      Object.defineProperty(bot, "inventory", {
        configurable: true,
        value: inventory,
        writable: true,
      });
    },
    blocks,
    candidates,
    hiddenBlockKeys,
    findBlockSearches,
    setCrosshairRaycastResult: (result) => {
      crosshairRaycastResult = result;
    },
    setPlacementRaycastBlocker: (targetPosition, blockerPosition) => {
      const block =
        blocks.get(key(blockerPosition)) ??
        makeBlock("stone", 1, blockerPosition.floored());
      placementRaycastBlocker = { targetPosition, block };
    },
    setWindow: (window) => {
      pendingWindow = window as Window & EventEmitter;
    },
    emitWindowOpen: () => {
      const window = pendingWindow;
      if (window === undefined) throw new Error("No pending window");
      pendingWindow = undefined;
      bot.currentWindow = window;
      bot.emit("windowOpen", window);
    },
    resumeWindowOpen: () => {
      deferWindowOpen = false;
    },
  };
}

function addOffAxisStoneCandidates(
  fake: ReturnType<typeof makeFakeBot>,
  count: number,
): void {
  let added = 0;
  for (let z = -5; z >= -14 && added < count; z -= 1) {
    for (let x = -5; x <= 5 && added < count; x += 1) {
      if (Math.abs(x) < 2) continue;
      for (let y = 63; y <= 65 && added < count; y += 1) {
        const point = new Vec3(x, y, z);
        fake.blocks.set(`${x},${y},${z}`, makeBlock("stone", 1, point));
        fake.candidates.push(point);
        added += 1;
      }
    }
  }
  if (added !== count)
    throw new Error(`Only added ${added} of ${count} stone candidates`);
}

function registerFakeZombie(fake: ReturnType<typeof makeFakeBot>): void {
  Object.assign(fake.bot.registry.entitiesByName, {
    zombie: {
      name: "zombie",
      displayName: "Zombie",
      type: "hostile",
      category: "Hostile mobs",
    },
  });
}

function addFakeZombieEntity(
  fake: ReturnType<typeof makeFakeBot>,
  id = 2,
): Entity {
  const zombie = {
    id,
    name: "zombie",
    type: "mob",
    position: new Vec3(0, 64, -2),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    height: 1.95,
    metadata: [],
  } as unknown as Entity;
  (fake.bot.entities as Record<number, Entity>)[id] = zombie;
  return zombie;
}

function addWallWithOpening(fake: ReturnType<typeof makeFakeBot>): Vec3 {
  for (let x = -1; x <= 1; x += 1) {
    for (let y = 64; y <= 66; y += 1) {
      if (x === 0 && y === 65) continue;
      const position = new Vec3(x, y, -4);
      fake.blocks.set(`${x},${y},-4`, makeBlock("oak_planks", 4, position));
      fake.candidates.push(position);
    }
  }
  return new Vec3(0, 65, -4);
}

function beginPendingDig(
  fake: ReturnType<typeof makeFakeBot>,
  estimateMs: number,
  signal?: AbortSignal,
): {
  started: Promise<void>;
  result: Promise<PlayerOperationResult>;
  resolveNative(): void;
  sendServerAirUpdate(): void;
  completeWithServerUpdate(): void;
} {
  const target = new Vec3(0, 64, -2);
  const key = "0,64,-2";
  fake.blocks.set(key, makeBlock("stone", 1, target));
  fake.candidates.push(target);
  Object.assign(fake.bot, { digTime: vi.fn(() => estimateMs) });

  let markStarted!: () => void;
  let resolveDig!: () => void;
  let rejectDig!: (error: Error) => void;
  let actionSettled = false;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const action = new Promise<void>((resolve, reject) => {
    resolveDig = resolve;
    rejectDig = reject;
  });
  vi.mocked(fake.bot.dig).mockImplementationOnce(() => {
    markStarted();
    return action;
  });
  vi.mocked(fake.bot.stopDigging).mockImplementation(() => {
    if (actionSettled) return;
    actionSettled = true;
    rejectDig(new Error("Digging stopped"));
  });

  const body = new MineflayerPlayerBody(() => fake.bot);
  const result = body.execute(
    { kind: "dig", position: { x: 0, y: 64, z: -2 } },
    signal,
  );
  return {
    started,
    result,
    resolveNative: () => {
      if (actionSettled) return;
      fake.blocks.set(key, makeBlock("air", 0, target));
      actionSettled = true;
      resolveDig();
    },
    sendServerAirUpdate: () => {
      fake.blocks.set(key, makeBlock("air", 0, target));
      (fake.bot._client as unknown as EventEmitter).emit("block_change", {
        location: { x: 0, y: 64, z: -2 },
        type: 0,
      });
    },
    completeWithServerUpdate: () => {
      if (!actionSettled) {
        fake.blocks.set(key, makeBlock("air", 0, target));
        (fake.bot._client as unknown as EventEmitter).emit("block_change", {
          location: { x: 0, y: 64, z: -2 },
          type: 0,
        });
        actionSettled = true;
        resolveDig();
      }
    },
  };
}

function preparePlaceFixture(fake: ReturnType<typeof makeFakeBot>): Vec3 {
  const target = new Vec3(0, 64, -2);
  const support = new Vec3(0, 64, -3);
  const supportBlock = makeBlock("stone", 1, support);
  fake.blocks.set("0,64,-3", supportBlock);
  fake.candidates.push(support);
  fake.setCrosshairRaycastResult(supportBlock);
  const inventory = fake.bot.inventory as unknown as {
    slots: (Record<string, unknown> | null)[];
  };
  inventory.slots[36] = {
    type: 4,
    name: "oak_planks",
    count: 1,
    metadata: 0,
    enchants: [],
    nbt: null,
  };
  const registry = fake.bot.registry as unknown as {
    blocksByStateId: Record<number, { name: string }>;
    blocksByName: Record<string, { id: number; name: string }>;
  };
  registry.blocksByStateId[4] = { name: "oak_planks" };
  registry.blocksByName.oak_planks = { id: 4, name: "oak_planks" };
  Object.assign(fake.bot, { equip: vi.fn(async () => undefined) });
  return target;
}

function prepareConsumeFixture(
  fake: ReturnType<typeof makeFakeBot>,
  food = 19,
  itemName = "bread",
): Record<string, unknown> {
  const bread = {
    type: 5,
    name: itemName,
    count: 1,
    metadata: 0,
    durabilityUsed: null,
    maxDurability: null,
    customName: null,
    enchants: [],
    nbt: null,
  };
  const inventory = fake.bot.inventory as unknown as {
    slots: (Record<string, unknown> | null)[];
  };
  inventory.slots[36] = bread;
  fake.bot.food = food;
  const registry = fake.bot.registry as unknown as {
    foodsByName: Record<string, { effectiveQuality: number }>;
  };
  registry.foodsByName[itemName] = { effectiveQuality: 2 };
  Object.assign(fake.bot, {
    equip: vi.fn(async (item: unknown) => {
      Object.assign(fake.bot, { heldItem: item });
    }),
  });
  return bread;
}

function emitEatingCompletion(
  fake: ReturnType<typeof makeFakeBot>,
  entityId = fake.bot.entity.id,
): void {
  const client = fake.bot._client as unknown as EventEmitter;
  client.emit("entity_status", {
    entityId,
    entityStatus: 9,
  });
}

describe("player body", () => {
  it("exports a single strict operation catalog and rejects malformed variants", () => {
    expect(playerOperationNames).toHaveLength(31);
    expect(Object.keys(playerOperationDescriptions).sort()).toEqual(
      [...playerOperationNames].sort(),
    );
    expect(playerOperationNames).toContain("move_to");
    expect(playerOperationNames).toContain("move_relative");
    expect(playerOperationNames).toContain("look_sweep");
    expect(playerOperationNames).toContain("window_transfer");
    expect(playerOperationNames).toContain("elytra_fly");
    expect(playerOperationNames).toContain("collect_item");
    expect(playerOperationSchema.parse({ kind: "look_sweep" })).toEqual({
      kind: "look_sweep",
    });
    expect(
      playerOperationSchema.parse({ kind: "look_sweep", pitchDegrees: -60 }),
    ).toMatchObject({ kind: "look_sweep", pitchDegrees: -60 });
    expect(
      playerOperationSchema.parse({ kind: "look_sweep", pitchDegrees: 60 }),
    ).toMatchObject({ kind: "look_sweep", pitchDegrees: 60 });
    expect(() =>
      playerOperationSchema.parse({ kind: "look_sweep", pitchDegrees: -60.1 }),
    ).toThrow();
    expect(() =>
      playerOperationSchema.parse({ kind: "look_sweep", pitchDegrees: 60.1 }),
    ).toThrow();
    expect(() =>
      playerOperationSchema.parse({
        kind: "dig",
        position: { x: 1, y: 64, z: 2 },
        permission: "allow",
      }),
    ).toThrow();
    expect(() =>
      playerOperationSchema.parse({
        kind: "move_relative",
        offset: { x: 0, y: 0, z: 0 },
      }),
    ).toThrow();
    expect(() =>
      playerOperationSchema.parse({
        kind: "move_relative",
        offset: { x: 1, y: 0, z: 0 },
        range: 1,
      }),
    ).toThrow(/offset must exceed the arrival range/);
    expect(() =>
      playerOperationSchema.parse({
        kind: "move_relative",
        offset: { x: 33, y: 0, z: 0 },
      }),
    ).toThrow();
    expect(() =>
      playerOperationSchema.parse({
        kind: "anvil",
        position: { x: 0, y: 64, z: 0 },
        operation: "rename",
        firstItem: "iron_sword",
      }),
    ).toThrow();
    expect(() =>
      playerOperationSchema.parse({
        kind: "trade",
        entityId: 2,
        tradeIndex: "first",
      }),
    ).toThrow();
    expect(() =>
      playerOperationSchema.parse({
        kind: "use",
        target: { kind: "item", holdTicks: 0 },
      }),
    ).toThrow();
    expect(() =>
      playerOperationSchema.parse({
        kind: "use",
        target: { kind: "item", holdTicks: 201 },
      }),
    ).toThrow();
    expect(
      playerOperationSchema.parse({
        kind: "use",
        target: { kind: "item", holdTicks: 200 },
      }),
    ).toMatchObject({
      kind: "use",
      target: { kind: "item", holdTicks: 200 },
    });
    expect(
      playerOperationSchema.parse({ kind: "collect_item", entityId: 2 }),
    ).toEqual({ kind: "collect_item", entityId: 2 });
    expect(() =>
      playerOperationSchema.parse({ kind: "collect_item", entityId: 0 }),
    ).toThrow();
  });

  it("waits for delayed server food and inventory updates after consume", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const bread = prepareConsumeFixture(fake);
      const inventory = fake.bot.inventory as unknown as {
        slots: (Record<string, unknown> | null)[];
      };
      Object.assign(fake.bot, {
        consume: vi.fn(async () => {
          setTimeout(() => {
            fake.bot.food = 20;
            inventory.slots[36] = null;
            fake.inventory.emit("updateSlot", 36, bread, null);
          }, 200);
        }),
      });
      const body = new MineflayerPlayerBody(() => fake.bot);

      const resultPromise = body.execute({ kind: "consume", item: "bread" });
      await vi.advanceTimersByTimeAsync(300);
      const result = await resultPromise;

      expect(result.status).toBe("successful");
      expect(result.before?.self.food).toBe(19);
      expect(result.after?.self.food).toBe(20);
      expect(result.before?.self.inventory).toContainEqual(
        expect.objectContaining({ name: "bread", count: 1 }),
      );
      expect(result.after?.self.inventory).not.toContainEqual(
        expect.objectContaining({ name: "bread" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirms full-food golden-apple consumption from own eating status and item decrease", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const apple = prepareConsumeFixture(fake, 20, "golden_apple");
      const inventory = fake.bot.inventory as unknown as {
        slots: (Record<string, unknown> | null)[];
      };
      Object.assign(fake.bot, {
        consume: vi.fn(async () => {
          emitEatingCompletion(fake);
          setTimeout(() => {
            inventory.slots[36] = null;
            fake.inventory.emit("updateSlot", 36, apple, null);
          }, 200);
        }),
      });
      const body = new MineflayerPlayerBody(() => fake.bot);

      const resultPromise = body.execute({
        kind: "consume",
        item: "golden_apple",
      });
      await vi.advanceTimersByTimeAsync(300);
      const result = await resultPromise;

      expect(result.status).toBe("successful");
      expect(result.before?.self.food).toBe(20);
      expect(result.after?.self.food).toBe(20);
      expect(result.after?.self.inventory).not.toContainEqual(
        expect.objectContaining({ name: "golden_apple" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat an inventory decrease without own eating status as confirmed", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const apple = prepareConsumeFixture(fake, 20, "golden_apple");
      const inventory = fake.bot.inventory as unknown as {
        slots: (Record<string, unknown> | null)[];
      };
      Object.assign(fake.bot, {
        consume: vi.fn(async () => {
          setTimeout(() => {
            emitEatingCompletion(fake, fake.bot.entity.id + 1);
            inventory.slots[36] = null;
            fake.inventory.emit("updateSlot", 36, apple, null);
          }, 100);
        }),
      });
      const body = new MineflayerPlayerBody(() => fake.bot);

      const resultPromise = body.execute({
        kind: "consume",
        item: "golden_apple",
      });
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await resultPromise;

      expect(result.status).toBe("unverified");
      expect(result.after?.self.inventory).not.toContainEqual(
        expect.objectContaining({ name: "golden_apple" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not confirm own eating status without an item decrease", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      prepareConsumeFixture(fake, 20, "golden_apple");
      Object.assign(fake.bot, {
        consume: vi.fn(async () => emitEatingCompletion(fake)),
      });
      const body = new MineflayerPlayerBody(() => fake.bot);

      const resultPromise = body.execute({
        kind: "consume",
        item: "golden_apple",
      });
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await resultPromise;

      expect(result.status).toBe("unverified");
      expect(result.after?.self.inventory).toContainEqual(
        expect.objectContaining({ name: "golden_apple", count: 1 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores eating status after the consume operation changes life", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const apple = prepareConsumeFixture(fake, 20, "golden_apple");
      const inventory = fake.bot.inventory as unknown as {
        slots: (Record<string, unknown> | null)[];
      };
      Object.assign(fake.bot, {
        consume: vi.fn(async () => {
          fake.bot.emit("spawn");
          emitEatingCompletion(fake);
          inventory.slots[36] = null;
          fake.inventory.emit("updateSlot", 36, apple, null);
        }),
      });
      const body = new MineflayerPlayerBody(() => fake.bot);

      const resultPromise = body.execute({
        kind: "consume",
        item: "golden_apple",
      });
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await resultPromise;

      expect(result.status).toBe("unverified");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a consume without observed state changes unverified", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      prepareConsumeFixture(fake);
      Object.assign(fake.bot, { consume: vi.fn(async () => undefined) });
      const body = new MineflayerPlayerBody(() => fake.bot);

      const resultPromise = body.execute({ kind: "consume", item: "bread" });
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await resultPromise;

      expect(result.status).toBe("unverified");
      expect(result.before?.self.food).toBe(19);
      expect(result.after?.self.food).toBe(19);
      expect(result.before?.self.inventory).toContainEqual(
        expect.objectContaining({ name: "bread", count: 1 }),
      );
      expect(result.after?.self.inventory).toContainEqual(
        expect.objectContaining({ name: "bread", count: 1 }),
      );
      expect(
        (fake.bot._client as unknown as EventEmitter).listenerCount(
          "entity_status",
        ),
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets stop interrupt consume confirmation", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      prepareConsumeFixture(fake);
      Object.assign(fake.bot, { consume: vi.fn(async () => undefined) });
      const body = new MineflayerPlayerBody(() => fake.bot);
      const resultPromise = body.execute({ kind: "consume", item: "bread" });
      setTimeout(() => {
        void body.stop();
      }, 100);

      await vi.advanceTimersByTimeAsync(200);
      const result = await resultPromise;

      expect(result.status).toBe("interrupted");
      expect(result.before?.self.food).toBe(19);
      expect(result.after?.self.food).toBe(19);
      expect(result.after?.self.inventory).toContainEqual(
        expect.objectContaining({ name: "bread", count: 1 }),
      );
      expect(
        (fake.bot._client as unknown as EventEmitter).listenerCount(
          "entity_status",
        ),
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows a currently visible item entity and confirms pickup by entity ID", async () => {
    const fake = makeFakeBot();
    const item = addItemEntity(fake.bot, 2, new Vec3(0.25, 65.5, -5.5));
    const body = new MineflayerPlayerBody(() => fake.bot);
    const goto = vi.spyOn(fake.bot.pathfinder, "goto");
    goto.mockImplementation(async () => {
      fake.bot.entity.position = new Vec3(0, 65, -6);
      emitItemPickup(fake, item);
      removeItemEntity(fake.bot, item.id);
    });

    const result = await body.execute({ kind: "collect_item", entityId: 2 });

    expect(result.status).toBe("successful");
    expect(result.itemCollectionOutcome).toBe("collected");
    expect(result.observedEffect).toEqual({
      type: "item_collected",
      entityId: 2,
    });
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto.mock.calls[0]?.[0]).toMatchObject({
      x: 0,
      y: 65,
      z: -6,
      rangeSq: 1,
    });
    expect(result.after?.perception.entities).not.toContain(
      expect.objectContaining({ id: 2 }),
    );
  });

  it("waits briefly for the matching inventory count after a pickup event", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const item = addItemEntity(fake.bot, 2, undefined, {
        name: "emerald",
        count: 2,
      });
      addItemToInventory(fake, "emerald", 3);
      const body = new MineflayerPlayerBody(() => fake.bot);
      vi.spyOn(fake.bot.pathfinder, "goto").mockImplementation(async () => {
        emitItemPickup(fake, item, false);
        removeItemEntity(fake.bot, item.id);
        setTimeout(() => addItemToInventory(fake, "emerald", 2), 300);
      });

      const resultPromise = body.execute({ kind: "collect_item", entityId: 2 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result.status).toBe("successful");
      expect(result.before?.self.inventory).toContainEqual(
        expect.objectContaining({ name: "emerald", count: 3 }),
      );
      expect(result.after?.self.inventory).toContainEqual(
        expect.objectContaining({ name: "emerald", count: 5 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a matching pickup event unverified when inventory does not increase", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const item = addItemEntity(fake.bot);
      const body = new MineflayerPlayerBody(() => fake.bot);
      vi.spyOn(fake.bot.pathfinder, "goto").mockImplementation(async () => {
        emitItemPickup(fake, item, false);
        removeItemEntity(fake.bot, item.id);
      });

      const resultPromise = body.execute({ kind: "collect_item", entityId: 2 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result.status).toBe("unverified");
      expect(result.itemCollectionOutcome).toBe("collected");
      expect(result.detail).toContain("inventory increase was not confirmed");
      expect(result.observedEffect).toBeUndefined();
      expect(result.after?.self.inventory).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not count another item increase as proof of the requested pickup", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const item = addItemEntity(fake.bot, 2, undefined, {
        name: "emerald",
        count: 1,
      });
      const body = new MineflayerPlayerBody(() => fake.bot);
      vi.spyOn(fake.bot.pathfinder, "goto").mockImplementation(async () => {
        emitItemPickup(fake, item, false);
        addItemToInventory(fake, "coal", 1);
        removeItemEntity(fake.bot, item.id);
      });

      const resultPromise = body.execute({ kind: "collect_item", entityId: 2 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result.status).toBe("unverified");
      expect(result.itemCollectionOutcome).toBe("collected");
      expect(result.detail).toContain("inventory increase was not confirmed");
      expect(result.observedEffect).toBeUndefined();
      expect(result.after?.self.inventory).toContainEqual(
        expect.objectContaining({ name: "coal", count: 1 }),
      );
      expect(result.after?.self.inventory).not.toContainEqual(
        expect.objectContaining({ name: "emerald" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not confirm a pickup effect when the collected item's name is unknown", async () => {
    const fake = makeFakeBot();
    const item = addItemEntity(fake.bot, 2, undefined, null);
    const body = new MineflayerPlayerBody(() => fake.bot);
    vi.spyOn(fake.bot.pathfinder, "goto").mockImplementation(async () => {
      emitItemPickup(fake, item, false);
      addItemToInventory(fake, "coal", 1);
      removeItemEntity(fake.bot, item.id);
    });

    const result = await body.execute({ kind: "collect_item", entityId: 2 });

    expect(result.status).toBe("unverified");
    expect(result.itemCollectionOutcome).toBe("collected");
    expect(result.detail).toContain("inventory increase was not confirmed");
    expect(result.observedEffect).toBeUndefined();
    expect(result.after?.self.inventory).toContainEqual(
      expect.objectContaining({ name: "coal", count: 1 }),
    );
  });

  it("waits briefly for the same initially hidden item ID to become visible", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const item = addItemEntity(fake.bot, 2);
      fake.bot.entity.yaw = Math.PI / 2;
      const body = new MineflayerPlayerBody(() => fake.bot);
      const goto = vi
        .spyOn(fake.bot.pathfinder, "goto")
        .mockImplementation(async () => {
          fake.bot.entity.position = new Vec3(0, 64, -4);
          emitItemPickup(fake, item);
          removeItemEntity(fake.bot, item.id);
        });
      setTimeout(() => {
        fake.bot.entity.yaw = 0;
      }, 300);

      const resultPromise = body.execute({ kind: "collect_item", entityId: 2 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result.status).toBe("successful");
      expect(result.itemCollectionOutcome).toBe("collected");
      expect(result.observedEffect).toEqual({
        type: "item_collected",
        entityId: 2,
      });
      expect(goto).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a stale path and resumes the same item after brief tracking visibility loss", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const item = addItemEntity(fake.bot, 2);
      const body = new MineflayerPlayerBody(() => fake.bot);
      let cancelFirstPath: (() => void) | undefined;
      const goto = vi
        .spyOn(fake.bot.pathfinder, "goto")
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              cancelFirstPath = () => reject(new Error("Goal cancelled"));
              fake.bot.entity.yaw = Math.PI / 2;
            }),
        )
        .mockImplementationOnce(async () => {
          fake.bot.entity.position = new Vec3(0, 64, -4);
          emitItemPickup(fake, item);
          removeItemEntity(fake.bot, item.id);
        });
      const setGoal = vi.spyOn(fake.bot.pathfinder, "setGoal");
      setGoal.mockImplementation((goal) => {
        if (goal === null) cancelFirstPath?.();
      });
      setTimeout(() => {
        fake.bot.entity.yaw = 0;
      }, 500);

      const resultPromise = body.execute({ kind: "collect_item", entityId: 2 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;

      expect(result.status).toBe("successful");
      expect(result.itemCollectionOutcome).toBe("collected");
      expect(goto).toHaveBeenCalledTimes(2);
      expect(setGoal).toHaveBeenCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a visible non-item entity even when its Mineflayer type is other", async () => {
    const fake = makeFakeBot();
    const entity = addItemEntity(fake.bot);
    entity.name = "zombie";
    const body = new MineflayerPlayerBody(() => fake.bot);
    const goto = vi.spyOn(fake.bot.pathfinder, "goto");

    const result = await body.execute({ kind: "collect_item", entityId: 2 });

    expect(result.status).toBe("failed");
    expect(result.itemCollectionOutcome).toBe("invalid_target");
    expect(goto).not.toHaveBeenCalled();
  });

  it("updates pursuit from a newly observed item position", async () => {
    const fake = makeFakeBot();
    const item = addItemEntity(fake.bot);
    const body = new MineflayerPlayerBody(() => fake.bot);
    let cancelFirstPath: (() => void) | undefined;
    const followPositions: { x: number; y: number; z: number }[] = [];
    const goto = vi.spyOn(fake.bot.pathfinder, "goto");
    goto
      .mockImplementationOnce(() => {
        followPositions.push({
          x: item.position.x,
          y: item.position.y,
          z: item.position.z,
        });
        return new Promise<void>((_resolve, reject) => {
          cancelFirstPath = () => reject(new Error("Goal changed"));
          item.position = new Vec3(0, 64, -7);
        });
      })
      .mockImplementationOnce(async () => {
        followPositions.push({
          x: item.position.x,
          y: item.position.y,
          z: item.position.z,
        });
        emitItemPickup(fake, item);
        removeItemEntity(fake.bot, item.id);
      });
    const setGoal = vi.spyOn(fake.bot.pathfinder, "setGoal");
    setGoal.mockImplementation((goal) => {
      if (goal === null) cancelFirstPath?.();
    });

    const result = await body.execute({ kind: "collect_item", entityId: 2 });

    expect(result.status).toBe("successful");
    expect(result.itemCollectionOutcome).toBe("collected");
    expect(followPositions).toEqual([
      { x: 0, y: 64, z: -5 },
      { x: 0, y: 64, z: -7 },
    ]);
  });

  it("does not report success from path arrival without an observed pickup", async () => {
    const fake = makeFakeBot();
    addItemEntity(fake.bot);
    const body = new MineflayerPlayerBody(() => fake.bot);
    const controller = new AbortController();
    const goto = vi.spyOn(fake.bot.pathfinder, "goto");
    goto.mockResolvedValue(undefined);
    const abortTimer = setTimeout(
      () => controller.abort(new Error("test stop")),
      10,
    );

    const result = await body.execute(
      { kind: "collect_item", entityId: 2 },
      controller.signal,
    );
    clearTimeout(abortTimer);

    expect(result.status).toBe("interrupted");
    expect(result.itemCollectionOutcome).toBeUndefined();
    expect(result.observedEffect).toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("returns a bounded out-of-range result when a nearby goal is reached without pickup", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const item = addItemEntity(fake.bot, 2, new Vec3(0.99, 64.99, -5.01));
      await fake.bot.lookAt(item.position);
      const body = new MineflayerPlayerBody(() => fake.bot);
      const goto = vi.spyOn(fake.bot.pathfinder, "goto");
      goto.mockImplementation(async () => {
        fake.bot.entity.position = new Vec3(1, 64, -6);
        await fake.bot.lookAt(item.position);
      });

      const resultPromise = body.execute({ kind: "collect_item", entityId: 2 });
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await resultPromise;

      expect(result.status).toBe("failed");
      expect(result.itemCollectionOutcome).toBe("pickup_out_of_range");
      expect(result.observedEffect).toBeUndefined();
      expect(goto).toHaveBeenCalledTimes(1);
      expect(goto.mock.calls[0]?.[0]).toMatchObject({
        x: 0,
        y: 64,
        z: -6,
        rangeSq: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops pursuit when the target becomes unobservable without returning its hidden position", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const item = addItemEntity(fake.bot);
      const body = new MineflayerPlayerBody(() => fake.bot);
      let cancelPath: (() => void) | undefined;
      vi.spyOn(fake.bot.pathfinder, "goto").mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            cancelPath = () => reject(new Error("Path stopped"));
            fake.bot.entity.yaw = Math.PI / 2;
            item.position = new Vec3(0, 64, -12);
          }),
      );
      vi.spyOn(fake.bot.pathfinder, "setGoal").mockImplementation((goal) => {
        if (goal === null) cancelPath?.();
      });

      const resultPromise = body.execute({ kind: "collect_item", entityId: 2 });
      await vi.advanceTimersByTimeAsync(1_250);
      const result = await resultPromise;

      expect(result.status).toBe("failed");
      expect(result.itemCollectionOutcome).toBe("target_unobservable");
      expect(result.after?.perception.entities).not.toContain(
        expect.objectContaining({ id: 2 }),
      );
      expect(result.detail).toContain(
        "did not return to the current visible view",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the visibility grace wait without starting an item path", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      addItemEntity(fake.bot);
      fake.bot.entity.yaw = Math.PI / 2;
      const body = new MineflayerPlayerBody(() => fake.bot);
      const controller = new AbortController();
      const goto = vi.spyOn(fake.bot.pathfinder, "goto");
      const resultPromise = body.execute(
        { kind: "collect_item", entityId: 2 },
        controller.signal,
      );
      setTimeout(() => controller.abort(new Error("test stop")), 300);

      await vi.advanceTimersByTimeAsync(300);
      const result = await resultPromise;

      expect(result.status).toBe("interrupted");
      expect(result.itemCollectionOutcome).toBeUndefined();
      expect(goto).not.toHaveBeenCalled();
      expect(pathUpdateListenerCount(fake.bot)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes a removed target from a path failure", async () => {
    const disappeared = makeFakeBot();
    const removedItem = addItemEntity(disappeared.bot);
    let cancelRemovedPath: (() => void) | undefined;
    vi.spyOn(disappeared.bot.pathfinder, "goto").mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          cancelRemovedPath = () => reject(new Error("Path stopped"));
          removeItemEntity(disappeared.bot, removedItem.id);
        }),
    );
    vi.spyOn(disappeared.bot.pathfinder, "setGoal").mockImplementation(
      (goal) => {
        if (goal === null) cancelRemovedPath?.();
      },
    );

    const removedResult = await new MineflayerPlayerBody(
      () => disappeared.bot,
    ).execute({ kind: "collect_item", entityId: 2 });

    expect(removedResult.status).toBe("failed");
    expect(removedResult.itemCollectionOutcome).toBe("entity_removed");

    const noPath = makeFakeBot();
    addItemEntity(noPath.bot);
    vi.spyOn(noPath.bot.pathfinder, "goto").mockRejectedValueOnce(
      new Error("No path to the goal"),
    );

    const pathResult = await new MineflayerPlayerBody(() => noPath.bot).execute(
      {
        kind: "collect_item",
        entityId: 2,
      },
    );

    expect(pathResult.status).toBe("failed");
    expect(pathResult.itemCollectionOutcome).toBe("path_failed");
    expect(pathResult.itemCollectionPathFailureReason).toBe("goto_rejected");
    expect(pathResult.observedEffect).toBeUndefined();
  });

  it.each([
    { pathStatus: "noPath", expectedReason: "no_path" },
    { pathStatus: "timeout", expectedReason: "path_timeout" },
  ])(
    "preserves the fixed pathfinder status reason for $pathStatus",
    async ({ pathStatus, expectedReason }) => {
      const fake = makeFakeBot();
      addItemEntity(fake.bot);
      const eventEmitter = fake.bot as unknown as EventEmitter;
      let cancelPath: (() => void) | undefined;
      vi.spyOn(fake.bot.pathfinder, "goto").mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            cancelPath = () => reject(new Error("Path stopped"));
            queueMicrotask(() =>
              eventEmitter.emit("path_update", {
                status: pathStatus,
                path: [],
              }),
            );
          }),
      );
      vi.spyOn(fake.bot.pathfinder, "setGoal").mockImplementation((goal) => {
        if (goal === null) cancelPath?.();
      });

      const result = await new MineflayerPlayerBody(() => fake.bot).execute({
        kind: "collect_item",
        entityId: 2,
      });

      expect(result.itemCollectionOutcome).toBe("path_failed");
      expect(result.itemCollectionPathFailureReason).toBe(expectedReason);
    },
  );

  it("classifies untyped pathfinder rejections without exposing their message", async () => {
    const fake = makeFakeBot();
    addItemEntity(fake.bot);
    vi.spyOn(fake.bot.pathfinder, "goto").mockRejectedValueOnce(
      "opaque rejection",
    );

    const result = await new MineflayerPlayerBody(() => fake.bot).execute({
      kind: "collect_item",
      entityId: 2,
    });

    expect(result.itemCollectionOutcome).toBe("path_failed");
    expect(result.itemCollectionPathFailureReason).toBe("unknown");
    expect(result.detail).not.toContain("opaque rejection");
  });

  it("stops collection pathfinding when the operation is aborted", async () => {
    const fake = makeFakeBot();
    addItemEntity(fake.bot);
    const body = new MineflayerPlayerBody(() => fake.bot);
    const controller = new AbortController();
    let cancelPath: (() => void) | undefined;
    vi.spyOn(fake.bot.pathfinder, "goto").mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          cancelPath = () => reject(new Error("Path stopped"));
        }),
    );
    const setGoal = vi.spyOn(fake.bot.pathfinder, "setGoal");
    setGoal.mockImplementation((goal) => {
      if (goal === null) cancelPath?.();
    });
    setTimeout(() => controller.abort(new Error("test stop")), 10);

    const result = await body.execute(
      { kind: "collect_item", entityId: 2 },
      controller.signal,
    );

    expect(result.status).toBe("interrupted");
    expect(result.recoveryRequired).toBe(false);
    expect(setGoal).toHaveBeenCalledWith(null);
    expect(pathUpdateListenerCount(fake.bot)).toBe(0);
  });

  it("physically sweeps bounded views and reports blocks found only after turning", async () => {
    const fake = makeFakeBot();
    const eastBlock = new Vec3(3, 64, 0);
    fake.blocks.set("3,64,0", makeBlock("blue_wool", 3, eastBlock));
    fake.candidates.push(eastBlock);
    const before = observePlayerBody(fake.bot, "owner");
    expect(before.perception.blocks.map(({ name }) => name)).not.toContain(
      "blue_wool",
    );

    const body = new MineflayerPlayerBody(() => fake.bot);
    const result = await body.execute({ kind: "look_sweep" });
    const sweep = result.lookSweep;

    expect(result.status).toBe("successful");
    expect(fake.bot.lookAt).toHaveBeenCalledTimes(8);
    expect(sweep?.complete).toBe(true);
    expect(sweep?.current.visibleBlocks.map(({ name }) => name)).not.toContain(
      "blue_wool",
    );
    expect(
      sweep?.directions.some(({ visibleBlocks }) =>
        visibleBlocks.some(({ name }) => name === "blue_wool"),
      ),
    ).toBe(true);
    expect(sweep?.directions).toHaveLength(8);
    expect(sweep?.directions.map(({ pitchDegrees }) => pitchDegrees)).toEqual(
      Array(8).fill(-25),
    );
    expect(sweep?.worldAbsenceEstablished).toBe(false);
    const allViews = [sweep?.current, ...(sweep?.directions ?? [])].filter(
      (view) => view !== undefined,
    );
    expect(allViews.every((view) => view.visibleBlocks.length <= 8)).toBe(true);
    expect(allViews.every((view) => view.visibleEntities.length <= 2)).toBe(
      true,
    );
    expect(
      allViews.reduce((total, view) => total + view.visibleBlocks.length, 0),
    ).toBeLessThanOrEqual(72);
    expect(
      allViews.reduce((total, view) => total + view.visibleEntities.length, 0),
    ).toBeLessThanOrEqual(18);
  });

  it("sweeps at a requested upward pitch and reports observed pitch", async () => {
    const fake = makeFakeBot();
    const body = new MineflayerPlayerBody(() => fake.bot);
    const result = await body.execute({
      kind: "look_sweep",
      pitchDegrees: 35,
    });

    expect(result.status).toBe("successful");
    expect(fake.bot.lookAt).toHaveBeenCalledTimes(8);
    expect(result.lookSweep?.directions).toHaveLength(8);
    expect(
      result.lookSweep?.directions.map(({ pitchDegrees }) => pitchDegrees),
    ).toEqual(Array(8).fill(35));
  });

  it("stops a look sweep after an abort and keeps its partial result explicitly incomplete", async () => {
    const fake = makeFakeBot();
    const body = new MineflayerPlayerBody(() => fake.bot);
    const controller = new AbortController();
    vi.mocked(fake.bot.lookAt).mockImplementationOnce(async () => {
      controller.abort(new Error("stop scan"));
    });

    const result = await body.execute(
      { kind: "look_sweep" },
      controller.signal,
    );

    expect(result.status).toBe("interrupted");
    expect(fake.bot.lookAt).toHaveBeenCalledTimes(1);
    expect(result.lookSweep?.complete).toBe(false);
    expect(result.lookSweep?.directions).toHaveLength(0);
    expect(result.lookSweep?.worldAbsenceEstablished).toBe(false);
  });

  it("waits for Mineflayer plugin injection and retains lifecycle events across reconnects", async () => {
    let currentBot: Bot | undefined;
    const body = new MineflayerPlayerBody(() => {
      if (currentBot === undefined) throw new Error("Bot is not connected");
      return currentBot;
    });
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));

    const first = makeFakeBot({ deferInventory: true });
    const firstEvents = first.bot as unknown as EventEmitter;
    firstEvents.once("inject_allowed", () => first.initializeInventory());
    currentBot = first.bot;
    body.attach(first.bot);
    expect(first.inventory.listenerCount("updateSlot")).toBe(0);
    expect(firstEvents.listenerCount("spawn")).toBe(1);
    expect(firstEvents.listenerCount("end")).toBe(1);
    firstEvents.emit("spawn");

    firstEvents.emit("inject_allowed");
    await Promise.resolve();
    expect(first.inventory.listenerCount("updateSlot")).toBe(1);
    body.attach(first.bot);
    expect(first.inventory.listenerCount("updateSlot")).toBe(1);

    const window = makeWindow();
    firstEvents.emit("windowOpen", window);
    firstEvents.emit("windowOpen", window);
    expect(window.listenerCount("updateSlot")).toBe(1);

    first.inventory.emit("updateSlot", 0, null, null);
    await new Promise((resolve) => setTimeout(resolve, 175));
    expect(
      events.some(
        (event) =>
          event.type === "state_changed" && event.reason === "inventory",
      ),
    ).toBe(true);

    firstEvents.emit("end", "reconnect requested");
    const second = makeFakeBot();
    currentBot = second.bot;
    body.attach(second.bot);
    expect(first.inventory.listenerCount("updateSlot")).toBe(0);
    expect(window.listenerCount("updateSlot")).toBe(0);
    expect(second.inventory.listenerCount("updateSlot")).toBe(1);
    (second.bot as unknown as EventEmitter).emit("spawn");
    expect(events.some((event) => event.type === "reconnected")).toBe(true);
    expect(events.some((event) => event.type === "disconnected")).toBe(true);
  });

  it("does not emit observation-driven state changes while spawn admission is unavailable", async () => {
    const fake = makeFakeBot();
    let spawned = true;
    const body = new MineflayerPlayerBody(() => {
      if (!spawned) throw new Error("Bot is not spawned");
      return fake.bot;
    });
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));

    spawned = false;
    (fake.bot as unknown as EventEmitter).emit("health");
    await new Promise((resolve) => setTimeout(resolve, 175));

    expect(events.some((event) => event.type === "state_changed")).toBe(false);
    await expect(body.observe()).rejects.toThrow("Bot is not spawned");
  });

  it("resumes observation-driven state changes with a fresh observation after spawn", async () => {
    const fake = makeFakeBot();
    let spawned = true;
    const body = new MineflayerPlayerBody(() => {
      if (!spawned) throw new Error("Bot is not spawned");
      return fake.bot;
    });
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));

    spawned = false;
    (fake.bot as unknown as EventEmitter).emit("health");
    await new Promise((resolve) => setTimeout(resolve, 175));
    spawned = true;
    (fake.bot as unknown as EventEmitter).emit("health");
    await new Promise((resolve) => setTimeout(resolve, 175));

    expect(
      events.some(
        (event) => event.type === "state_changed" && event.reason === "vitals",
      ),
    ).toBe(true);
    await expect(body.observe()).resolves.toMatchObject({
      self: { health: fake.bot.health },
    });
  });

  it("emits self damage with Mineflayer's attributed source but no private identity or position", () => {
    const fake = makeFakeBot();
    const zombie = {
      id: 2,
      name: "zombie",
      type: "mob",
      position: new Vec3(0, 64, -2),
      username: "private-player-name",
    } as unknown as Entity;
    registerFakeZombie(fake);
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));

    (fake.bot as unknown as EventEmitter).emit(
      "entityHurt",
      fake.bot.entity,
      zombie,
    );

    const damageEvent = events.find((event) => event.type === "bot_damaged");
    expect(damageEvent?.type).toBe("bot_damaged");
    if (damageEvent?.type !== "bot_damaged") {
      throw new Error("expected bot damage event");
    }
    expect(damageEvent.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(damageEvent).toEqual({
      type: "bot_damaged",
      at: damageEvent.at,
      source: { kind: "mob", name: "zombie", category: "Hostile mobs" },
      confidence: "observed",
    });
    expect(JSON.stringify(damageEvent)).not.toContain("private-player-name");
    expect(JSON.stringify(damageEvent)).not.toContain('"position"');
    expect(JSON.stringify(damageEvent)).not.toContain('"id"');

    (fake.bot as unknown as EventEmitter).emit(
      "entityHurt",
      zombie,
      fake.bot.entity,
    );
    expect(events.filter((event) => event.type === "bot_damaged")).toHaveLength(
      1,
    );

    (fake.bot as unknown as EventEmitter).emit(
      "entityHurt",
      fake.bot.entity,
      undefined,
    );
    expect(events.at(-1)).toMatchObject({
      type: "bot_damaged",
      source: null,
      confidence: "unknown",
    });
  });

  it("equips the best carried known armor while enabled without damage", async () => {
    const fake = makeFakeBot();
    addItemToInventory(fake, "leather_helmet", 1);
    addItemToInventory(fake, "diamond_helmet", 1);
    addItemToInventory(fake, "iron_chestplate", 1);
    const equip = installFakeArmorEquip(fake);
    const body = new MineflayerPlayerBody(() => fake.bot);
    body.onEvent(() => undefined);
    body.setDamageReflexEnabled(true);

    await vi.waitFor(() => expect(equip).toHaveBeenCalledTimes(2));

    expect(
      equip.mock.calls.map(([item, destination]) => ({
        item: item.name,
        destination,
      })),
    ).toEqual([
      { item: "diamond_helmet", destination: "head" },
      { item: "iron_chestplate", destination: "torso" },
    ]);
    await body.stop();
  });

  it("reacts to inventory updates but keeps stronger and unknown equipped armor", async () => {
    const fake = makeFakeBot();
    const slots = fake.inventory as EventEmitter & {
      slots: (Record<string, unknown> | null)[];
    };
    slots.slots[5] = { name: "diamond_helmet", count: 1 };
    slots.slots[6] = { name: "modded_chestplate", count: 1 };
    slots.slots[7] = { name: "diamond_leggings", count: 1 };
    slots.slots[8] = { name: "netherite_boots", count: 1 };
    addItemToInventory(fake, "golden_helmet", 1);
    addItemToInventory(fake, "diamond_chestplate", 1);
    addItemToInventory(fake, "golden_leggings", 1);
    addItemToInventory(fake, "iron_boots", 1);
    const equip = installFakeArmorEquip(fake);
    const body = new MineflayerPlayerBody(() => fake.bot);
    body.onEvent(() => undefined);
    body.setDamageReflexEnabled(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(equip).not.toHaveBeenCalled();

    addItemToInventory(fake, "netherite_leggings", 1);
    await vi.waitFor(() => expect(equip).toHaveBeenCalledTimes(1));
    expect(equip.mock.calls[0]?.[0].name).toBe("netherite_leggings");
    expect(equip.mock.calls[0]?.[1]).toBe("legs");
    await body.stop();
  });

  it("does not use queued armor from a dead life and retries after spawn", async () => {
    const fake = makeFakeBot();
    addItemToInventory(fake, "iron_helmet", 1);
    const equip = installFakeArmorEquip(fake);
    const botEvents = fake.bot as unknown as EventEmitter;
    const body = new MineflayerPlayerBody(() => fake.bot);
    body.onEvent(() => undefined);
    body.setDamageReflexEnabled(true);
    fake.bot.health = 0;
    botEvents.emit("health");
    botEvents.emit("death");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(equip).not.toHaveBeenCalled();

    fake.bot.health = 20;
    botEvents.emit("spawn");
    await vi.waitFor(() => expect(equip).toHaveBeenCalledTimes(1));
    expect(equip.mock.calls[0]?.[0].name).toBe("iron_helmet");
    await body.stop();
  });

  it("cancels queued passive armor when the body is stopped", async () => {
    const fake = makeFakeBot();
    addItemToInventory(fake, "iron_helmet", 1);
    const equip = installFakeArmorEquip(fake);
    const body = new MineflayerPlayerBody(() => fake.bot);
    body.onEvent(() => undefined);
    body.setDamageReflexEnabled(true);

    await body.stop();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(equip).not.toHaveBeenCalled();
  });

  it("keeps reflex attack moving while a native passive equip is unsettled", async () => {
    const fake = makeFakeBot();
    const zombie = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    addItemToInventory(fake, "golden_helmet", 1);
    addItemToInventory(fake, "iron_sword", 1);
    const inventory = fake.inventory as EventEmitter & {
      slots: (Record<string, unknown> | null)[];
    };
    const botEvents = fake.bot as unknown as EventEmitter;
    let finishNativeEquip!: () => void;
    const nativeEquip = new Promise<void>((resolve) => {
      finishNativeEquip = resolve;
    });
    const equip = vi.fn((item: Item, destination: string) => {
      if (destination === "head")
        return nativeEquip.then(() => {
          const slot = fake.bot.getEquipmentDestSlot(destination);
          const previous = inventory.slots[slot] ?? null;
          inventory.slots[slot] = item as unknown as Record<string, unknown>;
          fake.inventory.emit("updateSlot", slot, previous, item);
        });
      return Promise.resolve();
    });
    const attack = vi.fn((target: Entity) =>
      botEvents.emit("entityHurt", target, fake.bot.entity),
    );
    Object.assign(fake.bot, { equip, attack });
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    body.setDamageReflexEnabled(true);
    await vi.waitFor(() => expect(equip).toHaveBeenCalledTimes(1));

    botEvents.emit("entityHurt", fake.bot.entity, zombie);
    await vi.waitFor(() => expect(attack).toHaveBeenCalled());
    expect(equip).toHaveBeenCalledTimes(1);
    await body.stop();
    expect(
      events.some((event) => event.type === "damage_reflex_completed"),
    ).toBe(true);

    finishNativeEquip();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(equip).toHaveBeenCalledTimes(1);
  });

  it("does not retry passive armor in a loop after native equip rejects", async () => {
    const fake = makeFakeBot();
    addItemToInventory(fake, "iron_helmet", 1);
    const inventory = fake.inventory;
    const equip = vi.fn((_item: Item, _destination: string) => {
      inventory.emit("updateSlot", 40, null, null);
      return Promise.reject(new Error("native equip rejected"));
    });
    Object.assign(fake.bot, { equip });
    const body = new MineflayerPlayerBody(() => fake.bot);
    body.onEvent(() => undefined);
    body.setDamageReflexEnabled(true);

    await vi.waitFor(() => expect(equip).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(equip).toHaveBeenCalledTimes(1);
    await body.stop();
  });

  it("coalesces damage into a visible short retaliation without cancelling the active operation", async () => {
    const fake = makeFakeBot();
    const zombie = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    body.setDamageReflexEnabled(true);
    const botEvents = fake.bot as unknown as EventEmitter;
    Object.assign(fake.bot, { setControlState: vi.fn() });
    const attack = vi.fn((_target: Entity) => {
      botEvents.emit("entityHurt", zombie, fake.bot.entity);
    });
    Object.assign(fake.bot, { attack });

    const pendingControl = body.execute({
      kind: "control",
      controls: { forward: true },
      ticks: 100,
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "operation_started")).toBe(
        true,
      ),
    );
    botEvents.emit("entityHurt", fake.bot.entity, zombie);
    botEvents.emit("entityHurt", fake.bot.entity, zombie);

    await vi.waitFor(() => expect(attack.mock.calls.length).toBeGreaterThan(0));
    expect(fake.bot.lookAt).toHaveBeenCalledWith(expect.any(Vec3), true);
    await body.stopActiveOperation();
    await expect(pendingControl).resolves.toMatchObject({
      operation: { kind: "control" },
      status: "interrupted",
    });
    const attacksAfterPrimaryStop = attack.mock.calls.length;
    await vi.waitFor(() =>
      expect(attack.mock.calls.length).toBeGreaterThan(attacksAfterPrimaryStop),
    );

    body.setDamageReflexEnabled(false);
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "damage_reflex_completed"),
      ).toBe(true),
    );
    expect(
      events.filter((event) => event.type === "damage_reflex_started"),
    ).toHaveLength(1);
    const completion = events.find(
      (event) => event.type === "damage_reflex_completed",
    );
    expect(completion).toMatchObject({
      operationKind: "attack",
      status: "successful",
      sameLife: true,
      summary: "hit_confirmed",
    });
    if (completion?.type !== "damage_reflex_completed")
      throw new Error("expected reflex completion");
    expect(typeof completion.serverConfirmedAt).toBe("string");
    expect(JSON.stringify(completion)).not.toContain("zombie");
    expect(JSON.stringify(completion)).not.toContain('"id"');
  });

  it("starts one reflex for a nearby hostile before damage and coalesces later damage", async () => {
    const fake = makeFakeBot();
    const zombie = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    const botEvents = fake.bot as unknown as EventEmitter;
    const attack = vi.fn((target: Entity) =>
      botEvents.emit("entityHurt", target, fake.bot.entity),
    );
    Object.assign(fake.bot, { attack });
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    body.setDamageReflexEnabled(true);
    botEvents.emit("entityMoved", zombie);
    botEvents.emit("entityMoved", zombie);

    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "damage_reflex_started"),
      ).toBe(true),
    );
    expect(
      events.find((event) => event.type === "damage_reflex_started"),
    ).toMatchObject({ trigger: "hostile_approach" });
    expect(events.some((event) => event.type === "bot_damaged")).toBe(false);
    await vi.waitFor(() => expect(attack).toHaveBeenCalled(), {
      timeout: 1_000,
    });

    botEvents.emit("entityHurt", fake.bot.entity, zombie);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "bot_damaged")).toBe(true),
    );
    await vi.waitFor(
      () =>
        expect(
          events.some((event) => event.type === "damage_reflex_completed"),
        ).toBe(true),
      { timeout: 2_000 },
    );

    botEvents.emit("entityMoved", zombie);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(
      events.filter((event) => event.type === "damage_reflex_started"),
    ).toHaveLength(1);

    fake.bot.health = 0;
    botEvents.emit("health");
    botEvents.emit("death");
    fake.bot.health = 20;
    botEvents.emit("spawn");
    botEvents.emit("entityMoved", zombie);
    await vi.waitFor(
      () =>
        expect(
          events.filter((event) => event.type === "damage_reflex_started"),
        ).toHaveLength(2),
      { timeout: 1_000 },
    );
    expect(
      events.filter((event) => event.type === "damage_reflex_started")[1],
    ).toMatchObject({ trigger: "hostile_approach" });
    await body.stop();
  });

  it("re-engages after a hostile leaves and returns to ordinary attack reach", async () => {
    const fake = makeFakeBot();
    const zombie = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    const botEvents = fake.bot as unknown as EventEmitter;
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    body.setDamageReflexEnabled(true);

    await vi.waitFor(() =>
      expect(
        events.filter((event) => event.type === "damage_reflex_started"),
      ).toHaveLength(1),
    );
    await vi.waitFor(
      () =>
        expect(
          events.some((event) => event.type === "damage_reflex_completed"),
        ).toBe(true),
      { timeout: 2_000 },
    );

    zombie.position = new Vec3(0, 64, -5);
    botEvents.emit("entityMoved", zombie);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(
      events.filter((event) => event.type === "damage_reflex_started"),
    ).toHaveLength(1);

    zombie.position = new Vec3(0, 64, -2);
    botEvents.emit("entityMoved", zombie);
    await vi.waitFor(() =>
      expect(
        events.filter((event) => event.type === "damage_reflex_started"),
      ).toHaveLength(2),
    );
    await body.stop();
  });

  it("rejects passive, player, occluded, out-of-reach, and disabled hostile approaches", async () => {
    const cases = [
      "passive",
      "player",
      "occluded",
      "out-of-reach",
      "disabled",
    ] as const;
    for (const scenario of cases) {
      const fake = makeFakeBot();
      const target = addFakeZombieEntity(fake);
      registerFakeZombie(fake);
      if (scenario === "passive")
        Object.assign(fake.bot.registry.entitiesByName, {
          zombie: {
            name: "zombie",
            displayName: "Zombie",
            type: "mob",
            category: "Passive mobs",
          },
        });
      if (scenario === "player")
        Object.assign(target, { type: "player", username: "other" });
      if (scenario === "occluded") {
        const wall = makeBlock("stone", 1, new Vec3(0, 64, -1));
        Object.assign(fake.bot.world, {
          raycast: vi.fn(() => wall),
        });
      }
      if (scenario === "out-of-reach") target.position = new Vec3(0, 64, -5);

      const botEvents = fake.bot as unknown as EventEmitter;
      const body = new MineflayerPlayerBody(() => fake.bot);
      const events: PlayerBodyEvent[] = [];
      body.onEvent((event) => events.push(event));
      if (scenario !== "disabled") body.setDamageReflexEnabled(true);
      botEvents.emit("entityMoved", target);
      await vi.waitFor(() =>
        expect(
          events.some(
            (event) =>
              event.type === "state_changed" && event.reason === "entities",
          ),
        ).toBe(true),
      );
      expect(
        events.some((event) => event.type === "damage_reflex_started"),
      ).toBe(false);
      expect(fake.bot.attack).not.toHaveBeenCalled();
      await body.stop();
    }
  });

  it("rechecks a stationary hostile on spawn after replacing an old-life timer", async () => {
    const fake = makeFakeBot();
    const zombie = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    const botEvents = fake.bot as unknown as EventEmitter;
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    body.setDamageReflexEnabled(true);
    botEvents.emit("entityMoved", zombie);
    fake.bot.health = 0;
    botEvents.emit("health");
    botEvents.emit("death");
    fake.bot.health = 20;
    botEvents.emit("spawn");

    await vi.waitFor(() =>
      expect(
        events.filter((event) => event.type === "damage_reflex_started"),
      ).toHaveLength(1),
    );
    expect(
      events.find((event) => event.type === "damage_reflex_started"),
    ).toMatchObject({ trigger: "hostile_approach" });
    await body.stop();
  });

  it("equips only owned items into empty armor slots and recognizes a spear from server slot packets", async () => {
    const fake = makeFakeBot();
    const zombie = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    addItemToInventory(fake, "golden_helmet", 1);
    addItemToInventory(fake, "iron_chestplate", 1);
    addItemToInventory(fake, "golden_spear", 1);
    addItemToInventory(fake, "iron_boots", 1);
    const slots = fake.inventory as EventEmitter & {
      slots: (Record<string, unknown> | null)[];
    };
    const bootsInventorySlot = slots.slots.findIndex(
      (item) => item?.name === "iron_boots",
    );
    slots.slots[8] = slots.slots[bootsInventorySlot] ?? null;
    slots.slots[bootsInventorySlot] = null;
    const botEvents = fake.bot as unknown as EventEmitter;
    const clientEvents = fake.bot._client as unknown as EventEmitter;
    const equipCalls: { name: string; destination: string }[] = [];
    const actionOrder: string[] = [];
    const attack = vi.fn((_target: Entity) => {
      actionOrder.push("attack");
      botEvents.emit("entityHurt", zombie, fake.bot.entity);
    });
    Object.assign(fake.bot, {
      equip: vi.fn(async (item: Item, destination: string) => {
        equipCalls.push({ name: item.name, destination });
        actionOrder.push(`equip:${destination}`);
        const slot = fake.bot.getEquipmentDestSlot(destination);
        const previous = slots.slots[slot] ?? null;
        slots.slots[slot] = item as unknown as Record<string, unknown>;
        fake.inventory.emit("updateSlot", slot, previous, item);
        clientEvents.emit("set_slot", { windowId: 0, slot, item: {} });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }),
      attack,
    });
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    body.setDamageReflexEnabled(true);

    botEvents.emit("entityHurt", fake.bot.entity, zombie);
    await vi.waitFor(() => expect(equipCalls).toHaveLength(3));
    await vi.waitFor(() => expect(attack).toHaveBeenCalled());
    body.setDamageReflexEnabled(false);
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "damage_reflex_completed"),
      ).toBe(true),
    );

    expect(equipCalls).toEqual([
      { name: "golden_helmet", destination: "head" },
      { name: "iron_chestplate", destination: "torso" },
      { name: "golden_spear", destination: "hand" },
    ]);
    expect(equipCalls.some((call) => call.destination === "feet")).toBe(false);
    expect(attack).toHaveBeenCalled();
    expect(actionOrder.indexOf("attack")).toBeLessThan(
      actionOrder.indexOf("equip:torso"),
    );
    const completion = events.find(
      (event) => event.type === "damage_reflex_completed",
    );
    expect(completion).toMatchObject({
      operationKind: "equip",
      status: "successful",
      sameLife: true,
      summary: "equipment_and_hit_confirmed",
    });
    if (completion?.type !== "damage_reflex_completed")
      throw new Error("expected reflex completion");
    expect(typeof completion.serverConfirmedAt).toBe("string");
  });

  it("keeps an equipped melee weapon while still filling empty armor slots", async () => {
    const fake = makeFakeBot();
    const zombie = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    addItemToInventory(fake, "golden_spear", 1);
    addItemToInventory(fake, "iron_sword", 1);
    addItemToInventory(fake, "golden_helmet", 1);
    addItemToInventory(fake, "iron_chestplate", 1);
    const inventory = fake.inventory as EventEmitter & {
      slots: (Record<string, unknown> | null)[];
    };
    const swordSlot = inventory.slots.findIndex(
      (item) => item?.name === "iron_sword",
    );
    const heldSword = inventory.slots[swordSlot];
    inventory.slots[36] = heldSword ?? null;
    inventory.slots[swordSlot] = null;
    const botEvents = fake.bot as unknown as EventEmitter;
    const clientEvents = fake.bot._client as unknown as EventEmitter;
    const equipCalls: { name: string; destination: string }[] = [];
    const attack = vi.fn((_target: Entity) => {
      botEvents.emit("entityHurt", zombie, fake.bot.entity);
    });
    Object.assign(fake.bot, {
      heldItem: heldSword,
      equip: vi.fn(async (item: Item, destination: string) => {
        equipCalls.push({ name: item.name, destination });
        const slot = fake.bot.getEquipmentDestSlot(destination);
        const previous = inventory.slots[slot] ?? null;
        inventory.slots[slot] = item as unknown as Record<string, unknown>;
        fake.inventory.emit("updateSlot", slot, previous, item);
        clientEvents.emit("set_slot", { windowId: 0, slot, item: {} });
      }),
      attack,
    });
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    body.setDamageReflexEnabled(true);

    botEvents.emit("entityHurt", fake.bot.entity, zombie);
    await vi.waitFor(() => expect(equipCalls).toHaveLength(2));
    await vi.waitFor(() => expect(attack).toHaveBeenCalled());
    body.setDamageReflexEnabled(false);
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "damage_reflex_completed"),
      ).toBe(true),
    );

    expect(equipCalls).toEqual([
      { name: "golden_helmet", destination: "head" },
      { name: "iron_chestplate", destination: "torso" },
    ]);
    expect(fake.bot.heldItem?.name).toBe("iron_sword");
    expect(inventory.slots.some((item) => item?.name === "golden_spear")).toBe(
      true,
    );
    expect(
      events.find((event) => event.type === "damage_reflex_completed"),
    ).toMatchObject({
      status: "successful",
      summary: "equipment_and_hit_confirmed",
    });
  });

  it("does not treat optimistic inventory updates as server-confirmed reflex equipment", async () => {
    const fake = makeFakeBot();
    const zombie = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    addItemToInventory(fake, "golden_helmet", 1);
    const slots = fake.inventory as EventEmitter & {
      slots: (Record<string, unknown> | null)[];
    };
    Object.assign(fake.bot, {
      equip: vi.fn(async (item: Item, destination: string) => {
        const slot = fake.bot.getEquipmentDestSlot(destination);
        const previous = slots.slots[slot] ?? null;
        slots.slots[slot] = item as unknown as Record<string, unknown>;
        fake.inventory.emit("updateSlot", slot, previous, item);
      }),
    });
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    body.setDamageReflexEnabled(true);

    (fake.bot as unknown as EventEmitter).emit(
      "entityHurt",
      fake.bot.entity,
      zombie,
    );
    await vi.waitFor(
      () =>
        expect(
          events.some((event) => event.type === "damage_reflex_completed"),
        ).toBe(true),
      { timeout: 2_000 },
    );

    const completion = events.find(
      (event) => event.type === "damage_reflex_completed",
    );
    expect(completion).toMatchObject({
      operationKind: "attack",
      status: "unverified",
      serverConfirmedAt: null,
      sameLife: null,
      summary: "action_unverified",
    });
    expect(fake.bot.attack).toHaveBeenCalled();
  });

  it("holds a damage reflex through death and resumes after the next spawned life", async () => {
    const fake = makeFakeBot();
    const zombie = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    const botEvents = fake.bot as unknown as EventEmitter;
    const attack = vi.fn((_target: Entity) => {
      if (attack.mock.calls.length > 1)
        botEvents.emit("entityHurt", zombie, fake.bot.entity);
    });
    Object.assign(fake.bot, { attack });
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    body.setDamageReflexEnabled(true);

    botEvents.emit("entityHurt", fake.bot.entity, zombie);
    await vi.waitFor(() => expect(attack.mock.calls.length).toBeGreaterThan(0));
    fake.bot.health = 0;
    botEvents.emit("health");
    botEvents.emit("death");
    const attacksWhileDead = attack.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(attack).toHaveBeenCalledTimes(attacksWhileDead);

    fake.bot.health = 20;
    botEvents.emit("spawn");
    botEvents.emit("health");
    await vi.waitFor(() =>
      expect(attack.mock.calls.length).toBeGreaterThan(attacksWhileDead),
    );
    await vi.waitFor(
      () =>
        expect(
          events.some((event) => event.type === "damage_reflex_completed"),
        ).toBe(true),
      { timeout: 2_000 },
    );

    expect(
      events.filter((event) => event.type === "damage_reflex_started"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.type === "damage_reflex_completed"),
    ).toMatchObject({
      operationKind: "attack",
      status: "successful",
      sameLife: false,
      summary: "hit_confirmed",
    });
  });

  it("retains damage attribution through a positive health packet before death", () => {
    const fake = makeFakeBot();
    const zombie = {
      id: 2,
      name: "zombie",
      type: "mob",
      position: new Vec3(0, 64, -2),
    } as unknown as Entity;
    registerFakeZombie(fake);
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    const botEvents = fake.bot as unknown as EventEmitter;

    botEvents.emit("entityHurt", fake.bot.entity, zombie);
    fake.bot.health = 2.33;
    botEvents.emit("health");
    fake.bot.health = 0;
    botEvents.emit("health");
    botEvents.emit("death");

    expect(events.find((event) => event.type === "bot_death")).toMatchObject({
      type: "bot_death",
      cause: {
        source: { kind: "mob", name: "zombie", category: "Hostile mobs" },
        confidence: "observed",
        provenance: "damage_event",
      },
    });
    expect(events.filter((event) => event.type === "bot_death")).toHaveLength(
      1,
    );
    botEvents.emit("end", "test complete");
  });

  it("resolves a registry-backed attacker translation in a self death notice", () => {
    const fake = makeFakeBot();
    registerFakeZombie(fake);
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    const botEvents = fake.bot as unknown as EventEmitter;

    botEvents.emit(
      "message",
      {
        json: {
          translate: "death.attack.mob",
          with: [{ text: "bot" }, { translate: "entity.minecraft.zombie" }],
        },
      },
      "system",
      null,
    );
    botEvents.emit("death");

    const deathEvent = events.at(-1);
    expect(deathEvent?.type).toBe("bot_death");
    if (deathEvent?.type !== "bot_death") {
      throw new Error("expected bot death event");
    }
    expect(deathEvent.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(deathEvent).toEqual({
      type: "bot_death",
      at: deathEvent.at,
      cause: {
        source: { kind: "mob", name: "zombie", category: "Hostile mobs" },
        confidence: "observed",
        provenance: "death_notification",
        causeKey: "death.attack.mob",
      },
    });
    botEvents.emit("end", "test complete");
  });

  it("resolves only exact registry display names and preserves unknown or player attackers generically", () => {
    const observeCause = (key: string, attacker: unknown) => {
      const fake = makeFakeBot();
      registerFakeZombie(fake);
      const body = new MineflayerPlayerBody(() => fake.bot);
      const events: PlayerBodyEvent[] = [];
      body.onEvent((event) => events.push(event));
      const botEvents = fake.bot as unknown as EventEmitter;
      botEvents.emit(
        "message",
        {
          json: {
            translate: key,
            with: [{ text: "bot" }, attacker],
          },
        },
        "system",
        null,
      );
      botEvents.emit("death");
      const death = events.find((event) => event.type === "bot_death");
      botEvents.emit("end", "test complete");
      return death;
    };

    expect(observeCause("death.attack.mob", { text: "Zombie" })).toMatchObject({
      type: "bot_death",
      cause: {
        source: { kind: "mob", name: "zombie", category: "Hostile mobs" },
        causeKey: "death.attack.mob",
      },
    });
    expect(
      observeCause("death.attack.mob", { text: "Custom Zombie" }),
    ).toMatchObject({
      type: "bot_death",
      cause: {
        source: {
          kind: "death_cause",
          name: "death.attack.mob",
          category: null,
        },
        causeKey: "death.attack.mob",
      },
    });
    expect(
      observeCause("death.attack.player", { text: "Zombie" }),
    ).toMatchObject({
      type: "bot_death",
      cause: {
        source: {
          kind: "death_cause",
          name: "death.attack.player",
          category: null,
        },
        causeKey: "death.attack.player",
      },
    });
  });

  it("attaches a late self death notice to the same death without another death event", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      registerFakeZombie(fake);
      const body = new MineflayerPlayerBody(() => fake.bot);
      const events: PlayerBodyEvent[] = [];
      body.onEvent((event) => events.push(event));
      const botEvents = fake.bot as unknown as EventEmitter;
      fake.bot.health = 0;
      botEvents.emit("health");
      botEvents.emit("death");
      const death = events.find((event) => event.type === "bot_death");
      expect(death).toBeDefined();

      await vi.advanceTimersByTimeAsync(500);
      botEvents.emit(
        "message",
        {
          json: {
            translate: "death.attack.mob",
            with: [{ text: "bot" }, { translate: "entity.minecraft.zombie" }],
          },
        },
        "system",
        null,
      );

      expect(events.filter((event) => event.type === "bot_death")).toHaveLength(
        1,
      );
      expect(events.at(-1)).toMatchObject({
        type: "bot_death_cause_updated",
        deathAt: death?.at,
        cause: {
          source: { kind: "mob", name: "zombie", category: "Hostile mobs" },
          causeKey: "death.attack.mob",
          confidence: "observed",
          provenance: "death_notification",
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      botEvents.emit(
        "message",
        {
          json: {
            translate: "death.attack.arrow",
            with: [{ text: "bot" }, { text: "Arrow" }],
          },
        },
        "system",
        null,
      );
      expect(
        events.filter((event) => event.type === "bot_death_cause_updated"),
      ).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: "bot_death_cause_updated",
        cause: {
          source: { kind: "mob", name: "zombie", category: "Hostile mobs" },
          causeKey: "death.attack.mob",
        },
      });

      await vi.advanceTimersByTimeAsync(901);
      botEvents.emit(
        "message",
        {
          json: {
            translate: "death.attack.mob",
            with: [{ text: "bot" }, { translate: "entity.minecraft.zombie" }],
          },
        },
        "system",
        null,
      );
      expect(
        events.filter((event) => event.type === "bot_death_cause_updated"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not turn player-authored or another player's death text into self-cause", () => {
    const fake = makeFakeBot();
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    const botEvents = fake.bot as unknown as EventEmitter;
    const message = (victim: string) => ({
      json: {
        translate: "death.attack.mob",
        with: [{ text: victim }, { text: "Zombie" }],
      },
    });

    botEvents.emit("message", message("bot"), "chat", null);
    botEvents.emit("message", message("another"), "system", null);
    botEvents.emit("message", message("bot"), "system", "player-uuid");
    botEvents.emit("death");

    const deathEvent = events.at(-1);
    expect(deathEvent?.type).toBe("bot_death");
    if (deathEvent?.type !== "bot_death") {
      throw new Error("expected bot death event");
    }
    expect(deathEvent.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(deathEvent).toEqual({ type: "bot_death", at: deathEvent.at });
  });

  it("limits block and entity perception to visible, unoccluded targets and labels unknowns", () => {
    const fake = makeFakeBot();
    const chestPoint = new Vec3(0, 64, -2);
    const hiddenBlock = new Vec3(0, 64, -3);
    fake.blocks.set("0,64,-2", makeBlock("chest", 3, chestPoint));
    fake.blocks.set("0,64,-3", makeBlock("stone", 1, hiddenBlock));
    fake.candidates.push(chestPoint, hiddenBlock, new Vec3(4, 64, -2));
    fake.hiddenBlockKeys.add("0,64,-3");
    const unknownHealthEntity = {
      id: 2,
      name: "cow",
      type: "mob",
      position: new Vec3(0, 64, -4),
      velocity: new Vec3(0, 0, 0),
      height: 1.4,
      username: undefined,
    };
    const occludedEntity = {
      ...unknownHealthEntity,
      id: 3,
      position: new Vec3(2, 64, -4),
    };
    Object.assign(fake.bot, {
      entities: {
        1: (fake.bot as unknown as { entity: unknown }).entity,
        2: unknownHealthEntity,
        3: occludedEntity,
      },
      players: {
        Owner: {
          entity: {
            ...unknownHealthEntity,
            id: 4,
            position: new Vec3(0, 64, -6),
            username: "Owner",
          },
        },
      },
    });
    const observation = observePlayerBody(fake.bot, "owner");
    expect(observation.observedAt).toMatch(/^\d{4}-/);
    expect(observation.perception.blocks.map((block) => block.name)).toContain(
      "chest",
    );
    expect(
      observation.perception.blocks.map((block) => block.name),
    ).not.toContain("stone");
    expect(
      observation.perception.entities.map((entity) => entity.id),
    ).toContain(2);
    expect(
      observation.perception.entities.map((entity) => entity.id),
    ).not.toContain(3);
    expect(
      observation.perception.entities.find((entity) => entity.id === 2)?.health,
    ).toBeNull();
    expect(observation.perception.ownerPositionException).toBeUndefined();
    expect(
      observePlayerBody(fake.bot, "owner", { ownerPositionException: true })
        .perception.ownerPositionException?.source,
    ).toBe("owner_position_exception");
  });

  it("uses MineflayerClient's authoritative oxygen in PlayerBody observations", async () => {
    const fake = makeFakeBot();
    fake.bot.oxygenLevel = 0;
    const client = new MineflayerClient(
      {
        bot: { username: "fixture_bot" },
        ownerUsername: "fixture_owner",
        pathfinderThinkTimeoutMs: 100,
        pathfinderTickTimeoutMs: 10,
        collectTimeoutMs: 100,
      },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    Object.assign(client, {
      spawned: true,
      botInstance: fake.bot,
      authoritativeOxygen: 12,
    });

    const observation = await client.createPlayerBody().observe();

    expect(fake.bot.oxygenLevel).toBe(0);
    expect(observation.self.oxygen).toBe(12);
  });

  it("searches past a dominant block name and balances the capped visible list", () => {
    const fake = makeFakeBot();
    for (let z = -6; z >= -15 && fake.candidates.length < 192; z -= 1) {
      for (let x = -5; x <= 5 && fake.candidates.length < 192; x += 1) {
        for (let y = 63; y <= 65 && fake.candidates.length < 192; y += 1) {
          const point = new Vec3(x, y, z);
          fake.blocks.set(`${x},${y},${z}`, makeBlock("stone", 1, point));
          fake.candidates.push(point);
        }
      }
    }
    const oakLogA = new Vec3(0, 64, -5);
    const oakLogB = new Vec3(1, 64, -5);
    const hiddenChest = new Vec3(0, 64, -4);
    fake.blocks.set("0,64,-5", makeBlock("oak_log", 4, oakLogA));
    fake.blocks.set("1,64,-5", makeBlock("oak_log", 4, oakLogB));
    fake.blocks.set("0,64,-4", makeBlock("chest", 3, hiddenChest));
    fake.candidates.push(oakLogA, oakLogB, hiddenChest);
    fake.hiddenBlockKeys.add("0,64,-4");

    const observation = observePlayerBody(fake.bot, "owner");
    const visibleNames = observation.perception.blocks.map(
      (block) => block.name,
    );

    expect(fake.candidates).toHaveLength(195);
    expect(fake.findBlockSearches).toEqual([
      { count: 8, resultCount: 0 },
      { count: 192, resultCount: 192 },
      { count: 192, resultCount: 3 },
    ]);
    expect(observation.perception.blocks).toHaveLength(96);
    expect(visibleNames).toContain("oak_log");
    expect(visibleNames).not.toContain("chest");
    expect(observation.perception.omittedBlockCandidates).toBe(98);
    expect(observation.perception.candidateSearchMayBeTruncated).toBe(true);
  });

  it("searches past several saturated ordinary block types for a visible rare target", () => {
    const fake = makeFakeBot();
    const ordinaryNames = ["stone", "dirt", "grass_block"];
    for (let z = -5; z >= -15 && fake.candidates.length < 576; z -= 1) {
      for (let x = -8; x <= 8 && fake.candidates.length < 576; x += 1) {
        for (let y = 62; y <= 66 && fake.candidates.length < 576; y += 1) {
          const point = new Vec3(x, y, z);
          if (
            point.distanceTo(new Vec3(0, 64, 0)) > 16 ||
            (x === 0 && y === 65 && z === -15)
          )
            continue;
          const name = ordinaryNames[fake.candidates.length % 3] ?? "stone";
          fake.blocks.set(`${x},${y},${z}`, makeBlock(name, 1, point));
          fake.candidates.push(point);
        }
      }
    }
    const target = new Vec3(0, 65, -15);
    fake.blocks.set("0,65,-15", makeBlock("blue_wool", 2, target));
    fake.candidates.push(target);

    const observation = observePlayerBody(fake.bot, "owner");
    expect(fake.candidates).toHaveLength(577);
    expect(fake.findBlockSearches).toHaveLength(3);
    expect(fake.findBlockSearches.slice(1)).toHaveLength(2);
    expect(observation.perception.blocks.map(({ name }) => name)).toContain(
      "blue_wool",
    );
    expect(observation.perception.candidateSearchMayBeTruncated).toBe(true);
  });

  it("reserves the first crosshair hit when a common block type fills the search cap", () => {
    const fake = makeFakeBot();
    addOffAxisStoneCandidates(fake, 192);
    const target = new Vec3(0, 65, -15);
    const targetBlock = makeBlock("stone", 1, target);
    fake.blocks.set("0,65,-15", targetBlock);
    fake.setCrosshairRaycastResult(targetBlock);

    const observation = observePlayerBody(fake.bot, "owner");
    const targetKey = "0,65,-15";
    const observedKeys = observation.perception.blocks.map(
      ({ position }) =>
        `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`,
    );

    expect(fake.findBlockSearches.find(({ count }) => count === 192)).toEqual({
      count: 192,
      resultCount: 192,
    });
    expect(observation.perception.blocks).toHaveLength(96);
    expect(observedKeys).toContain(targetKey);
    expect(new Set(observedKeys).size).toBe(96);
    expect(observation.perception.candidateSearchMayBeTruncated).toBe(true);
  });

  it("keeps nearby hand-operable doors visible when saturated block searches omit them", () => {
    const fake = makeFakeBot();
    const ordinaryNames = ["stone", "dirt", "grass_block"];
    const ordinaryPositions: Vec3[] = [];
    for (let z = -5; z >= -16; z -= 1) {
      for (let x = -7; x <= 7; x += 1) {
        for (let y = 62; y <= 66; y += 1) {
          const position = new Vec3(x, y, z);
          if (position.distanceTo(fake.bot.entity.position) <= 16)
            ordinaryPositions.push(position);
        }
      }
    }
    expect(ordinaryPositions.length).toBeGreaterThanOrEqual(576);
    for (let index = 0; index < 576; index += 1) {
      const position = ordinaryPositions[index];
      if (position === undefined) throw new Error("Missing fixture position");
      const name = ordinaryNames[Math.floor(index / 192)];
      if (name === undefined) throw new Error("Missing fixture block name");
      fake.blocks.set(
        `${position.x},${position.y},${position.z}`,
        makeBlock(name, index + 10, position),
      );
      fake.candidates.push(position);
    }

    const visibleDoorPositions = [new Vec3(0, 64, -2), new Vec3(0, 65, -2)];
    for (const [index, position] of visibleDoorPositions.entries()) {
      const door = makeBlock("oak_door", 700 + index, position);
      door.getProperties = () => ({
        half: index === 0 ? "lower" : "upper",
        open: false,
      });
      fake.blocks.set(`${position.x},${position.y},${position.z}`, door);
      fake.candidates.push(position);
    }

    const hiddenDoorPositions = [new Vec3(1, 64, -2), new Vec3(1, 65, -2)];
    for (const [index, position] of hiddenDoorPositions.entries()) {
      const door = makeBlock("oak_door", 710 + index, position);
      door.getProperties = () => ({ half: index === 0 ? "lower" : "upper" });
      fake.blocks.set(`${position.x},${position.y},${position.z}`, door);
      fake.candidates.push(position);
      fake.hiddenBlockKeys.add(`${position.x},${position.y},${position.z}`);
    }

    const outsideFovPosition = new Vec3(4, 65, 0);
    const outsideFovDoor = makeBlock("oak_door", 720, outsideFovPosition);
    fake.blocks.set("4,65,0", outsideFovDoor);
    fake.candidates.push(outsideFovPosition);

    const observation = observePlayerBody(fake.bot, "owner");
    const observedDoorKeys = observation.perception.blocks
      .filter((block) => block.name === "oak_door")
      .map(({ position }) => `${position.x},${position.y},${position.z}`);

    expect(fake.findBlockSearches).toEqual([
      { count: 8, resultCount: 5 },
      { count: 192, resultCount: 192 },
      { count: 192, resultCount: 192 },
      { count: 192, resultCount: 192 },
    ]);
    expect([...observedDoorKeys].sort()).toEqual(["0,64,-2", "0,65,-2"].sort());
    expect(
      observation.perception.blocks.find(
        ({ name, position }) =>
          name === "oak_door" && position.x === 0 && position.y === 64,
      )?.properties,
    ).toEqual({ half: "lower", open: false });
    expect(observation.perception.blocks).toHaveLength(96);
    expect(observation.perception.candidateSearchMayBeTruncated).toBe(true);
  });

  it("does not expose a block behind the first crosshair hit", () => {
    const fake = makeFakeBot();
    const blockerPosition = new Vec3(0, 65, -6);
    const hiddenTarget = new Vec3(0, 65, -9);
    const blocker = makeBlock("stone", 1, blockerPosition);
    fake.blocks.set("0,65,-6", blocker);
    fake.blocks.set("0,65,-9", makeBlock("chest", 3, hiddenTarget));
    fake.candidates.push(blockerPosition, hiddenTarget);
    fake.hiddenBlockKeys.add("0,65,-9");
    fake.setCrosshairRaycastResult(blocker);

    const observation = observePlayerBody(fake.bot, "owner");
    const observedNames = observation.perception.blocks.map(({ name }) => name);
    const blockerCount = observation.perception.blocks.filter(
      ({ position }) =>
        position.x === blockerPosition.x &&
        position.y === blockerPosition.y &&
        position.z === blockerPosition.z,
    ).length;

    expect(observedNames).toContain("stone");
    expect(observedNames).not.toContain("chest");
    expect(blockerCount).toBe(1);
  });

  it("reports a visible, reachable air opening with its supporting face", () => {
    const fake = makeFakeBot();
    const opening = addWallWithOpening(fake);

    const observation = observePlayerBody(fake.bot, "owner");
    const candidate = observation.perception.placementCandidates.find(
      ({ position }) =>
        position.x === opening.x &&
        position.y === opening.y &&
        position.z === opening.z,
    );

    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({
      position: { x: opening.x, y: opening.y, z: opening.z },
      supportingBlock: { name: "oak_planks" },
    });
    expect(candidate?.distance).toBeLessThanOrEqual(4.5);
    expect(
      playerOperationSchema.parse({
        kind: "place",
        item: "oak_planks",
        position: candidate?.position,
        face: candidate?.face,
      }),
    ).toMatchObject({ kind: "place", position: candidate?.position });
    expect(observation.perception.placementCandidateLimit).toBe(24);
    expect(observation.perception.placementCandidatesMayBeTruncated).toBe(
      false,
    );
    expect(
      observation.perception.placementCandidates.some(({ position }) =>
        fake.blocks.has(`${position.x},${position.y},${position.z}`),
      ),
    ).toBe(false);

    const faceNormals = {
      up: [0, 1, 0],
      down: [0, -1, 0],
      north: [0, 0, -1],
      south: [0, 0, 1],
      east: [1, 0, 0],
      west: [-1, 0, 0],
    } as const;
    const normal =
      candidate?.face === undefined ? undefined : faceNormals[candidate.face];
    expect(normal).toBeDefined();
    expect(candidate?.supportingBlock.position).toEqual({
      x: opening.x - (normal?.[0] ?? 0),
      y: opening.y - (normal?.[1] ?? 0),
      z: opening.z - (normal?.[2] ?? 0),
    });
  });

  it("omits an otherwise valid opening hidden behind a solid block", () => {
    const fake = makeFakeBot();
    const opening = addWallWithOpening(fake);
    const blockerPosition = new Vec3(0, 65, -2);
    const blocker = makeBlock("stone", 1, blockerPosition);
    fake.blocks.set("0,65,-2", blocker);
    fake.candidates.push(blockerPosition);
    fake.setPlacementRaycastBlocker(opening, blockerPosition);

    const observation = observePlayerBody(fake.bot, "owner");

    expect(
      observation.perception.placementCandidates.some(
        ({ position }) =>
          position.x === opening.x &&
          position.y === opening.y &&
          position.z === opening.z,
      ),
    ).toBe(false);
  });

  it("does not report air cells outside the normal placement interaction range", () => {
    const fake = makeFakeBot();
    const distantSupport = new Vec3(0, 65, -6);
    fake.blocks.set("0,65,-6", makeBlock("stone", 1, distantSupport));
    fake.candidates.push(distantSupport);

    const observation = observePlayerBody(fake.bot, "owner");

    expect(
      observation.perception.placementCandidates.some(
        ({ position }) =>
          position.x === 0 && position.y === 65 && position.z === -5,
      ),
    ).toBe(false);
  });

  it("does not report a reachable air cell outside the body view cone", () => {
    const fake = makeFakeBot();
    const support = new Vec3(2, 65, -1);
    fake.blocks.set("2,65,-1", makeBlock("stone", 1, support));
    fake.candidates.push(support);

    const observation = observePlayerBody(fake.bot, "owner");

    expect(
      observation.perception.placementCandidates.some(
        ({ position }) =>
          position.x === 3 && position.y === 65 && position.z === -1,
      ),
    ).toBe(false);
  });

  it("caps placement candidates and marks incomplete coverage", () => {
    const fake = makeFakeBot();
    for (let x = -2; x <= 2; x += 1) {
      for (let y = 64; y <= 67; y += 1) {
        const position = new Vec3(x, y, -3);
        fake.blocks.set(`${x},${y},-3`, makeBlock("stone", 1, position));
        fake.candidates.push(position);
      }
    }

    const observation = observePlayerBody(fake.bot, "owner");

    expect(observation.perception.placementCandidateLimit).toBe(24);
    expect(observation.perception.placementCandidates).toHaveLength(24);
    expect(observation.perception.omittedPlacementCandidates).toBeGreaterThan(
      0,
    );
    expect(observation.perception.placementCandidatesMayBeTruncated).toBe(true);
    expect(
      new Set(
        observation.perception.placementCandidates.map(
          ({ position }) => `${position.x},${position.y},${position.z}`,
        ),
      ).size,
    ).toBe(24);
  });

  it("ignores null, malformed, and air crosshair raycast results", () => {
    const fake = makeFakeBot();
    const airPosition = new Vec3(0, 65, -5);
    const invalidResults: unknown[] = [
      null,
      undefined,
      42,
      { x: Number.NaN, y: 65, z: -5 },
      makeBlock("air", 0, airPosition),
    ];

    for (const result of invalidResults) {
      fake.setCrosshairRaycastResult(result);
      expect(observePlayerBody(fake.bot, "owner").perception.blocks).toEqual(
        [],
      );
    }
  });

  it("does not treat local-only dig mutation as success, but accepts a server block packet", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const target = new Vec3(0, 64, -2);
      fake.blocks.set("0,64,-2", makeBlock("stone", 1, target));
      fake.candidates.push(target);
      Object.assign(fake.bot, { digTime: vi.fn(() => 1_000) });
      const body = new MineflayerPlayerBody(() => fake.bot);
      vi.mocked(fake.bot.dig).mockImplementationOnce(async () => {
        fake.blocks.set("0,64,-2", makeBlock("air", 0, target));
      });
      const localOnlyPromise = body.execute({
        kind: "dig",
        position: { x: 0, y: 64, z: -2 },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const localOnly = await localOnlyPromise;
      expect(localOnly.status).toBe("unverified");

      fake.blocks.set("0,64,-2", makeBlock("stone", 1, target));
      vi.mocked(fake.bot.dig).mockImplementationOnce(async () => {
        fake.blocks.set("0,64,-2", makeBlock("air", 0, target));
        (fake.bot._client as unknown as EventEmitter).emit("block_change", {
          location: { x: 0, y: 64, z: -2 },
          type: 0,
        });
      });
      const serverConfirmed = await body.execute({
        kind: "dig",
        position: { x: 0, y: 64, z: -2 },
      });
      expect(serverConfirmed.status).toBe("successful");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aims at a loaded, reachable block before rechecking view and digging", async () => {
    const fake = makeFakeBot();
    const target = new Vec3(0, 64, 2);
    const targetKey = "0,64,2";
    fake.blocks.set(targetKey, makeBlock("stone", 1, target));
    fake.candidates.push(target);
    Object.assign(fake.bot, { digTime: vi.fn(() => 1_000) });
    expect(
      observePlayerBody(fake.bot, "owner").perception.blocks.some(
        (block) => block.position.z === target.z,
      ),
    ).toBe(false);
    vi.mocked(fake.bot.dig).mockImplementationOnce(async () => {
      expect(fake.bot.lookAt).toHaveBeenCalledWith(
        target.offset(0.5, 0.5, 0.5),
        true,
      );
      expect(
        observePlayerBody(fake.bot, "owner").perception.blocks.some(
          (block) => block.position.z === target.z,
        ),
      ).toBe(true);
      fake.blocks.set(targetKey, makeBlock("air", 0, target));
      (fake.bot._client as unknown as EventEmitter).emit("block_change", {
        location: target,
        type: 0,
      });
    });

    const result = await new MineflayerPlayerBody(() => fake.bot).execute({
      kind: "dig",
      position: { x: target.x, y: target.y, z: target.z },
    });

    expect(fake.bot.dig).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("successful");
  });

  it("does not dig after aiming if the block stays occluded or the Bot changes", async () => {
    const fake = makeFakeBot();
    const target = new Vec3(0, 64, 2);
    const targetKey = "0,64,2";
    fake.blocks.set(targetKey, makeBlock("stone", 1, target));
    fake.candidates.push(target);
    Object.assign(fake.bot, { digTime: vi.fn(() => 1_000) });
    fake.hiddenBlockKeys.add(targetKey);
    let currentBot = fake.bot;
    const body = new MineflayerPlayerBody(() => currentBot);

    const occluded = await body.execute({
      kind: "dig",
      position: { x: target.x, y: target.y, z: target.z },
    });
    expect(fake.bot.lookAt).toHaveBeenCalledTimes(1);
    expect(fake.bot.dig).not.toHaveBeenCalled();
    expect(occluded.status).toBe("failed");
    expect(occluded.detail).toContain("Target block is occluded");

    fake.hiddenBlockKeys.delete(targetKey);
    const replacement = makeFakeBot();
    vi.mocked(fake.bot.lookAt).mockImplementationOnce(async () => {
      currentBot = replacement.bot;
    });
    const changedBot = await body.execute({
      kind: "dig",
      position: { x: target.x, y: target.y, z: target.z },
    });
    expect(fake.bot.dig).not.toHaveBeenCalled();
    expect(changedBot.status).toBe("failed");
    expect(changedBot.detail).toContain("Minecraft bot changed while aiming");
  });

  it("does not start digging when the operation is cancelled while aiming", async () => {
    const fake = makeFakeBot();
    const target = new Vec3(0, 64, 2);
    fake.blocks.set("0,64,2", makeBlock("stone", 1, target));
    fake.candidates.push(target);
    const controller = new AbortController();
    let markLookStarted!: () => void;
    const lookStarted = new Promise<void>((resolve) => {
      markLookStarted = resolve;
    });
    let resolveLook!: () => void;
    const pendingLook = new Promise<void>((resolve) => {
      resolveLook = resolve;
    });
    vi.mocked(fake.bot.lookAt).mockImplementationOnce(async () => {
      markLookStarted();
      await pendingLook;
    });

    const resultPromise = new MineflayerPlayerBody(() => fake.bot).execute(
      { kind: "dig", position: { x: target.x, y: target.y, z: target.z } },
      controller.signal,
    );
    await lookStarted;
    controller.abort(new Error("Owner stopped the operation"));
    const result = await resultPromise;
    resolveLook();

    expect(result.status).toBe("interrupted");
    expect(fake.bot.dig).not.toHaveBeenCalled();
  });

  it("waits for the target's server block update after native placement resolves", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const target = preparePlaceFixture(fake);
      let markStarted!: () => void;
      let resolvePlace!: (position: Vec3) => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const nativePlace = new Promise<Vec3>((resolve) => {
        resolvePlace = resolve;
      });
      Object.assign(fake.bot, {
        _genericPlace: vi.fn(() => {
          markStarted();
          return nativePlace;
        }),
      });
      const body = new MineflayerPlayerBody(() => fake.bot);
      const resultPromise = body.execute({
        kind: "place",
        position: { x: 0, y: 64, z: -2 },
        item: "oak_planks",
        face: "south",
      });
      await Promise.race([
        started,
        resultPromise.then((result) => {
          throw new Error(
            `Placement ended before native call: ${result.detail}`,
          );
        }),
      ]);
      resolvePlace(target);
      let completed = false;
      void resultPromise.then(() => {
        completed = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(completed).toBe(false);

      fake.blocks.set("0,64,-2", makeBlock("oak_planks", 4, target));
      (fake.bot._client as unknown as EventEmitter).emit("block_change", {
        location: { x: 0, y: 64, z: -2 },
        type: 4,
      });
      const result = await resultPromise;
      expect(result.status).toBe("successful");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a locally changed placement unverified without a server block update", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const target = preparePlaceFixture(fake);
      Object.assign(fake.bot, {
        _genericPlace: vi.fn(async () => {
          fake.blocks.set("0,64,-2", makeBlock("oak_planks", 4, target));
          return target;
        }),
      });
      const body = new MineflayerPlayerBody(() => fake.bot);
      const resultPromise = body.execute({
        kind: "place",
        position: { x: 0, y: 64, z: -2 },
        item: "oak_planks",
        face: "south",
      });
      await vi.advanceTimersByTimeAsync(5_001);
      const result = await resultPromise;
      expect(result.status).toBe("unverified");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails move_to when an empty noPath update is followed by goto resolution", async () => {
    const fake = makeFakeBot();
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    vi.spyOn(fake.bot.pathfinder, "goto").mockImplementationOnce(async () => {
      fake.bot.emit("path_update", {
        status: "noPath",
        path: [],
        cost: 0,
        time: 0,
        visitedNodes: 0,
        generatedNodes: 0,
      });
    });

    const result = await body.execute({
      kind: "move_to",
      position: { x: 5, y: 64, z: 0 },
      range: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toBe("Error: No path to the goal!");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "operation_path_updated",
        operationId: result.operationId,
        status: "noPath",
        pathLength: 0,
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "operation_failed",
      operation: "move_to",
      operationId: result.operationId,
    });
    expect(pathUpdateListenerCount(fake.bot)).toBe(0);
  });

  it("reports travel stalls despite changing world time and resets after real movement", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      let finishGoto: (() => void) | undefined;
      vi.spyOn(fake.bot.pathfinder, "goto").mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishGoto = resolve;
          }),
      );
      const body = new MineflayerPlayerBody(() => fake.bot);
      const events: PlayerBodyEvent[] = [];
      body.onEvent((event) => events.push(event));
      const resultPromise = body.execute({
        kind: "move_to",
        position: { x: 8, y: 64, z: 0 },
        range: 1,
      });
      await vi.advanceTimersByTimeAsync(0);

      for (let tick = 0; tick < 4; tick += 1) {
        fake.bot.time.timeOfDay += 100;
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(
        events.filter(({ type }) => type === "operation_stalled"),
      ).toHaveLength(1);

      fake.bot.entity.position.x = 0.8;
      await vi.advanceTimersByTimeAsync(25_000);
      expect(
        events.filter(({ type }) => type === "operation_stalled"),
      ).toHaveLength(2);

      finishGoto?.();
      await resultPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a later path update supersede stale noPath and keeps an unreached move unverified", async () => {
    const fake = makeFakeBot();
    const body = new MineflayerPlayerBody(() => fake.bot);
    vi.spyOn(fake.bot.pathfinder, "goto").mockImplementationOnce(async () => {
      fake.bot.emit("path_update", {
        status: "noPath",
        path: [],
        cost: 0,
        time: 0,
        visitedNodes: 0,
        generatedNodes: 0,
      });
      fake.bot.emit("path_update", {
        status: "success",
        path: [],
        cost: 0,
        time: 0,
        visitedNodes: 0,
        generatedNodes: 0,
      });
    });

    const result = await body.execute({
      kind: "move_to",
      position: { x: 5, y: 64, z: 0 },
      range: 1,
    });

    expect(result.status).toBe("unverified");
    expect(pathUpdateListenerCount(fake.bot)).toBe(0);
  });

  it("keeps a normally resolved but unobserved move_to unverified", async () => {
    const fake = makeFakeBot();
    const body = new MineflayerPlayerBody(() => fake.bot);

    const result = await body.execute({
      kind: "move_to",
      position: { x: 5, y: 64, z: 0 },
      range: 1,
    });

    expect(result.status).toBe("unverified");
    expect(pathUpdateListenerCount(fake.bot)).toBe(0);
  });

  it("keeps observed move_to arrival successful after a noPath update", async () => {
    const fake = makeFakeBot();
    const body = new MineflayerPlayerBody(() => fake.bot);
    vi.spyOn(fake.bot.pathfinder, "goto").mockImplementationOnce(async () => {
      fake.bot.emit("path_update", {
        status: "noPath",
        path: [],
        cost: 0,
        time: 0,
        visitedNodes: 0,
        generatedNodes: 0,
      });
      fake.bot.entity.position.x = 5;
    });

    const result = await body.execute({
      kind: "move_to",
      position: { x: 5, y: 64, z: 0 },
      range: 1,
    });

    expect(result.status).toBe("successful");
    expect(pathUpdateListenerCount(fake.bot)).toBe(0);
  });

  it("confirms move_to using GoalNear's floored block range", async () => {
    const fake = makeFakeBot();
    const body = new MineflayerPlayerBody(() => fake.bot);
    vi.spyOn(fake.bot.pathfinder, "goto").mockImplementationOnce(async () => {
      fake.bot.entity.position.x = 4;
    });

    const result = await body.execute({
      kind: "move_to",
      position: { x: 5.9, y: 64, z: 0 },
      range: 1,
    });

    expect(result.status).toBe("successful");
    expect(pathUpdateListenerCount(fake.bot)).toBe(0);
  });

  it("waits for spawn admission before executing a selected relative move", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const notConnected = new AppError({
        category: "connection",
        code: "MINECRAFT_NOT_CONNECTED",
        message: "not connected",
        retryable: true,
      });
      let admitted = false;
      const body = new MineflayerPlayerBody(() => {
        if (!admitted) throw notConnected;
        return fake.bot;
      });
      body.attach(fake.bot);
      const goto = vi
        .spyOn(fake.bot.pathfinder, "goto")
        .mockImplementationOnce(async () => {
          fake.bot.entity.position.x = 13;
        });

      const pending = body.execute({
        kind: "move_relative",
        offset: { x: 3, y: 0, z: 0 },
        range: 1,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(goto).not.toHaveBeenCalled();

      (fake.bot as unknown as EventEmitter).emit("spawn");
      await vi.advanceTimersByTimeAsync(100);
      expect(goto).not.toHaveBeenCalled();

      fake.bot.entity.position.x = 10;
      admitted = true;
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;

      expect(result.status).toBe("successful");
      expect(result.before?.self.position.x).toBe(10);
      expect(goto).toHaveBeenCalledOnce();
      expect(goto.mock.calls[0]?.[0]).toMatchObject({ x: 13, y: 64, z: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending spawn admission through signal or body stop", async () => {
    vi.useFakeTimers();
    try {
      for (const cancellation of ["signal", "stop"] as const) {
        const fake = makeFakeBot();
        const notConnected = new AppError({
          category: "connection",
          code: "MINECRAFT_NOT_CONNECTED",
          message: "not connected",
          retryable: true,
        });
        const body = new MineflayerPlayerBody(() => {
          throw notConnected;
        });
        body.attach(fake.bot);
        const goto = vi.spyOn(fake.bot.pathfinder, "goto");
        const controller = new AbortController();
        const pending = body.execute(
          {
            kind: "move_relative",
            offset: { x: 3, y: 0, z: 0 },
            range: 1,
          },
          cancellation === "signal" ? controller.signal : undefined,
        );
        await vi.advanceTimersByTimeAsync(50);

        if (cancellation === "signal") controller.abort();
        else await body.stop();
        const result = await pending;

        expect(result.status).toBe("interrupted");
        expect(result.before).toBeNull();
        expect(goto).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves spawn admission errors on timeout and bot replacement", async () => {
    vi.useFakeTimers();
    try {
      const notConnected = new AppError({
        category: "connection",
        code: "MINECRAFT_NOT_CONNECTED",
        message: "not connected",
        retryable: true,
      });
      const denied = new AppError({
        category: "permission",
        code: "MINECRAFT_ACTION_DENIED",
        message: "action denied",
        retryable: false,
      });
      const deniedFixture = makeFakeBot();
      const deniedBody = new MineflayerPlayerBody(() => {
        throw denied;
      });
      deniedBody.attach(deniedFixture.bot);
      await expect(
        deniedBody.execute({
          kind: "move_relative",
          offset: { x: 3, y: 0, z: 0 },
          range: 1,
        }),
      ).rejects.toBe(denied);

      const timeoutFixture = makeFakeBot();
      const timeoutBody = new MineflayerPlayerBody(() => {
        throw notConnected;
      });
      timeoutBody.attach(timeoutFixture.bot);
      const timedOut = timeoutBody.execute({
        kind: "move_relative",
        offset: { x: 3, y: 0, z: 0 },
        range: 1,
      });
      const timeoutExpectation = expect(timedOut).rejects.toBe(notConnected);
      await vi.advanceTimersByTimeAsync(3_000);
      await timeoutExpectation;

      const oldBot = makeFakeBot();
      const replacementBot = makeFakeBot();
      let currentBot = oldBot.bot;
      const replacementBody = new MineflayerPlayerBody(() => {
        if (currentBot === oldBot.bot) throw notConnected;
        return currentBot;
      });
      replacementBody.attach(oldBot.bot);
      const replacementGoto = vi.spyOn(replacementBot.bot.pathfinder, "goto");
      const replaced = replacementBody.execute({
        kind: "move_relative",
        offset: { x: 3, y: 0, z: 0 },
        range: 1,
      });
      const replacementExpectation =
        expect(replaced).rejects.toBe(notConnected);
      await Promise.resolve();
      (oldBot.bot as unknown as EventEmitter).emit("end", "replaced");
      currentBot = replacementBot.bot;
      replacementBody.attach(replacementBot.bot);
      await vi.advanceTimersByTimeAsync(50);
      await replacementExpectation;
      expect(replacementGoto).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a relative move from the observed start and verifies arrival", async () => {
    const fake = makeFakeBot();
    fake.bot.entity.position.x = 4.2;
    fake.bot.entity.position.z = 2.4;
    const body = new MineflayerPlayerBody(() => fake.bot);
    let plannedGoal: unknown;
    const goto = vi
      .spyOn(fake.bot.pathfinder, "goto")
      .mockImplementationOnce(async (goal) => {
        plannedGoal = goal;
        fake.bot.entity.position.x = 8;
        fake.bot.entity.position.z = 1.1;
      });

    const result = await body.execute({
      kind: "move_relative",
      offset: { x: 3.8, y: 0, z: -1.3 },
      range: 1,
    });

    expect(result.status).toBe("successful");
    expect(result.operation.kind).toBe("move_relative");
    expect(goto).toHaveBeenCalledOnce();
    expect(plannedGoal).toMatchObject({ x: 8, y: 64, z: 1 });
    expect(pathUpdateListenerCount(fake.bot)).toBe(0);
  });

  it("does not claim a relative move succeeded without observed arrival", async () => {
    const fake = makeFakeBot();
    const body = new MineflayerPlayerBody(() => fake.bot);

    const result = await body.execute({
      kind: "move_relative",
      offset: { x: 6, y: 0, z: 0 },
      range: 1,
    });

    expect(result.status).toBe("unverified");
    expect(pathUpdateListenerCount(fake.bot)).toBe(0);
  });

  it("does not claim a relative move succeeded when already within arrival range without moving", async () => {
    const fake = makeFakeBot();
    const body = new MineflayerPlayerBody(() => fake.bot);

    const result = await body.execute({
      kind: "move_relative",
      offset: { x: 1.1, y: 0, z: 0 },
      range: 1,
    });

    expect(result.status).toBe("unverified");
    expect(pathUpdateListenerCount(fake.bot)).toBe(0);
  });

  it("removes the move_to path listener when goto rejects", async () => {
    const fake = makeFakeBot();
    const body = new MineflayerPlayerBody(() => fake.bot);
    vi.spyOn(fake.bot.pathfinder, "goto").mockRejectedValueOnce(
      new Error("NoPath: No path to the goal!"),
    );

    const result = await body.execute({
      kind: "move_to",
      position: { x: 5, y: 64, z: 0 },
      range: 1,
    });

    expect(result.status).toBe("failed");
    expect(pathUpdateListenerCount(fake.bot)).toBe(0);
  });

  it("waits briefly after native dig completion for a delayed target server update", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const dig = beginPendingDig(fake, 7_500);
      await dig.started;
      let completed = false;
      void dig.result.then(() => {
        completed = true;
      });
      setTimeout(() => dig.resolveNative(), 7_500);
      setTimeout(() => dig.sendServerAirUpdate(), 9_500);

      await vi.advanceTimersByTimeAsync(9_499);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const result = await dig.result;
      expect(result.status).toBe("successful");
      expect(result.recoveryRequired).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps dig unverified when only an acknowledgement and another block update arrive", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const dig = beginPendingDig(fake, 7_500);
      await dig.started;
      setTimeout(() => dig.resolveNative(), 7_500);
      setTimeout(() => {
        (fake.bot._client as unknown as EventEmitter).emit(
          "acknowledge_player_digging",
          { sequenceId: 1 },
        );
      }, 8_000);
      setTimeout(() => {
        (fake.bot._client as unknown as EventEmitter).emit("block_change", {
          location: { x: 10, y: 64, z: 10 },
          type: 0,
        });
      }, 8_500);

      await vi.advanceTimersByTimeAsync(12_500);
      const result = await dig.result;

      expect(result.status).toBe("unverified");
      expect(result.recoveryRequired).toBe(false);
      expect(fake.bot.stopDigging).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the post-dig server update wait immediately on abort", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const controller = new AbortController();
      const dig = beginPendingDig(fake, 7_500, controller.signal);
      await dig.started;
      dig.resolveNative();
      await vi.advanceTimersByTimeAsync(100);

      controller.abort(new Error("test stop"));
      const result = await dig.result;

      expect(result.status).toBe("interrupted");
      expect(result.recoveryRequired).toBe(false);
      expect(fake.bot.stopDigging).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits past 35 seconds for a slow dig and requires the server block update", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const dig = beginPendingDig(fake, 37_500);
      await dig.started;
      let completed = false;
      void dig.result.then(() => {
        completed = true;
      });
      setTimeout(() => dig.completeWithServerUpdate(), 40_000);

      await vi.advanceTimersByTimeAsync(35_000);
      expect(fake.bot.stopDigging).not.toHaveBeenCalled();
      expect(completed).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      const result = await dig.result;
      expect(result.status).toBe("successful");
      expect(result.recoveryRequired).toBe(false);
      expect(fake.bot.stopDigging).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, 10_000, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "keeps a %s ms or invalid dig estimate at the 35-second floor",
    async (estimateMs) => {
      vi.useFakeTimers();
      try {
        const fake = makeFakeBot();
        const dig = beginPendingDig(fake, estimateMs);
        await dig.started;

        await vi.advanceTimersByTimeAsync(34_999);
        expect(fake.bot.stopDigging).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const result = await dig.result;

        expect(result.status).toBe("unverified");
        expect(result.recoveryRequired).toBe(false);
        expect(fake.bot.stopDigging).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("caps a dig estimate at five minutes without treating timeout as success", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const dig = beginPendingDig(fake, 600_000);
      await dig.started;

      await vi.advanceTimersByTimeAsync(299_999);
      expect(fake.bot.stopDigging).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await dig.result;

      expect(result.status).toBe("unverified");
      expect(result.recoveryRequired).toBe(false);
      expect(fake.bot.stopDigging).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a pending dig immediately on abort and keeps it interrupted", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      const controller = new AbortController();
      const dig = beginPendingDig(fake, 37_500, controller.signal);
      await dig.started;

      controller.abort(new Error("test stop"));
      const result = await dig.result;

      expect(result.status).toBe("interrupted");
      expect(result.recoveryRequired).toBe(false);
      expect(fake.bot.stopDigging).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses source-attributed server hit events and distinguishes a hit from target death", async () => {
    const fake = makeFakeBot();
    const target = {
      id: 2,
      name: "cow",
      type: "mob",
      position: new Vec3(0, 64, -2),
      velocity: new Vec3(0, 0, 0),
      height: 1.4,
    };
    const otherPlayer = { id: 4 };
    Object.assign(fake.bot, {
      entities: {
        1: (fake.bot as unknown as { entity: unknown }).entity,
        2: target,
      },
    });
    const botEvents = fake.bot as unknown as EventEmitter;
    const body = new MineflayerPlayerBody(() => fake.bot);
    vi.mocked(fake.bot.attack).mockImplementationOnce((entity) => {
      botEvents.emit("entityHurt", entity, otherPlayer);
    });
    const unrelatedHit = await body.execute({ kind: "attack", entityId: 2 });
    expect(unrelatedHit.status).toBe("unverified");

    vi.mocked(fake.bot.attack).mockImplementationOnce((entity) => {
      botEvents.emit("entityHurt", entity, undefined);
    });
    const sourceLessHit = await body.execute({
      kind: "attack",
      entityId: 2,
    });
    expect(sourceLessHit.status).toBe("unverified");
    expect(sourceLessHit.observedEffect).toBeUndefined();

    vi.mocked(fake.bot.attack).mockImplementationOnce((entity) => {
      botEvents.emit("entityHurt", entity, fake.bot.entity);
    });
    const hit = await body.execute({ kind: "attack", entityId: 2 });
    expect(hit.status).toBe("successful");
    expect(hit.observedEffect).toEqual({ type: "entity_hit", entityId: 2 });

    vi.mocked(fake.bot.attack).mockImplementationOnce((entity) => {
      botEvents.emit("entityHurt", entity, fake.bot.entity);
      botEvents.emit("entityDead", entity);
    });
    const killed = await body.execute({ kind: "attack", entityId: 2 });
    expect(killed.status).toBe("successful");
    expect(killed.observedEffect).toEqual({ type: "entity_died", entityId: 2 });
  });

  it("forces a body aim and waits for physicsTick before a normal attack", async () => {
    const fake = makeFakeBot();
    const target = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    fake.bot.entity.pitch = 1.4;
    expect(
      observePlayerBody(fake.bot, undefined).perception.entities.some(
        (entity) => entity.id === target.id,
      ),
    ).toBe(false);

    const botEvents = fake.bot as unknown as EventEmitter;
    let aimedPoint: Vec3 | undefined;
    let forcedLook = false;
    const lookAt = vi.fn(async (point: Vec3, force?: boolean) => {
      aimedPoint = point;
      forcedLook = force === true;
      const delta = point.minus(fake.bot.entity.position.offset(0, 1.62, 0));
      fake.bot.entity.yaw = Math.atan2(-delta.x, -delta.z);
      fake.bot.entity.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
    });
    const attack = vi.fn((entity: Entity) => {
      botEvents.emit("entityHurt", entity, fake.bot.entity);
    });
    Object.assign(fake.bot, { lookAt, attack });

    const pending = new MineflayerPlayerBody(() => fake.bot).execute({
      kind: "attack",
      entityId: target.id,
    });
    await vi.waitFor(() => expect(lookAt).toHaveBeenCalledTimes(1));
    expect(attack).not.toHaveBeenCalled();
    botEvents.emit("physicsTick");
    const result = await pending;

    expect(result.status).toBe("successful");
    expect(aimedPoint).toEqual(
      target.position.offset(0, target.height * 0.55, 0),
    );
    expect(forcedLook).toBe(true);
    expect(attack).toHaveBeenCalledTimes(1);
  });

  it("does not reflex-attack if death occurs while waiting for physicsTick", async () => {
    const fake = makeFakeBot();
    const target = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    const botEvents = fake.bot as unknown as EventEmitter;
    const lookAt = vi.fn(async (point: Vec3) => {
      const delta = point.minus(fake.bot.entity.position.offset(0, 1.62, 0));
      fake.bot.entity.yaw = Math.atan2(-delta.x, -delta.z);
      fake.bot.entity.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
    });
    const attack = vi.fn();
    Object.assign(fake.bot, { lookAt, attack });
    const body = new MineflayerPlayerBody(() => fake.bot);
    const events: PlayerBodyEvent[] = [];
    body.onEvent((event) => events.push(event));
    body.setDamageReflexEnabled(true);

    botEvents.emit("entityHurt", fake.bot.entity, target);
    await vi.waitFor(() => expect(lookAt).toHaveBeenCalledTimes(1));
    expect(attack).not.toHaveBeenCalled();
    fake.bot.health = 0;
    botEvents.emit("health");
    botEvents.emit("death");
    botEvents.emit("physicsTick");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(attack).not.toHaveBeenCalled();
    body.setDamageReflexEnabled(false);
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "damage_reflex_completed"),
      ).toBe(true),
    );
  });

  it("does not attack when the owner aborts while waiting for physicsTick", async () => {
    const fake = makeFakeBot();
    const target = addFakeZombieEntity(fake);
    registerFakeZombie(fake);
    const botEvents = fake.bot as unknown as EventEmitter;
    const lookAt = vi.fn(async () => undefined);
    const attack = vi.fn();
    Object.assign(fake.bot, { lookAt, attack });
    const controller = new AbortController();
    const pending = new MineflayerPlayerBody(() => fake.bot).execute(
      { kind: "attack", entityId: target.id },
      controller.signal,
    );

    await vi.waitFor(() => expect(lookAt).toHaveBeenCalledTimes(1));
    expect(attack).not.toHaveBeenCalled();
    controller.abort(new Error("Owner stopped the action"));
    const result = await pending;
    botEvents.emit("physicsTick");

    expect(result.status).toBe("interrupted");
    expect(attack).not.toHaveBeenCalled();
    expect(fake.bot.listenerCount("physicsTick")).toBe(0);
  });

  it("uses a visible entity with an empty hand without throwing", async () => {
    const fake = makeFakeBot();
    const target = {
      id: 2,
      name: "cow",
      type: "mob",
      position: new Vec3(0, 64, -2),
      velocity: new Vec3(0, 0, 0),
      height: 1.4,
    };
    Object.assign(fake.bot, {
      entities: {
        1: (fake.bot as unknown as { entity: unknown }).entity,
        2: target,
      },
      heldItem: null,
    });

    const body = new MineflayerPlayerBody(() => fake.bot);
    const result = await body.execute({
      kind: "use",
      target: { kind: "entity", entityId: 2 },
    });

    expect(result.status).toBe("unverified");
    expect(result.observedEffect).toBeUndefined();
  });

  it("defaults item use to four ticks and keeps unobserved effects unverified", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      fake.bot.inventory.slots[36] = { name: "snowball", count: 1 } as never;
      let markActivated!: () => void;
      const activated = new Promise<void>((resolve) => {
        markActivated = resolve;
      });
      vi.mocked(fake.bot.activateItem).mockImplementationOnce(() => {
        markActivated();
      });
      const body = new MineflayerPlayerBody(() => fake.bot);
      const operation = playerOperationSchema.parse({
        kind: "use",
        target: { kind: "item" },
      });
      if (operation.kind !== "use" || operation.target.kind !== "item")
        throw new Error("Expected a parsed item-use operation");
      expect(operation.target.holdTicks).toBe(4);

      const resultPromise = body.execute(operation);
      await activated;
      await vi.advanceTimersByTimeAsync(199);
      expect(fake.bot.deactivateItem).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;
      expect(fake.bot.activateItem).toHaveBeenCalledWith(false);
      expect(fake.bot.deactivateItem).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("unverified");
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds item use beyond the default and releases it immediately on cancellation", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      fake.bot.inventory.slots[36] = { name: "snowball", count: 1 } as never;
      let markActivated!: () => void;
      const activated = new Promise<void>((resolve) => {
        markActivated = resolve;
      });
      vi.mocked(fake.bot.activateItem).mockImplementationOnce(() => {
        markActivated();
      });
      const body = new MineflayerPlayerBody(() => fake.bot);
      const controller = new AbortController();
      const operation = playerOperationSchema.parse({
        kind: "use",
        target: { kind: "item", holdTicks: 40 },
      });
      const resultPromise = body.execute(operation, controller.signal);
      await activated;
      await vi.advanceTimersByTimeAsync(200);
      expect(fake.bot.deactivateItem).not.toHaveBeenCalled();

      controller.abort(new Error("test stop"));
      const result = await resultPromise;
      expect(result.status).toBe("interrupted");
      expect(result.recoveryRequired).toBe(false);
      expect(fake.bot.deactivateItem).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("quarantines an unsettled native action and admits a replacement only after it settles", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot();
      let resolveNative!: () => void;
      let announceStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        announceStarted = resolve;
      });
      vi.spyOn(fake.bot.pathfinder, "goto").mockImplementationOnce(() => {
        announceStarted();
        return new Promise<void>((resolve) => {
          resolveNative = resolve;
        });
      });
      const body = new MineflayerPlayerBody(() => fake.bot);
      const controller = new AbortController();
      const operation = body.execute(
        {
          kind: "move_to",
          position: { x: 5, y: 64, z: 0 },
          range: 1,
        },
        controller.signal,
      );
      await started;
      controller.abort(new Error("test stop"));
      expect(pathUpdateListenerCount(fake.bot)).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
      const interrupted = await operation;
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.recoveryRequired).toBe(true);
      await expect(body.execute({ kind: "window_close" })).rejects.toThrow(
        /still settling/,
      );

      resolveNative();
      await Promise.resolve();
      await Promise.resolve();
      expect(pathUpdateListenerCount(fake.bot)).toBe(0);
      const replacement = await body.execute({
        kind: "look",
        target: { x: 0, y: 65, z: -2 },
      });
      expect(replacement.recoveryRequired).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens and exposes a generic brewing window and verifies a specific slot click", async () => {
    const fake = makeFakeBot();
    const target = new Vec3(0, 64, -2);
    fake.blocks.set("0,64,-2", makeBlock("brewing_stand", 2, target));
    fake.candidates.push(target);
    const window = makeWindow();
    fake.setWindow(window);
    const body = new MineflayerPlayerBody(() => fake.bot);
    const opened = await body.execute({
      kind: "open_window",
      target: { kind: "block", position: { x: 0, y: 64, z: -2 } },
    });
    expect(opened.status).toBe("successful");
    const observedWindow = await body.observe();
    expect(observedWindow.window?.type).toBe("minecraft:brewing_stand");
    expect(observedWindow.window?.slots).toHaveLength(41);

    window.slots[0] = {
      type: potionItem().type,
      name: "potion",
      count: 1,
      metadata: 0,
      maxDurability: 0,
      durabilityUsed: 0,
      enchants: [],
      customName: null,
    } as never;
    vi.mocked(fake.bot.clickWindow).mockImplementationOnce(
      async (slot: number) => {
        window.selectedItem = window.slots[slot] as never;
        window.slots[slot] = null;
      },
    );
    const clicked = await body.execute({
      kind: "window_click",
      slot: 0,
      button: 0,
      mode: 0,
    });
    expect(clicked.status).toBe("successful");
  });

  it("awaits a rejected async close and releases the operation for a replacement", async () => {
    const fake = makeFakeBot();
    fake.setWindow(makeWindow());
    fake.emitWindowOpen();
    const body = new MineflayerPlayerBody(() => fake.bot);
    vi.mocked(fake.bot.closeWindow).mockImplementationOnce(async () => {
      throw new Error("close acknowledgement failed");
    });

    const closed = await body.execute({ kind: "window_close" });
    expect(closed.status).toBe("failed");
    expect(fake.bot.closeWindow).toHaveBeenCalledOnce();
    expect(fake.bot.currentWindow).not.toBeNull();

    const retried = await body.execute({ kind: "window_close" });
    expect(retried.status).toBe("successful");
    expect(fake.bot.currentWindow).toBeNull();

    const replacement = await body.execute({
      kind: "look",
      target: { x: 0, y: 65, z: -2 },
    });
    expect(replacement.status).toBe("successful");
    expect(replacement.recoveryRequired).toBe(false);
  });

  it("removes the window waiter when cancellation happens before activation sends a packet", async () => {
    const fake = makeFakeBot();
    const target = new Vec3(0, 64, -2);
    fake.blocks.set("0,64,-2", makeBlock("brewing_stand", 2, target));
    fake.candidates.push(target);
    const window = makeWindow();
    fake.setWindow(window);
    let finishLook!: () => void;
    let looked!: () => void;
    const lookStarted = new Promise<void>((resolve) => (looked = resolve));
    const lookDeferred = new Promise<void>((resolve) => (finishLook = resolve));
    vi.mocked(fake.bot.lookAt).mockImplementationOnce(() => {
      looked();
      return lookDeferred;
    });
    const client = (
      fake.bot as Bot & {
        _client: EventEmitter & {
          write: (event: string, packet: unknown) => void;
        };
      }
    )._client;
    const write = vi.spyOn(client, "write");
    const body = new MineflayerPlayerBody(() => fake.bot);
    const controller = new AbortController();
    const pending = body.execute(
      {
        kind: "open_window",
        target: { kind: "block", position: { x: 0, y: 64, z: -2 } },
      },
      controller.signal,
    );
    await lookStarted;
    controller.abort(new Error("cancel before packet"));
    const cancelled = await pending;
    expect(cancelled.status).toBe("interrupted");
    expect(cancelled.recoveryRequired).toBe(false);
    finishLook();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();

    const replacement = await body.execute({
      kind: "open_window",
      target: { kind: "block", position: { x: 0, y: 64, z: -2 } },
    });
    expect(replacement.status).toBe("successful");
    expect(fake.bot.closeWindow).not.toHaveBeenCalledWith(window);
  });

  it("keeps a late window quarantined after synchronous close throws until disconnect", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot({ deferWindowOpen: true });
      const target = new Vec3(0, 64, -2);
      fake.blocks.set("0,64,-2", makeBlock("brewing_stand", 2, target));
      fake.candidates.push(target);
      const lateWindow = makeWindow();
      fake.setWindow(lateWindow);
      vi.mocked(fake.bot.swingArm).mockImplementationOnce(() => {
        throw new Error("activation completion failed after packet dispatch");
      });
      const client = (
        fake.bot as Bot & {
          _client: EventEmitter & {
            write: (event: string, packet: unknown) => void;
          };
        }
      )._client;
      const write = vi.spyOn(client, "write");
      let currentBot = fake.bot;
      const body = new MineflayerPlayerBody(() => currentBot);
      const controller = new AbortController();
      const pending = body.execute(
        {
          kind: "open_window",
          target: { kind: "block", position: { x: 0, y: 64, z: -2 } },
        },
        controller.signal,
      );
      await vi.waitFor(() =>
        expect(write).toHaveBeenCalledWith("block_place", expect.any(Object)),
      );
      const persistentWindowListeners =
        fake.bot.listenerCount("windowOpen") - 1;
      controller.abort(new Error("cancel after packet"));
      await vi.advanceTimersByTimeAsync(2_000);
      const cancelled = await pending;
      expect(cancelled.status).toBe("interrupted");
      expect(cancelled.recoveryRequired).toBe(true);
      await expect(body.execute({ kind: "window_close" })).rejects.toThrow(
        /still settling/,
      );

      vi.mocked(fake.bot.closeWindow).mockImplementationOnce(() => {
        throw new Error("late close threw before local release");
      });
      fake.emitWindowOpen();
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.bot.closeWindow).toHaveBeenCalledWith(lateWindow);
      expect(fake.bot.currentWindow).toBe(lateWindow);
      await expect(body.execute({ kind: "window_close" })).rejects.toThrow(
        /still settling/,
      );

      fake.bot.emit("end", "test disconnect");
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.bot.listenerCount("windowOpen")).toBe(
        persistentWindowListeners,
      );

      const next = makeFakeBot();
      currentBot = next.bot;
      body.attach(next.bot);
      const replacement = await body.execute({
        kind: "look",
        target: { x: 0, y: 65, z: -2 },
      });
      expect(replacement.status).toBe("successful");
    } finally {
      vi.useRealTimers();
    }
  });

  it("quarantines a sent window activation until its late window is closed", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot({ deferWindowOpen: true });
      const target = new Vec3(0, 64, -2);
      fake.blocks.set("0,64,-2", makeBlock("brewing_stand", 2, target));
      fake.candidates.push(target);
      const lateWindow = makeWindow();
      fake.setWindow(lateWindow);
      vi.mocked(fake.bot.swingArm).mockImplementationOnce(() => {
        throw new Error("activation completion failed after packet dispatch");
      });
      const client = (
        fake.bot as Bot & {
          _client: EventEmitter & {
            write: (event: string, packet: unknown) => void;
          };
        }
      )._client;
      const write = vi.spyOn(client, "write");
      const body = new MineflayerPlayerBody(() => fake.bot);
      const controller = new AbortController();
      const pending = body.execute(
        {
          kind: "open_window",
          target: { kind: "block", position: { x: 0, y: 64, z: -2 } },
        },
        controller.signal,
      );
      await vi.waitFor(() =>
        expect(write).toHaveBeenCalledWith("block_place", expect.any(Object)),
      );
      controller.abort(new Error("cancel after packet"));
      await vi.advanceTimersByTimeAsync(2_000);
      const cancelled = await pending;
      expect(cancelled.status).toBe("interrupted");
      expect(cancelled.recoveryRequired).toBe(true);
      await expect(body.execute({ kind: "window_close" })).rejects.toThrow(
        /still settling/,
      );

      fake.emitWindowOpen();
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.bot.closeWindow).toHaveBeenCalledWith(lateWindow);
      expect(fake.bot.currentWindow).toBeNull();

      fake.resumeWindowOpen();
      const nextWindow = makeWindow(4);
      fake.setWindow(nextWindow);
      const replacement = await body.execute({
        kind: "open_window",
        target: { kind: "block", position: { x: 0, y: 64, z: -2 } },
      });
      expect(replacement.status).toBe("successful");
      expect(fake.bot.closeWindow).not.toHaveBeenCalledWith(nextWindow);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks entity-use packet dispatch before waiting for its late window", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot({ deferWindowOpen: true });
      const target = {
        id: 2,
        name: "cow",
        type: "mob",
        position: new Vec3(0, 64, -2),
        velocity: new Vec3(0, 0, 0),
        height: 1.4,
      };
      Object.assign(fake.bot, {
        entities: {
          1: (fake.bot as unknown as { entity: unknown }).entity,
          2: target,
        },
      });
      const lateWindow = makeWindow();
      fake.setWindow(lateWindow);
      const client = (
        fake.bot as Bot & {
          _client: EventEmitter & {
            write: (event: string, packet: unknown) => void;
          };
        }
      )._client;
      const write = vi.spyOn(client, "write");
      const body = new MineflayerPlayerBody(() => fake.bot);
      const controller = new AbortController();
      const pending = body.execute(
        { kind: "open_window", target: { kind: "entity", entityId: 2 } },
        controller.signal,
      );
      await vi.waitFor(() =>
        expect(write).toHaveBeenCalledWith(
          "use_entity",
          expect.objectContaining({ target: 2 }),
        ),
      );
      controller.abort(new Error("cancel entity open"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending).recoveryRequired).toBe(true);
      fake.emitWindowOpen();
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.bot.closeWindow).toHaveBeenCalledWith(lateWindow);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles and disposes a pending window waiter on disconnect before reattaching", async () => {
    vi.useFakeTimers();
    try {
      const first = makeFakeBot({ deferWindowOpen: true });
      const target = new Vec3(0, 64, -2);
      first.blocks.set("0,64,-2", makeBlock("brewing_stand", 2, target));
      first.candidates.push(target);
      first.setWindow(makeWindow());
      const client = (
        first.bot as Bot & {
          _client: EventEmitter & {
            write: (event: string, packet: unknown) => void;
          };
        }
      )._client;
      const write = vi.spyOn(client, "write");
      let currentBot = first.bot;
      const body = new MineflayerPlayerBody(() => currentBot);
      const controller = new AbortController();
      const pending = body.execute(
        {
          kind: "open_window",
          target: { kind: "block", position: { x: 0, y: 64, z: -2 } },
        },
        controller.signal,
      );
      await vi.waitFor(() =>
        expect(write).toHaveBeenCalledWith("block_place", expect.any(Object)),
      );
      const persistentWindowListeners =
        first.bot.listenerCount("windowOpen") - 1;
      controller.abort(new Error("cancel pending open"));
      first.bot.emit("end", "test disconnect");
      await vi.advanceTimersByTimeAsync(2_000);
      const cancelled = await pending;
      expect(cancelled.status).toBe("interrupted");
      expect(cancelled.recoveryRequired).toBe(false);
      expect(first.bot.listenerCount("windowOpen")).toBe(
        persistentWindowListeners,
      );

      const second = makeFakeBot();
      currentBot = second.bot;
      body.attach(second.bot);
      const replacement = await body.execute({
        kind: "look",
        target: { x: 0, y: 65, z: -2 },
      });
      expect(replacement.status).toBe("successful");
      expect(first.bot.listenerCount("windowOpen")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a stopped body's pending window quarantined until the late window is closed", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeBot({ deferWindowOpen: true });
      const target = new Vec3(0, 64, -2);
      fake.blocks.set("0,64,-2", makeBlock("brewing_stand", 2, target));
      fake.candidates.push(target);
      const lateWindow = makeWindow();
      fake.setWindow(lateWindow);
      const body = new MineflayerPlayerBody(() => fake.bot);
      const client = (
        fake.bot as Bot & {
          _client: EventEmitter & {
            write: (event: string, packet: unknown) => void;
          };
        }
      )._client;
      const write = vi.spyOn(client, "write");
      const pending = body.execute({
        kind: "open_window",
        target: { kind: "block", position: { x: 0, y: 64, z: -2 } },
      });
      await vi.waitFor(() =>
        expect(write).toHaveBeenCalledWith("block_place", expect.any(Object)),
      );
      const stopping = body.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      await stopping;
      const result = await pending;
      expect(result.status).toBe("interrupted");
      expect(result.recoveryRequired).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);

      fake.emitWindowOpen();
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.bot.closeWindow).toHaveBeenCalledWith(lateWindow);
      expect(fake.bot.currentWindow).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

function potionItem(): { type: number } {
  return { type: 1 };
}
