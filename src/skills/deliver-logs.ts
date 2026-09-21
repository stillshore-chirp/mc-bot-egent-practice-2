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
            const proof = await this.minecraft.storageIdentity(
              null,
              false,
              signal,
            );
            const state = await this.minecraft.observe();
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
            return state;
          };
          const checkChest = async () => {
            const proof = await this.minecraft.storageIdentity(
              input.chest.position,
              false,
              signal,
            );
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
          };
          await context.advance("delivery_precheck");
          await checkWorld();
          await checkChest();
          if (input.gather) await this.gather.collect(input, context, signal);
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
            await this.minecraft.moveTo(position, range, signal);
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
          const homeDistance = await move(
            input.home.position,
            2,
            "return_to_home",
          );
          await checkChest();
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
