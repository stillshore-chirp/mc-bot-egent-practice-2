import { describe, expect, it } from "vitest";
import { ExpectedDescentDamage } from "../../src/decision/expected-descent-damage.js";
import { createSnapshot } from "../support/fake-minecraft.js";

const first = { position: { x: 1, y: 64, z: 0 }, fromY: 68 };
const second = { position: { x: 2, y: 60, z: 0 }, fromY: 64 };

describe("expected descent damage", () => {
  it("consumes damage separately at two planned landings", () => {
    const tracker = new ExpectedDescentDamage([first, second], 16);
    tracker.observeFall({ x: 1, y: 65, z: 0 }, 20, 100);
    expect(
      tracker.consume(
        createSnapshot({ position: { x: 0, y: 68, z: 0 }, health: 20 }),
        createSnapshot({ position: first.position, health: 18 }),
        200,
      ),
    ).toBe(true);
    tracker.observeFall({ x: 2, y: 61, z: 0 }, 18, 300);
    expect(
      tracker.consume(
        createSnapshot({ position: first.position, health: 18 }),
        createSnapshot({ position: second.position, health: 16 }),
        400,
      ),
    ).toBe(true);
  });

  it("does not reuse a damage-free landing or a settled route", () => {
    const tracker = new ExpectedDescentDamage([first, second], 16);
    tracker.observeFall({ x: 1, y: 65, z: 0 }, 20, 100);
    tracker.observeFall({ x: 2, y: 61, z: 0 }, 20, 200);
    expect(
      tracker.consume(
        createSnapshot({ position: first.position, health: 20 }),
        createSnapshot({ position: first.position, health: 19 }),
        300,
      ),
    ).toBe(false);
    tracker.clear();
    expect(
      tracker.consume(
        createSnapshot({ position: second.position, health: 20 }),
        createSnapshot({ position: second.position, health: 19 }),
        400,
      ),
    ).toBe(false);
  });

  it("rejects late, excessive, and off-route damage", () => {
    const tracker = new ExpectedDescentDamage([first], 18);
    tracker.observeFall({ x: 1, y: 65, z: 0 }, 20, 100);
    const before = createSnapshot({
      position: { x: 0, y: 68, z: 0 },
      health: 20,
    });
    expect(
      tracker.consume(
        before,
        createSnapshot({ position: first.position, health: 17 }),
        200,
      ),
    ).toBe(false);
    expect(
      tracker.consume(
        before,
        createSnapshot({ position: { x: 4, y: 64, z: 0 }, health: 19 }),
        300,
      ),
    ).toBe(false);
    expect(
      tracker.consume(
        before,
        createSnapshot({ position: first.position, health: 19 }),
        5_101,
      ),
    ).toBe(false);
  });
});
