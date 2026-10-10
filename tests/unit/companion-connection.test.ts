import { EventEmitter } from "node:events";
import mineflayer from "mineflayer";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/domain/errors.js";
import {
  ConnectionManager,
  type MinecraftConnectionLifecycle,
} from "../../src/minecraft/connection-manager.js";
import {
  MineflayerClient,
  oxygenFromEntityMetadata,
} from "../../src/minecraft/mineflayer-client.js";

function createFakeBot(
  options: {
    readonly username?: string;
    readonly version?: string;
    readonly playerLoaded?: boolean;
    readonly tickEnd?: boolean;
    readonly namedMetadata?: boolean;
    readonly lessCharsInChat?: boolean;
    readonly waitForChunks?: () => Promise<void>;
  } = {},
) {
  const client = Object.assign(new EventEmitter(), {
    state: "play",
    write: vi.fn(),
  });
  const bot = Object.assign(new EventEmitter(), {
    _client: client,
    username: options.username ?? "Companion",
    version: options.version ?? "26.3",
    entity: { id: 1, name: "player" },
    registry: { entitiesByName: {} },
    inventory: new EventEmitter(),
    health: 20,
    loadPlugin: vi.fn(),
    supportFeature: vi.fn((feature: string) => {
      switch (feature) {
        case "sendsPlayerLoadedPacket":
          return options.playerLoaded ?? false;
        case "sendsClientTickEndPacket":
          return options.tickEnd ?? false;
        case "mcDataHasEntityMetadata":
          return options.namedMetadata ?? false;
        case "lessCharsInChat":
          return options.lessCharsInChat ?? false;
        default:
          return false;
      }
    }),
    waitForChunksToLoad:
      options.waitForChunks ?? vi.fn().mockResolvedValue(undefined),
    chat: vi.fn<(message: string) => void>(),
    end: vi.fn(function (this: EventEmitter, reason: string) {
      this.emit("end", reason);
    }),
  });
  return { bot, client };
}

function clientFor(
  username = "Companion",
  ownerUsername = "Owner",
  chatLengthLimit?: number,
) {
  return new MineflayerClient({
    bot: {
      username,
      version: "26.3",
      ...(chatLengthLimit === undefined ? {} : { chatLengthLimit }),
    },
    ownerUsername,
  });
}

function mockCreateBots(...bots: ReturnType<typeof createFakeBot>["bot"][]) {
  return vi
    .spyOn(mineflayer, "createBot")
    .mockImplementation(
      () => bots.shift() as unknown as ReturnType<typeof mineflayer.createBot>,
    );
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (index + 1 >= text.length || next < 0xdc00 || next > 0xdfff)
        return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("Minecraft companion connection", () => {
  it("waits for chunk readiness, attaches the body, filters its own chat, and sends chat", async () => {
    let resolveChunks!: () => void;
    const chunks = new Promise<void>((resolve) => {
      resolveChunks = resolve;
    });
    const { bot, client: protocolClient } = createFakeBot({
      username: "CompanionLive",
      playerLoaded: true,
      waitForChunks: () => chunks,
    });
    const createBot = mockCreateBots(bot);
    const minecraft = clientFor();
    const body = minecraft.createPlayerBody() as unknown as {
      attach: (attachedBot: unknown) => void;
    };
    const attach = vi.spyOn(body, "attach");
    const chats: [string, string][] = [];
    minecraft.onChat((username, message) => chats.push([username, message]));
    const disconnected: string[] = [];
    minecraft.onDisconnected((reason) => disconnected.push(reason));

    try {
      const connecting = minecraft.connect();
      await vi.waitFor(() => expect(createBot).toHaveBeenCalledOnce());
      bot.emit("spawn");
      await Promise.resolve();

      expect(minecraft.isConnected).toBe(false);
      expect(protocolClient.write).not.toHaveBeenCalledWith(
        "player_loaded",
        {},
      );

      resolveChunks();
      await connecting;

      expect(minecraft.isConnected).toBe(true);
      expect(protocolClient.write).toHaveBeenCalledWith("player_loaded", {});
      expect(attach).toHaveBeenCalledWith(bot);
      bot.emit("chat", "COMPANIONLIVE", "own echo");
      bot.emit("chat", "COMPANION", "configured identity echo");
      bot.emit("chat", "visitor", "hello");
      expect(chats).toEqual([["visitor", "hello"]]);

      await minecraft.say("こんにちは");
      expect(bot.chat).toHaveBeenCalledWith("こんにちは");

      bot.emit("end", "connection lost");
      expect(minecraft.isConnected).toBe(false);
      expect(disconnected).toEqual(["connection lost"]);
    } finally {
      createBot.mockRestore();
    }
  });

  it("sends up to 2000 characters in ordered packet-sized chunks", async () => {
    const { bot } = createFakeBot();
    const createBot = mockCreateBots(bot);
    const minecraft = clientFor();

    try {
      const connecting = minecraft.connect();
      await vi.waitFor(() => expect(createBot).toHaveBeenCalledOnce());
      bot.emit("spawn");
      await connecting;

      const commandAtBoundary = `${"a".repeat(256)}/cmd${"b".repeat(1_740)}`;
      await minecraft.say(commandAtBoundary);
      let packets = bot.chat.mock.calls.map(([packet]) => packet);

      expect(packets.length).toBeGreaterThan(1);
      expect(packets.every((packet) => packet.length <= 256)).toBe(true);
      expect(packets.every((packet) => !packet.startsWith("/"))).toBe(true);
      expect(
        packets.map((packet) => packet.replaceAll("\u200B", "")).join(""),
      ).toBe(commandAtBoundary);
      expect(packets[0]).toBe("a".repeat(256));
      expect(packets[1]?.startsWith("\u200B/cmd")).toBe(true);

      bot.chat.mockClear();
      const unicodeAtBoundary = `${"a".repeat(255)}🙂${"b".repeat(1_743)}`;
      await minecraft.say(unicodeAtBoundary);
      packets = bot.chat.mock.calls.map(([packet]) => packet);

      expect(
        packets.map((packet) => packet.replaceAll("\u200B", "")).join(""),
      ).toBe(unicodeAtBoundary);
      expect(packets.every((packet) => !hasUnpairedSurrogate(packet))).toBe(
        true,
      );
      expect(packets.every((packet) => packet.length <= 256)).toBe(true);
      await expect(minecraft.say("x".repeat(2_001))).rejects.toMatchObject({
        detail: { code: "INVALID_CHAT_MESSAGE" },
      });
    } finally {
      createBot.mockRestore();
    }
  });

  it("honors smaller configured chunks and caps larger ones at the feature limit", async () => {
    const scenarios: {
      configuredLimit?: number;
      lessCharsInChat?: boolean;
      expectedLimit: number;
    }[] = [
      { configuredLimit: 100, expectedLimit: 100 },
      { configuredLimit: 512, expectedLimit: 256 },
      { lessCharsInChat: true, expectedLimit: 100 },
    ];
    for (const scenario of scenarios) {
      const { bot } = createFakeBot(
        scenario.lessCharsInChat === undefined
          ? {}
          : { lessCharsInChat: scenario.lessCharsInChat },
      );
      const createBot = mockCreateBots(bot);
      const minecraft = clientFor(
        "Companion",
        "Owner",
        scenario.configuredLimit,
      );

      try {
        const connecting = minecraft.connect();
        await vi.waitFor(() => expect(createBot).toHaveBeenCalledOnce());
        bot.emit("spawn");
        await connecting;

        await minecraft.say("x".repeat(300));
        const packets = bot.chat.mock.calls.map(([packet]) => packet);
        expect(
          packets.every((packet) => packet.length <= scenario.expectedLimit),
        ).toBe(true);
        expect(packets.join("")).toBe("x".repeat(300));
      } finally {
        createBot.mockRestore();
      }
    }
  });

  it("rejects an invalid configured chat chunk limit before sending", async () => {
    const { bot } = createFakeBot();
    const createBot = mockCreateBots(bot);
    const minecraft = clientFor("Companion", "Owner", 1);

    try {
      const connecting = minecraft.connect();
      await vi.waitFor(() => expect(createBot).toHaveBeenCalledOnce());
      bot.emit("spawn");
      await connecting;

      await expect(minecraft.say("/command")).rejects.toMatchObject({
        detail: { code: "INVALID_CHAT_LENGTH_LIMIT" },
      });
      expect(bot.chat).not.toHaveBeenCalled();
    } finally {
      createBot.mockRestore();
    }
  });

  it("reattaches the same PlayerBody after a disconnect and respawn", async () => {
    const first = createFakeBot();
    const second = createFakeBot();
    const createBot = mockCreateBots(first.bot, second.bot);
    const minecraft = clientFor();
    const body = minecraft.createPlayerBody() as unknown as {
      attach: (attachedBot: unknown) => void;
    };
    const attach = vi.spyOn(body, "attach");
    const chats: [string, string][] = [];
    minecraft.onChat((username, message) => chats.push([username, message]));

    try {
      const firstConnection = minecraft.connect();
      await vi.waitFor(() => expect(createBot).toHaveBeenCalledTimes(1));
      first.bot.emit("spawn");
      await firstConnection;
      first.bot.emit("end", "temporary disconnect");
      first.bot.emit("chat", "visitor", "late after end");

      const secondConnection = minecraft.connect();
      await vi.waitFor(() => expect(createBot).toHaveBeenCalledTimes(2));
      second.client.emit("respawn");
      expect(minecraft.isConnected).toBe(false);
      second.bot.emit("spawn");
      await secondConnection;
      second.bot.emit("chat", "visitor", "current connection");
      first.bot.emit("chat", "visitor", "late from old connection");

      expect(minecraft.isConnected).toBe(true);
      expect(attach.mock.calls.map(([attachedBot]) => attachedBot)).toEqual([
        first.bot,
        second.bot,
      ]);
      expect(chats).toEqual([["visitor", "current connection"]]);
    } finally {
      createBot.mockRestore();
    }
  });

  it("ignores entity metadata before Mineflayer creates the bot entity", async () => {
    const { bot, client: protocolClient } = createFakeBot();
    const createBot = mockCreateBots(bot);
    const minecraft = clientFor();

    try {
      const connecting = minecraft.connect();
      await vi.waitFor(() => expect(createBot).toHaveBeenCalledOnce());
      const entity = bot.entity;
      (bot as unknown as { entity: unknown }).entity = undefined;

      expect(() =>
        protocolClient.emit("entity_metadata", {
          entityId: 1,
          metadata: [{ key: 1, value: 300 }],
        }),
      ).not.toThrow();

      (bot as unknown as { entity: unknown }).entity = entity;
      bot.emit("spawn");
      await connecting;
    } finally {
      createBot.mockRestore();
    }
  });

  it("rejects owner identity conflicts before starting Mineflayer", async () => {
    const createBot = vi.spyOn(mineflayer, "createBot");
    const minecraft = clientFor("OWNER", "owner");

    try {
      await expect(minecraft.connect()).rejects.toMatchObject({
        detail: { code: "MINECRAFT_IDENTITY_CONFLICT" },
      });
      expect(createBot).not.toHaveBeenCalled();
    } finally {
      createBot.mockRestore();
    }
  });

  it("rejects an owner identity conflict learned during login", async () => {
    const { bot } = createFakeBot({ username: "Owner" });
    const createBot = mockCreateBots(bot);
    const minecraft = clientFor("Companion", "owner");

    try {
      const connecting = minecraft.connect();
      await vi.waitFor(() => expect(createBot).toHaveBeenCalledOnce());
      bot.emit("login");

      await expect(connecting).rejects.toMatchObject({
        detail: { code: "MINECRAFT_IDENTITY_CONFLICT" },
      });
      expect(bot.end).toHaveBeenCalledWith("identity conflict");
    } finally {
      createBot.mockRestore();
    }
  });

  it("guards tick-end readiness and non-finite movement packets", async () => {
    const { bot, client: protocolClient } = createFakeBot({ tickEnd: true });
    const createBot = mockCreateBots(bot);
    const minecraft = clientFor();

    try {
      const connecting = minecraft.connect();
      await vi.waitFor(() => expect(createBot).toHaveBeenCalledOnce());
      bot._client.state = "configuration";
      bot.emit("physicsTick");
      expect(protocolClient.write).not.toHaveBeenCalled();

      bot._client.state = "play";
      bot.emit("spawn");
      await connecting;
      protocolClient.write.mockClear();

      bot.emit("physicsTick");
      protocolClient.write("position", { x: Number.NaN, y: 2, z: 3 });
      protocolClient.write("position", { x: 1, y: 2, z: 3 });

      expect(protocolClient.write.mock.calls).toEqual([
        ["tick_end", {}],
        ["position", { x: 1, y: 2, z: 3 }],
      ]);
      await minecraft.disconnect();
      expect(bot.listenerCount("physicsTick")).toBe(0);
    } finally {
      createBot.mockRestore();
    }
  });

  it("sets immediate post-respawn correction only for the 26.1 bridge", async () => {
    const { bot } = createFakeBot({ version: "26.1" });
    const createBot = mockCreateBots(bot);
    const minecraft = new MineflayerClient({
      bot: { username: "Companion", version: "26.1" },
      ownerUsername: "Owner",
    });

    try {
      const connecting = minecraft.connect();
      await vi.waitFor(() => expect(createBot).toHaveBeenCalledOnce());
      expect(createBot.mock.calls[0]?.[0]).toMatchObject({
        respawnPositionDelayMs: 0,
      });
      bot.emit("spawn");
      await connecting;
    } finally {
      createBot.mockRestore();
    }
  });

  it("accepts oxygen metadata only from the bot's own entity", () => {
    const packet = {
      entityId: 7,
      metadata: [{ key: 4, value: 285 }],
    };
    const metadataKeys = ["", "", "", "", "air_supply"];
    expect(oxygenFromEntityMetadata(packet, 7, metadataKeys)).toBe(19);
    expect(oxygenFromEntityMetadata(packet, 8, metadataKeys)).toBeUndefined();
    expect(
      oxygenFromEntityMetadata(
        { entityId: 7, metadata: [{ key: 4, value: 400 }] },
        7,
        metadataKeys,
      ),
    ).toBeNull();
  });

  it("normalizes bounded drowning air to zero oxygen and rejects invalid bounds", () => {
    const metadataKeys = ["", "", "", "", "air_supply"];
    for (const airSupply of [-20, -19, -16, -15, -1, 0]) {
      expect(
        oxygenFromEntityMetadata(
          { entityId: 7, metadata: [{ key: 4, value: airSupply }] },
          7,
          metadataKeys,
        ),
      ).toBe(0);
    }

    expect(
      oxygenFromEntityMetadata(
        { entityId: 7, metadata: [{ key: 4, value: 300 }] },
        7,
        metadataKeys,
      ),
    ).toBe(20);
    expect(
      oxygenFromEntityMetadata(
        { entityId: 7, metadata: [{ key: 4, value: 285 }] },
        7,
        metadataKeys,
      ),
    ).toBe(19);
    for (const airSupply of [-21, 301, 400, Number.NaN, "-16"]) {
      expect(
        oxygenFromEntityMetadata(
          { entityId: 7, metadata: [{ key: 4, value: airSupply }] },
          7,
          metadataKeys,
        ),
      ).toBeNull();
    }
    expect(
      oxygenFromEntityMetadata(
        { entityId: 8, metadata: [{ key: 4, value: -16 }] },
        7,
        metadataKeys,
      ),
    ).toBeUndefined();
  });

  it("stores zero oxygen from the bot's negative air-supply packet", async () => {
    const { bot, client: protocolClient } = createFakeBot({
      namedMetadata: true,
    });
    Object.assign(bot.registry.entitiesByName, {
      player: { metadataKeys: ["", "", "", "", "air_supply"] },
    });
    const createBot = mockCreateBots(bot);
    const minecraft = clientFor();
    const clientCache = minecraft as unknown as {
      authoritativeOxygen: number | null | undefined;
    };

    try {
      const connecting = minecraft.connect();
      await vi.waitFor(() => expect(createBot).toHaveBeenCalledOnce());
      protocolClient.emit("entity_metadata", {
        entityId: 1,
        metadata: [{ key: 4, value: -16 }],
      });
      expect(clientCache.authoritativeOxygen).toBe(0);
      bot.emit("spawn");
      await connecting;
    } finally {
      createBot.mockRestore();
    }
  });

  it("retries retryable connects and reconnects after a disconnect", async () => {
    let disconnectListener: ((reason: string) => void) | undefined;
    const connect = vi
      .fn<MinecraftConnectionLifecycle["connect"]>()
      .mockRejectedValueOnce(
        new AppError({
          category: "connection",
          code: "TEMPORARY",
          message: "Temporary connection failure",
          retryable: true,
        }),
      )
      .mockResolvedValue(undefined);
    const disconnect = vi
      .fn<MinecraftConnectionLifecycle["disconnect"]>()
      .mockResolvedValue(undefined);
    const onDisconnected = vi.fn<
      MinecraftConnectionLifecycle["onDisconnected"]
    >((listener) => {
      disconnectListener = listener;
      return () => {
        disconnectListener = undefined;
      };
    });
    const lifecycle: MinecraftConnectionLifecycle = {
      connect,
      disconnect,
      onDisconnected,
    };
    const manager = new ConnectionManager(
      lifecycle,
      {
        maxAttempts: 2,
        initialDelayMs: 0,
        maxDelayMs: 0,
        multiplier: 1,
      },
      1_000,
    );

    await manager.connect();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(manager.state).toBe("connected");

    disconnectListener?.("unexpected end");
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    expect(manager.state).toBe("connected");

    await manager.shutdown();
    expect(manager.state).toBe("stopped");
    expect(disconnect).toHaveBeenCalledWith("shutdown");
  });

  it("reports disabled reconnect without starting another connection", async () => {
    let disconnectListener: ((reason: string) => void) | undefined;
    const connect = vi
      .fn<MinecraftConnectionLifecycle["connect"]>()
      .mockResolvedValue(undefined);
    const disconnect = vi
      .fn<MinecraftConnectionLifecycle["disconnect"]>()
      .mockResolvedValue(undefined);
    const onDisconnected = vi.fn<
      MinecraftConnectionLifecycle["onDisconnected"]
    >((listener) => {
      disconnectListener = listener;
      return () => {
        disconnectListener = undefined;
      };
    });
    const lifecycle: MinecraftConnectionLifecycle = {
      connect,
      disconnect,
      onDisconnected,
    };
    const manager = new ConnectionManager(
      lifecycle,
      {
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        multiplier: 1,
      },
      1_000,
      false,
    );

    await manager.connect();
    disconnectListener?.("unexpected end");

    expect(manager.state).toBe("failed");
    expect(manager.lastReconnectFailure).toMatchObject({
      detail: { code: "RECONNECT_DISABLED" },
    });
    expect(connect).toHaveBeenCalledOnce();
    await manager.shutdown();
  });
});
