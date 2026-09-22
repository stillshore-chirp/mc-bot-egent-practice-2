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
        { entityId: 1, metadata: [{ key: 4, value: 76 }] },
        1,
        metadataKeys,
      ),
    ).toBe(6);
    expect(
      oxygenFromEntityMetadata(
        { entityId: 1, metadata: [{ key: 4, value: 399 }] },
        1,
        metadataKeys,
      ),
    ).toBeNull();
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
