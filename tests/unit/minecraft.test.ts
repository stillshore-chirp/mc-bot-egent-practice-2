import { Vec3 } from "vec3";
import {
  MineflayerClient,
  oxygenFromEntityMetadata,
} from "../../src/minecraft/mineflayer-client.js";
import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../../src/minecraft/connection-manager.js";
import { FakeMinecraft } from "../support/fake-minecraft.js";

describe("Minecraft boundary", () => {
  it("connects through the bounded connection manager", async () => {
    const minecraft = new FakeMinecraft();
    const manager = new ConnectionManager(
      minecraft,
      { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, multiplier: 1 },
      1_000,
    );
    await manager.connect();
    expect(manager.state).toBe("connected");
    expect(minecraft.actions).toEqual(["connect"]);
  });

  it("stops product controls through the port", async () => {
    const minecraft = new FakeMinecraft();
    await minecraft.stopCurrentAction();
    expect(minecraft.stopCount).toBe(1);
  });

  it("returns actually observed bounded surroundings through the port contract", async () => {
    const minecraft = new FakeMinecraft();
    minecraft.resources.push({
      name: "oak_log",
      position: { x: 1, y: 64, z: 0 },
    });
    const surroundings = await minecraft.observeSurroundings(8, false);
    expect(surroundings.blocks).toMatchObject([{ name: "oak_log" }]);
    expect(surroundings.entities).toEqual([]);
  });

  it("observes requested ore even when nearby ground fills the general scan", async () => {
    const client = new MineflayerClient(
      {
        bot: { username: "fixture_bot" },
        pathfinderThinkTimeoutMs: 100,
        pathfinderTickTimeoutMs: 10,
        collectTimeoutMs: 100,
      },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    const ground = Array.from(
      { length: 128 },
      (_, index) => new Vec3((index % 16) + 1, 63, Math.floor(index / 16) + 1),
    );
    const ore = new Vec3(2, 64, 0);
    const blocks = [
      ...ground.map((position) => ({ name: "dirt", position })),
      { name: "iron_ore", position: ore },
    ];
    const bot = {
      username: "fixture_bot",
      entity: {
        id: 1,
        position: new Vec3(0, 64, 0),
        velocity: new Vec3(0, 0, 0),
      },
      inventory: { items: () => [] },
      players: {},
      entities: {},
      registry: { itemsByName: {}, blocksByName: {} },
      findBlocks: ({
        matching,
        count,
      }: {
        matching: (block: { name: string }) => boolean;
        count: number;
      }) =>
        blocks
          .filter((block) => matching(block))
          .slice(0, count)
          .map((block) => block.position),
      findBlock: () => null,
      blockAt: (position: Vec3) =>
        blocks.find((block) => block.position.equals(position)) ?? null,
      game: { dimension: "overworld" },
      health: 20,
      food: 20,
    };
    Object.assign(client, { spawned: true, botInstance: bot });

    const general = await client.observeSurroundings(32, true);
    expect(general.blocks).toHaveLength(128);
    expect(general.blocks.some((block) => block.name === "iron_ore")).toBe(
      false,
    );

    const candidates = await client.observeActionCandidates(
      { radius: 32, requestedItems: ["iron_ingot"], maxCandidates: 8 },
      new AbortController().signal,
    );
    expect(candidates).toMatchObject([
      {
        action: "mine_block",
        resourceName: "iron_ore",
        goalItem: "iron_ingot",
        intermediateItems: ["raw_iron"],
      },
    ]);
  });

  it("reclaims the bot-owned furnace input, output, and fuel after an owner stop", async () => {
    const controller = new AbortController();
    const client = new MineflayerClient(
      {
        bot: { username: "fixture_bot" },
        pathfinderThinkTimeoutMs: 100,
        pathfinderTickTimeoutMs: 10,
        collectTimeoutMs: 100,
      },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    const held = new Map([
      ["raw_iron", 6],
      ["coal", 1],
    ]);
    const slots: {
      input: { name: string; count: number } | null;
      fuel: { name: string; count: number } | null;
      output: { name: string; count: number } | null;
    } = { input: null, fuel: null, output: null };
    const taken: string[] = [];
    const furnace = {
      inputItem: () => slots.input,
      fuelItem: () => slots.fuel,
      outputItem: () => slots.output,
      putInput: async (_id: number, _metadata: unknown, count: number) => {
        held.set("raw_iron", (held.get("raw_iron") ?? 0) - count);
        slots.input = { name: "raw_iron", count };
      },
      putFuel: async (_id: number, _metadata: unknown, count: number) => {
        held.set("coal", (held.get("coal") ?? 0) - count);
        slots.fuel = { name: "coal", count };
        slots.input = { name: "raw_iron", count: 5 };
        slots.output = { name: "iron_ingot", count: 1 };
        controller.abort(new Error("owner stop"));
      },
      takeInput: async () => {
        taken.push("input");
        held.set("raw_iron", (held.get("raw_iron") ?? 0) + 5);
        slots.input = null;
      },
      takeOutput: async () => {
        taken.push("output");
        held.set("iron_ingot", (held.get("iron_ingot") ?? 0) + 1);
        slots.output = null;
      },
      takeFuel: async () => {
        taken.push("fuel");
        held.set("coal", (held.get("coal") ?? 0) + 1);
        slots.fuel = null;
      },
      close: vi.fn(),
    };
    const bot = {
      username: "fixture_bot",
      entity: {
        id: 1,
        position: new Vec3(0, 64, 0),
        velocity: new Vec3(0, 0, 0),
      },
      inventory: {
        items: () =>
          [...held]
            .filter(([, count]) => count > 0)
            .map(([name, count]) => ({ name, count })),
      },
      players: {},
      entities: {},
      registry: {
        itemsByName: {
          raw_iron: { id: 1, name: "raw_iron" },
          coal: { id: 2, name: "coal" },
        },
        blocksByName: {},
      },
      blockAt: (position: Vec3) =>
        position.equals(new Vec3(1, 64, 0))
          ? { name: "furnace" }
          : { name: "air" },
      openFurnace: async () => furnace,
      game: { dimension: "overworld" },
      health: 20,
      food: 20,
    };
    Object.assign(client, { spawned: true, botInstance: bot });

    await expect(
      client.smeltItem(
        {
          input: "raw_iron",
          output: "iron_ingot",
          count: 6,
          furnace: { x: 1, y: 64, z: 0 },
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(taken).toEqual(["input", "output", "fuel"]);
    expect(slots).toEqual({ input: null, fuel: null, output: null });
    expect(furnace.close).toHaveBeenCalledOnce();
  });

  it.each(["open", "input"] as const)(
    "does not fuel a furnace after cancellation during %s",
    async (abortDuring) => {
      const controller = new AbortController();
      const client = new MineflayerClient(
        {
          bot: { username: "fixture_bot" },
          pathfinderThinkTimeoutMs: 100,
          pathfinderTickTimeoutMs: 10,
          collectTimeoutMs: 100,
        },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      );
      let rawIron = 6;
      let inputSlot: { name: string; count: number } | null = null;
      const putInput = vi.fn(async () => {
        rawIron = 0;
        inputSlot = { name: "raw_iron", count: 6 };
        if (abortDuring === "input") controller.abort(new Error("owner stop"));
      });
      const putFuel = vi.fn(async () => undefined);
      const furnace = {
        inputItem: () => inputSlot,
        fuelItem: () => null,
        outputItem: () => null,
        putInput,
        putFuel,
        takeInput: async () => {
          rawIron = 6;
          inputSlot = null;
        },
        takeFuel: async () => undefined,
        takeOutput: async () => undefined,
        close: vi.fn(),
      };
      const bot = {
        username: "fixture_bot",
        entity: {
          id: 1,
          position: new Vec3(0, 64, 0),
          velocity: new Vec3(0, 0, 0),
        },
        inventory: {
          items: () => [
            { name: "raw_iron", count: rawIron },
            { name: "coal", count: 1 },
          ],
        },
        players: {},
        entities: {},
        registry: {
          itemsByName: {
            raw_iron: { id: 1, name: "raw_iron" },
            coal: { id: 2, name: "coal" },
          },
          blocksByName: {},
        },
        blockAt: (position: Vec3) =>
          position.equals(new Vec3(1, 64, 0))
            ? { name: "furnace" }
            : { name: "air" },
        openFurnace: async () => {
          if (abortDuring === "open") controller.abort(new Error("owner stop"));
          return furnace;
        },
        game: { dimension: "overworld" },
        health: 20,
        food: 20,
      };
      Object.assign(client, { spawned: true, botInstance: bot });

      await expect(
        client.smeltItem(
          {
            input: "raw_iron",
            output: "iron_ingot",
            count: 6,
            furnace: { x: 1, y: 64, z: 0 },
          },
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(putInput).toHaveBeenCalledTimes(abortDuring === "open" ? 0 : 1);
      expect(putFuel).not.toHaveBeenCalled();
      expect(inputSlot).toBeNull();
      expect(rawIron).toBe(6);
      expect(furnace.close).toHaveBeenCalledOnce();
    },
  );

  it("subscribes and unsubscribes chat listeners", () => {
    const minecraft = new FakeMinecraft();
    const messages: string[] = [];
    const unsubscribe = minecraft.onChat((_username, message) =>
      messages.push(message),
    );
    minecraft.emitChat("owner", "first");
    unsubscribe();
    minecraft.emitChat("owner", "second");
    expect(messages).toEqual(["first"]);
  });

  it("reconnects with the same bounded policy after a connection end", async () => {
    const minecraft = new FakeMinecraft();
    const manager = new ConnectionManager(
      minecraft,
      { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, multiplier: 1 },
      1_000,
    );
    await manager.connect();
    minecraft.emitDisconnected();
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      minecraft.actions.filter((action) => action === "connect"),
    ).toHaveLength(2);
    await manager.shutdown();
    expect(manager.state).toBe("stopped");
  });

  it("enters an explicit failed state when reconnect is disabled", async () => {
    const minecraft = new FakeMinecraft();
    const manager = new ConnectionManager(
      minecraft,
      { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, multiplier: 1 },
      1_000,
      false,
    );
    await manager.connect();
    minecraft.emitDisconnected();
    expect(manager.state).toBe("failed");
    expect(manager.lastReconnectFailure).toMatchObject({
      detail: { code: "RECONNECT_DISABLED" },
    });
    await manager.shutdown();
  });
});

describe("Mineflayer player observation", () => {
  it("attributes air supply to the Bot entity instead of nearby entity metadata", () => {
    const metadataKeys: string[] = [];
    metadataKeys[4] = "air_supply";
    const botFull = {
      entityId: 1,
      metadata: [{ key: 4, value: 300 }],
    };
    const nearbyLow = {
      entityId: 2,
      metadata: [{ key: 4, value: 75 }],
    };
    const botLow = {
      entityId: 1,
      metadata: [{ key: 4, value: 75 }],
    };
    const nearbyFull = {
      entityId: 2,
      metadata: [{ key: 4, value: 300 }],
    };

    expect(oxygenFromEntityMetadata(botFull, 1, metadataKeys)).toBe(20);
    expect(
      oxygenFromEntityMetadata(nearbyLow, 1, metadataKeys),
    ).toBeUndefined();
    expect(oxygenFromEntityMetadata(botLow, 1, metadataKeys)).toBe(5);
    expect(
      oxygenFromEntityMetadata(nearbyFull, 1, metadataKeys),
    ).toBeUndefined();
    expect(
      oxygenFromEntityMetadata(
        { entityId: 1, metadata: [{ key: 4, value: 399 }] },
        1,
        metadataKeys,
      ),
    ).toBeNull();
  });

  it.each([
    [1, 1],
    [7, 1],
    [8, 1],
    [75, 5],
    [76, 6],
    [82, 6],
  ])("maps raw air supply %i to oxygen unit %i", (raw, expected) => {
    const metadataKeys: string[] = [];
    metadataKeys[4] = "air_supply";
    expect(
      oxygenFromEntityMetadata(
        { entityId: 1, metadata: [{ key: 4, value: raw }] },
        1,
        metadataKeys,
      ),
    ).toBe(expected);
  });

  it("returns Bot oxygen, water state, and derived hazard from one observation", async () => {
    const client = new MineflayerClient(
      {
        bot: { username: "fixture_bot" },
        pathfinderThinkTimeoutMs: 100,
        pathfinderTickTimeoutMs: 10,
        collectTimeoutMs: 100,
      },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    Object.assign(client, {
      spawned: true,
      authoritativeOxygen: 5,
      botInstance: {
        username: "fixture_bot",
        entity: {
          id: 1,
          position: new Vec3(0, 64, 0),
          velocity: new Vec3(0, 0, 0),
          isInWater: true,
        },
        inventory: { items: () => [] },
        players: {},
        entities: {},
        findBlocks: () => [],
        blockAt: () => null,
        game: { dimension: "overworld" },
        health: 20,
        food: 20,
        oxygenLevel: 5,
      },
    });

    const snapshot = await client.observe();
    const surroundings = await client.observeSurroundings(8, false);

    expect(snapshot).toMatchObject({
      subject: "bot",
      source: "minecraft",
      oxygen: 5,
      oxygenState: "low",
      inWater: true,
    });
    expect(surroundings).toMatchObject({
      subject: "bot",
      source: "minecraft",
      oxygen: 5,
      oxygenState: "low",
      inWater: true,
      hazards: ["low_oxygen"],
    });
    expect(surroundings.observedAt).toEqual(expect.any(String));
  });

  it("marks out-of-range oxygen as unknown instead of reporting a false numeric value", async () => {
    const client = new MineflayerClient(
      {
        bot: { username: "fixture_bot" },
        pathfinderThinkTimeoutMs: 100,
        pathfinderTickTimeoutMs: 10,
        collectTimeoutMs: 100,
      },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    const bot = {
      username: "fixture_bot",
      entity: {
        id: 1,
        position: new Vec3(0, 64, 0),
        velocity: new Vec3(0, 0, 0),
        isInWater: false,
      },
      inventory: { items: () => [] },
      players: {},
      entities: {},
      findBlocks: () => [],
      blockAt: () => null,
      game: { dimension: "overworld" },
      health: 20,
      food: 20,
      oxygenLevel: 399,
    };
    Object.assign(client, { spawned: true, botInstance: bot });

    const snapshot = await client.observe();
    const surroundings = await client.observeSurroundings(8, false);

    expect(snapshot).toMatchObject({
      oxygen: null,
      oxygenState: "unknown",
      inWater: false,
    });
    expect(surroundings.hazards).toEqual([]);

    bot.entity.isInWater = true;
    const underwaterSurroundings = await client.observeSurroundings(8, false);
    expect(underwaterSurroundings).toMatchObject({
      oxygen: null,
      oxygenState: "unknown",
      inWater: true,
      hazards: ["oxygen_unconfirmed"],
    });
  });

  it("ignores distant unloaded players while preserving visible observations", async () => {
    const client = new MineflayerClient(
      {
        bot: { username: "fixture_bot" },
        pathfinderThinkTimeoutMs: 100,
        pathfinderTickTimeoutMs: 10,
        collectTimeoutMs: 100,
      },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    Object.assign(client, {
      spawned: true,
      botInstance: {
        username: "fixture_bot",
        entity: {
          id: 1,
          position: new Vec3(0, 64, 0),
          velocity: new Vec3(0, 0, 0),
        },
        inventory: { items: () => [] },
        players: {
          unloaded: { username: "unloaded", entity: null },
          missing: { username: "missing", entity: undefined },
          visible: {
            username: "visible",
            entity: { position: new Vec3(2, 64, 0) },
          },
        },
        entities: {},
        blockAt: () => null,
        game: { dimension: "overworld" },
        health: 20,
        food: 20,
        oxygenLevel: 20,
      },
    });
    const state = await client.observe();
    expect(state.players).toEqual([
      { username: "visible", position: { x: 2, y: 64, z: 0 }, distance: 2 },
    ]);
    expect(state.connected).toBe(true);
  });
});
