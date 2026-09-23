import { AppError } from "../domain/errors.js";
import {
  countInventory,
  distance,
  type Position,
  type WorldSnapshot,
} from "../domain/snapshot.js";
import type { TaskRecord } from "../domain/task.js";
import type { TaskRunRecord } from "../memory/types.js";
import type { MinecraftPort } from "../minecraft/port.js";
import {
  actionPriorities,
  type ActionArbiter,
} from "../runtime/action-arbiter.js";
import { throwIfAborted } from "../runtime/cancellation.js";
import type { TaskRuntime } from "../runtime/task-service.js";
import type { GatherLogsSkill } from "./gather-logs/gather-logs-skill.js";
import {
  baseBuildLog,
  baseBuildMaterial,
  baseBuildMaxBlocks,
  baseBuildMaxLogs,
  buildBlockKey,
  buildPlan,
  buildSiteCandidates,
  buildStateSafe,
  groundSuitable,
  placementState,
  siteClearOfPlayers,
  type BaseBuildPlan,
} from "./base-build-plan.js";

export interface BaseBuildInput {
  readonly resumedFrom?: string;
}

export interface BaseBuildOutput {
  readonly verifiedBlocks: number;
  readonly totalBlocks: number;
  readonly observedAt: string;
}

interface ResumeState {
  readonly plan: BaseBuildPlan;
  readonly verified: ReadonlySet<string>;
  readonly sourceId: string;
}

function position(value: unknown, requireInteger = true): Position | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = value as Record<string, unknown>;
  const { x, y, z } = candidate;
  if (
    ![x, y, z].every(
      (item) =>
        typeof item === "number" &&
        Number.isFinite(item) &&
        (!requireInteger || Number.isSafeInteger(item)),
    )
  )
    return undefined;
  return { x: x as number, y: y as number, z: z as number };
}

function resumeState(
  record: TaskRunRecord | undefined,
): ResumeState | undefined {
  if (record?.kind !== "build_base" || record.status === "completed")
    return undefined;
  const checkpoint = record.checkpoint?.data;
  const center = position(checkpoint?.center);
  const origin = position(checkpoint?.origin, false);
  const dimension = checkpoint?.dimension;
  const worldId = checkpoint?.worldId;
  const verified = checkpoint?.verified;
  if (
    center === undefined ||
    origin === undefined ||
    typeof dimension !== "string" ||
    typeof worldId !== "string" ||
    !Array.isArray(verified) ||
    !verified.every((key) => typeof key === "string")
  )
    return undefined;
  const plan = buildPlan(center, dimension, origin, worldId);
  const known = new Set(plan.blocks.map(buildBlockKey));
  if (
    plan.blocks.length !== baseBuildMaxBlocks ||
    verified.some((key) => !known.has(key))
  )
    return undefined;
  return { plan, verified: new Set(verified), sourceId: record.id };
}

function checkpoint(
  plan: BaseBuildPlan,
  origin: Position,
  verified: ReadonlySet<string>,
) {
  return {
    dimension: plan.dimension,
    worldId: plan.worldId,
    center: plan.center,
    origin,
    material: plan.material,
    verified: [...verified],
    totalBlocks: plan.blocks.length,
  };
}

function safeOrStop(snapshot: WorldSnapshot, dimension: string): void {
  if (snapshot.dimension !== dimension || !buildStateSafe(snapshot)) {
    throw new AppError({
      category: "safety",
      code: "BASE_BUILD_UNSAFE",
      message: "建築中に安全な状態または同じworldを確認できませんでした。",
      retryable: true,
      failedAt: "base_build_safety",
    });
  }
}

export class BaseBuildSkill {
  public constructor(
    private readonly minecraft: MinecraftPort,
    private readonly tasks: TaskRuntime,
    private readonly arbiter: ActionArbiter,
    private readonly gather: GatherLogsSkill,
    private readonly ownerUsername: string,
    private readonly excludedPositions: () => readonly Position[],
  ) {}

  public async run(
    previous?: TaskRunRecord,
  ): Promise<TaskRecord<BaseBuildInput, BaseBuildOutput>> {
    const resume = resumeState(previous);
    const input: BaseBuildInput =
      resume === undefined ? {} : { resumedFrom: resume.sourceId };
    return this.tasks.run("build_base", input, async (context) => {
      await this.arbiter.waitForAvailable(
        actionPriorities.task,
        context.signal,
      );
      const lease = this.arbiter.acquire(
        `task:${context.taskId}`,
        actionPriorities.task,
      );
      const signal = AbortSignal.any([context.signal, lease.signal]);
      let plan: BaseBuildPlan | undefined;
      let origin: Position | undefined;
      const verified = new Set<string>(resume?.verified);
      try {
        const start = await this.minecraft.observe();
        safeOrStop(start, resume?.plan.dimension ?? start.dimension);
        const world = await this.minecraft.storageIdentity(null, false, signal);
        if (resume !== undefined && world.worldId !== resume.plan.worldId) {
          throw new AppError({
            category: "safety",
            code: "BASE_WORLD_CHANGED",
            message: "保存した建築 world と現在の world が異なります。",
            retryable: false,
            failedAt: "site_selection",
          });
        }
        const loadingPoint = {
          x: Math.floor(start.position.x),
          y: Math.floor(start.position.y) - 1,
          z: Math.floor(start.position.z),
        };
        const loaded = await this.minecraft.inspectBuildBlock(
          loadingPoint,
          baseBuildMaterial,
          signal,
        );
        if (loaded.name === null || !loaded.serverConfirmed) {
          throw new AppError({
            category: "observation",
            code: "BASE_AREA_NOT_LOADED",
            message: "周辺のブロックをサーバーで確認できません。",
            retryable: true,
            failedAt: "site_selection",
          });
        }
        origin =
          resume === undefined
            ? start.position
            : position(previous?.checkpoint?.data.origin, false);
        if (origin === undefined) throw new Error("Missing base origin");
        await context.advance("site_selection");
        plan =
          resume?.plan ?? (await this.selectSite(start, world.worldId, signal));
        if (plan === undefined)
          throw new AppError({
            category: "safety",
            code: "BASE_SITE_UNAVAILABLE",
            message:
              "保護対象やプレイヤーを避けた平坦な候補地を確認できません。",
            retryable: true,
            failedAt: "site_selection",
          });
        await this.moveToConfirmedSite(plan.center, plan.worldId, signal);
        const confirmed = await this.verifySite(plan, verified, signal);
        verified.clear();
        for (const key of confirmed) verified.add(key);
        await context.advance(
          "material_estimate",
          checkpoint(plan, origin, verified),
        );

        const needed = plan.blocks.length - verified.size;
        let state = await this.minecraft.observe();
        safeOrStop(state, plan.dimension);
        const planks = countInventory(state, baseBuildMaterial);
        if (planks < needed) {
          const logsRequired = Math.ceil((needed - planks) / 4);
          if (logsRequired > baseBuildMaxLogs)
            throw new Error("Base material limit exceeded");
          const heldLogs = countInventory(state, baseBuildLog);
          const missingLogs = Math.max(0, logsRequired - heldLogs);
          if (missingLogs > 0) {
            const selectedPlan = plan;
            const siteOrigin = origin;
            await context.advance(
              "procurement",
              checkpoint(plan, origin, verified),
            );
            await this.gather.collect(
              {
                resource: baseBuildLog,
                count: missingLogs,
                requester: this.ownerUsername,
              },
              {
                ...context,
                advance: (phase, detail) =>
                  context.advance(phase, {
                    ...checkpoint(selectedPlan, siteOrigin, verified),
                    gather: detail ?? {},
                  }),
              },
              signal,
              false,
              { center: plan.center, radius: 24 },
            );
            await this.moveToConfirmedSite(plan.center, plan.worldId, signal);
          }
          state = await this.minecraft.observe();
          safeOrStop(state, plan.dimension);
          if (countInventory(state, baseBuildLog) < logsRequired) {
            throw new AppError({
              category: "inventory",
              code: "BASE_MATERIAL_SHORTAGE",
              message: "必要な原木が足りません。",
              retryable: true,
              failedAt: "procurement",
            });
          }
          await context.advance("crafting", checkpoint(plan, origin, verified));
          await this.minecraft.craftItem(
            { name: baseBuildMaterial, count: needed - planks },
            signal,
          );
          state = await this.minecraft.observe();
          if (countInventory(state, baseBuildMaterial) < needed) {
            throw new AppError({
              category: "inventory",
              code: "BASE_CRAFT_UNVERIFIED",
              message: "必要な板材を所持品で確認できません。",
              retryable: true,
              failedAt: "crafting",
            });
          }
        }

        for (const target of plan.blocks) {
          throwIfAborted(signal, "base_placement");
          state = await this.minecraft.observe();
          safeOrStop(state, plan.dimension);
          if (!siteClearOfPlayers(state, plan.center)) {
            throw new AppError({
              category: "safety",
              code: "BASE_SITE_PLAYER_NEARBY",
              message: "建築範囲にプレイヤーが近づきました。",
              retryable: true,
              failedAt: "placement",
            });
          }
          const key = buildBlockKey(target);
          const observed = await this.minecraft.inspectBuildBlock(
            target,
            baseBuildMaterial,
            signal,
          );
          const status = placementState(
            observed,
            baseBuildMaterial,
            verified.has(key),
          );
          if (status === "verified") continue;
          if (status !== "empty")
            throw new AppError({
              category: "safety",
              code: "BASE_TARGET_CHANGED",
              message:
                "設置先が保護対象または予期しないブロックに変わりました。",
              retryable: true,
              failedAt: "placement",
            });
          await context.advance(
            "placement",
            checkpoint(plan, origin, verified),
          );
          await this.minecraft.placeBlock(
            { name: baseBuildMaterial, position: target },
            signal,
          );
          const after = await this.minecraft.inspectBuildBlock(
            target,
            baseBuildMaterial,
            signal,
          );
          if (after.name !== baseBuildMaterial || !after.serverConfirmed) {
            throw new AppError({
              category: "observation",
              code: "BASE_PLACEMENT_UNVERIFIED",
              message: "設置後のブロックをサーバー側で確認できません。",
              retryable: true,
              failedAt: "placement",
            });
          }
          verified.add(key);
          await context.advance(
            "placement",
            checkpoint(plan, origin, verified),
          );
        }

        await context.advance(
          "final_verify",
          checkpoint(plan, origin, verified),
        );
        await this.verifySite(plan, verified, signal);
        for (const target of plan.blocks) {
          const observed = await this.minecraft.inspectBuildBlock(
            target,
            baseBuildMaterial,
            signal,
          );
          if (
            placementState(
              observed,
              baseBuildMaterial,
              verified.has(buildBlockKey(target)),
            ) !== "verified"
          )
            throw new AppError({
              category: "observation",
              code: "BASE_FINAL_UNVERIFIED",
              message: "完成物の全箇所を確認できません。",
              retryable: true,
              failedAt: "final_verify",
            });
        }
        state = await this.minecraft.observe();
        safeOrStop(state, plan.dimension);
        return {
          verifiedBlocks: verified.size,
          totalBlocks: plan.blocks.length,
          observedAt: state.observedAt,
        };
      } catch (error) {
        if (
          plan !== undefined &&
          origin !== undefined &&
          error instanceof AppError &&
          [
            "resource",
            "inventory",
            "safety",
            "connection",
            "observation",
            "path",
          ].includes(error.detail.category) &&
          !signal.aborted
        ) {
          await context.advance("waiting", checkpoint(plan, origin, verified));
          await this.tasks.suspend(error.detail.message);
          return {
            verifiedBlocks: verified.size,
            totalBlocks: plan.blocks.length,
            observedAt: new Date().toISOString(),
          };
        }
        throw error;
      } finally {
        lease.release();
      }
    });
  }

  private async selectSite(
    start: WorldSnapshot,
    worldId: string,
    signal: AbortSignal,
  ): Promise<BaseBuildPlan | undefined> {
    for (const center of buildSiteCandidates(start)) {
      throwIfAborted(signal, "base_site_selection");
      if (!siteClearOfPlayers(start, center)) continue;
      if (
        this.excludedPositions().some(
          (position) => distance(position, center) <= 4,
        )
      )
        continue;
      try {
        await this.moveToConfirmedSite(center, worldId, signal);
      } catch (error) {
        if (error instanceof AppError && error.detail.category === "path")
          continue;
        throw error;
      }
      const state = await this.minecraft.observe();
      safeOrStop(state, start.dimension);
      if (!siteClearOfPlayers(state, center)) continue;
      const plan = buildPlan(center, state.dimension, start.position, worldId);
      try {
        await this.verifySite(plan, new Set(), signal);
        return plan;
      } catch (error) {
        if (
          error instanceof AppError &&
          error.detail.code === "BASE_SITE_BLOCKED"
        )
          continue;
        throw error;
      }
    }
    return undefined;
  }

  private async moveToConfirmedSite(
    center: Position,
    worldId: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.minecraft.moveTo(center, 0.5, signal);
    const proof = await this.minecraft.storageIdentity(null, false, signal);
    if (
      proof.worldId !== worldId ||
      proof.position === undefined ||
      distance(proof.position, center) > 1.75
    ) {
      throw new AppError({
        category: "path",
        code: "BASE_SITE_SERVER_POSITION_UNCONFIRMED",
        message: "サーバー側で建築地点への到達を確認できません。",
        retryable: true,
        failedAt: "site_selection",
      });
    }
  }

  private async verifySite(
    plan: BaseBuildPlan,
    verified: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<Set<string>> {
    const confirmed = new Set<string>();
    const blocked = (): never => {
      throw new AppError({
        category: "safety",
        code: "BASE_SITE_BLOCKED",
        message:
          "建築候補地に保護対象、既存ブロック、または未確認箇所があります。",
        retryable: true,
        failedAt: "site_selection",
      });
    };
    for (let x = plan.center.x - 1; x <= plan.center.x + 1; x += 1) {
      for (let z = plan.center.z - 1; z <= plan.center.z + 1; z += 1) {
        const ground = await this.minecraft.inspectBuildBlock(
          { x, y: plan.center.y - 1, z },
          plan.material,
          signal,
        );
        if (!groundSuitable(ground)) blocked();
      }
    }
    // Leave a one-block clear buffer so the hut does not join an observed structure.
    for (let y = plan.center.y; y <= plan.center.y + 1; y += 1) {
      for (let x = plan.center.x - 2; x <= plan.center.x + 2; x += 1) {
        for (let z = plan.center.z - 2; z <= plan.center.z + 2; z += 1) {
          if (
            Math.abs(x - plan.center.x) < 2 &&
            Math.abs(z - plan.center.z) < 2
          )
            continue;
          const edge = await this.minecraft.inspectBuildBlock(
            { x, y, z },
            plan.material,
            signal,
          );
          if (placementState(edge, plan.material, false) !== "empty") blocked();
        }
      }
    }
    const planned = new Set(plan.blocks.map(buildBlockKey));
    for (let y = plan.center.y; y <= plan.center.y + 2; y += 1) {
      for (let x = plan.center.x - 1; x <= plan.center.x + 1; x += 1) {
        for (let z = plan.center.z - 1; z <= plan.center.z + 1; z += 1) {
          const target = { x, y, z };
          const key = buildBlockKey(target);
          if (y === plan.center.y + 2 && !planned.has(key)) continue;
          const observed = await this.minecraft.inspectBuildBlock(
            target,
            plan.material,
            signal,
          );
          const state = placementState(
            observed,
            plan.material,
            verified.has(key),
          );
          if (planned.has(key) ? state === "blocked" : state !== "empty")
            blocked();
          if (planned.has(key) && state === "verified") confirmed.add(key);
        }
      }
    }
    return confirmed;
  }
}
