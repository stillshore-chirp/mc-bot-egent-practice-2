import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";
import { MineflayerClient } from "../../src/minecraft/mineflayer-client.js";
import { createSnapshot } from "../support/fake-minecraft.js";

function makeClient(returnConfirmed: boolean) {
  const client = new MineflayerClient(
    {
      bot: { username: "fixture_bot" },
      pathfinderThinkTimeoutMs: 100,
      pathfinderTickTimeoutMs: 10,
      collectTimeoutMs: 100,
    },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  );
  const bot = new EventEmitter() as EventEmitter & {
    entity: { position: Vec3 };
    pathfinder: {
      setGoal: ReturnType<typeof vi.fn>;
      goto: ReturnType<typeof vi.fn>;
    };
    clearControlStates: ReturnType<typeof vi.fn>;
  };
  bot.entity = { position: new Vec3(0, 64, 0) };
  let goalActive = true;
  bot.pathfinder = {
    setGoal: vi.fn((goal: unknown) => {
      goalActive = goal !== null;
    }),
    goto: vi.fn(async () => {
      bot.emit("path_update", {
        path: [{ x: 1, y: 69, z: 0 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (goalActive) bot.entity.position = new Vec3(1, 69, 0);
    }),
  };
  bot.clearControlStates = vi.fn();
  Object.assign(client, {
    spawned: true,
    botInstance: bot,
    hasObservedReturnRoute: () => returnConfirmed,
    observe: async () =>
      createSnapshot({
        position: {
          x: bot.entity.position.x,
          y: bot.entity.position.y,
          z: bot.entity.position.z,
        },
      }),
  });
  return { client, bot };
}

describe("high-place path guard", () => {
  it("stops before entering a planned high node without a confirmed return", async () => {
    const { client, bot } = makeClient(false);
    await expect(
      client.moveTo({ x: 1, y: 69, z: 0 }, 1, new AbortController().signal),
    ).rejects.toMatchObject({
      detail: { code: "ASCENT_RETURN_UNCONFIRMED" },
    });
    expect(bot.entity.position.y).toBe(64);
    expect(bot.pathfinder.setGoal).toHaveBeenCalledWith(null);
  });

  it("allows a planned high node when a return route was observed", async () => {
    const { client, bot } = makeClient(true);
    await client.moveTo({ x: 1, y: 69, z: 0 }, 1, new AbortController().signal);
    expect(bot.entity.position.y).toBe(69);
  });
});
