import { describe, expect, it } from "vitest";

import {
  isNewFailureAfterUnfreeze,
  recoveryCagePlan,
  waitForRecoveryObstacleReadiness,
  withRestorableObstacle,
  type RecoveryObstaclePlan,
} from "./unknown-recovery-obstacle.js";

describe("bounded recovery-obstacle readiness", () => {
  it("waits only while the same travel operation remains active", async () => {
    let now = 0;
    let operationChecks = 0;
    let probeChecks = 0;
    const result = await waitForRecoveryObstacleReadiness({
      operationStillActive: async () => {
        operationChecks += 1;
        return operationChecks < 3;
      },
      probeStandingSpace: async () => {
        probeChecks += 1;
        return { status: "unsafe" as const };
      },
      wait: async (durationMs) => {
        now += durationMs;
      },
      now: () => now,
      timeoutMs: 1_000,
      intervalMs: 100,
    });

    expect(result).toEqual({ status: "operation_changed" });
    expect(operationChecks).toBe(3);
    expect(probeChecks).toBe(2);
    expect(now).toBe(200);
  });

  it("returns the safe probe result without extending the wait", async () => {
    let now = 0;
    let probeChecks = 0;
    const result = await waitForRecoveryObstacleReadiness({
      operationStillActive: async () => true,
      probeStandingSpace: async () => {
        probeChecks += 1;
        return probeChecks === 2
          ? { status: "ready" as const, value: "safe-position" }
          : { status: "unsafe" as const };
      },
      wait: async (durationMs) => {
        now += durationMs;
      },
      now: () => now,
      timeoutMs: 1_000,
      intervalMs: 100,
    });

    expect(result).toEqual({ status: "ready", value: "safe-position" });
    expect(probeChecks).toBe(2);
    expect(now).toBe(100);
  });

  it("stops after the fixed wait window when a safe position never appears", async () => {
    let now = 0;
    let probeChecks = 0;
    const result = await waitForRecoveryObstacleReadiness({
      operationStillActive: async () => true,
      probeStandingSpace: async () => {
        probeChecks += 1;
        return { status: "unsafe" as const };
      },
      wait: async (durationMs) => {
        now += durationMs;
      },
      now: () => now,
      timeoutMs: 1_000,
      intervalMs: 100,
    });

    expect(result).toEqual({ status: "standing_space_unavailable" });
    expect(now).toBe(1_000);
    expect(probeChecks).toBe(10);
  });
});

describe("post-unfreeze failure attribution", () => {
  const unfrozenAt = Date.parse("2026-01-01T00:00:10.000Z");
  const known = new Set([
    "active-before-unfreeze",
    "completed-before-unfreeze",
  ]);

  it("counts only a new failed operation observed after unfreezing", () => {
    expect(
      isNewFailureAfterUnfreeze(
        {
          operationId: "new-operation",
          status: "failed",
          observedAt: "2026-01-01T00:00:10.001Z",
        },
        known,
        unfrozenAt,
      ),
    ).toBe(true);
    for (const operationId of known) {
      expect(
        isNewFailureAfterUnfreeze(
          {
            operationId,
            status: "failed",
            observedAt: "2026-01-01T00:00:11.000Z",
          },
          known,
          unfrozenAt,
        ),
      ).toBe(false);
    }
    expect(
      isNewFailureAfterUnfreeze(
        {
          operationId: "new-operation",
          status: "failed",
          observedAt: "2026-01-01T00:00:09.999Z",
        },
        known,
        unfrozenAt,
      ),
    ).toBe(false);
    expect(
      isNewFailureAfterUnfreeze(
        {
          operationId: "new-operation",
          status: "successful",
          observedAt: "2026-01-01T00:00:11.000Z",
        },
        known,
        unfrozenAt,
      ),
    ).toBe(false);
  });
});

class FakeRcon {
  public readonly commands: string[] = [];
  public readonly blocks = new Map<string, string>();
  public failSecondPlacement = false;
  public failRestore = false;
  private score = 0;
  private placements = 0;

  public constructor(private readonly plan: RecoveryObstaclePlan) {
    const region = plan.sourceRegion;
    for (let x = region.minX; x <= region.maxX; x += 1) {
      for (let y = region.minY; y <= region.maxY; y += 1) {
        for (let z = region.minZ; z <= region.maxZ; z += 1) {
          this.blocks.set(
            this.key(x, y, z),
            y === region.minY ? "minecraft:stone" : "minecraft:air",
          );
        }
      }
    }
  }

  public async command(command: string): Promise<string> {
    this.commands.push(command);
    if (command.startsWith("forceload add "))
      return "Marked 1 chunk in minecraft:overworld to be force loaded";
    if (command.startsWith("forceload query "))
      return "Chunk at [8, 8] in minecraft:overworld is marked for force loading";
    if (command.startsWith("scoreboard players set #oracle ai_e2e ")) {
      this.score = Number(command.split(" ").at(-1));
      return `Set [ai_e2e] for #oracle to ${this.score}`;
    }
    if (command.startsWith("execute if loaded ")) {
      this.score += 1;
      return `Added 1 to [ai_e2e] for #oracle (now ${this.score})`;
    }
    if (command === "scoreboard players get #oracle ai_e2e")
      return `#oracle has ${this.score} [ai_e2e]`;

    const fill =
      /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) minecraft:([a-z0-9_]+) replace$/u.exec(
        command,
      );
    if (fill !== null) {
      this.placements += 1;
      if (this.failSecondPlacement && this.placements === 2)
        throw new Error("fake placement failure");
      for (let x = Number(fill[1]); x <= Number(fill[4]); x += 1) {
        for (let y = Number(fill[2]); y <= Number(fill[5]); y += 1) {
          for (let z = Number(fill[3]); z <= Number(fill[6]); z += 1) {
            this.blocks.set(this.key(x, y, z), `minecraft:${fill[7]}`);
          }
        }
      }
      return "Filled 25 blocks";
    }

    const setBlock =
      /^setblock (-?\d+) (-?\d+) (-?\d+) minecraft:([a-z0-9_]+) replace$/u.exec(
        command,
      );
    if (setBlock !== null) {
      this.placements += 1;
      if (this.failSecondPlacement && this.placements === 2)
        throw new Error("fake placement failure");
      this.blocks.set(
        this.key(Number(setBlock[1]), Number(setBlock[2]), Number(setBlock[3])),
        `minecraft:${setBlock[4]}`,
      );
      return "Block placed";
    }

    const blockCheck =
      /^execute if block (-?\d+) (-?\d+) (-?\d+) minecraft:([a-z0-9_]+) run scoreboard players set #oracle ai_e2e 1$/u.exec(
        command,
      );
    if (blockCheck !== null) {
      const block = this.blocks.get(
        this.key(
          Number(blockCheck[1]),
          Number(blockCheck[2]),
          Number(blockCheck[3]),
        ),
      );
      if (block === `minecraft:${blockCheck[4]}`) this.score = 1;
      return "";
    }

    const compare =
      /^execute if blocks (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) all run scoreboard players set #oracle ai_e2e 1$/u.exec(
        command,
      );
    if (compare !== null) {
      const [source, destination] = this.regionsFromCompare(compare);
      if (this.equalRegions(source, destination)) this.score = 1;
      return "";
    }

    const clone =
      /^clone (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) replace force$/u.exec(
        command,
      );
    if (clone !== null) {
      const source = {
        minX: Number(clone[1]),
        minY: Number(clone[2]),
        minZ: Number(clone[3]),
        maxX: Number(clone[4]),
        maxY: Number(clone[5]),
        maxZ: Number(clone[6]),
      };
      const destination = {
        x: Number(clone[7]),
        y: Number(clone[8]),
        z: Number(clone[9]),
      };
      if (this.failRestore && source.minX === this.plan.backupOrigin.x)
        return "RCON transport error";
      let count = 0;
      for (let x = source.minX; x <= source.maxX; x += 1) {
        for (let y = source.minY; y <= source.maxY; y += 1) {
          for (let z = source.minZ; z <= source.maxZ; z += 1) {
            this.blocks.set(
              this.key(
                destination.x + x - source.minX,
                destination.y + y - source.minY,
                destination.z + z - source.minZ,
              ),
              this.blocks.get(this.key(x, y, z)) ?? "minecraft:air",
            );
            count += 1;
          }
        }
      }
      return `Successfully cloned ${count} block(s)`;
    }
    return "Unknown command";
  }

  public equalRegions(
    first: {
      readonly minX: number;
      readonly minY: number;
      readonly minZ: number;
      readonly maxX: number;
      readonly maxY: number;
      readonly maxZ: number;
    },
    second: { readonly x: number; readonly y: number; readonly z: number },
  ): boolean {
    for (let x = first.minX; x <= first.maxX; x += 1) {
      for (let y = first.minY; y <= first.maxY; y += 1) {
        for (let z = first.minZ; z <= first.maxZ; z += 1) {
          if (
            (this.blocks.get(this.key(x, y, z)) ?? "minecraft:air") !==
            (this.blocks.get(
              this.key(
                second.x + x - first.minX,
                second.y + y - first.minY,
                second.z + z - first.minZ,
              ),
            ) ?? "minecraft:air")
          )
            return false;
        }
      }
    }
    return true;
  }

  private regionsFromCompare(match: RegExpExecArray): [
    {
      readonly minX: number;
      readonly minY: number;
      readonly minZ: number;
      readonly maxX: number;
      readonly maxY: number;
      readonly maxZ: number;
    },
    { readonly x: number; readonly y: number; readonly z: number },
  ] {
    return [
      {
        minX: Number(match[1]),
        minY: Number(match[2]),
        minZ: Number(match[3]),
        maxX: Number(match[4]),
        maxY: Number(match[5]),
        maxZ: Number(match[6]),
      },
      { x: Number(match[7]), y: Number(match[8]), z: Number(match[9]) },
    ];
  }

  private key(x: number, y: number, z: number): string {
    return `${x}:${y}:${z}`;
  }
}

function makePlan(): RecoveryObstaclePlan {
  return recoveryCagePlan(
    { x: 10.5, y: 64, z: 10.5 },
    { x: 1_000, y: 64, z: 1_000 },
  );
}

function fail(code: string): never {
  throw new Error(code);
}

describe("restorable unknown-scenario obstacle", () => {
  it("builds an outer cage while preserving the interior and floor", () => {
    const plan = makePlan();
    expect(plan.sourceRegion).toEqual({
      minX: 8,
      minY: 64,
      minZ: 8,
      maxX: 12,
      maxY: 66,
      maxZ: 12,
    });
    expect(plan.blocks).toHaveLength(57);
    expect(
      plan.blocks.some(
        ({ position }) =>
          position.y === 63 ||
          (position.x >= 9 &&
            position.x <= 11 &&
            position.y <= 65 &&
            position.z >= 9 &&
            position.z <= 11),
      ),
    ).toBe(false);
  });

  it("skips before snapshot when the operation is no longer eligible", async () => {
    const plan = makePlan();
    const rcon = new FakeRcon(plan);
    const result = await withRestorableObstacle(
      rcon,
      plan,
      {
        eligible: async () => false,
        observeWhileApplied: async () => "unused",
      },
      fail,
    );
    expect(result).toEqual({
      status: "skipped",
      reason: "not_eligible_before_snapshot",
    });
    expect(
      rcon.commands.some(
        (command) =>
          command.startsWith("setblock ") || command.startsWith("fill "),
      ),
    ).toBe(false);
  });

  it("rechecks eligibility after a verified snapshot before writing", async () => {
    const plan = makePlan();
    const rcon = new FakeRcon(plan);
    const eligibility = [true, false];
    const result = await withRestorableObstacle(
      rcon,
      plan,
      {
        eligible: async () => eligibility.shift() ?? false,
        observeWhileApplied: async () => "unused",
      },
      fail,
    );
    expect(result).toEqual({
      status: "skipped",
      reason: "not_eligible_before_mutation",
    });
    expect(
      rcon.commands.some(
        (command) =>
          command.startsWith("setblock ") || command.startsWith("fill "),
      ),
    ).toBe(false);
  });

  it("observes the applied obstacle and restores the exact snapshot", async () => {
    const plan = makePlan();
    const rcon = new FakeRcon(plan);
    const progress: string[] = [];
    const result = await withRestorableObstacle(
      rcon,
      plan,
      {
        eligible: async () => true,
        observeWhileApplied: async () => {
          expect(rcon.blocks.get("8:64:8")).toBe("minecraft:bedrock");
          return "failed-operation-observed";
        },
        onProgress: ({ phase }) => progress.push(phase),
      },
      fail,
    );
    expect(result).toEqual({
      status: "applied",
      observation: "failed-operation-observed",
      restorationVerified: true,
    });
    expect(
      rcon.commands.filter((command) => command.startsWith("fill ")),
    ).toHaveLength(5);
    expect(
      rcon.equalRegions(plan.sourceRegion, {
        x: plan.backupOrigin.x,
        y: plan.backupOrigin.y,
        z: plan.backupOrigin.z,
      }),
    ).toBe(true);
    expect(progress).toContain("restore_verified");
  });

  it("restores after a partial write failure", async () => {
    const plan = makePlan();
    const rcon = new FakeRcon(plan);
    rcon.failSecondPlacement = true;
    await expect(
      withRestorableObstacle(
        rcon,
        plan,
        {
          eligible: async () => true,
          observeWhileApplied: async () => "unused",
        },
        fail,
      ),
    ).rejects.toThrow("fake placement failure");
    expect(
      rcon.equalRegions(plan.sourceRegion, {
        x: plan.backupOrigin.x,
        y: plan.backupOrigin.y,
        z: plan.backupOrigin.z,
      }),
    ).toBe(true);
  });

  it("ignores diagnostic callback failures and still restores every phase", async () => {
    const plan = makePlan();
    const rcon = new FakeRcon(plan);
    const result = await withRestorableObstacle(
      rcon,
      plan,
      {
        eligible: async () => true,
        observeWhileApplied: async () => "observed",
        onProgress: () => {
          throw new Error("diagnostic callback failure");
        },
      },
      fail,
    );
    expect(result).toEqual({
      status: "applied",
      observation: "observed",
      restorationVerified: true,
    });
    expect(
      rcon.equalRegions(plan.sourceRegion, {
        x: plan.backupOrigin.x,
        y: plan.backupOrigin.y,
        z: plan.backupOrigin.z,
      }),
    ).toBe(true);
  });

  it("stops when snapshot restoration cannot be confirmed", async () => {
    const plan = makePlan();
    const rcon = new FakeRcon(plan);
    rcon.failRestore = true;
    let failureStage: string | undefined;
    await expect(
      withRestorableObstacle(
        rcon,
        plan,
        {
          eligible: async () => true,
          observeWhileApplied: async () => "done",
          onRestoreFailure: (stage) => {
            failureStage = stage;
          },
        },
        fail,
      ),
    ).rejects.toThrow("UNKNOWN_OBSTACLE_RESTORE_FAILED");
    expect(failureStage).toBe("clone");
  });

  it("runs restoration inside the supplied stable-world boundary", async () => {
    const plan = makePlan();
    const rcon = new FakeRcon(plan);
    const phases: string[] = [];
    const result = await withRestorableObstacle(
      rcon,
      plan,
      {
        eligible: async () => true,
        observeWhileApplied: async () => "observed",
        restoreInStableWorld: async (restore) => {
          phases.push("stabilize");
          await restore();
          phases.push("restored");
        },
      },
      fail,
    );
    expect(result.status).toBe("applied");
    expect(phases).toEqual(["stabilize", "restored"]);
    expect(rcon.equalRegions(plan.sourceRegion, plan.backupOrigin)).toBe(true);
  });
});
