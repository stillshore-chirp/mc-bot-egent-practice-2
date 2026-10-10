import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { Window } from "prismarine-windows";
import { MineflayerPlayerBody } from "../../src/minecraft/player-body.js";
import {
  observePlayerBody,
  playerBodyLookSweepSchema,
  summarizeLookSweepView,
} from "../../src/minecraft/player-body-observation.js";

function makeBot(
  equipment: readonly (string | null | undefined)[],
  options: {
    readonly entityName?: string;
    readonly getDroppedItem?: () => unknown;
  } = {},
): Bot {
  const self = {
    id: 1,
    position: new Vec3(0, 64, 0),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    height: 1.8,
    eyeHeight: 1.62,
  };
  const enemy = {
    id: 2,
    name: options.entityName ?? "zombie",
    type: "hostile",
    position: new Vec3(0, 64, -4),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    height: 1.95,
    health: 20,
    equipment: equipment.map((name) =>
      name === undefined ? undefined : name === null ? null : { name },
    ),
    ...(options.getDroppedItem === undefined
      ? {}
      : { getDroppedItem: options.getDroppedItem }),
  };
  const inventorySlots = Array.from(
    { length: 46 },
    () => null,
  ) as (Item | null)[];
  const inventory = Object.assign(new EventEmitter(), {
    slots: inventorySlots,
    inventoryStart: 9,
    inventoryEnd: 45,
    items: () => inventorySlots.filter((item): item is Item => item !== null),
  });
  const bot = Object.assign(new EventEmitter(), {
    username: "fixture_bot",
    version: "26.1",
    entity: self,
    entities: { 1: self, 2: enemy },
    players: {},
    game: { dimension: "overworld", gameMode: "survival" },
    time: { day: 1, timeOfDay: 5_000, isDay: true },
    isRaining: false,
    health: 20,
    food: 20,
    foodSaturation: 5,
    isSleeping: false,
    experience: { level: 0, points: 0, progress: 0 },
    inventory,
    getEquipmentDestSlot: (destination: string) =>
      ({ hand: 36, "off-hand": 45, head: 5, torso: 6, legs: 7, feet: 8 })[
        destination
      ] ?? 0,
    registry: {
      entitiesByName: { zombie: { category: "Hostile mobs" } },
      itemsByName: {
        diamond_sword: {},
        iron_shears: { id: 42, name: "iron_shears" },
      },
      blocksByStateId: {},
    },
    world: { raycast: () => null },
    findBlocks: () => [],
    blockAt: () => null,
    canSeeBlock: () => true,
    currentWindow: null,
    clickWindow: vi.fn(async (slot: number) => {
      const window = bot.currentWindow as Window | null;
      if (window === null) throw new Error("No open test window");
      if (window.selectedItem === null) {
        window.selectedItem = window.slots[slot] ?? null;
        window.slots[slot] = null;
      } else {
        window.slots[slot] = window.selectedItem;
        window.selectedItem = null;
      }
    }),
    closeWindow: vi.fn(async (window: Window) => {
      syncWindowToInventory(bot as unknown as Bot, window);
      Object.assign(bot, { currentWindow: null });
      bot.emit("windowClose", window);
    }),
    equip: vi.fn(async (item: Item, destination: string) => {
      const slot = bot.getEquipmentDestSlot(destination);
      if (item.slot !== slot) {
        inventorySlots[item.slot] = null;
        inventorySlots[slot] = Object.assign(item, { slot });
      }
    }),
  });
  return bot as unknown as Bot;
}

function syncWindowToInventory(bot: Bot, window: Window): void {
  const offset = window.inventoryStart - bot.inventory.inventoryStart;
  for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot++) {
    const inventorySlot = slot - offset;
    const item = window.slots[slot] ?? null;
    if (item !== null) Object.assign(item, { slot: inventorySlot });
    bot.inventory.slots[inventorySlot] = item;
  }
}

function transferWindow(): Window {
  const slots = Array.from({ length: 63 }, () => null) as (Item | null)[];
  slots[0] = {
    type: 42,
    name: "iron_shears",
    count: 1,
    metadata: 0,
    durabilityUsed: null,
    maxDurability: null,
    customName: null,
    enchants: [],
    nbt: null,
    stackSize: 64,
    slot: 0,
  } as unknown as Item;
  const window = Object.assign(new EventEmitter(), {
    id: 7,
    type: "minecraft:chest",
    title: "Chest",
    inventoryStart: 27,
    inventoryEnd: 63,
    selectedItem: null,
    slots,
    findItemRange: (
      start: number,
      end: number,
      type: number,
      metadata: number,
    ) => {
      for (let slot = start; slot < end; slot++) {
        const item = slots[slot];
        if (item?.type === type && item.metadata === metadata) {
          Object.assign(item, { slot });
          return item;
        }
      }
      return null;
    },
    firstEmptySlotRange: (start: number, end: number) => {
      for (let slot = start; slot < end; slot++)
        if (slots[slot] === null) return slot;
      return null;
    },
  }) as unknown as Window;
  return window;
}

function sweepFor(bot: Bot) {
  const observation = observePlayerBody(bot, undefined);
  const current = summarizeLookSweepView(observation, null);
  return {
    observation,
    current,
    parsed: playerBodyLookSweepSchema.safeParse({
      current,
      directions: [],
      plannedDirectionCount: 8,
      complete: false,
      candidateSearchMayBeTruncated: false,
      worldAbsenceEstablished: false,
    }),
  };
}

describe("visible entity equipment observation", () => {
  it("maps the six received slots and carries only bounded item kinds into look sweeps", () => {
    const longName = "a".repeat(100);
    const { observation, current, parsed } = sweepFor(
      makeBot([
        longName,
        null,
        "iron_boots",
        "iron_leggings",
        "iron_chestplate",
        "iron_helmet",
      ]),
    );

    const equipment = observation.perception.entities[0]?.equipment;
    expect(equipment).toEqual({
      mainHand: "a".repeat(80),
      offHand: null,
      feet: "iron_boots",
      legs: "iron_leggings",
      torso: "iron_chestplate",
      head: "iron_helmet",
    });
    expect(current.visibleEntities[0]?.equipment).toEqual(equipment);
    expect(parsed.success).toBe(true);
  });

  it("keeps unreceived slots unknown and explicit empty slots null", () => {
    const { observation, current, parsed } = sweepFor(
      makeBot([undefined, null]),
    );
    const equipment = observation.perception.entities[0]?.equipment;

    expect(equipment).toEqual({ offHand: null });
    expect(equipment).not.toHaveProperty("mainHand");
    expect(current.visibleEntities[0]?.equipment).toEqual({ offHand: null });
    expect(parsed.success).toBe(true);
  });

  it("does not invent equipment when no slots have been received", () => {
    const { observation, current, parsed } = sweepFor(makeBot([]));

    expect(observation.perception.entities[0]?.equipment).toBeUndefined();
    expect(current.visibleEntities[0]).not.toHaveProperty("equipment");
    expect(parsed.success).toBe(true);
  });

  it("observes a bounded registry dropped-item name and count in normal and sweep views", () => {
    const { observation, current, parsed } = sweepFor(
      makeBot([], {
        entityName: "item",
        getDroppedItem: () => ({
          name: "diamond_sword",
          count: 1,
          customName: "untrusted display text",
          nbt: { display: "untrusted display text" },
        }),
      }),
    );

    expect(observation.perception.entities[0]?.droppedItem).toEqual({
      name: "diamond_sword",
      count: 1,
    });
    expect(current.visibleEntities[0]?.droppedItem).toEqual({
      name: "diamond_sword",
      count: 1,
    });
    expect(JSON.stringify(current.visibleEntities[0])).not.toContain(
      "untrusted display text",
    );
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["missing", () => null],
    [
      "throws",
      () => {
        throw new Error("fixture failure");
      },
    ],
    ["unregistered item", () => ({ name: "custom_item", count: 1 })],
    ["out-of-bound count", () => ({ name: "diamond_sword", count: 128 })],
  ])(
    "omits a dropped item when native data is %s",
    (_label, getDroppedItem) => {
      const { observation, current, parsed } = sweepFor(
        makeBot([], { entityName: "item", getDroppedItem }),
      );

      expect(observation.perception.entities[0]).not.toHaveProperty(
        "droppedItem",
      );
      expect(current.visibleEntities[0]).not.toHaveProperty("droppedItem");
      expect(parsed.success).toBe(true);
    },
  );
});

function makeTransferPlayer(): { bot: Bot; window: Window } {
  const bot = makeBot([]);
  const window = transferWindow();
  Object.assign(bot, { currentWindow: window });
  return { bot, window };
}

describe("equipment after an open-window transfer", () => {
  it("observes transferred gear and equips it after closing and syncing the window", async () => {
    const { bot } = makeTransferPlayer();
    const body = new MineflayerPlayerBody(() => bot);
    const transferred = await body.execute({
      kind: "window_transfer",
      item: "iron_shears",
      count: 1,
      direction: "window_to_inventory",
    });
    const afterTransfer = await body.observe();

    expect(transferred.status).toBe("successful");
    expect(afterTransfer.window?.slots[0]).toBeNull();
    expect(afterTransfer.window?.slots[27]).toEqual(
      expect.objectContaining({ name: "iron_shears", slot: 27 }),
    );
    expect(afterTransfer.self.inventory).toContainEqual(
      expect.objectContaining({ name: "iron_shears", count: 1, slot: 9 }),
    );

    const equipped = await body.execute({
      kind: "equip",
      item: "iron_shears",
      destination: "hand",
    });

    expect(vi.mocked(bot.closeWindow)).toHaveBeenCalledOnce();
    expect(vi.mocked(bot.equip)).toHaveBeenCalledWith(
      expect.objectContaining({ name: "iron_shears" }),
      "hand",
    );
    expect(bot.currentWindow).toBeNull();
    expect(equipped.status).toBe("successful");
    expect(equipped.after?.self.equipment.hand).toEqual(
      expect.objectContaining({ name: "iron_shears", slot: 36 }),
    );
  });

  it("does not equip after caller cancellation while closing transferred gear", async () => {
    const { bot } = makeTransferPlayer();
    const body = new MineflayerPlayerBody(() => bot);
    const transferred = await body.execute({
      kind: "window_transfer",
      item: "iron_shears",
      count: 1,
      direction: "window_to_inventory",
    });
    expect(transferred.status).toBe("successful");

    let announceClose!: () => void;
    let releaseClose!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      announceClose = resolve;
    });
    const closeReleased = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    vi.mocked(bot.closeWindow).mockImplementationOnce(async (window) => {
      announceClose();
      await closeReleased;
      syncWindowToInventory(bot, window);
      Object.assign(bot, { currentWindow: null });
      bot.emit("windowClose", window);
    });

    const controller = new AbortController();
    const equipping = body.execute(
      { kind: "equip", item: "iron_shears", destination: "hand" },
      controller.signal,
    );
    await closeStarted;
    controller.abort(new Error("owner stop"));
    releaseClose();
    const result = await equipping;

    expect(result.status).toBe("interrupted");
    expect(vi.mocked(bot.equip)).not.toHaveBeenCalled();
  });

  it("does not equip across a death observed while closing transferred gear", async () => {
    const { bot } = makeTransferPlayer();
    const body = new MineflayerPlayerBody(() => bot);
    const transferred = await body.execute({
      kind: "window_transfer",
      item: "iron_shears",
      count: 1,
      direction: "window_to_inventory",
    });
    expect(transferred.status).toBe("successful");
    vi.mocked(bot.closeWindow).mockImplementationOnce(async (window) => {
      syncWindowToInventory(bot, window);
      Object.assign(bot, { currentWindow: null });
      bot.emit("windowClose", window);
      bot.emit("death");
    });

    const result = await body.execute({
      kind: "equip",
      item: "iron_shears",
      destination: "hand",
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("life changed while closing a window");
    expect(vi.mocked(bot.equip)).not.toHaveBeenCalled();
  });
});
