import { describe, expect, it } from "vitest";

import {
  closestHostileDistance,
  decideHostileResponse,
} from "../../src/decision/hostile-response.js";
import { createSnapshot } from "../support/fake-minecraft.js";

const zombie = (id: number, distance: number) => ({
  id,
  name: "zombie",
  kind: "mob",
  position: { x: distance, y: 64, z: 0 },
  distance,
  hostile: true,
});

describe("hostile response decision", () => {
  it("does not turn a player or peaceful mob into an attack target", () => {
    const snapshot = createSnapshot({
      nearbyEntities: [
        { ...zombie(1, 2), name: "player", hostile: false },
        { ...zombie(2, 2), name: "cow", hostile: false },
      ],
    });
    expect(decideHostileResponse(snapshot)).toEqual({ mode: "none" });
    expect(closestHostileDistance(snapshot)).toBeNull();
  });

  it("attacks only an adjacent low-risk hostile with a weapon", () => {
    const snapshot = createSnapshot({
      nearbyEntities: [zombie(7, 2.5)],
      inventory: [{ name: "iron_sword", count: 1 }],
    });
    expect(decideHostileResponse(snapshot)).toEqual({
      mode: "attack",
      entityId: 7,
    });
  });

  it("chooses an actual retreat when unarmed or facing multiple threats", () => {
    const unarmed = createSnapshot({ nearbyEntities: [zombie(7, 2.5)] });
    expect(decideHostileResponse(unarmed)).toMatchObject({ mode: "retreat" });

    const multiple = createSnapshot({
      nearbyEntities: [zombie(7, 2.5), zombie(8, 6)],
      inventory: [{ name: "iron_sword", count: 1 }],
    });
    expect(decideHostileResponse(multiple)).toMatchObject({ mode: "retreat" });
    expect(closestHostileDistance(multiple)).toBe(2.5);
  });

  it("will not rush distant, explosive, injured, or underwater threats", () => {
    const armed = [{ name: "iron_sword", count: 1 }];
    for (const snapshot of [
      createSnapshot({ nearbyEntities: [zombie(1, 21)], inventory: armed }),
      createSnapshot({
        nearbyEntities: [{ ...zombie(1, 2), name: "creeper" }],
        inventory: armed,
      }),
      createSnapshot({
        nearbyEntities: [zombie(1, 2)],
        inventory: armed,
        health: 10,
      }),
      createSnapshot({
        nearbyEntities: [zombie(1, 2)],
        inventory: armed,
        inWater: true,
      }),
    ]) {
      expect(decideHostileResponse(snapshot).mode).toBe("retreat");
    }
  });
});
