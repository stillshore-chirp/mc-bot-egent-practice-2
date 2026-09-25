import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Movements, type SafeBlock } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";

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
}
