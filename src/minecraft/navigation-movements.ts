import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import {
  Movements,
  type Move,
  type PartiallyComputedPath,
  type SafeBlock,
  type XZCoordinates,
} from "mineflayer-pathfinder";
import { Vec3 } from "vec3";

const woodenDoorNames = new Set([
  "oak_door",
  "spruce_door",
  "birch_door",
  "jungle_door",
  "acacia_door",
  "dark_oak_door",
  "mangrove_door",
  "cherry_door",
  "bamboo_door",
  "crimson_door",
  "warped_door",
  "pale_oak_door",
]);
const validDoorFacings = new Set(["north", "east", "south", "west"]);
const pathPointTolerance = 1e-6;
const collisionTolerance = 1e-6;
const supportedNativeWoodDoorLeaves = new Set([
  "0,0,0,0.1875,1,1",
  "0.8125,0,0,1,1,1",
  "0,0,0,1,1,0.1875",
  "0,0,0.8125,1,1,1",
]);

export function isHandOperableDoor(name: unknown): boolean {
  return (
    typeof name === "string" && name.endsWith("_door") && name !== "iron_door"
  );
}

/** Resolve either half of a door to the lower block used for interaction. */
export function handOperableDoorAt(bot: Bot, position: Vec3): Block | null {
  for (const offset of [0, -1]) {
    const block = bot.blockAt(position.offset(0, offset, 0));
    if (!block || !isHandOperableDoor(block.name)) continue;
    return block.getProperties().half === "upper"
      ? bot.blockAt(block.position.offset(0, -1, 0))
      : block;
  }
  return null;
}

export function closedDoorAt(bot: Bot, position: Vec3): Block | null {
  const door = handOperableDoorAt(bot, position);
  return door?.getProperties().open === false ? door : null;
}

/** Correct a fresh single-leaf open wood-door waypoint before path assignment. */
export function correctOpenWoodDoorPath(
  bot: Bot,
  result: PartiallyComputedPath,
): void {
  const { path } = result;
  if (
    path.length === 0 ||
    path.some(
      (node) =>
        node.toBreak.length > 0 ||
        node.toPlace.length > 0 ||
        !Number.isFinite(node.x) ||
        !Number.isFinite(node.y) ||
        !Number.isFinite(node.z),
    )
  )
    return;

  const width = bot.entity.width;
  if (!Number.isFinite(width) || width <= 0 || width >= 1) return;

  const corrections: { readonly node: Move; readonly point: Vec3 }[] = [];
  try {
    for (const node of path) {
      const observed = bot.blockAt(
        new Vec3(Math.floor(node.x), Math.floor(node.y), Math.floor(node.z)),
        false,
      );
      if (observed === null || !woodenDoorNames.has(observed.name)) continue;

      const observedPosition = observed.position;
      const observedProperties = observed.getProperties();
      if (
        observedProperties.half !== "lower" &&
        observedProperties.half !== "upper"
      )
        continue;
      const lowerPosition = observedPosition.offset(
        0,
        observedProperties.half === "upper" ? -1 : 0,
        0,
      );

      const upperPosition = lowerPosition.offset(0, 1, 0);
      const lower = bot.blockAt(lowerPosition, false);
      const upper = bot.blockAt(upperPosition, false);
      if (
        lower === null ||
        upper === null ||
        lower.name !== observed.name ||
        upper.name !== observed.name ||
        !samePoint(lower.position, lowerPosition) ||
        !samePoint(upper.position, upperPosition)
      )
        continue;

      const lowerState = lower.getProperties();
      const upperState = upper.getProperties();
      const shape = lower.shapes[0];
      const upperShape = upper.shapes[0];
      if (
        lower.shapes.length !== 1 ||
        upper.shapes.length !== 1 ||
        shape === undefined ||
        upperShape === undefined ||
        !supportedNativeWoodDoorLeaves.has(shape.join(",")) ||
        shape.join(",") !== upperShape.join(",") ||
        lowerState.half !== "lower" ||
        upperState.half !== "upper" ||
        lowerState.open !== true ||
        upperState.open !== true ||
        lowerState.facing !== upperState.facing ||
        lowerState.hinge !== upperState.hinge ||
        lowerState.powered !== upperState.powered ||
        typeof lowerState.facing !== "string" ||
        !validDoorFacings.has(lowerState.facing) ||
        (lowerState.hinge !== "left" && lowerState.hinge !== "right")
      )
        continue;

      const topPoint = new Vec3(
        lower.position.x + 0.25 + (shape[0] + shape[3]) / 4,
        lower.position.y + 1,
        lower.position.z + 0.25 + (shape[2] + shape[5]) / 4,
      );
      if (!samePoint(node, topPoint)) continue;

      const halfWidth = width / 2;
      const thinAxis = shape[3] - shape[0] < 0.25 ? "x" : "z";
      const leafMinimum = thinAxis === "x" ? shape[0] : shape[2];
      const leafMaximum = thinAxis === "x" ? shape[3] : shape[5];
      const freeMinimum =
        leafMinimum <= pathPointTolerance
          ? leafMaximum + halfWidth + collisionTolerance
          : halfWidth;
      const freeMaximum =
        leafMaximum >= 1 - pathPointTolerance
          ? leafMinimum - halfWidth - collisionTolerance
          : 1 - halfWidth;
      if (freeMinimum >= freeMaximum) continue;

      const offset = (freeMinimum + freeMaximum) / 2;
      const feetPoint =
        thinAxis === "x"
          ? lower.position.offset(offset, 0, 0.5)
          : lower.position.offset(0.5, 0, offset);
      corrections.push({ node, point: feetPoint });
    }
  } catch {
    // Stale or unavailable block observations leave the path unchanged.
    return;
  }

  for (const { node, point } of corrections) {
    node.x = point.x;
    node.y = point.y;
    node.z = point.z;
  }
}

function samePoint(
  first: { readonly x: number; readonly y: number; readonly z: number },
  second: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  return [first.x - second.x, first.y - second.y, first.z - second.z].every(
    (difference) => Math.abs(difference) <= pathPointTolerance,
  );
}

/** Walk-only navigation that can use ordinary doors without creating blocks. */
export class NavigationMovements extends Movements {
  public constructor(bot: Bot) {
    super(bot);
    this.canDig = false;
    this.allow1by1towers = false;
    this.allowParkour = false;
    this.allowSprinting = false;
    this.maxDropDown = 2;
    this.infiniteLiquidDropdownDistance = false;
    this.scafoldingBlocks = [];
    this.canOpenDoors = true;
    this.openable.clear();
    for (const block of bot.registry.blocksArray) {
      if (isHandOperableDoor(block.name)) this.openable.add(block.id);
    }
  }

  public override getBlock(
    position: Vec3,
    dx: number,
    dy: number,
    dz: number,
  ): SafeBlock {
    const block = super.getBlock(position, dx, dy, dz);
    if (!isHandOperableDoor(block.name)) return block;
    // The pathfinder must plan through both door halves. It interacts only
    // with a closed door; activating an open door would close the passage.
    block.safe = true;
    block.physical = false;
    // Door collision shapes describe the leaf, not a floor to climb onto.
    block.height = block.position.y;
    block.openable = block.getProperties().open !== true;
    return block;
  }

  public override getMoveDiagonal(
    node: Move,
    dir: XZCoordinates,
    neighbors: Move[],
  ): void {
    const position = new Vec3(node.x, node.y, node.z);
    const destination = this.getBlock(position, dir.x, 0, dir.z);
    if (!destination.physical) {
      // The upstream planner permits a diagonal when either side is clear.
      // A player-sized body cannot cut through the corner of the blocked side.
      for (const [dx, dz] of [
        [dir.x, 0],
        [0, dir.z],
      ] as const) {
        for (const dy of [0, 1]) {
          const side = this.getBlock(position, dx, dy, dz);
          if (!side.safe || side.physical) return;
        }
      }
    }
    super.getMoveDiagonal(node, dir, neighbors);
  }
}
