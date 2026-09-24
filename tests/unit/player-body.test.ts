import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import type { Window } from "prismarine-windows";
import {
  MineflayerPlayerBody,
  playerOperationNames,
  playerOperationDescriptions,
  playerOperationSchema,
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

function makeFakeBot(): {
  bot: Bot;
  blocks: Map<string, FakeBlock>;
  candidates: Vec3[];
  hiddenBlockKeys: Set<string>;
  setWindow(window: Window): void;
} {
  const botEvents = new EventEmitter();
  const client = new EventEmitter() as EventEmitter & {
    write: (event: string, packet: unknown) => void;
  };
  const blocks = new Map<string, FakeBlock>();
  const candidates: Vec3[] = [];
  const hiddenBlockKeys = new Set<string>();
  let pendingWindow: (Window & EventEmitter) | undefined;
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
      raycast: (_origin: Vec3, direction: Vec3) =>
        direction.x > 0.2 ? makeBlock("stone", 1, new Vec3(1, 64, -2)) : null,
    },
    pathfinder: {
      goto: vi.fn(async () => undefined),
      setGoal: vi.fn(),
    },
    supportFeature: (feature: string) => feature === "blockPlaceHasInsideBlock",
    findBlocks: ({ matching }: { matching: (block: FakeBlock) => boolean }) =>
      candidates.filter((point) =>
        matching(blocks.get(key(point)) ?? airAt(point)),
      ),
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
    }),
    clearControlStates: vi.fn(),
    deactivateItem: vi.fn(),
    stopDigging: vi.fn(),
    moveVehicle: vi.fn(),
    activateItem: vi.fn(),
    attack: vi.fn(),
    heldItem: null,
    swingArm: vi.fn(),
    closeWindow: vi.fn(),
    dig: vi.fn(async () => undefined),
    clickWindow: vi.fn(async () => undefined),
    recipesAll: () => [],
    recipesFor: () => [],
    isABed: () => false,
  });
  client.write = (event, packet) => {
    if (event !== "block_place") return;
    const location = (packet as { location?: Vec3 }).location;
    if (location === undefined) return;
    const window = pendingWindow;
    if (window !== undefined) {
      bot.currentWindow = window;
      pendingWindow = undefined;
      queueMicrotask(() => bot.emit("windowOpen", window));
    }
  };
  return {
    bot: bot as unknown as Bot,
    blocks,
    candidates,
    hiddenBlockKeys,
    setWindow: (window) => {
      pendingWindow = window as Window & EventEmitter;
    },
  };
}

describe("player body", () => {
  it("exports a single strict operation catalog and rejects malformed variants", () => {
    expect(playerOperationNames).toHaveLength(28);
    expect(Object.keys(playerOperationDescriptions).sort()).toEqual(
      [...playerOperationNames].sort(),
    );
    expect(playerOperationNames).toContain("move_to");
    expect(playerOperationNames).toContain("window_transfer");
    expect(playerOperationNames).toContain("elytra_fly");
    expect(() =>
      playerOperationSchema.parse({
        kind: "dig",
        position: { x: 1, y: 64, z: 2 },
        permission: "allow",
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
        owner: {
          entity: {
            ...unknownHealthEntity,
            id: 4,
            position: new Vec3(0, 64, -6),
            username: "owner",
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

  it("does not treat a local-only dig mutation as success, but accepts a server block packet", async () => {
    const fake = makeFakeBot();
    const target = new Vec3(0, 64, -2);
    fake.blocks.set("0,64,-2", makeBlock("stone", 1, target));
    fake.candidates.push(target);
    const body = new MineflayerPlayerBody(() => fake.bot);
    vi.mocked(fake.bot.dig).mockImplementationOnce(async () => {
      fake.blocks.set("0,64,-2", makeBlock("air", 0, target));
    });
    const localOnly = await body.execute({
      kind: "dig",
      position: { x: 0, y: 64, z: -2 },
    });
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
});

function potionItem(): { type: number } {
  return { type: 1 };
}
