import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type {
  BodyItemStack,
  BodyWindowSnapshot,
  PlayerBodyObservation,
} from "../../src/minecraft/player-body-observation.js";
import {
  findChestEquipmentWithdrawal,
  findInventoryEquipmentUpgrade,
  findRetaliationWeaponUpgrade,
  isChestEquipmentWindow,
} from "../../src/player/equipment-upkeep.js";

interface NativeWindow {
  readonly type: string;
  readonly title: string;
  readonly inventoryStart: number;
  readonly inventoryEnd: number;
  readonly slots: readonly unknown[];
}

interface PrismarineWindows {
  createWindow(id: number, type: string, title: string): NativeWindow | null;
}

const prismarineWindows = createRequire(import.meta.url)(
  "prismarine-windows",
) as (version: string) => PrismarineWindows;

function item(
  name: string,
  slot: number,
  overrides: Partial<BodyItemStack> = {},
): BodyItemStack {
  return {
    slot,
    itemId: slot + 1,
    name,
    count: 1,
    metadata: 0,
    durability: 100,
    maxDurability: 100,
    customName: null,
    enchantments: [],
    ...overrides,
  };
}

function observation(
  options: {
    readonly inventory?: readonly BodyItemStack[];
    readonly equipment?: Partial<Record<string, BodyItemStack | null>>;
    readonly window?: BodyWindowSnapshot | null;
  } = {},
): PlayerBodyObservation {
  return {
    self: {
      inventory: [...(options.inventory ?? [])],
      equipment: {
        hand: null,
        "off-hand": null,
        head: null,
        torso: null,
        legs: null,
        feet: null,
        ...options.equipment,
      },
    },
    window: options.window ?? null,
  } as unknown as PlayerBodyObservation;
}

function chestWindow(
  chestItems: readonly (BodyItemStack | null)[],
  playerItems: readonly (BodyItemStack | null)[] = [],
): BodyWindowSnapshot {
  const inventoryStart = 27;
  const slots = [
    ...chestItems,
    ...Array<BodyItemStack | null>(inventoryStart - chestItems.length).fill(
      null,
    ),
    ...playerItems,
    ...Array<BodyItemStack | null>(36 - playerItems.length).fill(null),
  ];
  return {
    id: 1,
    type: "minecraft:generic_9x3",
    title: "Chest",
    inventoryStart,
    inventoryEnd: inventoryStart + 36,
    selectedItem: null,
    slots,
  };
}

describe("deterministic equipment upkeep", () => {
  it("chooses a strictly stronger armor item from inventory", () => {
    const equipped = item("iron_chestplate", 6);
    const candidate = item("diamond_chestplate", 9);
    const result = findInventoryEquipmentUpgrade(
      observation({
        inventory: [equipped, candidate],
        equipment: { torso: equipped },
      }),
    );

    expect(result).toEqual({ item: candidate, destination: "torso" });
  });

  it("prefers a same-tier sword over an axe for the combat hand slot", () => {
    const equipped = item("iron_axe", 36);
    const candidate = item("iron_sword", 9);
    const result = findInventoryEquipmentUpgrade(
      observation({
        inventory: [equipped, candidate],
        equipment: { hand: equipped },
      }),
    );

    expect(result).toEqual({ item: candidate, destination: "hand" });
  });

  it("chooses the highest ranked owned weapon over a held work tool for retaliation", () => {
    const workTool = item("diamond_pickaxe", 36);
    const stoneSword = item("stone_sword", 9);
    const ironSword = item("iron_sword", 10);
    expect(
      findRetaliationWeaponUpgrade(
        observation({
          inventory: [ironSword, workTool, stoneSword],
          equipment: { hand: workTool },
        }),
      ),
    ).toEqual({ item: ironSword, destination: "hand" });
  });

  it("does not replace the best held weapon and does not invent a weapon", () => {
    const held = item("netherite_sword", 36);
    const weaker = item("iron_sword", 9);
    expect(
      findRetaliationWeaponUpgrade(
        observation({
          inventory: [weaker, held],
          equipment: { hand: held },
        }),
      ),
    ).toBeNull();
    expect(
      findRetaliationWeaponUpgrade(
        observation({ inventory: [item("apple", 9)] }),
      ),
    ).toBeNull();
  });

  it("preserves an unrankable recognized weapon already in hand", () => {
    const held = item("iron_sword", 36, {
      enchantments: [{ name: "sharpness", level: 1 }],
    });
    expect(
      findRetaliationWeaponUpgrade(
        observation({
          inventory: [item("netherite_sword", 9), held],
          equipment: { hand: held },
        }),
      ),
    ).toBeNull();
  });

  it("does not exchange equal, unknown, broken, or enchanted equipment", () => {
    const cases = [
      {
        label: "equal rank",
        current: item("iron_helmet", 5),
        candidate: item("iron_helmet", 9),
      },
      {
        label: "unknown item",
        current: item("iron_helmet", 5),
        candidate: item("turtle_helmet", 9),
      },
      {
        label: "broken candidate",
        current: item("iron_helmet", 5),
        candidate: item("diamond_helmet", 9, { durability: 0 }),
      },
      {
        label: "enchanted current item",
        current: item("iron_helmet", 5, {
          enchantments: [{ name: "protection", level: 1 }],
        }),
        candidate: item("diamond_helmet", 9),
      },
    ];

    for (const { label, current, candidate } of cases) {
      expect(
        findInventoryEquipmentUpgrade(
          observation({
            inventory: [current, candidate],
            equipment: { head: current },
          }),
        ),
        label,
      ).toBeNull();
    }
  });

  it("keeps a held work tool when a combat weapon is in inventory", () => {
    const workTool = item("diamond_pickaxe", 36);
    const weapon = item("netherite_sword", 9);
    const result = findInventoryEquipmentUpgrade(
      observation({
        inventory: [workTool, weapon],
        equipment: { hand: workTool },
      }),
    );

    expect(result).toBeNull();
  });

  it("can equip a standard armor stack selected in the main hand", () => {
    const held = item("iron_chestplate", 36);
    expect(
      findInventoryEquipmentUpgrade(
        observation({
          inventory: [held],
          equipment: { hand: held },
        }),
      ),
    ).toEqual({ item: held, destination: "torso" });
  });

  it("can choose a chest sword when a standard armor item is held", () => {
    const worn = item("iron_chestplate", 6);
    const held = item("iron_chestplate", 36);
    const sword = item("iron_sword", 3);
    expect(
      findChestEquipmentWithdrawal(
        observation({
          inventory: [held],
          equipment: { hand: held, torso: worn },
          window: chestWindow([null, null, null, sword]),
        }),
      ),
    ).toEqual({ item: sword, destination: "hand", count: 1 });
  });

  it("keeps unrankable held armor and custom or enchanted swords unchanged", () => {
    const candidate = item("netherite_sword", 9);
    const heldItems = [
      item("iron_chestplate", 36, { durability: 0 }),
      item("iron_chestplate", 36, { customName: "記念品" }),
      item("iron_chestplate", 36, {
        enchantments: [{ name: "protection", level: 1 }],
      }),
      item("iron_sword", 36, { customName: "記念品" }),
      item("iron_sword", 36, {
        enchantments: [{ name: "sharpness", level: 1 }],
      }),
    ];

    for (const held of heldItems) {
      expect(
        findInventoryEquipmentUpgrade(
          observation({
            inventory: [held, candidate],
            equipment: { hand: held },
          }),
        ),
      ).toBeNull();
    }
  });

  it("uses only the first operable stack because Body addresses items by name", () => {
    const current = item("iron_helmet", 5, { durability: 40 });
    const first = item("diamond_helmet", 12, { durability: 0 });
    const laterSameName = item("diamond_helmet", 20);
    const craftingSlot = item("netherite_chestplate", 8);
    expect(
      findInventoryEquipmentUpgrade(
        observation({
          inventory: [laterSameName, first, craftingSlot],
          equipment: { head: current },
        }),
      ),
    ).toBeNull();
  });

  it("does not skip an already held first stack to target a later duplicate", () => {
    const held = item("iron_sword", 36, { durability: 20 });
    const laterDuplicate = item("iron_sword", 37, { durability: 100 });
    expect(
      findInventoryEquipmentUpgrade(
        observation({
          inventory: [held, laterDuplicate],
          equipment: { hand: held },
        }),
      ),
    ).toBeNull();
  });

  it("does not select a later chest duplicate after an unknown-quality first stack", () => {
    const first = item("diamond_helmet", 0, { durability: null });
    const laterDuplicate = item("diamond_helmet", 1);
    expect(
      findChestEquipmentWithdrawal(
        observation({
          equipment: { head: item("iron_helmet", 5) },
          window: chestWindow([first, laterDuplicate]),
        }),
      ),
    ).toBeNull();
  });

  it("withdraws one best chest item and ignores the player's window slots", () => {
    const current = item("iron_boots", 8);
    const betterInChest = item("diamond_boots", 0);
    const playerWindowItem = item("netherite_helmet", 27);
    const result = findChestEquipmentWithdrawal(
      observation({
        inventory: [current],
        equipment: { feet: current },
        window: chestWindow([betterInChest], [playerWindowItem]),
      }),
    );

    expect(result).toEqual({
      item: betterInChest,
      destination: "feet",
      count: 1,
    });
  });

  it("accepts modern double-chest and legacy chest layouts with matching slots", () => {
    const current = item("iron_helmet", 5);
    const candidate = item("diamond_helmet", 0);
    const singleChest = chestWindow([candidate]);
    const doubleChest: BodyWindowSnapshot = {
      ...singleChest,
      type: "minecraft:generic_9x6",
      inventoryStart: 54,
      inventoryEnd: 90,
      slots: [
        ...singleChest.slots.slice(0, 27),
        ...Array<BodyItemStack | null>(27).fill(null),
        ...Array<BodyItemStack | null>(36).fill(null),
      ],
    };
    const legacyChest = { ...singleChest, type: "minecraft:chest" };

    expect(
      findChestEquipmentWithdrawal(
        observation({
          equipment: { head: current },
          window: doubleChest,
        }),
      )?.item,
    ).toEqual(candidate);
    expect(
      findChestEquipmentWithdrawal(
        observation({
          equipment: { head: current },
          window: legacyChest,
        }),
      )?.item,
    ).toEqual(candidate);
    expect(
      findChestEquipmentWithdrawal(
        observation({
          equipment: { head: current },
          window: { ...singleChest, type: "minecraft:generic_9x2" },
        }),
      ),
    ).toBeNull();
  });

  it("matches window geometry produced by prismarine-windows", () => {
    const windows = prismarineWindows("1.21.4");
    const current = item("iron_helmet", 5);
    const candidate = item("diamond_helmet", 0);

    for (const [type, inventoryStart, inventoryEnd] of [
      ["minecraft:generic_9x3", 27, 63],
      ["minecraft:generic_9x6", 54, 90],
    ] as const) {
      const nativeWindow = windows.createWindow(7, type, "Chest");
      expect(nativeWindow).not.toBeNull();
      if (nativeWindow === null) throw new Error("Expected native window");
      const window: BodyWindowSnapshot = {
        id: 7,
        type: nativeWindow.type,
        title: nativeWindow.title,
        inventoryStart: nativeWindow.inventoryStart,
        inventoryEnd: nativeWindow.inventoryEnd,
        selectedItem: null,
        slots: nativeWindow.slots.map((_, index) =>
          index === 0 ? candidate : null,
        ),
      };

      expect([
        window.inventoryStart,
        window.inventoryEnd,
        window.slots.length,
      ]).toEqual([inventoryStart, inventoryEnd, inventoryEnd]);
      expect(isChestEquipmentWindow(window)).toBe(true);
      expect(
        findChestEquipmentWithdrawal(
          observation({
            equipment: { head: current },
            window,
          }),
        )?.item,
      ).toEqual(candidate);
    }
  });

  it("does not withdraw an equal or already-owned upgrade", () => {
    const current = item("iron_sword", 36);
    const equalChestItem = item("iron_sword", 0);
    expect(
      findChestEquipmentWithdrawal(
        observation({
          inventory: [current],
          equipment: { hand: current },
          window: chestWindow([equalChestItem]),
        }),
      ),
    ).toBeNull();

    const ownedUpgrade = item("diamond_helmet", 9);
    const weakerChestItem = item("iron_helmet", 0);
    expect(
      findChestEquipmentWithdrawal(
        observation({
          inventory: [ownedUpgrade],
          window: chestWindow([weakerChestItem]),
        }),
      ),
    ).toBeNull();
  });
});
