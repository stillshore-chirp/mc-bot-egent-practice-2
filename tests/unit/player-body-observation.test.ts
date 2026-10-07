import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import { describe, expect, it } from "vitest";
import { observePlayerBody } from "../../src/minecraft/player-body-observation.js";

interface FixtureEntity {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly height: number;
  readonly health?: number;
  readonly username?: string;
  readonly equipment?: readonly (null | { readonly name: string })[];
}

function makeObservationBot(
  entities: readonly FixtureEntity[],
  blockPositiveX = true,
): Bot {
  const self = {
    id: 1,
    name: "player",
    type: "player",
    position: new Vec3(0, 64, 0),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    height: 1.8,
    eyeHeight: 1.62,
  };
  const byId: Record<number, unknown> = { 1: self };
  for (const entity of entities) byId[entity.id] = entity;
  const inventory = { slots: Array.from({ length: 46 }, () => null) };
  const bot = {
    username: "bot",
    version: "1.21.4",
    entity: self,
    entities: byId,
    players: {},
    game: { dimension: "overworld", gameMode: "survival" },
    time: { day: 1, timeOfDay: 5_000, isDay: true },
    isRaining: false,
    health: 20,
    food: 20,
    foodSaturation: 5,
    isSleeping: false,
    experience: { level: 0, points: 0, progress: 0 },
    inventory,
    currentWindow: null,
    registry: {
      entitiesByName: {
        zombie: { category: "Hostile mobs" },
        skeleton: { category: "Hostile mobs" },
        cow: { category: "Passive mobs" },
        player: { category: "Hostile mobs" },
      },
      itemsByName: {},
    },
    findBlocks: () => [],
    blockAt: () => null,
    canSeeBlock: () => true,
    getEquipmentDestSlot: () => 0,
    world: {
      raycast: (_origin: Vec3, direction: Vec3) =>
        blockPositiveX && direction.x > 0.55
          ? { position: new Vec3(1, 64, 1) }
          : null,
    },
  };
  return bot as unknown as Bot;
}

function mob(
  id: number,
  name: string,
  position: Vec3,
  extra: Partial<FixtureEntity> = {},
): FixtureEntity {
  return {
    id,
    name,
    type: "mob",
    position,
    velocity: new Vec3(0, 0, 0),
    height: 1.8,
    health: 18,
    ...extra,
  };
}

describe("nearby hostile observation", () => {
  it("uses the 26.1 registry category for native hostile entity types", () => {
    const registry = minecraftData("26.1");
    const fromRegistry = (
      id: number,
      name: string,
      position: Vec3,
    ): FixtureEntity => {
      const entry = registry.entitiesByName[name];
      if (entry === undefined)
        throw new Error(`Missing 26.1 entity registry entry for ${name}`);
      return mob(id, name, position, { type: entry.type });
    };
    const bot = makeObservationBot(
      [
        fromRegistry(2, "zombie", new Vec3(0, 64, -4)),
        fromRegistry(3, "skeleton", new Vec3(0, 64, 4)),
        fromRegistry(4, "creeper", new Vec3(8, 64, 4)),
        fromRegistry(5, "drowned", new Vec3(0, 64, 9)),
        fromRegistry(6, "player", new Vec3(0, 64, 6)),
        fromRegistry(7, "end_crystal", new Vec3(0, 64, -1)),
        fromRegistry(8, "strider", new Vec3(0, 64, 1)),
      ],
      false,
    );
    Object.assign(bot.registry.entitiesByName, registry.entitiesByName);
    Object.assign(bot, { version: "26.1" });

    for (const name of ["zombie", "skeleton", "creeper", "drowned"])
      expect(registry.entitiesByName[name]?.type).toBe("hostile");
    expect(registry.entitiesByName.player?.type).toBe("player");
    expect(registry.entitiesByName.end_crystal?.type).toBe("other");
    expect(registry.entitiesByName.strider?.type).toBe("animal");
    expect(registry.entitiesByName.end_crystal?.category).toBe("Hostile mobs");
    expect(registry.entitiesByName.strider?.category).toBe("Hostile mobs");

    const observation = observePlayerBody(bot, undefined);
    expect(
      observation.perception.nearbyHostiles?.entities
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["creeper", "drowned", "skeleton", "zombie"]);
    expect(observation.perception.entities.map(({ name }) => name)).toContain(
      "zombie",
    );
    expect(
      observation.perception.entities.map(({ name }) => name),
    ).not.toContain("skeleton");
  });

  it("adds unoccluded client-received hostiles outside FOV with current evidence", () => {
    const observation = observePlayerBody(
      makeObservationBot([
        mob(2, "zombie", new Vec3(0, 64, -4)),
        mob(3, "skeleton", new Vec3(0, 64, 4), {
          equipment: [
            { name: "iron_sword" },
            null,
            null,
            null,
            null,
            { name: "diamond_helmet" },
          ],
        }),
        mob(4, "skeleton", new Vec3(5, 64, 4)),
        mob(5, "cow", new Vec3(-4, 64, 4)),
        mob(6, "player", new Vec3(0, 64, 5), { username: "other" }),
        mob(7, "zombie", new Vec3(0, 64, 17)),
        mob(8, "zombie", new Vec3(0, 64, 6), { type: "player" }),
      ]),
      undefined,
    );
    const nearby = observation.perception.nearbyHostiles;
    expect(nearby).toBeDefined();
    expect(nearby?.observedAt).toBe(observation.observedAt);
    expect(nearby?.source).toBe("client_received_unoccluded_nearby_hostiles");
    expect(nearby?.maxDistance).toBe(16);
    expect(nearby?.entities.map(({ id }) => id)).toEqual([2, 3]);
    expect(observation.perception.entities.map(({ id }) => id)).toContain(2);
    expect(nearby?.entities[1]?.equipment).toEqual({
      mainHand: "iron_sword",
      offHand: null,
      feet: null,
      legs: null,
      torso: null,
      head: "diamond_helmet",
    });
  });

  it("caps nearby output and marks omitted candidates and a truncated scan", () => {
    const hostiles = Array.from({ length: 130 }, (_, index) =>
      mob(
        index + 2,
        index % 2 === 0 ? "zombie" : "skeleton",
        new Vec3(index % 5, 64, -2 - (index % 12)),
      ),
    );
    const observation = observePlayerBody(
      makeObservationBot(hostiles, false),
      undefined,
    );
    const nearby = observation.perception.nearbyHostiles;
    expect(nearby?.entities).toHaveLength(16);
    expect(nearby?.entityOutputLimit).toBe(16);
    expect(nearby?.omittedEntityCandidates).toBe(112);
    expect(nearby?.candidateSearchMayBeTruncated).toBe(true);
    expect(nearby?.aggregate?.clientReceivedHostileCount).toBe(130);
    expect(nearby?.aggregate?.occlusionCheck).toEqual({
      method: "raycast_entity_body_point",
      candidateLimit: 128,
      candidatesChecked: 128,
      unoccludedCandidates: 128,
      occludedCandidates: 0,
      uncheckedCandidates: 2,
      detailOutputLimit: 16,
      omittedUnoccludedDetails: 112,
    });
    expect(
      nearby?.aggregate?.byKind.reduce((total, { count }) => total + count, 0),
    ).toBe(130);
  });

  it("aggregates 100 received hostiles while keeping a bounded detail list", () => {
    const directions = [
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
    ] as const;
    const hostiles = Array.from({ length: 100 }, (_, index) => {
      const [dx, dz] = directions[index % directions.length] ?? [0, -1];
      const radius = 2 + (Math.floor(index / directions.length) % 8) * 0.5;
      return mob(
        index + 2,
        index % 2 === 0 ? "zombie" : "skeleton",
        new Vec3(dx * radius, 64 + ((index % 3) - 1), dz * radius),
      );
    });
    const observation = observePlayerBody(
      makeObservationBot(hostiles, false),
      undefined,
    );
    const nearby = observation.perception.nearbyHostiles;
    const aggregate = nearby?.aggregate;

    expect(nearby?.entities).toHaveLength(16);
    expect(aggregate?.clientReceivedHostileCount).toBe(100);
    expect(aggregate?.maxDistance).toBe(16);
    expect(aggregate?.worldAbsenceEstablished).toBe(false);
    expect(aggregate?.countScope).toBe(
      "client_entity_table_within_max_distance",
    );
    expect(aggregate?.byKind).toEqual([
      { name: "skeleton", count: 50 },
      { name: "zombie", count: 50 },
    ]);
    expect(
      Object.fromEntries(
        aggregate?.byDirection.map(({ direction, count }) => [
          direction,
          count,
        ]) ?? [],
      ),
    ).toEqual({
      north: 13,
      northeast: 13,
      east: 13,
      southeast: 13,
      south: 12,
      southwest: 12,
      west: 12,
      northwest: 12,
      coincident: 0,
    });
    expect(
      aggregate?.byDirection
        .map(({ count }) => count)
        .reduce((a, b) => a + b, 0),
    ).toBe(100);
    expect(aggregate?.relativeOffsetBounds).toEqual({
      min: { x: -5.5, y: -1, z: -5.5 },
      max: { x: 5.5, y: 1, z: 5.5 },
    });
    expect(aggregate?.occlusionCheck).toEqual({
      method: "raycast_entity_body_point",
      candidateLimit: 128,
      candidatesChecked: 100,
      unoccludedCandidates: 100,
      occludedCandidates: 0,
      uncheckedCandidates: 0,
      detailOutputLimit: 16,
      omittedUnoccludedDetails: 84,
    });
  });

  it("keeps occluded candidates in aggregate counts but out of visible details", () => {
    const observation = observePlayerBody(
      makeObservationBot([
        mob(2, "zombie", new Vec3(5, 64, 0)),
        mob(3, "skeleton", new Vec3(0, 64, -4)),
      ]),
      undefined,
    );
    const nearby = observation.perception.nearbyHostiles;
    const aggregate = nearby?.aggregate;

    expect(aggregate?.clientReceivedHostileCount).toBe(2);
    expect(
      aggregate?.byDirection.find(({ direction }) => direction === "east")
        ?.count,
    ).toBe(1);
    expect(
      aggregate?.byDirection.find(({ direction }) => direction === "east")
        ?.relativeOffsetBounds,
    ).toEqual({
      min: { x: 5, y: 0, z: 0 },
      max: { x: 5, y: 0, z: 0 },
    });
    expect(
      aggregate?.byDirection.find(({ direction }) => direction === "north")
        ?.relativeOffsetBounds,
    ).toEqual({
      min: { x: 0, y: 0, z: -4 },
      max: { x: 0, y: 0, z: -4 },
    });
    expect(aggregate?.occlusionCheck).toMatchObject({
      candidatesChecked: 2,
      unoccludedCandidates: 1,
      occludedCandidates: 1,
      uncheckedCandidates: 0,
    });
    expect(nearby?.entities.map(({ id }) => id)).toEqual([3]);
  });
});
