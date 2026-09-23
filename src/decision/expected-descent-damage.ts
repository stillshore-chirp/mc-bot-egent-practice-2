import {
  distance,
  type Position,
  type WorldSnapshot,
} from "../domain/snapshot.js";

export interface PlannedLanding {
  readonly position: Position;
  readonly fromY: number;
}

/** Keeps a single, short-lived damage expectation for each planned landing. */
export class ExpectedDescentDamage {
  private nextLandingIndex = 0;
  private expected:
    | {
        readonly landing: PlannedLanding;
        readonly healthBefore: number;
        readonly expiresAt: number;
      }
    | undefined;

  public constructor(
    private readonly landings: readonly PlannedLanding[],
    private readonly minimumHealth: number,
  ) {}

  public observeFall(
    position: Position,
    health: number,
    now = Date.now(),
  ): void {
    const landing = this.landings[this.nextLandingIndex];
    if (
      landing === undefined ||
      position.y >= landing.fromY - 2 ||
      position.y < landing.position.y - 1 ||
      Math.hypot(
        position.x - landing.position.x,
        position.z - landing.position.z,
      ) >= 2
    ) {
      return;
    }
    this.expected = {
      landing,
      healthBefore: health,
      expiresAt: now + 5_000,
    };
    this.nextLandingIndex += 1;
  }

  public consume(
    previous: WorldSnapshot,
    current: WorldSnapshot,
    now = Date.now(),
  ): boolean {
    const expected = this.expected;
    if (expected === undefined) return false;
    if (now > expected.expiresAt) {
      this.expected = undefined;
      return false;
    }
    if (
      current.health < this.minimumHealth ||
      current.health > expected.healthBefore ||
      current.health >= previous.health ||
      current.position.y > expected.landing.fromY - 2 ||
      distance(current.position, expected.landing.position) >= 2
    ) {
      return false;
    }
    this.expected = undefined;
    return true;
  }

  public clear(): void {
    this.expected = undefined;
    this.nextLandingIndex = this.landings.length;
  }
}
