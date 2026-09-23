import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";
import { MineflayerClient } from "../../src/minecraft/mineflayer-client.js";
import { createSnapshot } from "../support/fake-minecraft.js";

function makeClient(returnConfirmed: boolean) {
  const client = new MineflayerClient(
    {
      bot: { username: "fixture_bot" },
      ownerUsername: "fixture_owner",
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
      getPathFromTo: ReturnType<typeof vi.fn>;
      movements: object;
    };
    clearControlStates: ReturnType<typeof vi.fn>;
    blockAt: ReturnType<typeof vi.fn>;
  };
  bot.entity = { position: new Vec3(0, 64, 0) };
  let goalActive = true;
  bot.pathfinder = {
    setGoal: vi.fn((goal: unknown) => {
      goalActive = goal !== null;
    }),
    goto: vi.fn(async (goal: { x: number; y: number; z: number }) => {
      bot.emit("path_update", {
        path: [{ x: goal.x, y: goal.y, z: goal.z }],
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (goalActive) {
        bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
      }
    }),
    getPathFromTo: vi.fn(() => ({
      next: () => ({
        value: {
          result: { status: "success", path: [{ x: 1, y: 69, z: 0 }] },
        },
      }),
    })),
    movements: {},
  };
  bot.clearControlStates = vi.fn();
  bot.blockAt = vi.fn(() => null);
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
    expect(bot.pathfinder.goto).not.toHaveBeenCalled();
  });

  it("allows a planned high node when a return route was observed", async () => {
    const { client, bot } = makeClient(true);
    await client.moveTo({ x: 1, y: 69, z: 0 }, 1, new AbortController().signal);
    expect(bot.entity.position.y).toBe(69);
  });

  it("walks toward a distant high goal before a later route becomes observable", async () => {
    const { client, bot } = makeClient(false);
    bot.pathfinder.getPathFromTo = vi.fn(() => ({
      next: () => ({
        value: {
          result: {
            status: "partial",
            path:
              bot.entity.position.x === 0
                ? [
                    { x: 1, y: 64, z: 0 },
                    { x: 2, y: 65, z: 0 },
                    { x: 3, y: 66, z: 0 },
                    { x: 4, y: 67, z: 0 },
                    { x: 5, y: 68, z: 0 },
                  ]
                : [
                    { x: 4, y: 67, z: 0 },
                    { x: 5, y: 68, z: 0 },
                  ],
          },
        },
      }),
    }));
    Object.assign(client, {
      hasObservedReturnRoute: () => bot.entity.position.x >= 3,
    });

    await client.moveTo({ x: 5, y: 68, z: 0 }, 0, new AbortController().signal);

    expect(bot.pathfinder.goto).toHaveBeenCalledTimes(2);
    expect(bot.pathfinder.goto.mock.calls[0]?.[0]).toMatchObject({
      x: 3,
      y: 66,
    });
    expect(bot.pathfinder.goto.mock.calls[1]?.[0]).toMatchObject({
      x: 5,
      y: 68,
    });
    expect(bot.entity.position).toMatchObject({ x: 5, y: 68 });
  });

  it("stops after bounded walking attempts with no observed progress", async () => {
    const { client, bot } = makeClient(true);
    bot.pathfinder.goto = vi.fn(
      async (goal: { x: number; y: number; z: number }) => {
        bot.emit("path_update", {
          path: [{ x: goal.x, y: goal.y, z: goal.z }],
        });
      },
    );

    await expect(
      client.moveTo({ x: 1, y: 69, z: 0 }, 0, new AbortController().signal),
    ).rejects.toMatchObject({ detail: { code: "PATH_PROGRESS_STALLED" } });
    expect(bot.pathfinder.goto).toHaveBeenCalledTimes(2);
    expect(bot.entity.position.y).toBe(64);
  });
});
