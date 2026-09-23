import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  queryTreeProtection,
  requireTreePermission,
  treeProtectionChannel,
} from "../../src/minecraft/tree-protection.js";

type Client = Parameters<typeof queryTreeProtection>[0];
const target = { name: "oak_log", position: { x: 1, y: 64, z: 2 } };
function connection(decision?: string) {
  const events = new EventEmitter();
  const write = vi.fn((_name: string, packet: { data: Buffer }) => {
    const id = packet.data.toString().split("|")[0];
    if (decision)
      queueMicrotask(() =>
        events.emit("custom_payload", {
          channel: treeProtectionChannel,
          data: Buffer.from(`${id}|${decision}`),
        }),
      );
  });
  return {
    client: Object.assign(events, { write }) as unknown as Client,
    events,
    write,
  };
}
describe("tree protection protocol", () => {
  it.each(["allowed", "unknown", "protected", "changed"] as const)(
    "accepts bounded server decision %s",
    async (decision) => {
      const { client, events } = connection(decision);
      expect(await queryTreeProtection(client, target)).toBe(decision);
      expect(events.listenerCount("custom_payload")).toBe(0);
      expect(events.listenerCount("end")).toBe(0);
    },
  );
  it.each(["unknown", "protected", "changed"] as const)(
    "never authorizes %s",
    (decision) => {
      expect(() => requireTreePermission(decision)).toThrow();
    },
  );
  it("fails closed for missing helper and removes listeners", async () => {
    const { client, events } = connection();
    await expect(
      queryTreeProtection(client, target, undefined, 5),
    ).rejects.toMatchObject({
      detail: { code: "TREE_PROTECTION_UNAVAILABLE" },
    });
    expect(events.listenerCount("custom_payload")).toBe(0);
  });
  it("ignores unrelated responses and rejects invalid decisions", async () => {
    const { client, events } = connection("permit_everything");
    const result = queryTreeProtection(client, target);
    events.emit("custom_payload", {
      channel: treeProtectionChannel,
      data: Buffer.from("unrelated|allowed"),
    });
    await expect(result).rejects.toMatchObject({
      detail: { code: "TREE_PROTECTION_INVALID_RESPONSE" },
    });
  });
  it("cancels pending inspection and sends no request after stop", async () => {
    const { client, events, write } = connection();
    const abort = new AbortController();
    const result = queryTreeProtection(client, target, abort.signal);
    abort.abort();
    await expect(result).rejects.toThrow();
    expect(events.listenerCount("custom_payload")).toBe(0);
    await expect(
      queryTreeProtection(client, target, abort.signal),
    ).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("connection loss invalidates the request", async () => {
    const { client, events } = connection();
    const result = queryTreeProtection(client, target);
    events.emit("end");
    await expect(result).rejects.toMatchObject({
      detail: { code: "TREE_PROTECTION_DISCONNECTED" },
    });
  });
  it("does not reuse exploration permission at mining time", async () => {
    const { client, write } = connection("allowed");
    expect(await queryTreeProtection(client, target)).toBe("allowed");
    expect(await queryTreeProtection(client, target)).toBe("allowed");
    expect(
      write.mock.calls[0]?.[1].data.toString() ===
        write.mock.calls[1]?.[1].data.toString(),
    ).toBe(false);
  });
});

describe("Mineflayer mining boundary", () => {
  async function miningClient(decision: string, abortDuringEquip = false) {
    const { MineflayerClient } =
      await import("../../src/minecraft/mineflayer-client.js");
    const { Vec3 } = await import("vec3");
    const { client } = connection(decision);
    const abort = new AbortController();
    let mined = false;
    const block = { name: "oak_log", stateId: 1, position: new Vec3(1, 64, 2) };
    const bot = {
      _client: client,
      blockAt: () => (mined ? { ...block, name: "air", stateId: 0 } : block),
      world: {},
      canDigBlock: () => true,
      pathfinder: { bestHarvestTool: () => ({}) },
      equip: vi.fn(async () => {
        if (abortDuringEquip) abort.abort();
      }),
      stopDigging: vi.fn(),
      dig: vi.fn(async () => {
        mined = true;
      }),
    };
    const adapter = new MineflayerClient(
      {
        bot: { username: "fixture_bot" },
        ownerUsername: "fixture_owner",
        pathfinderThinkTimeoutMs: 100,
        pathfinderTickTimeoutMs: 10,
        collectTimeoutMs: 100,
      },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    Object.assign(adapter, {
      botInstance: bot,
      spawned: true,
      runPathfinder: vi.fn().mockResolvedValue(undefined),
    });
    return { adapter, bot, abort };
  }
  it.each(["protected", "unknown", "changed"])(
    "never digs a %s target",
    async (decision) => {
      const { adapter, bot, abort } = await miningClient(decision);
      await expect(adapter.dig(target, abort.signal)).rejects.toThrow();
      expect(bot.dig).not.toHaveBeenCalled();
    },
  );
  it("does not start digging when stopped during equipment change", async () => {
    const { adapter, bot, abort } = await miningClient("allowed", true);
    await expect(adapter.dig(target, abort.signal)).rejects.toThrow();
    expect(bot.dig).not.toHaveBeenCalled();
  });
  it("digs only after fresh permission and checks observed removal", async () => {
    const { adapter, bot, abort } = await miningClient("allowed");
    await adapter.dig(target, abort.signal);
    expect(bot.dig).toHaveBeenCalledTimes(1);
  });
});

describe("protected resource candidate paging", () => {
  it("finds an allowed tree after more than 64 denied logs and stops requests on abort", async () => {
    const { MineflayerClient } =
      await import("../../src/minecraft/mineflayer-client.js");
    const { Vec3 } = await import("vec3");
    const blocks = Array.from({ length: 70 }, (_, x) => ({
      name: "oak_log",
      position: new Vec3(x, 64, 0),
    }));
    const events = new EventEmitter();
    const abort = new AbortController();
    let requests = 0;
    const write = vi.fn((_name: string, packet: { data: Buffer }) => {
      const [id, x] = packet.data.toString().split("|");
      requests++;
      queueMicrotask(() =>
        events.emit("custom_payload", {
          channel: treeProtectionChannel,
          data: Buffer.from(
            `${id}|${Number(x) === 69 ? "allowed" : "protected"}`,
          ),
        }),
      );
    });
    const findBlocks = vi.fn(
      (options: {
        count: number;
        useExtraInfo: (block: (typeof blocks)[number]) => boolean;
      }) =>
        blocks
          .filter(options.useExtraInfo)
          .slice(0, options.count)
          .map((b) => b.position),
    );
    const adapter = new MineflayerClient(
      {
        bot: { username: "fixture_bot" },
        ownerUsername: "fixture_owner",
        pathfinderThinkTimeoutMs: 100,
        pathfinderTickTimeoutMs: 10,
        collectTimeoutMs: 100,
      },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    Object.assign(adapter, {
      spawned: true,
      botInstance: {
        registry: { blocksByName: { oak_log: { id: 1 } } },
        _client: Object.assign(events, { write }),
        findBlocks,
        blockAt: (position: { x: number }) => blocks[position.x],
      },
    });
    expect(
      await adapter.findResources(["oak_log"], 80, 1, abort.signal),
    ).toEqual([{ name: "oak_log", position: { x: 69, y: 64, z: 0 } }]);
    expect(findBlocks).toHaveBeenCalledTimes(2);
    expect(requests).toBe(70);
    abort.abort();
    await expect(
      adapter.findResources(["oak_log"], 80, 1, abort.signal),
    ).rejects.toThrow();
    expect(requests).toBe(70);
  });
});
