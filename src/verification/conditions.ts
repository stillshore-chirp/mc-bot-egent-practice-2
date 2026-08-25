import { AppError } from "../domain/errors.js";
import { countInventory, type WorldSnapshot } from "../domain/snapshot.js";

export interface GatherVerification {
  readonly itemName: string;
  readonly requestedCount: number;
  readonly collectedCount: number;
  readonly heldCount: number;
  readonly playerDistance: number;
}

export function verifyGatherCompletion(
  before: WorldSnapshot,
  after: WorldSnapshot,
  itemName: string,
  requestedCount: number,
  requester: string,
  returnRange: number,
): GatherVerification {
  const baseline = countInventory(before, itemName);
  const heldCount = countInventory(after, itemName);
  const collectedCount = heldCount - baseline;
  const player = after.players.find(
    (candidate) => candidate.username === requester,
  );
  if (collectedCount < requestedCount) {
    throw new AppError({
      category: "inventory",
      code: "GATHER_COUNT_NOT_MET",
      message: `Observed inventory increase ${String(collectedCount)} is below requested count ${String(requestedCount)}`,
      retryable: true,
      failedAt: "final_verify",
      confirmedState: { collectedCount, heldCount, requestedCount },
    });
  }
  if (player === undefined || player.distance > returnRange) {
    throw new AppError({
      category: "observation",
      code: "RETURN_NOT_VERIFIED",
      message: "The requester is not visible within the required return range",
      retryable: true,
      failedAt: "final_verify",
      confirmedState: {
        playerVisible: player !== undefined,
        playerDistance: player?.distance,
        returnRange,
      },
    });
  }
  return {
    itemName,
    requestedCount,
    collectedCount,
    heldCount,
    playerDistance: player.distance,
  };
}
