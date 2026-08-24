import { distance, type WorldSnapshot } from "../domain/snapshot.js";

export const reflexKinds = [
  "hazard",
  "damage",
  "hostile",
  "hunger",
  "stuck",
] as const;
export type ReflexKind = (typeof reflexKinds)[number];

export interface ReflexIncident {
  readonly kind: ReflexKind;
  readonly reason: string;
  readonly priority: number;
}

export interface ReflexThresholds {
  readonly lowFood: number;
  readonly lowOxygen: number;
  readonly hostileDistance: number;
  readonly fallingVelocity: number;
  readonly stuckWindowMs: number;
  readonly stuckDistance: number;
}

export class ReflexDetector {
  private previous: WorldSnapshot | undefined;
  private movementAnchor:
    { snapshot: WorldSnapshot; expected: boolean } | undefined;

  public constructor(private readonly thresholds: ReflexThresholds) {}

  public detect(
    current: WorldSnapshot,
    movementExpected: boolean,
  ): ReflexIncident | undefined {
    const previous = this.previous;
    this.previous = current;

    if (
      current.inLava ||
      current.onFire ||
      current.suffocating ||
      current.oxygen <= this.thresholds.lowOxygen ||
      current.velocityY <= this.thresholds.fallingVelocity
    ) {
      return {
        kind: "hazard",
        reason: "Immediate environmental hazard observed",
        priority: 500,
      };
    }
    if (previous?.health !== undefined && current.health < previous.health) {
      return { kind: "damage", reason: "Health decreased", priority: 400 };
    }
    if (
      current.nearbyEntities.some(
        (entity) =>
          entity.hostile && entity.distance <= this.thresholds.hostileDistance,
      )
    ) {
      return {
        kind: "hostile",
        reason: "Hostile entity is within safety distance",
        priority: 300,
      };
    }
    if (current.food <= this.thresholds.lowFood) {
      return {
        kind: "hunger",
        reason: "Food level is below the configured threshold",
        priority: 200,
      };
    }

    if (!movementExpected) {
      this.movementAnchor = undefined;
      return undefined;
    }
    if (!this.movementAnchor?.expected) {
      this.movementAnchor = { snapshot: current, expected: true };
      return undefined;
    }
    const elapsed =
      Date.parse(current.observedAt) -
      Date.parse(this.movementAnchor.snapshot.observedAt);
    if (elapsed < this.thresholds.stuckWindowMs) return undefined;
    const moved = distance(
      current.position,
      this.movementAnchor.snapshot.position,
    );
    this.movementAnchor = { snapshot: current, expected: true };
    return moved < this.thresholds.stuckDistance
      ? {
          kind: "stuck",
          reason: "Movement was requested but position did not change",
          priority: 100,
        }
      : undefined;
  }
}

export function isStableAfterIncident(
  kind: ReflexKind,
  snapshot: WorldSnapshot,
  thresholds: ReflexThresholds,
): boolean {
  switch (kind) {
    case "hazard":
      return (
        !snapshot.inLava &&
        !snapshot.onFire &&
        !snapshot.suffocating &&
        snapshot.oxygen > thresholds.lowOxygen
      );
    case "damage":
    case "hostile":
      return !snapshot.nearbyEntities.some(
        (entity) =>
          entity.hostile && entity.distance <= thresholds.hostileDistance,
      );
    case "hunger":
      return snapshot.food > thresholds.lowFood;
    case "stuck":
      return true;
  }
}
