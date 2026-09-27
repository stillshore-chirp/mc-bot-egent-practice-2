import type { RecoveryObstaclePlan } from "./unknown-recovery-obstacle.js";

export interface PartialPathPlans {
  readonly sidewalls: RecoveryObstaclePlan;
  readonly barrier: RecoveryObstaclePlan;
  readonly target: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly barrierPosition: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
}

export function partialPathPlans(origin: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): PartialPathPlans {
  const startX = Math.floor(origin.x);
  const floorY = Math.floor(origin.y);
  const centerZ = Math.floor(origin.z);
  const targetX = startX + 10;
  const barrierX = startX + 5;
  const minZ = centerZ - 1;
  const maxZ = centerZ + 1;
  const sideRegion = {
    minX: startX - 1,
    minY: floorY,
    minZ,
    maxX: targetX + 1,
    maxY: floorY + 1,
    maxZ,
  };
  const sideBlocks = [];
  for (let x = sideRegion.minX; x <= sideRegion.maxX; x += 1) {
    for (let y = sideRegion.minY; y <= sideRegion.maxY; y += 1) {
      sideBlocks.push(
        { position: { x, y, z: minZ }, block: "bedrock" },
        { position: { x, y, z: maxZ }, block: "bedrock" },
      );
      if (x === sideRegion.minX || x === sideRegion.maxX) {
        sideBlocks.push({
          position: { x, y, z: centerZ },
          block: "bedrock",
        });
      } else {
        sideBlocks.push({
          position: { x, y, z: centerZ },
          block: "air",
        });
      }
    }
  }
  const barrierRegion = {
    minX: barrierX,
    minY: floorY,
    minZ,
    maxX: barrierX,
    maxY: floorY + 1,
    maxZ,
  };
  const barrierBlocks = [];
  for (let y = barrierRegion.minY; y <= barrierRegion.maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      barrierBlocks.push({ position: { x: barrierX, y, z }, block: "bedrock" });
    }
  }
  return {
    sidewalls: {
      sourceRegion: sideRegion,
      backupOrigin: { x: 4_000, y: floorY, z: 4_000 },
      blocks: sideBlocks,
    },
    barrier: {
      sourceRegion: barrierRegion,
      backupOrigin: { x: 5_000, y: floorY, z: 5_000 },
      blocks: barrierBlocks,
    },
    target: { x: targetX + 0.5, y: floorY, z: centerZ + 0.5 },
    barrierPosition: { x: barrierX, y: floorY, z: centerZ },
  };
}

export function isInsidePartialPathCorridor(
  position: { readonly x: number; readonly z: number },
  plans: PartialPathPlans,
): boolean {
  const { sourceRegion } = plans.sidewalls;
  return (
    position.x > sourceRegion.minX + 1.3 &&
    position.x < sourceRegion.maxX - 0.3 &&
    position.z > sourceRegion.minZ + 1.3 &&
    position.z < sourceRegion.maxZ - 0.3
  );
}

export interface PartialPathProbeEvidence {
  readonly gptCalls: number;
  readonly operationStatus:
    "successful" | "failed" | "interrupted" | "unverified";
  readonly failureClass:
    "none" | "no_path" | "timeout" | "interrupted" | "probe_deadline" | "other";
  readonly progressedBeforeBarrier: boolean;
  readonly barrierInstalledWhileMoveActive: boolean;
  readonly barrierAheadBeforeUnfreeze: boolean;
  readonly barrierVisibleBeforeUnfreeze: boolean;
  readonly stoppedBeforeTarget: boolean;
  readonly freshBodyObservation: boolean;
  readonly bodyObservedBarrier: boolean;
  readonly rconConfirmedBarrier: boolean;
  readonly restorationVerified: boolean;
}

export function partialPathProbeComplete(
  evidence: PartialPathProbeEvidence,
): boolean {
  return (
    evidence.gptCalls === 0 &&
    evidence.operationStatus === "failed" &&
    evidence.failureClass === "no_path" &&
    evidence.progressedBeforeBarrier &&
    evidence.barrierInstalledWhileMoveActive &&
    evidence.barrierAheadBeforeUnfreeze &&
    evidence.stoppedBeforeTarget &&
    evidence.freshBodyObservation &&
    evidence.bodyObservedBarrier &&
    evidence.rconConfirmedBarrier &&
    evidence.restorationVerified
  );
}
