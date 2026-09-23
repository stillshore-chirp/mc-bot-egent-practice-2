import type { Bot } from "mineflayer";
import { Movements, type SafeBlock } from "mineflayer-pathfinder";
import type { Vec3 } from "vec3";

export function isHandOperableDoor(name: string): boolean {
  return name.endsWith("_door") && name !== "iron_door";
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
    block.openable = block.getProperties().open !== true;
    return block;
  }
}
