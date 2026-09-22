import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import {
  depositIntoChest,
  verifyDeposit,
} from "../../src/minecraft/chest-deposit.js";
import type { ChestTarget } from "../../src/memory/delivery-targets.js";
import type { StorageIdentity } from "../../src/minecraft/port.js";
const target: ChestTarget = {
  kind: "chest",
  worldId: "00000000-0000-4000-8000-000000000001",
  dimension: "overworld",
  position: { x: 1, y: 64, z: 0 },
  identity: "fixture",
};
const proof = (
  playerCount: number,
  chestCount: number,
  revision = 0,
): StorageIdentity => ({
  worldId: target.worldId,
  identity: target.identity,
  observation: {
    playerCount,
    chestCount,
    revision,
    epoch: target.worldId,
    uncontested: true,
  },
});
interface Item {
  name: string;
  count: number;
  stackSize: number;
  slot: number;
  metadata: number;
  nbt: null;
  components: unknown[];
}
const item = (name: string, count: number, slot: number): Item => ({
  name,
  count,
  slot,
  stackSize: 64,
  metadata: 0,
  nbt: null,
  components: [],
});
function simulation(full = false, abortAt = 0, externalChange = false) {
  const controller = new AbortController();
  let calls = 0;
  let revision = 0;
  const slots: (Item | null)[] = Array.from({ length: 63 }, (_, slot) =>
    slot < 27 && full ? item("stone", 64, slot) : null,
  );
  slots[27] = item("oak_log", 5, 27);
  slots[28] = item("diamond", 3, 28);
  const window = {
    slots,
    inventoryStart: 27,
    inventoryEnd: 63,
    selectedItem: null as Item | null,
    close: () => {
      if (window.selectedItem) {
        window.slots[27] = window.selectedItem;
        window.selectedItem = null;
      }
      bot.currentWindow = null;
    },
  };
  const bot = {
    currentWindow: null as typeof window | null,
    blockAt: () => ({ name: "chest" }),
    quit: vi.fn(),
    openContainer: vi.fn(async () => {
      bot.currentWindow = window;
      return window;
    }),
    clickWindow: vi.fn(async (slot: number, button: number) => {
      calls++;
      if (window.selectedItem === null) {
        if (slot < 27) throw new Error("Attempted withdrawal");
        window.selectedItem = slots[slot] ?? null;
        slots[slot] = null;
      } else if (button === 1) {
        const current = slots[slot];
        if (current && current.name !== window.selectedItem.name)
          throw new Error("Attempted swap");
        if (current) current.count++;
        else slots[slot] = item(window.selectedItem.name, 1, slot);
        window.selectedItem.count--;
        if (window.selectedItem.count === 0) window.selectedItem = null;
      } else {
        if (slots[slot]) throw new Error("Occupied return slot");
        slots[slot] = window.selectedItem;
        window.selectedItem = null;
      }
      if (externalChange && slot < 27) revision++;
      if (calls === abortAt) controller.abort();
    }),
  };
  const count = (start: number, end: number) =>
    slots
      .slice(start, end)
      .filter((i) => i?.name === "oak_log")
      .reduce((n, i) => n + (i?.count ?? 0), 0);
  return {
    bot: bot as unknown as Bot,
    window,
    signal: controller.signal,
    inspect: async () => proof(count(27, 63), count(0, 27), revision),
  };
}
describe("observed deposit", () => {
  it("requires matching player decrease and chest increase with no concurrent changes", () => {
    expect(verifyDeposit(proof(5, 10), proof(3, 12), 2)).toMatchObject({
      verified: true,
      deposited: 2,
      remaining: 0,
      heldCount: 3,
    });
    expect(verifyDeposit(proof(5, 10), proof(3, 11), 2).verified).toBe(false);
    expect(verifyDeposit(proof(5, 10), proof(3, 12, 1), 2).verified).toBe(
      false,
    );
    expect(
      verifyDeposit(
        proof(5, 10),
        { ...proof(3, 12), identity: "replacement" },
        2,
      ).verified,
    ).toBe(false);
  });
  it("deposits exactly the requested logs and preserves unrelated inventory", async () => {
    const s = simulation();
    const result = await depositIntoChest(
      s.bot,
      target,
      "oak_log",
      2,
      s.signal,
      s.inspect,
    );
    expect(result).toMatchObject({
      verified: true,
      deposited: 2,
      remaining: 0,
      heldCount: 3,
      reason: "completed",
    });
    expect(s.window.slots[28]).toMatchObject({ name: "diamond", count: 3 });
    expect(s.bot.currentWindow).toBeNull();
  });
  it("full chest does not pick up any inventory or claim completion", async () => {
    const s = simulation(true);
    const result = await depositIntoChest(
      s.bot,
      target,
      "oak_log",
      2,
      s.signal,
      s.inspect,
    );
    expect(result).toMatchObject({
      verified: true,
      deposited: 0,
      heldCount: 5,
      reason: "full",
    });
    expect(s.bot.clickWindow).not.toHaveBeenCalled();
  });
  it("stop after one item closes the window and reconciles partial storage", async () => {
    const s = simulation(false, 2);
    const result = await depositIntoChest(
      s.bot,
      target,
      "oak_log",
      2,
      s.signal,
      s.inspect,
    );
    expect(result).toMatchObject({
      verified: true,
      deposited: 1,
      remaining: 1,
      heldCount: 4,
      reason: "cancelled",
    });
    expect(s.bot.clickWindow).toHaveBeenCalledTimes(2);
    expect(s.bot.currentWindow).toBeNull();
  });
  it("never claims verified completion when another operation changes the chest", async () => {
    const s = simulation(false, 0, true);
    const result = await depositIntoChest(
      s.bot,
      target,
      "oak_log",
      2,
      s.signal,
      s.inspect,
    );
    expect(result).toMatchObject({
      verified: false,
      deposited: null,
      reason: "unverified",
    });
  });
  it("does not merge into a same-name stack with different components", async () => {
    const s = simulation();
    s.window.slots[0] = {
      ...item("oak_log", 2, 0),
      components: [{ custom_name: "fixture" }],
    };
    const result = await depositIntoChest(
      s.bot,
      target,
      "oak_log",
      1,
      s.signal,
      s.inspect,
    );
    expect(result.verified).toBe(true);
    expect(s.window.slots[0].count).toBe(2);
    expect(s.window.slots[1]?.count).toBe(1);
  });
});
