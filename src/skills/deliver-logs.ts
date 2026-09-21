import { AppError } from "../domain/errors.js";
import { countInventory, distance } from "../domain/snapshot.js";
import type {
  ChestTarget,
  DeliveryTarget,
} from "../memory/delivery-targets.js";
import type { DepositResult, MinecraftPort } from "../minecraft/port.js";
import {
  actionPriorities,
  type ActionArbiter,
} from "../runtime/action-arbiter.js";
import { throwIfAborted } from "../runtime/cancellation.js";
import type { TaskRuntime } from "../runtime/task-service.js";
import type { GatherLogsSkill } from "./gather-logs/gather-logs-skill.js";
import type { GatherableLog } from "./gather-logs/resource-catalog.js";
export interface DeliveryInput {
  resource: GatherableLog;
  count: number;
  requester: string;
  gather: boolean;
  home: Extract<DeliveryTarget, { kind: "home" }>;
  chest: ChestTarget;
}
export class DeliverLogsSkill {
  constructor(
    private readonly minecraft: MinecraftPort,
    private readonly tasks: TaskRuntime,
    private readonly arbiter: ActionArbiter,
    private readonly gather: GatherLogsSkill,
    private readonly maxDistance: number,
  ) {}
  async run(input: DeliveryInput, onDeposit: (result: DepositResult) => void) {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 64)
      throw new AppError({
        category: "validation",
        code: "INVALID_DEPOSIT_COUNT",
        message: "収納数は1から64です。",
        retryable: false,
      });
    return this.tasks.run(
      input.gather ? "gather_and_store" : "store_logs",
      input,
      async (context) => {
        const lease = this.arbiter.acquire(
          `task:${context.taskId}`,
          actionPriorities.task,
        );
        const signal = AbortSignal.any([context.signal, lease.signal]);
        try {
          const checkWorld = async () => {
            throwIfAborted(signal, "delivery_precheck");
            const state = await this.minecraft.observe();
            const proof = await this.minecraft.storageIdentity(
              null,
              false,
              signal,
            );
            if (proof.position === undefined)
              throw new AppError({
                category: "observation",
                code: "DELIVERY_WORLD_UNVERIFIED",
                message: "worldと位置の対応をサーバーで確認できません。",
                retryable: false,
              });
            if (
              proof.worldId !== input.home.worldId ||
              proof.worldId !== input.chest.worldId ||
              state.dimension !== input.home.dimension ||
              state.dimension !== input.chest.dimension
            )
              throw new AppError({
                category: "observation",
                code: "DELIVERY_WORLD_CHANGED",
                message: "登録したworldにいないため移動・収納しません。",
                retryable: false,
              });
            return { ...state, position: proof.position };
          };
          const checkChest = async (allowUnavailable = false) => {
            const proof = await this.minecraft.storageIdentity(
              input.chest.position,
              false,
              signal,
            );
            if (
              allowUnavailable &&
              proof.worldId === input.chest.worldId &&
              proof.identity === null
            )
              return false;
            if (
              proof.worldId !== input.chest.worldId ||
              proof.identity !== input.chest.identity
            )
              throw new AppError({
                category: "observation",
                code: "STORAGE_TARGET_CHANGED",
                message: "登録チェストが消失・変更されたため作業を停止します。",
                retryable: false,
              });
            return true;
          };
          await context.advance("delivery_precheck");
          const move = async (
            position: DeliveryTarget["position"],
            range: number,
            phase: string,
          ) => {
            const before = await checkWorld();
            if (distance(before.position, position) > this.maxDistance)
              throw new AppError({
                category: "validation",
                code: "DELIVERY_DISTANCE_EXCEEDED",
                message: "登録先が移動距離の設定上限を超えています。",
                retryable: false,
              });
            await context.advance(phase);
            // 経路探索はブロック単位で停止するため、1ブロック内側を目指す。
            // 到達確認はBotの実座標で行い、許容範囲を広げない。
            let current = before;
            // 遠方の未読込地形まで一度に探索せず、読込範囲内の区間を進む。
            for (
              let step = 0;
              distance(current.position, position) > 32;
              step += 1
            ) {
              const remaining = distance(current.position, position);
              if (
                remaining > this.maxDistance ||
                step > Math.ceil(this.maxDistance / 16)
              )
                throw new AppError({
                  category: "validation",
                  code: "DELIVERY_DISTANCE_EXCEEDED",
                  message: "帰還経路が距離上限を超えたため移動を停止します。",
                  retryable: false,
                });
              const fraction = 32 / remaining;
              const waypoint = {
                x:
                  current.position.x +
                  (position.x - current.position.x) * fraction,
                y:
                  current.position.y +
                  (position.y - current.position.y) * fraction,
                z:
                  current.position.z +
                  (position.z - current.position.z) * fraction,
              };
              await this.minecraft.moveTo(waypoint, 1, signal);
              current = await checkWorld();
              if (distance(current.position, position) >= remaining - 1)
                throw new AppError({
                  category: "path",
                  code: "DELIVERY_RETURN_NOT_VERIFIED",
                  message: "帰還先へ近づいたことを確認できません。",
                  retryable: false,
                });
            }
            await this.minecraft.moveTo(
              position,
              Math.max(0, range - 1),
              signal,
            );
            const after = await checkWorld();
            if (distance(after.position, position) > range)
              throw new AppError({
                category: "observation",
                code: "DELIVERY_RETURN_NOT_VERIFIED",
                message: "登録先への到達を確認できません。",
                retryable: false,
              });
            return distance(after.position, position);
          };
          const initial = await checkWorld();
          if (
            distance(initial.position, input.home.position) >
              this.maxDistance ||
            distance(input.home.position, input.chest.position) + 2 >
              this.maxDistance
          )
            throw new AppError({
              category: "validation",
              code: "DELIVERY_DISTANCE_EXCEEDED",
              message:
                "登録先への帰還・収納経路が移動距離の設定上限を超えています。",
              retryable: false,
            });
          if (input.gather) {
            // 遠方・未読込は消失と断定せず、登録地点へ近づいてから採取前に確認する。
            if (!(await checkChest(true))) {
              await move(input.home.position, 2, "inspect_via_home");
              await move(input.chest.position, 3, "inspect_registered_chest");
              await checkChest();
            }
            await this.gather.collect(input, context, signal, false, {
              center: input.home.position,
              radius: this.maxDistance,
            });
          }
          const inventory = await this.minecraft.observe();
          if (countInventory(inventory, input.resource) < input.count)
            throw new AppError({
              category: "inventory",
              code: "DEPOSIT_ITEMS_MISSING",
              message: "指定数の原木を所持していません。",
              retryable: false,
              confirmedState: {
                heldCount: countInventory(inventory, input.resource),
              },
            });
          const homeDistance = await move(
            input.home.position,
            2,
            "return_to_home",
          );
          await move(input.chest.position, 3, "move_to_registered_chest");
          await checkChest();
          await context.advance("deposit_logs");
          const result = await this.minecraft.depositLogs(
            input.chest,
            input.resource,
            input.count,
            signal,
          );
          onDeposit(result);
          await context.advance("verify_deposit", { ...result, homeDistance });
          if (
            !result.verified ||
            result.deposited !== input.count ||
            result.reason !== "completed"
          )
            throw new AppError({
              category: "inventory",
              code: "DEPOSIT_NOT_COMPLETED",
              message: "収納の全量完了を確認できません。",
              retryable: false,
              confirmedState: { ...result, homeDistance },
            });
          return { ...result, homeDistance, resource: input.resource };
        } finally {
          try {
            await this.minecraft.stopCurrentAction();
          } finally {
            lease.release();
          }
        }
      },
    );
  }
}
