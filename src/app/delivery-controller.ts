import type { ActionReport } from "../tools/contracts.js";
import { AppError } from "../domain/errors.js";
import type { Position } from "../domain/snapshot.js";
import type { DeliveryTargetKind } from "../memory/delivery-targets.js";
import type { MemoryStore } from "../memory/store.js";
import type { MinecraftPort } from "../minecraft/port.js";
import {
  actionPriorities,
  type ActionArbiter,
} from "../runtime/action-arbiter.js";
import { throwIfAborted } from "../runtime/cancellation.js";

export class DeliveryController {
  constructor(
    private readonly minecraft: MinecraftPort,
    private readonly memory: MemoryStore,
    private readonly owner: string,
    private readonly arbiter: ActionArbiter,
    private readonly executeDelivery?: (
      resource: string,
      count: number,
      gather: boolean,
      signal: AbortSignal,
    ) => Promise<ActionReport>,
  ) {}
  async deliver(
    resource: string,
    count: number,
    gather: boolean,
    signal: AbortSignal,
  ) {
    if (!this.executeDelivery)
      throw new AppError({
        category: "validation",
        code: "DELIVERY_UNAVAILABLE",
        message: "収納実行機能を利用できません。",
        retryable: false,
      });
    return this.executeDelivery(resource, count, gather, signal);
  }
  private playerId() {
    return this.memory.getOrCreatePlayer(this.owner).id;
  }
  list() {
    return this.memory.getDeliveryTargets(this.playerId());
  }
  async register(
    kind: DeliveryTargetKind,
    position: Position | null,
    externalSignal: AbortSignal,
  ) {
    throwIfAborted(externalSignal, "register_delivery_target");
    const lease = this.arbiter.acquire(
      "register_delivery_target",
      actionPriorities.task,
    );
    const signal = AbortSignal.any([externalSignal, lease.signal]);
    try {
      const observed = await this.minecraft.observe();
      if ((kind === "chest") !== (position !== null))
        throw new AppError({
          category: "validation",
          code: "DELIVERY_TARGET_POSITION_REQUIRED",
          message:
            "拠点はBotの現在位置、チェストは利用者が明示した座標を登録してください。",
          retryable: false,
        });
      const proof = await this.minecraft.storageIdentity(
        position,
        kind === "chest",
        signal,
      );
      throwIfAborted(signal, "register_delivery_target");
      if ((await this.minecraft.observe()).dimension !== observed.dimension)
        throw new AppError({
          category: "observation",
          code: "DELIVERY_WORLD_CHANGED",
          message: "登録中にworldが変わりました。",
          retryable: false,
        });
      const targetPosition = position ?? proof.position;
      if (targetPosition === undefined)
        throw new AppError({
          category: "observation",
          code: "HOME_POSITION_UNAVAILABLE",
          message:
            "同じworld観測の拠点座標を確認できません。補助を更新してください。",
          retryable: false,
        });
      const common = {
        dimension: observed.dimension,
        worldId: proof.worldId,
        position: targetPosition,
      };
      if (kind === "home")
        return this.memory.saveDeliveryTarget(this.playerId(), {
          kind,
          ...common,
        });
      if (proof.identity === null)
        throw new AppError({
          category: "observation",
          code: "CHEST_NOT_REGISTERABLE",
          message:
            "指定チェストを確認できません。利用可能なチェストを明示してください。",
          retryable: false,
        });
      return this.memory.saveDeliveryTarget(this.playerId(), {
        kind,
        ...common,
        identity: proof.identity,
      });
    } finally {
      lease.release();
    }
  }
  forget(kind: DeliveryTargetKind, signal: AbortSignal) {
    throwIfAborted(signal, "forget_delivery_target");
    const lease = this.arbiter.acquire(
      "forget_delivery_target",
      actionPriorities.task,
    );
    try {
      this.memory.forgetDeliveryTarget(this.playerId(), kind);
    } finally {
      lease.release();
    }
  }
}
