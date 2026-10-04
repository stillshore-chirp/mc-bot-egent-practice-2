import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import minecraftData from "minecraft-data";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  restoreSource,
  transformSource,
} from "../../scripts/patch-mineflayer-respawn-position-delay.js";
import { Vec3 } from "vec3";

const require = createRequire(import.meta.url);
const physicsPlugin = require("mineflayer/lib/plugins/physics.js") as (
  bot: unknown,
  options: {
    readonly physicsEnabled?: boolean;
    readonly respawnPositionDelayMs?: number;
  },
) => void;
const declaration =
  "function inject (bot, { physicsEnabled, maxCatchupTicks }) {";
const delayBlock = `    if (respawnTimer > 0 && Date.now() - respawnTimer < 2000) {
      respawnTimer = 0 // only delay once
      const delayedPos = pos.clone()
      const delayedYaw = newYaw
      const delayedPitch = newPitch
      const delayedOnGround = bot.entity.onGround
      setTimeout(() => {
        sendPacketPositionAndLook(delayedPos, delayedYaw, delayedPitch, delayedOnGround)
        shouldUsePhysics = true
        bot.jumpTicks = 0
        lastSentYaw = bot.entity.yaw
        lastSentPitch = bot.entity.pitch
        bot.emit('forcedMove')
      }, 1500)
      return
    }
`;
const upstreamSnippet = `${declaration}\n${delayBlock}`;

type FakeBot = EventEmitter & {
  readonly _client: EventEmitter & {
    state: string;
    write(name: string, payload: unknown): void;
  };
  readonly registry: unknown;
  readonly entity: {
    readonly position: InstanceType<typeof Vec3>;
    readonly velocity: InstanceType<typeof Vec3>;
    yaw: number;
    pitch: number;
    onGround: boolean;
    height: number;
  };
  readonly game: { readonly gameMode: string };
  readonly version: string;
  isAlive: boolean;
  physicsEnabled: boolean;
  jumpTicks: number;
  blockAt(): object;
  supportFeature(feature: string): boolean;
};

const activeBots: FakeBot[] = [];

afterEach(() => {
  for (const bot of activeBots.splice(0)) bot.emit("end");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function useDeterministicClock(): void {
  vi.useFakeTimers({
    toFake: [
      "clearInterval",
      "clearTimeout",
      "Date",
      "performance",
      "setInterval",
      "setTimeout",
    ],
  });
  vi.setSystemTime(new Date("2026-10-04T11:00:00.000Z"));
  const startedAt = Date.now();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - startedAt);
}

function createFakeBot(): {
  bot: FakeBot;
  writes: string[];
  blockAt: ReturnType<typeof vi.fn>;
} {
  const registry = minecraftData("26.1");
  const writes: string[] = [];
  const blockAt = vi.fn(() => ({}));
  const client = Object.assign(new EventEmitter(), {
    state: "play",
    write: (name: string, _payload: unknown) => {
      writes.push(name);
    },
  });
  const bot = Object.assign(new EventEmitter(), {
    _client: client,
    registry,
    entity: {
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: false,
      height: 1.8,
    },
    game: { gameMode: "survival" },
    version: "26.1",
    isAlive: true,
    physicsEnabled: false,
    jumpTicks: 0,
    blockAt,
    supportFeature: (feature: string) => feature === "teleportUsesOwnPacket",
  }) as FakeBot;
  activeBots.push(bot);
  return { bot, writes, blockAt };
}

function startRespawnCorrection(bot: FakeBot): void {
  bot.emit("login");
  bot.isAlive = false;
  bot.emit("death");
  bot.emit("respawn");
  bot.isAlive = true;
  bot._client.emit("position", {
    x: 0,
    y: 64,
    z: 0,
    yaw: 0,
    pitch: 0,
    flags: { x: false, y: false, z: false, yaw: false, pitch: false },
    teleportId: 7,
  });
}

describe("Mineflayer post-respawn position delay patch", () => {
  it("is reversible, idempotent, and fails closed when its anchors drift", () => {
    const patched = transformSource(upstreamSnippet);
    expect(restoreSource(patched)).toBe(upstreamSnippet);
    expect(() => transformSource(patched)).toThrow(/PATCH_ALREADY_PRESENT/);
    expect(() => transformSource(`${upstreamSnippet}\n${declaration}`)).toThrow(
      /ANCHOR_MISMATCH/,
    );
    expect(() =>
      transformSource(
        upstreamSnippet.replace("maxCatchupTicks", "changedOption"),
      ),
    ).toThrow(/ANCHOR_MISMATCH/);
  });

  it("preserves Mineflayer's 1500 ms default, then starts ordinary movement", async () => {
    useDeterministicClock();
    const { bot, writes, blockAt } = createFakeBot();
    let forcedMoves = 0;
    bot.on("forcedMove", () => forcedMoves++);
    physicsPlugin(bot, { physicsEnabled: false });
    startRespawnCorrection(bot);

    expect(writes).toEqual(["teleport_confirm"]);
    expect(forcedMoves).toBe(0);
    await vi.advanceTimersByTimeAsync(1499);
    expect(writes).toEqual(["teleport_confirm"]);
    expect(forcedMoves).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toEqual(["teleport_confirm", "position_look"]);
    expect(forcedMoves).toBe(1);
    bot.entity.position.x = 1;
    await vi.advanceTimersByTimeAsync(50);
    expect(writes).toContain("position");
    expect(blockAt).toHaveBeenCalled();
  });

  it("opts the 26.1 bridge into immediate correction and resumes movement", async () => {
    useDeterministicClock();
    const { bot, writes, blockAt } = createFakeBot();
    let forcedMoves = 0;
    bot.on("forcedMove", () => forcedMoves++);
    physicsPlugin(bot, { physicsEnabled: false, respawnPositionDelayMs: 0 });
    startRespawnCorrection(bot);

    expect(writes).toEqual(["teleport_confirm", "position_look"]);
    expect(forcedMoves).toBe(1);
    bot.entity.position.x = 1;
    await vi.advanceTimersByTimeAsync(50);
    expect(writes).toContain("position");
    expect(blockAt).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1450);
    expect(writes.filter((name) => name === "position_look")).toHaveLength(1);
    expect(forcedMoves).toBe(1);
  });
});
