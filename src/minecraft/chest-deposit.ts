import type { Bot, Chest } from "mineflayer";
import { Vec3 } from "vec3";
import { AppError } from "../domain/errors.js";
import type { ChestTarget } from "../memory/delivery-targets.js";
import { throwIfAborted } from "../runtime/cancellation.js";
import { delay } from "../runtime/timeout.js";
import type { DepositResult, StorageIdentity } from "./port.js";

type Inspect = (signal: AbortSignal) => Promise<StorageIdentity>;
export function verifyDeposit(
  before: StorageIdentity,
  after: StorageIdentity,
  requested: number,
): DepositResult {
  const a = before.observation,
    b = after.observation;
  const withdrawn = a && b ? a.playerCount - b.playerCount : -1;
  const added = a && b ? b.chestCount - a.chestCount : -1;
  const verified =
    before.worldId === after.worldId &&
    before.identity !== null &&
    before.identity === after.identity &&
    !!a &&
    !!b &&
    a.uncontested &&
    b.uncontested &&
    a.epoch === b.epoch &&
    a.revision === b.revision &&
    withdrawn >= 0 &&
    withdrawn <= requested &&
    withdrawn === added;
  return {
    requested,
    deposited: verified ? added : null,
    remaining: verified ? requested - added : null,
    heldCount: b?.playerCount ?? null,
    verified,
    reason: verified && added === requested ? "completed" : "unverified",
  };
}
function ensureIdentity(proof: StorageIdentity, target: ChestTarget) {
  if (
    proof.worldId !== target.worldId ||
    proof.identity !== target.identity ||
    !proof.observation?.uncontested
  )
    throw new AppError({
      category: "observation",
      code: "STORAGE_TARGET_CHANGED",
      message: "指定チェストの個体・利用状態が変わりました。",
      retryable: false,
    });
}

/** Only inventory->chest clicks. Never calls withdraw, toss or generic transfer cleanup. */
export async function depositIntoChest(
  bot: Bot,
  target: ChestTarget,
  resource: string,
  count: number,
  signal: AbortSignal,
  inspect: Inspect,
): Promise<DepositResult> {
  throwIfAborted(signal, "deposit_logs");
  if (!Number.isInteger(count) || count < 1 || count > 64)
    throw new AppError({
      category: "validation",
      code: "INVALID_DEPOSIT_COUNT",
      message: "収納数は1から64です。",
      retryable: false,
    });
  const before = await inspect(signal);
  ensureIdentity(before, target);
  let window: Chest | undefined;
  let reason: DepositResult["reason"] = "completed";
  const close = () => {
    if (window && bot.currentWindow === window) window.close();
  };
  const abort = () => {
    try {
      close();
    } catch {
      /* Connection shutdown may already have closed it. */
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    // Mineflayer delays hotbar clicks after digging. Finish that delay before owning a window.
    await delay(550, signal);
    const block = bot.blockAt(
      new Vec3(target.position.x, target.position.y, target.position.z),
    );
    if (!block || !["chest", "trapped_chest"].includes(block.name))
      throw new Error("Chest missing");
    ensureIdentity(await inspect(signal), target);
    const open = bot.openContainer(block);
    let abandoned = false;
    const timerSignal = AbortSignal.any([signal, AbortSignal.timeout(2500)]);
    const guarded = new Promise<never>((_resolve, reject) => {
      const stopped = () => {
        abandoned = true;
        bot.quit("container_open_cancelled");
        reject(new Error("Container opening interrupted"));
      };
      if (timerSignal.aborted) stopped();
      else timerSignal.addEventListener("abort", stopped, { once: true });
      void open.then(
        () => timerSignal.removeEventListener("abort", stopped),
        () => timerSignal.removeEventListener("abort", stopped),
      );
    });
    void open.then(
      (opened) => {
        if (abandoned && bot.currentWindow === opened) {
          try {
            opened.close();
          } catch {
            /* Connection already closed. */
          }
        }
      },
      () => undefined,
    );
    window = await Promise.race([open, guarded]);
    const active = window;
    const check = () => {
      throwIfAborted(signal, "deposit_logs");
      if (bot.currentWindow !== active) throw new Error("Container closed");
    };
    const click = async (slot: number, button: 0 | 1) => {
      check();
      await bot.clickWindow(slot, button, 0);
      check();
    };
    const hasCursor = () => active.selectedItem !== null;
    if (hasCursor()) throw new Error("Unexpected cursor item");
    let moved = 0;
    while (moved < count) {
      check();
      const fresh = await inspect(signal);
      ensureIdentity(fresh, target);
      if (
        !fresh.observation ||
        fresh.observation.epoch !== before.observation?.epoch ||
        fresh.observation.revision !== before.observation.revision
      ) {
        reason = "unverified";
        break;
      }
      const source = active.slots
        .slice(active.inventoryStart, active.inventoryEnd)
        .find((item) => item?.name === resource);
      if (!source) {
        reason = "failed";
        break;
      }
      let destination = -1;
      for (let slot = 0; slot < active.inventoryStart; slot++) {
        const item = active.slots[slot];
        if (
          item == null ||
          (item.name === source.name &&
            item.metadata === source.metadata &&
            JSON.stringify(Reflect.get(item, "components")) ===
              JSON.stringify(Reflect.get(source, "components")) &&
            JSON.stringify(Reflect.get(item, "removeComponents")) ===
              JSON.stringify(Reflect.get(source, "removeComponents")) &&
            item.count < item.stackSize &&
            JSON.stringify(item.nbt) === JSON.stringify(source.nbt))
        ) {
          destination = slot;
          break;
        }
      }
      if (destination < 0) {
        reason = "full";
        break;
      }
      const destinationItem = active.slots[destination];
      const amount = Math.min(
        count - moved,
        source.count,
        source.stackSize - (destinationItem?.count ?? 0),
      );
      const sourceSlot = source.slot;
      await click(sourceSlot, 0);
      // A selected stack is returned to its own source slot, never to a chest source slot.
      for (let n = 0; n < amount; n++) {
        await click(destination, 1);
        moved++;
      }
      if (hasCursor()) {
        const retained = active.slots[sourceSlot];
        if (retained !== null) throw new Error("Reserved source slot changed");
        await click(sourceSlot, 0);
      }
      const current = await inspect(signal);
      ensureIdentity(current, target);
      const interim = verifyDeposit(before, current, count);
      if (!interim.verified || interim.deposited !== moved) {
        reason = "unverified";
        break;
      }
    }
  } catch {
    reason = signal.aborted ? "cancelled" : "failed";
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      close();
    } catch {
      reason = "failed";
    }
  }
  try {
    // Read-only reconciliation remains allowed after stop; no further clicks are issued.
    const after = await inspect(AbortSignal.timeout(1500));
    const result = verifyDeposit(before, after, count);
    return {
      ...result,
      reason: result.verified
        ? reason === "completed" && result.deposited !== count
          ? "failed"
          : reason
        : "unverified",
    };
  } catch {
    return {
      requested: count,
      deposited: null,
      remaining: null,
      heldCount: null,
      verified: false,
      reason: signal.aborted ? "cancelled" : "unverified",
    };
  }
}
