import {
  blockIs,
  cloneBaseline,
  destinationRegion,
  establishBaseline,
  regionsEqual,
  type OracleRegion,
  type OracleRcon,
} from "./world-oracle.js";

export interface RecoveryObstacleBlock {
  readonly position: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly block: string;
}

export interface RecoveryObstaclePlan {
  readonly sourceRegion: OracleRegion;
  readonly backupOrigin: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly blocks: readonly RecoveryObstacleBlock[];
}

export interface RecoveryPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type RecoveryObstaclePhase =
  | "eligibility_checked"
  | "backup_verified"
  | "eligibility_lost"
  | "mutation_started"
  | "mutation_verified"
  | "observation_started"
  | "restore_started"
  | "restore_verified"
  | "mutation_failed";

export interface RecoveryObstacleProgress {
  readonly phase: RecoveryObstaclePhase;
  readonly placementCount: number;
  readonly confirmedPlacementCount: number;
  readonly restorationVerified: boolean;
}

export type RecoveryObstacleResult<T> =
  | {
      readonly status: "skipped";
      readonly reason:
        "not_eligible_before_snapshot" | "not_eligible_before_mutation";
    }
  | {
      readonly status: "applied";
      readonly observation: T;
      readonly restorationVerified: true;
    };

export type RecoveryObstacleFailure = (code: string) => never;

export interface RecoveryObstacleCallbacks<T> {
  readonly eligible: () => Promise<boolean>;
  readonly observeWhileApplied: () => Promise<T>;
  readonly onProgress?: (progress: RecoveryObstacleProgress) => void;
}

export function isNewFailureAfterUnfreeze(
  outcome: {
    readonly operationId: string;
    readonly status?: string;
    readonly observedAt?: string;
  },
  knownOperationIds: ReadonlySet<string>,
  unfrozenAt: number,
): boolean {
  if (
    knownOperationIds.has(outcome.operationId) ||
    outcome.status !== "failed" ||
    outcome.observedAt === undefined
  )
    return false;
  const observedAt = Date.parse(outcome.observedAt);
  return Number.isFinite(observedAt) && observedAt >= unfrozenAt;
}

export function recoveryCagePlan(
  position: RecoveryPosition,
  backupOrigin: RecoveryPosition,
): RecoveryObstaclePlan {
  const centerX = Math.floor(position.x);
  const floorY = Math.floor(position.y);
  const centerZ = Math.floor(position.z);
  const sourceRegion: OracleRegion = {
    minX: centerX - 2,
    minY: floorY,
    minZ: centerZ - 2,
    maxX: centerX + 2,
    maxY: floorY + 2,
    maxZ: centerZ + 2,
  };
  const blocks: RecoveryObstacleBlock[] = [];

  for (const y of [floorY, floorY + 1]) {
    for (let x = sourceRegion.minX; x <= sourceRegion.maxX; x += 1) {
      for (let z = sourceRegion.minZ; z <= sourceRegion.maxZ; z += 1) {
        if (
          x !== sourceRegion.minX &&
          x !== sourceRegion.maxX &&
          z !== sourceRegion.minZ &&
          z !== sourceRegion.maxZ
        )
          continue;
        blocks.push({ position: { x, y, z }, block: "bedrock" });
      }
    }
  }
  const roofY = floorY + 2;
  for (let x = sourceRegion.minX; x <= sourceRegion.maxX; x += 1) {
    for (let z = sourceRegion.minZ; z <= sourceRegion.maxZ; z += 1) {
      blocks.push({ position: { x, y: roofY, z }, block: "bedrock" });
    }
  }
  return { sourceRegion, backupOrigin, blocks };
}

export async function withRestorableObstacle<T>(
  rcon: OracleRcon,
  plan: RecoveryObstaclePlan,
  callbacks: RecoveryObstacleCallbacks<T>,
  fail: RecoveryObstacleFailure,
): Promise<RecoveryObstacleResult<T>> {
  if (!isValidPlan(plan)) fail("UNKNOWN_OBSTACLE_PLAN_INVALID");

  report(callbacks, plan, "eligibility_checked", 0, false);
  if (!(await callbacks.eligible())) {
    report(callbacks, plan, "eligibility_lost", 0, false);
    return { status: "skipped", reason: "not_eligible_before_snapshot" };
  }

  const backupRegion = destinationRegion(plan.sourceRegion, plan.backupOrigin);
  await establishBaseline(rcon, plan.sourceRegion, plan.backupOrigin, fail);
  report(callbacks, plan, "backup_verified", 0, false);

  if (!(await callbacks.eligible())) {
    report(callbacks, plan, "eligibility_lost", 0, false);
    return { status: "skipped", reason: "not_eligible_before_mutation" };
  }

  let mutationMayHaveStarted = false;
  let confirmedPlacementCount = 0;
  try {
    // Register restoration before the first source-region write.
    mutationMayHaveStarted = true;
    report(callbacks, plan, "mutation_started", 0, false);
    for (const command of writeCommands(plan)) {
      await rcon.command(command);
    }
    for (const placement of plan.blocks) {
      if (!(await blockIs(rcon, placement.position, placement.block, fail))) {
        fail("UNKNOWN_OBSTACLE_INJECTION_NOT_CONFIRMED");
      }
      confirmedPlacementCount += 1;
      report(
        callbacks,
        plan,
        "mutation_started",
        confirmedPlacementCount,
        false,
      );
    }
    report(
      callbacks,
      plan,
      "mutation_verified",
      confirmedPlacementCount,
      false,
    );
    report(
      callbacks,
      plan,
      "observation_started",
      confirmedPlacementCount,
      false,
    );
    const observation = await callbacks.observeWhileApplied();
    return {
      status: "applied",
      observation,
      restorationVerified: true,
    };
  } catch (error) {
    report(callbacks, plan, "mutation_failed", confirmedPlacementCount, false);
    throw error;
  } finally {
    if (mutationMayHaveStarted) {
      report(
        callbacks,
        plan,
        "restore_started",
        confirmedPlacementCount,
        false,
      );
      try {
        await cloneBaseline(
          rcon,
          backupRegion,
          {
            x: plan.sourceRegion.minX,
            y: plan.sourceRegion.minY,
            z: plan.sourceRegion.minZ,
          },
          fail,
        );
        if (
          !(await regionsEqual(
            rcon,
            backupRegion,
            {
              x: plan.sourceRegion.minX,
              y: plan.sourceRegion.minY,
              z: plan.sourceRegion.minZ,
            },
            fail,
          ))
        ) {
          fail("UNKNOWN_OBSTACLE_RESTORE_NOT_CONFIRMED");
        }
        report(
          callbacks,
          plan,
          "restore_verified",
          confirmedPlacementCount,
          true,
        );
      } catch {
        fail("UNKNOWN_OBSTACLE_RESTORE_FAILED");
      }
    }
  }
}

function report<T>(
  callbacks: RecoveryObstacleCallbacks<T>,
  plan: RecoveryObstaclePlan,
  phase: RecoveryObstaclePhase,
  confirmedPlacementCount: number,
  restorationVerified: boolean,
): void {
  try {
    callbacks.onProgress?.({
      phase,
      placementCount: plan.blocks.length,
      confirmedPlacementCount,
      restorationVerified,
    });
  } catch {
    // Diagnostic callbacks cannot be allowed to interrupt restoration.
  }
}

function writeCommands(plan: RecoveryObstaclePlan): readonly string[] {
  const region = plan.sourceRegion;
  if (!isCagePlan(plan))
    return plan.blocks.map(
      ({ position, block }) =>
        `setblock ${position.x} ${position.y} ${position.z} minecraft:${block} replace`,
    );

  const { minX, minY, minZ, maxX, maxZ } = region;
  const wallMaxY = minY + 1;
  const roofY = minY + 2;
  const block = plan.blocks[0]?.block;
  if (block === undefined) return [];
  return [
    `fill ${minX} ${minY} ${minZ} ${maxX} ${wallMaxY} ${minZ} minecraft:${block} replace`,
    `fill ${minX} ${minY} ${maxZ} ${maxX} ${wallMaxY} ${maxZ} minecraft:${block} replace`,
    `fill ${minX} ${minY} ${minZ + 1} ${minX} ${wallMaxY} ${maxZ - 1} minecraft:${block} replace`,
    `fill ${maxX} ${minY} ${minZ + 1} ${maxX} ${wallMaxY} ${maxZ - 1} minecraft:${block} replace`,
    `fill ${minX} ${roofY} ${minZ} ${maxX} ${roofY} ${maxZ} minecraft:${block} replace`,
  ];
}

function isCagePlan(plan: RecoveryObstaclePlan): boolean {
  const { sourceRegion: region } = plan;
  if (
    region.maxX - region.minX !== 4 ||
    region.maxY - region.minY !== 2 ||
    region.maxZ - region.minZ !== 4
  )
    return false;
  const expected = new Set<string>();
  for (const y of [region.minY, region.minY + 1]) {
    for (let x = region.minX; x <= region.maxX; x += 1) {
      for (let z = region.minZ; z <= region.maxZ; z += 1) {
        if (
          x === region.minX ||
          x === region.maxX ||
          z === region.minZ ||
          z === region.maxZ
        )
          expected.add(`${x}:${y}:${z}`);
      }
    }
  }
  for (let x = region.minX; x <= region.maxX; x += 1) {
    for (let z = region.minZ; z <= region.maxZ; z += 1) {
      expected.add(`${x}:${region.minY + 2}:${z}`);
    }
  }
  return (
    plan.blocks.length === expected.size &&
    plan.blocks.every(
      ({ position, block }) =>
        block === plan.blocks[0]?.block &&
        expected.delete(`${position.x}:${position.y}:${position.z}`),
    ) &&
    expected.size === 0
  );
}

function isValidPlan(plan: RecoveryObstaclePlan): boolean {
  const { sourceRegion, backupOrigin } = plan;
  const backup = destinationRegion(sourceRegion, backupOrigin);
  const overlaps =
    sourceRegion.minX <= backup.maxX &&
    sourceRegion.maxX >= backup.minX &&
    sourceRegion.minY <= backup.maxY &&
    sourceRegion.maxY >= backup.minY &&
    sourceRegion.minZ <= backup.maxZ &&
    sourceRegion.maxZ >= backup.minZ;
  if (overlaps || plan.blocks.length === 0) return false;
  return plan.blocks.every(
    ({ position, block }) =>
      /^[a-z0-9_]+$/u.test(block) &&
      position.x >= sourceRegion.minX &&
      position.x <= sourceRegion.maxX &&
      position.y >= sourceRegion.minY &&
      position.y <= sourceRegion.maxY &&
      position.z >= sourceRegion.minZ &&
      position.z <= sourceRegion.maxZ,
  );
}
