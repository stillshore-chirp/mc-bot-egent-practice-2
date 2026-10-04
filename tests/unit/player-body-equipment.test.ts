import { Vec3 } from "vec3";
import { describe, expect, it } from "vitest";
import type { Bot } from "mineflayer";
import {
  observePlayerBody,
  playerBodyLookSweepSchema,
  summarizeLookSweepView,
} from "../../src/minecraft/player-body-observation.js";

function makeBot(equipment: readonly (string | null | undefined)[]): Bot {
  const self = {
    id: 1,
    position: new Vec3(0, 64, 0),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    height: 1.8,
    eyeHeight: 1.62,
  };
  const enemy = {
    id: 2,
    name: "zombie",
    type: "hostile",
    position: new Vec3(0, 64, -4),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    height: 1.95,
    health: 20,
    equipment: equipment.map((name) =>
      name === undefined ? undefined : name === null ? null : { name },
    ),
  };
  return {
    username: "fixture_bot",
    version: "26.1",
    entity: self,
    entities: { 1: self, 2: enemy },
    players: {},
    game: { dimension: "overworld", gameMode: "survival" },
    time: { day: 1, timeOfDay: 5_000, isDay: true },
    isRaining: false,
    health: 20,
    food: 20,
    foodSaturation: 5,
    isSleeping: false,
    experience: { level: 0, points: 0, progress: 0 },
    inventory: { slots: Array.from({ length: 46 }, () => null) },
    getEquipmentDestSlot: () => 0,
    registry: {
      entitiesByName: { zombie: { category: "Hostile mobs" } },
      blocksByStateId: {},
    },
    world: { raycast: () => null },
    findBlocks: () => [],
    blockAt: () => null,
    canSeeBlock: () => true,
    currentWindow: null,
  } as unknown as Bot;
}

function sweepFor(bot: Bot) {
  const observation = observePlayerBody(bot, undefined);
  const current = summarizeLookSweepView(observation, null);
  return {
    observation,
    current,
    parsed: playerBodyLookSweepSchema.safeParse({
      current,
      directions: [],
      plannedDirectionCount: 8,
      complete: false,
      candidateSearchMayBeTruncated: false,
      worldAbsenceEstablished: false,
    }),
  };
}

describe("visible entity equipment observation", () => {
  it("maps the six received slots and carries only bounded item kinds into look sweeps", () => {
    const longName = "a".repeat(100);
    const { observation, current, parsed } = sweepFor(
      makeBot([
        longName,
        null,
        "iron_boots",
        "iron_leggings",
        "iron_chestplate",
        "iron_helmet",
      ]),
    );

    const equipment = observation.perception.entities[0]?.equipment;
    expect(equipment).toEqual({
      mainHand: "a".repeat(80),
      offHand: null,
      feet: "iron_boots",
      legs: "iron_leggings",
      torso: "iron_chestplate",
      head: "iron_helmet",
    });
    expect(current.visibleEntities[0]?.equipment).toEqual(equipment);
    expect(parsed.success).toBe(true);
  });

  it("keeps unreceived slots unknown and explicit empty slots null", () => {
    const { observation, current, parsed } = sweepFor(
      makeBot([undefined, null]),
    );
    const equipment = observation.perception.entities[0]?.equipment;

    expect(equipment).toEqual({ offHand: null });
    expect(equipment).not.toHaveProperty("mainHand");
    expect(current.visibleEntities[0]?.equipment).toEqual({ offHand: null });
    expect(parsed.success).toBe(true);
  });

  it("does not invent equipment when no slots have been received", () => {
    const { observation, current, parsed } = sweepFor(makeBot([]));

    expect(observation.perception.entities[0]?.equipment).toBeUndefined();
    expect(current.visibleEntities[0]).not.toHaveProperty("equipment");
    expect(parsed.success).toBe(true);
  });
});
