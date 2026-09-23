import { createHash } from "node:crypto";

import {
  extractBehaviorMemory,
  type BehaviorMemoryExtraction,
} from "../memory/behavior-memory.js";
import type {
  BehaviorMemoryRecord,
  RememberBehaviorMemoryInput,
} from "../memory/types.js";

export interface BehaviorMemoryPersistence {
  rememberBehaviorMemory(
    input: RememberBehaviorMemoryInput,
  ): BehaviorMemoryRecord;
  correctBehaviorMemory(input: {
    readonly playerId: string;
    readonly memoryId?: string;
    readonly category: RememberBehaviorMemoryInput["category"];
    readonly slot: string;
    readonly value: string;
    readonly summary: string;
    readonly idempotencyKey?: string;
  }): BehaviorMemoryRecord;
}

export interface OwnerBehaviorMemoryLearningInput {
  readonly ownerUsername: string;
  readonly requesterUsername: string;
  readonly playerId: string;
  readonly message: string;
  readonly requestKind: "owner_message" | "runtime_reassessment";
  /** An opaque id for one accepted owner message; it is hashed before storage. */
  readonly eventId: string;
}

export interface OwnerBehaviorMemoryLearningResult {
  readonly candidates: readonly BehaviorMemoryExtraction[];
  readonly savedCount: number;
  readonly failedCount: number;
}

/**
 * Extracts only from an authenticated owner message and writes typed records
 * before deliberation. It never stores the source message or lets tool output
 * become an owner preference.
 */
export class OwnerBehaviorMemoryLearner {
  public constructor(private readonly persistence: BehaviorMemoryPersistence) {}

  public learn(
    input: OwnerBehaviorMemoryLearningInput,
  ): OwnerBehaviorMemoryLearningResult {
    if (
      input.requestKind !== "owner_message" ||
      input.requesterUsername !== input.ownerUsername
    ) {
      return { candidates: [], savedCount: 0, failedCount: 0 };
    }

    const candidates = extractBehaviorMemory(input.message);
    let savedCount = 0;
    let failedCount = 0;
    for (const candidate of candidates) {
      try {
        const idempotencyKey = behaviorMemoryEventKey(
          input.playerId,
          input.eventId,
          candidate.slot,
        );
        if (candidate.source === "owner_correction") {
          this.persistence.correctBehaviorMemory({
            playerId: input.playerId,
            category: candidate.category,
            slot: candidate.slot,
            value: candidate.value,
            summary: candidate.summary,
            idempotencyKey,
          });
        } else {
          this.persistence.rememberBehaviorMemory({
            playerId: input.playerId,
            category: candidate.category,
            slot: candidate.slot,
            value: candidate.value,
            summary: candidate.summary,
            source: candidate.source,
            confidence: candidate.confidence,
            scope: candidate.scope,
            idempotencyKey,
          });
        }
        savedCount += 1;
      } catch {
        // A rejected candidate or temporary persistence failure must not turn
        // an accepted owner message into a failed chat response.
        failedCount += 1;
      }
    }
    return { candidates, savedCount, failedCount };
  }
}

export function behaviorMemoryEventKey(
  playerId: string,
  eventId: string,
  slot: string,
): string {
  const digest = createHash("sha256")
    .update(`${playerId}\0${eventId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `owner-message:${digest}:${slot}`;
}
