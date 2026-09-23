import { DeliverLogsSkill } from "../skills/deliver-logs.js";
import type {
  SafeActionCandidate,
  SafeActionObservationRequest,
} from "../decision/safe-action-planner.js";
import type { DepositResult } from "../minecraft/port.js";
import { recommendArmor } from "../decision/armor-equipment.js";
import type { ArmorSlot } from "../domain/snapshot.js";
import {
  closestHostileDistance,
  decideHostileResponse,
  type HostileGoal,
} from "../decision/hostile-response.js";
import { DeliveryController } from "./delivery-controller.js";
import type { Logger } from "pino";

import {
  AppError,
  type ErrorCategory as DomainErrorCategory,
} from "../domain/errors.js";
import {
  countInventory,
  distance,
  type WorldSnapshot,
} from "../domain/snapshot.js";
import type { TaskRecord } from "../domain/task.js";
import type { MinecraftPort } from "../minecraft/port.js";
import type {
  CollectItemInput,
  CraftItemInput,
  GeneralActionCandidate,
  GeneralActionObservationInput,
  MineBlockInput,
  PlaceBlockInput,
  SmeltItemInput,
} from "../minecraft/general-actions.js";
import {
  knownBlockDrops,
  knownSmeltInputs,
} from "../minecraft/general-actions.js";
import type { MemoryStore } from "../memory/store.js";
import type { TaskRunRecord } from "../memory/types.js";
import {
  actionPriorities,
  type ActionArbiter,
} from "../runtime/action-arbiter.js";
import type { TaskRuntime } from "../runtime/task-service.js";
import type { FollowPlayerSkill } from "../skills/follow-player.js";
import type { GatherLogsSkill } from "../skills/gather-logs/gather-logs-skill.js";
import { createSearchFrontier } from "../skills/gather-logs/search-strategy.js";
import {
  gatherableLogs,
  type GatherableLog,
} from "../skills/gather-logs/resource-catalog.js";
import type { MoveToSkill } from "../skills/move-to.js";
import type { ReturnToPlayerSkill } from "../skills/return-to-player.js";
import { BaseBuildSkill } from "../skills/base-build-skill.js";
import type {
  ActionReport,
  ErrorCategory,
  GameController,
  GameStatus,
  Position,
  SafeResourceCandidate,
  SafeResourceSearchResult,
  SafeActionSearchResult,
  Surroundings,
} from "../tools/contracts.js";

interface CompanionGameControllerInput {
  readonly minecraft: MinecraftPort;
  readonly tasks: TaskRuntime;
  readonly arbiter: ActionArbiter;
  readonly followPlayer: FollowPlayerSkill;
  readonly moveTo: MoveToSkill;
  readonly gatherLogs: GatherLogsSkill;
  readonly returnToPlayer: ReturnToPlayerSkill;
  readonly ownerUsername: string;
  readonly playerId?: string;
  readonly taskTimeoutMs: number;
  readonly hungerThreshold?: number;
  readonly retryLimit: number;
  readonly maxMoveDistance?: number;
  readonly logger: Logger;
  readonly memory: MemoryStore;
}

const terminalTaskStatuses = new Set(["completed", "failed", "cancelled"]);

const resourceLabels: Readonly<Record<string, string>> = {
  oak_log: "オークの原木",
  spruce_log: "トウヒの原木",
  birch_log: "シラカバの原木",
  jungle_log: "ジャングルの原木",
  acacia_log: "アカシアの原木",
  dark_oak_log: "ダークオークの原木",
  mangrove_log: "マングローブの原木",
  cherry_log: "サクラの原木",
  pale_oak_log: "ペールオークの原木",
  crimson_stem: "真紅の幹",
  warped_stem: "歪んだ幹",
};

const resourceCollectionIntent =
  /(集め|集める|集めて|採取|採掘|掘る|掘って|切る|切って|伐採|持ってき|取ってき|collect|gather|mine|obtain|fetch|harvest)/iu;

function isResourceCollectionGoal(goal: string): boolean {
  const normalized = goal.trim().toLocaleLowerCase("ja-JP");
  if (normalized === "collect_resource") return true;
  if (!resourceCollectionIntent.test(normalized)) return false;
  if (
    /木を(?:少し|ちょっと)?\s*(?:(?:[0-9]{1,3}|一)\s*本)?\s*(?:切|伐採|倒)/u.test(
      normalized,
    )
  ) {
    return true;
  }
  return Object.entries(resourceLabels).some(([resource, label]) => {
    const canonical = resource.replaceAll("_", " ");
    return (
      normalized.includes(resource) ||
      normalized.includes(canonical) ||
      normalized.includes(label.toLocaleLowerCase("ja-JP"))
    );
  });
}

interface TaskStateForSummary {
  readonly kind: string;
  readonly status: TaskRecord["status"];
  readonly phase: string;
  readonly updatedAt: string;
  readonly failureCategory?: string;
  readonly failureCode?: string;
  readonly checkpoint?: Readonly<Record<string, unknown>>;
  readonly persistedWithoutRuntime?: boolean;
}

export class CompanionGameController implements GameController {
  public readonly delivery: DeliveryController;
  readonly #deliverySkill: DeliverLogsSkill;
  readonly #baseBuildSkill: BaseBuildSkill;
  readonly #minecraft: MinecraftPort;
  readonly #tasks: TaskRuntime;
  readonly #arbiter: ActionArbiter;
  readonly #followPlayer: FollowPlayerSkill;
  readonly #moveTo: MoveToSkill;
  readonly #gatherLogs: GatherLogsSkill;
  readonly #returnToPlayer: ReturnToPlayerSkill;
  readonly #ownerUsername: string;
  readonly #playerId: string | undefined;
  readonly #taskTimeoutMs: number;
  readonly #hungerThreshold: number;
  readonly #retryLimit: number;
  readonly #maxMoveDistance: number;
  readonly #logger: Logger;
  readonly #memory: MemoryStore;

  public constructor(input: CompanionGameControllerInput) {
    this.delivery = new DeliveryController(
      input.minecraft,
      input.memory,
      input.ownerUsername,
      input.arbiter,
      (resource, count, gather, signal) =>
        this.#deliverLogs(resource, count, gather, signal),
    );
    this.#deliverySkill = new DeliverLogsSkill(
      input.minecraft,
      input.tasks,
      input.arbiter,
      input.gatherLogs,
      input.maxMoveDistance ?? 128,
    );
    this.#baseBuildSkill = new BaseBuildSkill(
      input.minecraft,
      input.tasks,
      input.arbiter,
      input.gatherLogs,
      input.ownerUsername,
      () => this.delivery.list().map((target) => target.position),
    );
    this.#minecraft = input.minecraft;
    this.#tasks = input.tasks;
    this.#arbiter = input.arbiter;
    this.#followPlayer = input.followPlayer;
    this.#moveTo = input.moveTo;
    this.#gatherLogs = input.gatherLogs;
    this.#returnToPlayer = input.returnToPlayer;
    this.#ownerUsername = input.ownerUsername;
    this.#playerId = input.playerId;
    this.#taskTimeoutMs = input.taskTimeoutMs;
    this.#hungerThreshold = input.hungerThreshold ?? 14;
    this.#retryLimit = input.retryLimit;
    this.#maxMoveDistance = input.maxMoveDistance ?? 128;
    this.#logger = input.logger;
    this.#memory = input.memory;
  }

  public async observeStatus(): Promise<GameStatus> {
    return this.#statusFromSnapshot(await this.#minecraft.observe());
  }

  public async observeSurroundings(
    radius: number,
    includeEntities: boolean,
  ): Promise<Surroundings> {
    const observed = await this.#minecraft.observeSurroundings(
      radius,
      includeEntities,
    );
    return {
      observedAt: observed.observedAt,
      subject: observed.subject,
      source: observed.source,
      requesterVitals: "unobserved",
      oxygen: observed.oxygen,
      oxygenState: observed.oxygenState,
      inWater: observed.inWater,
      blocks: observed.blocks.map(({ name, distance }) => ({ name, distance })),
      entities: observed.entities.map(({ kind, distance }) => ({
        kind,
        distance,
      })),
      hazards: observed.hazards,
    };
  }

  public async findSafeResourceCandidates(
    maxDistance: number,
    count: number,
    signal: AbortSignal,
    allowedNames?: readonly string[],
  ): Promise<readonly SafeResourceCandidate[]> {
    if (!Number.isFinite(maxDistance) || maxDistance < 1) {
      throw new AppError({
        category: "validation",
        code: "INVALID_RESOURCE_OBSERVATION_DISTANCE",
        message: "Resource observation distance must be positive",
        retryable: false,
      });
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new AppError({
        category: "validation",
        code: "INVALID_RESOURCE_OBSERVATION_COUNT",
        message: "Resource observation count must be positive",
        retryable: false,
      });
    }
    const names =
      allowedNames === undefined
        ? [...gatherableLogs]
        : allowedNames.filter(isGatherableLog);
    if (names.length === 0) return [];
    const allowedNameSet = new Set<string>(names);
    const current = await this.#minecraft.observe();
    const targets = await this.#minecraft.findResources(
      names,
      Math.min(maxDistance, this.#maxMoveDistance),
      count,
      signal,
    );
    return targets
      .filter((target) => allowedNameSet.has(target.name))
      .map((target) => ({
        resource: target.name,
        distance: Math.hypot(
          target.position.x - current.position.x,
          target.position.y - current.position.y,
          target.position.z - current.position.z,
        ),
      }))
      .filter(({ distance }) => Number.isFinite(distance))
      .sort((left, right) => left.distance - right.distance);
  }

  public async searchSafeResourceCandidates(
    maxDistance: number,
    count: number,
    signal: AbortSignal,
    allowedNames?: readonly string[],
  ): Promise<SafeResourceSearchResult> {
    const searchDistance = Math.min(maxDistance, this.#maxMoveDistance, 32);
    const initial = await this.findSafeResourceCandidates(
      Math.min(32, searchDistance),
      count,
      signal,
      allowedNames,
    );
    if (initial.length > 0) {
      return {
        candidates: initial,
        attemptedWaypoints: 0,
        blockedWaypoints: 0,
      };
    }
    const origin = await this.#minecraft.observe();
    const frontier = createSearchFrontier(
      origin.position,
      Math.min(16, searchDistance),
      searchDistance,
    ).slice(0, 4);
    let attemptedWaypoints = 0;
    let blockedWaypoints = 0;
    let moved = false;
    for (const point of frontier) {
      signal.throwIfAborted();
      const beforeMove = await this.#minecraft.observe();
      const danger = observedCurrentDanger(beforeMove, this.#hungerThreshold);
      if (!beforeMove.connected || !beforeMove.spawned || danger !== null) {
        return {
          candidates: [],
          attemptedWaypoints,
          blockedWaypoints,
          stop: {
            code: "SAFE_RESOURCE_SEARCH_UNSAFE",
            reason: danger ?? "Minecraftへの接続と現在位置を確認できません。",
          },
        };
      }
      attemptedWaypoints += 1;
      const movement = await this.moveTo(point, 3, signal);
      if (movement.outcome !== "completed") {
        if (movement.failureCategory === "path") {
          blockedWaypoints += 1;
          continue;
        }
        return {
          candidates: [],
          attemptedWaypoints,
          blockedWaypoints,
          stop: {
            code: movement.failureCode ?? "SAFE_RESOURCE_SEARCH_STOPPED",
            reason: movement.summary,
          },
        };
      }
      moved = true;
      const candidates = await this.findSafeResourceCandidates(
        Math.min(32, searchDistance),
        count,
        signal,
        allowedNames,
      );
      if (candidates.length > 0) {
        return { candidates, attemptedWaypoints, blockedWaypoints };
      }
    }
    if (moved && !signal.aborted) {
      const returnMove = await this.moveTo(origin.position, 3, signal);
      if (returnMove.outcome !== "completed") {
        return {
          candidates: [],
          attemptedWaypoints,
          blockedWaypoints,
          stop: {
            code:
              returnMove.failureCode ?? "SAFE_RESOURCE_SEARCH_RETURN_FAILED",
            reason:
              "候補がなく、探索前の位置へ戻る移動も完了できませんでした。",
          },
        };
      }
    }
    return { candidates: [], attemptedWaypoints, blockedWaypoints };
  }

  public async findSafeActionCandidates(
    request: SafeActionObservationRequest,
    signal: AbortSignal,
  ): Promise<readonly SafeActionCandidate[]> {
    if (request.goal.trim().length === 0) {
      throw new AppError({
        category: "validation",
        code: "EMPTY_SAFE_ACTION_GOAL",
        message: "Safe action goal must not be empty",
        retryable: false,
      });
    }
    if (!Number.isInteger(request.count) || request.count < 1) {
      throw new AppError({
        category: "validation",
        code: "INVALID_SAFE_ACTION_COUNT",
        message: "Safe action count must be positive",
        retryable: false,
      });
    }
    if (!Number.isInteger(request.maxCandidates) || request.maxCandidates < 1) {
      throw new AppError({
        category: "validation",
        code: "INVALID_SAFE_ACTION_CANDIDATE_LIMIT",
        message: "Safe action candidate limit must be positive",
        retryable: false,
      });
    }
    const authorization = request.authorization;
    if (
      authorization?.kind === "owner_bounded_resource" &&
      authorization.targetItem !== "*" &&
      !isGatherableLog(authorization.targetItem)
    ) {
      const targetItem = authorization.targetItem;
      const intermediateItem = knownSmeltInputs[targetItem];
      const current = await this.#minecraft.observe();
      const readyToSmelt =
        intermediateItem !== undefined &&
        countInventory(current, intermediateItem) >= request.count;
      const craftFromInventory =
        authorization.allowedResources.includes(targetItem) &&
        intermediateItem === undefined &&
        knownBlockDrops[targetItem] === undefined;
      const candidates = await this.observeActionCandidates(
        {
          radius: Math.min(craftFromInventory ? 8 : 32, this.#maxMoveDistance),
          requestedItems: [targetItem],
          maxCandidates: Math.min(16, request.maxCandidates),
        },
        signal,
      );
      return candidates
        .filter(
          (candidate) =>
            candidate.goalItem === targetItem &&
            candidate.purposeFit === "direct" &&
            candidate.action ===
              (readyToSmelt
                ? "smelt_item"
                : craftFromInventory
                  ? "craft_item"
                  : "mine_block"),
        )
        .map((candidate) =>
          candidate.action !== "smelt_item"
            ? candidate
            : {
                ...candidate,
                requestedCount: request.count,
                args: { ...candidate.args, count: request.count },
                steps: candidate.steps.map((step) => ({
                  ...step,
                  input: { ...step.input, count: request.count },
                })),
              },
        )
        .slice(0, request.maxCandidates);
    }
    if (!isResourceCollectionGoal(request.goal)) return [];

    const allowedLogNames =
      authorization?.kind === "owner_bounded_resource"
        ? authorization.allowedResources.filter(isGatherableLog)
        : undefined;
    const resources = await this.findSafeResourceCandidates(
      Math.min(32, this.#maxMoveDistance),
      Math.min(8, request.maxCandidates),
      signal,
      allowedLogNames,
    );
    const nearestByResource = new Map<string, SafeResourceCandidate>();
    for (const resource of resources) {
      const previous = nearestByResource.get(resource.resource);
      if (previous === undefined || resource.distance < previous.distance) {
        nearestByResource.set(resource.resource, resource);
      }
    }
    return [...nearestByResource.values()]
      .sort((left, right) => left.distance - right.distance)
      .slice(0, request.maxCandidates)
      .map((resource, index) => ({
        id: `gather_resource:${resource.resource}`,
        label: resourceLabels[resource.resource] ?? "観測した原木",
        action: "gather_resource",
        observed: true,
        purposeFit: "direct",
        permission: "allowed",
        safety: "allowed",
        reversible: false,
        impact: "medium",
        operationClass: "natural_resource",
        requestedCount: request.count,
        resourceName: resource.resource,
        goalItem: resource.resource,
        distance: resource.distance,
        order: index,
        steps: [
          {
            tool: "gather_resource",
            input: {
              resource: resource.resource,
              count: request.count,
              commitmentId: null,
            },
          },
        ],
      }));
  }

  public async searchSafeActionCandidates(
    request: SafeActionObservationRequest,
    signal: AbortSignal,
  ): Promise<SafeActionSearchResult> {
    const authorization = request.authorization;
    if (
      authorization?.kind !== "owner_bounded_resource" ||
      authorization.targetItem === "*" ||
      isGatherableLog(authorization.targetItem)
    ) {
      return { candidates: [], attemptedWaypoints: 0, blockedWaypoints: 0 };
    }
    const origin = await this.#minecraft.observe();
    const searchDistance = Math.min(32, this.#maxMoveDistance);
    const readyInput = knownSmeltInputs[authorization.targetItem];
    if (
      readyInput === undefined &&
      authorization.allowedResources.includes(authorization.targetItem) &&
      knownBlockDrops[authorization.targetItem] === undefined
    ) {
      return {
        candidates: [],
        attemptedWaypoints: 0,
        blockedWaypoints: 0,
        stop: {
          code: "CRAFT_MATERIALS_NOT_OBSERVED",
          reason: "所持品から目的の品を作れるレシピや素材を確認できません。",
        },
      };
    }
    if (
      readyInput !== undefined &&
      countInventory(origin, readyInput) >= request.count
    ) {
      return {
        candidates: [],
        attemptedWaypoints: 0,
        blockedWaypoints: 0,
        stop: {
          code: "SMELT_STATION_NOT_OBSERVED",
          reason:
            "原料は揃っていますが、安全に使える精錬設備を観測できません。",
        },
      };
    }
    const initial = await this.findSafeActionCandidates(request, signal);
    if (initial.some((candidate) => candidate.safety === "allowed")) {
      return {
        candidates: initial,
        attemptedWaypoints: 0,
        blockedWaypoints: 0,
      };
    }
    const observed = await this.observeActionCandidates(
      {
        radius: searchDistance,
        requestedItems: [authorization.targetItem],
        maxCandidates: 16,
      },
      signal,
    );
    const allowedResources = new Set(authorization.allowedResources);
    const queued = observed
      .filter(
        (candidate) =>
          candidate.action === "mine_block" &&
          candidate.goalItem === authorization.targetItem &&
          candidate.resourceName !== undefined &&
          allowedResources.has(candidate.resourceName) &&
          candidate.permission === "unknown" &&
          candidate.distance > 6,
      )
      .map(candidateBlockPosition)
      .filter(
        (position): position is { x: number; y: number; z: number } =>
          position !== undefined,
      );
    queued.push(
      ...createSearchFrontier(
        origin.position,
        Math.min(16, searchDistance),
        searchDistance,
      ).slice(0, 4),
    );
    const seen = new Set<string>();
    let attemptedWaypoints = 0;
    let blockedWaypoints = 0;
    let moved = false;
    while (queued.length > 0 && attemptedWaypoints < 4) {
      signal.throwIfAborted();
      const point = queued.shift();
      if (point === undefined) break;
      if (distance(origin.position, point) > searchDistance) continue;
      const beforeMove = await this.#minecraft.observe();
      const waypoint = boundedApproachPoint(beforeMove.position, point, 8);
      const key = `${waypoint.x}:${waypoint.y}:${waypoint.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const danger = observedCurrentDanger(beforeMove, this.#hungerThreshold);
      if (!beforeMove.connected || !beforeMove.spawned || danger !== null) {
        return {
          candidates: [],
          attemptedWaypoints,
          blockedWaypoints,
          stop: {
            code: "SAFE_ACTION_SEARCH_UNSAFE",
            reason: danger ?? "Minecraftへの接続と現在位置を確認できません。",
          },
        };
      }
      attemptedWaypoints += 1;
      const movement = await this.moveTo(waypoint, 3, signal);
      if (movement.outcome !== "completed") {
        if (movement.failureCategory === "path") {
          blockedWaypoints += 1;
          continue;
        }
        return {
          candidates: [],
          attemptedWaypoints,
          blockedWaypoints,
          stop: {
            code: movement.failureCode ?? "SAFE_ACTION_SEARCH_STOPPED",
            reason: movement.summary,
          },
        };
      }
      moved = true;
      const candidates = await this.findSafeActionCandidates(request, signal);
      if (candidates.some((candidate) => candidate.safety === "allowed")) {
        return { candidates, attemptedWaypoints, blockedWaypoints };
      }
      const newlyObserved = await this.observeActionCandidates(
        {
          radius: searchDistance,
          requestedItems: [authorization.targetItem],
          maxCandidates: 16,
        },
        signal,
      );
      for (const candidate of newlyObserved) {
        if (
          candidate.action !== "mine_block" ||
          candidate.goalItem !== authorization.targetItem ||
          candidate.resourceName === undefined ||
          !allowedResources.has(candidate.resourceName) ||
          candidate.permission !== "unknown" ||
          candidate.distance <= 6
        )
          continue;
        const position = candidateBlockPosition(candidate);
        if (position !== undefined) queued.unshift(position);
      }
    }
    if (moved && !signal.aborted) {
      const returnMove = await this.moveTo(origin.position, 3, signal);
      if (returnMove.outcome !== "completed") {
        return {
          candidates: [],
          attemptedWaypoints,
          blockedWaypoints,
          stop: {
            code: returnMove.failureCode ?? "SAFE_ACTION_SEARCH_RETURN_FAILED",
            reason: "安全な候補がなく、探索前の位置へ戻れませんでした。",
          },
        };
      }
    }
    return { candidates: [], attemptedWaypoints, blockedWaypoints };
  }

  public async observeActionCandidates(
    input: GeneralActionObservationInput,
    signal: AbortSignal,
  ): Promise<readonly GeneralActionCandidate[]> {
    if (signal.aborted) throw signal.reason;
    return this.#minecraft.observeActionCandidates(input, signal);
  }

  public async say(message: string): Promise<void> {
    const normalized = message.trim().replace(/\s+/gu, " ");
    if (normalized.length === 0) {
      throw new AppError({
        category: "validation",
        code: "EMPTY_CHAT_MESSAGE",
        message: "A chat message cannot be empty",
        retryable: false,
      });
    }
    for (const chunk of splitMinecraftChat(normalized)) {
      await this.#minecraft.say(chunk);
    }
  }

  public async followOwner(
    safeDistance: number,
    maxDurationSeconds: number,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    return this.#executeTask(
      signal,
      () =>
        this.#followPlayer.run({
          username: this.#ownerUsername,
          range: safeDistance,
          maxDurationMs: maxDurationSeconds * 1_000,
          maxPathAttempts: this.#retryLimit + 1,
        }),
      (_output, after) => {
        const owner = after?.players.find(
          ({ username }) => username === this.#ownerUsername,
        );
        if (owner === undefined || owner.distance > safeDistance + 1) {
          return {
            outcome: "failed",
            failureCategory: "observation",
            failureCode: "FOLLOW_DISTANCE_NOT_VERIFIED",
            summary:
              "追従終了時に指定利用者との安全距離を確認できませんでした。",
          };
        }
        return {
          outcome: "completed",
          summary: `指定利用者を追従し、終了時の距離${owner.distance.toFixed(1)}ブロックを確認しました。`,
        };
      },
    );
  }

  public async respondToHostiles(
    goal: HostileGoal,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    const initial = await this.#minecraft.observe();
    if (decideHostileResponse(initial).mode === "none") {
      const status = this.#statusFromSnapshot(initial);
      return {
        before: status,
        after: status,
        outcome: "failed",
        failureCategory: "observation",
        failureCode: "HOSTILE_TARGET_NOT_OBSERVED",
        summary:
          "現在の観測範囲に敵対的な相手はいません。攻撃や退避は始めませんでした。",
      };
    }

    const report = await this.#executeTask(
      signal,
      () =>
        this.#runGeneralTask(
          "respond_to_hostiles",
          {
            goal,
            observedHostiles: initial.nearbyEntities.filter((e) => e.hostile)
              .length,
          },
          signal,
          async (actionSignal) => {
            let current = await this.#minecraft.observe();
            const equippedArmor: ArmorSlot[] = [];
            let armorEquipFailed = false;
            const equipWhenSafe = async (snapshot: WorldSnapshot) => {
              const hostileDistance = closestHostileDistance(snapshot);
              if (
                (hostileDistance !== null && hostileDistance < 6) ||
                snapshot.onFire ||
                snapshot.inLava ||
                snapshot.inWater ||
                snapshot.suffocating ||
                recommendArmor(snapshot).length === 0
              ) {
                return;
              }
              const result =
                await this.#minecraft.equipAvailableArmor(actionSignal);
              equippedArmor.push(...result.equipped);
              armorEquipFailed ||= result.failed;
            };
            await equipWhenSafe(current);
            if (equippedArmor.length > 0)
              current = await this.#minecraft.observe();
            const choice =
              goal === "evade"
                ? closestHostileDistance(current) === null
                  ? ({ mode: "none" } as const)
                  : ({
                      mode: "retreat",
                      reason: "退避を指示されたため",
                    } as const)
                : decideHostileResponse(current);
            if (choice.mode === "none")
              return { mode: "none" as const, equippedArmor };
            let attackedEntityId: number | undefined;
            let reason = choice.mode === "retreat" ? choice.reason : "";
            if (choice.mode === "attack") {
              attackedEntityId = choice.entityId;
              try {
                if (
                  await this.#minecraft.attackHostile(
                    choice.entityId,
                    actionSignal,
                  )
                ) {
                  return {
                    mode: "attack" as const,
                    entityId: choice.entityId,
                    equippedArmor,
                  };
                }
                reason = "攻撃しましたが撃破を確認できないため";
              } catch (error) {
                if (actionSignal.aborted) throw error;
                if (
                  !(error instanceof AppError) ||
                  error.detail.category !== "safety"
                ) {
                  throw error;
                }
                reason = "攻撃条件が変わったため";
              }
            }
            const distanceBefore = closestHostileDistance(current);
            try {
              await this.#minecraft.retreatFromHostiles(actionSignal);
            } catch (error) {
              if (
                actionSignal.aborted ||
                !(error instanceof AppError) ||
                error.detail.category !== "path"
              ) {
                throw error;
              }
              await this.#minecraft.recoverFromStuck(2, actionSignal);
              await this.#minecraft.retreatFromHostiles(actionSignal);
            }
            const first = await this.#minecraft.observe();
            if (
              distance(current.position, first.position) < 1.5 &&
              closestHostileDistance(first) !== null
            ) {
              await this.#minecraft.recoverFromStuck(2, actionSignal);
              await this.#minecraft.retreatFromHostiles(actionSignal);
            }
            await equipWhenSafe(await this.#minecraft.observe());
            return {
              mode: "retreat" as const,
              reason,
              distanceBefore,
              equippedArmor,
              armorEquipFailed,
              ...(attackedEntityId === undefined ? {} : { attackedEntityId }),
            };
          },
        ),
      (result, after) => {
        const armorSummary =
          result.equippedArmor.length > 0
            ? `所持防具を${result.equippedArmor.length}箇所装着し、`
            : result.mode === "retreat" && result.armorEquipFailed
              ? "防具の装着を確認できず、"
              : "";
        if (result.mode === "none") {
          return {
            outcome: "failed",
            failureCategory: "observation",
            failureCode: "HOSTILE_TARGET_CHANGED",
            summary: `${armorSummary}対象が観測範囲からいなくなったため、攻撃や退避は始めませんでした。`,
          };
        }
        if (result.mode === "attack") {
          // attackHostile returns true only after Mineflayer's entityDead event.
          // A dead entity can remain visible during its death animation.
          return {
            outcome: "completed",
            evidenceKind: "minecraft_snapshot",
            summary: `${armorSummary}敵対的な相手1体の死亡を確認しました。周囲の危険は引き続き観測が必要です。`,
          };
        }
        const moved =
          after === null ? 0 : distance(initial.position, after.position);
        const distanceAfter =
          after === null ? null : closestHostileDistance(after);
        const safer =
          moved >= 1.5 &&
          (distanceAfter === null ||
            (result.distanceBefore !== null &&
              distanceAfter >= result.distanceBefore + 1));
        return safer
          ? {
              outcome: goal === "evade" ? "completed" : "failed",
              ...(goal === "evade"
                ? {}
                : {
                    failureCategory: "safety" as const,
                    failureCode: "HOSTILE_ELIMINATION_NOT_CONFIRMED",
                  }),
              evidenceKind: "minecraft_snapshot",
              summary: `${armorSummary}${result.reason}攻撃は続けず、実際に${moved.toFixed(1)}ブロック移動して距離を取りました。敵の撃破は未確認です。`,
            }
          : {
              outcome: "failed",
              failureCategory: "safety",
              failureCode: "HOSTILE_RETREAT_NOT_VERIFIED",
              summary: `${armorSummary}退避を試みましたが、敵との距離が広がったことを確認できませんでした。撃破や安全確保は未確認です。`,
            };
      },
      initial,
      true,
    );
    return report.failureCategory === "path"
      ? {
          ...report,
          summary:
            "安全な退避経路を見つけられず、敵との距離を広げられたか確認できません。撃破や安全確保は未確認です。",
        }
      : report;
  }

  public async stopCurrentAction(reason: string): Promise<ActionReport> {
    const before = await this.#tryObserveStatus();
    const hadActiveTask =
      this.#tasks.current !== undefined &&
      !terminalTaskStatuses.has(this.#tasks.current.status);
    this.#arbiter.stop(reason);
    await this.#tasks.cancel(reason);
    await this.#minecraft.stopCurrentAction();
    const after = await this.#tryObserveStatus();
    return {
      before,
      after,
      outcome: "completed",
      evidenceKind: "task_state",
      summary: hadActiveTask
        ? after === null
          ? "進行中のMinecraft作業を停止しました。Minecraftとの接続状態は確認できませんでした。"
          : "進行中のMinecraft作業を停止しました。"
        : after === null
          ? "操作入力の停止を指示しました。Minecraftとの接続状態は確認できませんでした。"
          : "実行中のMinecraft作業はありません。操作入力を停止しました。",
    };
  }

  public async moveTo(
    destination: Omit<Position, "dimension">,
    radius: number,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    const current = await this.#minecraft.observe();
    return this.#executeTask(
      signal,
      () =>
        this.#moveTo.run({
          position: destination,
          range: radius,
          timeoutMs: this.#taskTimeoutMs,
        }),
      (output) => ({
        outcome: "completed",
        summary: `目的地へ移動し、座標${formatCoordinates(output.position)}への到達を観測しました。`,
      }),
      current,
    );
  }

  public async gatherResource(
    resource: string,
    count: number,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    if (!isGatherableLog(resource)) {
      throw new AppError({
        category: "validation",
        code: "UNSUPPORTED_GATHER_RESOURCE",
        message: "The requested resource is not in the supported log catalog",
        retryable: false,
      });
    }
    const report = await this.#executeTask(
      signal,
      () =>
        this.#gatherLogs.run({
          resource,
          count,
          requester: this.#ownerUsername,
        }),
      (output) => ({
        outcome: "completed",
        evidenceKind: "inventory_delta",
        confirmedState: {
          resource: output.itemName,
          requestedCount: output.requestedCount,
          collectedCount: output.collectedCount,
          heldCount: output.heldCount,
          playerDistance: output.playerDistance,
        },
        summary: `${output.itemName}を新たに${String(output.collectedCount)}個収集し、所持数${String(output.heldCount)}個と依頼者への帰還を観測しました。`,
      }),
    );
    if (
      report.outcome !== "completed" &&
      (report.failureCode?.startsWith("TREE_") ||
        report.failureCode === "RESOURCE_NOT_FOUND")
    ) {
      const held =
        report.after === null
          ? undefined
          : (report.after.inventory[resource] ?? 0);
      const before =
        report.before === null
          ? undefined
          : (report.before.inventory[resource] ?? 0);
      const acquired =
        held === undefined || before === undefined
          ? undefined
          : Math.max(0, held - before);
      return {
        ...report,
        nextActions: [
          "建築保護の補助が有効か確認し、その稼働中に建築から離れた苗木を育ててください。",
        ],
        summary: `安全に採取できる原木を確認できず、収集を停止しました。${acquired === undefined ? "取得数は未確認です。" : `今回の取得は${String(acquired)}個、現在の所持数は${String(held)}個です。`}履歴不足・建築保護・照会失敗の対象は採取しません。`,
      };
    }
    if (
      report.outcome !== "completed" &&
      report.failureCode === "RESOURCE_PATHS_BLOCKED"
    ) {
      const held =
        report.after?.inventory[resource] ?? (report.after ? 0 : undefined);
      const before =
        report.before?.inventory[resource] ?? (report.before ? 0 : undefined);
      const acquired =
        held === undefined || before === undefined
          ? undefined
          : Math.max(0, held - before);
      return {
        ...report,
        confirmedState: {
          ...report.confirmedState,
          collectedCount: acquired ?? null,
          heldCount: held ?? null,
        },
        nextActions: ["安全に到達できる別の木や経路がある場所で再依頼する"],
        summary: `保護条件を満たす木を探しましたが、試した経路では安全に近づけず、採取を停止しました。${acquired === undefined ? "取得数は未確認です。" : `今回の取得は${String(acquired)}個です。`}`,
      };
    }
    if (report.outcome !== "completed") {
      const held =
        report.after?.inventory[resource] ?? (report.after ? 0 : undefined);
      const before =
        report.before?.inventory[resource] ?? (report.before ? 0 : undefined);
      const acquired =
        held === undefined || before === undefined
          ? undefined
          : Math.max(0, held - before);
      return {
        ...report,
        confirmedState: {
          ...report.confirmedState,
          collectedCount: acquired ?? null,
          heldCount: held ?? null,
        },
        summary: `${report.summary}${acquired === undefined ? "取得数は未確認です。" : `今回の取得は${String(acquired)}個、現在の所持数は${String(held)}個です。`}`,
      };
    }
    return report;
  }

  public async mineBlock(
    input: MineBlockInput,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    const current = await this.#minecraft.observe();
    this.#assertActionDistance(
      current,
      input.position,
      "MINING_DISTANCE_EXCEEDED",
    );
    const itemName = knownBlockDrops[input.name];
    if (itemName === undefined) {
      throw new AppError({
        category: "resource",
        code: "UNSUPPORTED_BLOCK_DROP",
        message:
          "The requested block has no verified drop mapping, so mining was not started",
        retryable: false,
        failedAt: "mine_block",
        confirmedState: { block: input.name },
      });
    }
    const baseline = countInventory(current, itemName);
    return this.#executeTask(
      signal,
      () =>
        this.#runGeneralTask(
          "mine_block",
          input,
          signal,
          async (actionSignal) => {
            try {
              await this.#minecraft.moveTo(input.position, 3, actionSignal);
              await this.#minecraft.mineBlock(input, actionSignal);
            } catch (error) {
              if (
                error instanceof AppError &&
                error.detail.category === "path"
              ) {
                throw new AppError(
                  {
                    ...error.detail,
                    code: "MINE_APPROACH_PATH_BLOCKED",
                    confirmedState: { blockMutationStarted: false },
                  },
                  { cause: error },
                );
              }
              throw error;
            }
            await this.#minecraft.collectDropsNear(
              input.position,
              itemName,
              baseline + 1,
              actionSignal,
            );
            return { itemName, baseline };
          },
        ),
      (output, after) => {
        const held =
          after === null ? null : countInventory(after, output.itemName);
        const collected =
          held === null ? null : Math.max(0, held - output.baseline);
        if (held === null || collected === null || collected < 1) {
          return {
            outcome: "failed",
            failureCategory: "inventory",
            failureCode: "MINE_OUTPUT_NOT_VERIFIED",
            summary:
              "採掘は完了したように見えましたが、所持品の増加を確認できませんでした。",
          };
        }
        return {
          outcome: "completed",
          evidenceKind: "inventory_delta",
          confirmedState: {
            block: input.name,
            item: output.itemName,
            requestedCount: 1,
            minedCount: 1,
            collectedCount: collected,
            heldCount: held,
          },
          summary: `${input.name}を採掘し、${output.itemName}を${String(collected)}個増やしたことを所持品で確認しました。`,
        };
      },
      current,
    );
  }

  public async collectItem(
    input: CollectItemInput,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    const current = await this.#minecraft.observe();
    this.#assertActionDistance(
      current,
      input.position,
      "COLLECT_DISTANCE_EXCEEDED",
    );
    const baseline = countInventory(current, input.name);
    return this.#executeTask(
      signal,
      () =>
        this.#runGeneralTask(
          "collect_item",
          input,
          signal,
          async (actionSignal) => {
            await this.#minecraft.collectItem(input, actionSignal);
            return { baseline };
          },
        ),
      (output, after) => {
        const held = after === null ? null : countInventory(after, input.name);
        const collected =
          held === null ? null : Math.max(0, held - output.baseline);
        if (held === null || collected === null || collected < input.count) {
          return {
            outcome: "failed",
            failureCategory: "inventory",
            failureCode: "COLLECT_OUTPUT_NOT_VERIFIED",
            summary: "回収後の所持品増加を確認できませんでした。",
          };
        }
        return {
          outcome: "completed",
          evidenceKind: "inventory_delta",
          confirmedState: {
            item: input.name,
            requestedCount: input.count,
            collectedCount: collected,
            heldCount: held,
          },
          summary: `${input.name}を${String(collected)}個回収し、所持品の増加を確認しました。`,
        };
      },
      current,
    );
  }

  public async craftItem(
    input: CraftItemInput,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    const current = await this.#minecraft.observe();
    const baseline = countInventory(current, input.name);
    return this.#executeTask(
      signal,
      () =>
        this.#runGeneralTask(
          "craft_item",
          input,
          signal,
          async (actionSignal) => ({
            produced: await this.#minecraft.craftItem(input, actionSignal),
          }),
        ),
      (output, after) => {
        const held = after === null ? null : countInventory(after, input.name);
        const produced = held === null ? null : Math.max(0, held - baseline);
        if (held === null || produced === null || produced < input.count) {
          return {
            outcome: "failed",
            failureCategory: "inventory",
            failureCode: "CRAFT_OUTPUT_NOT_VERIFIED",
            summary: "クラフト後の所持品増加を確認できませんでした。",
          };
        }
        return {
          outcome: "completed",
          evidenceKind: "inventory_delta",
          confirmedState: {
            item: input.name,
            requestedCount: input.count,
            craftedCount: produced,
            heldCount: held,
          },
          summary: `${input.name}を${String(produced)}個クラフトし、所持品で確認しました。`,
        };
      },
      current,
    );
  }

  public async placeBlock(
    input: PlaceBlockInput,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    const current = await this.#minecraft.observe();
    this.#assertActionDistance(
      current,
      input.position,
      "PLACE_DISTANCE_EXCEEDED",
    );
    return this.#executeTask(
      signal,
      () =>
        this.#runGeneralTask(
          "place_block",
          input,
          signal,
          async (actionSignal) => {
            await this.#minecraft.placeBlock(input, actionSignal);
            return { position: input.position };
          },
        ),
      () => ({
        outcome: "completed",
        evidenceKind: "minecraft_snapshot",
        confirmedState: {
          block: input.name,
          position: input.position,
          requestedCount: 1,
          placedCount: 1,
        },
        summary: `${input.name}を指定位置へ設置し、ゲーム内のブロック状態を確認しました。`,
      }),
      current,
    );
  }

  public async buildBase(
    signal: AbortSignal,
    resume: boolean,
  ): Promise<ActionReport> {
    const previous =
      this.#playerId === undefined || !resume
        ? undefined
        : this.#memory
            .listRecentTaskRuns(this.#playerId, 12)
            .find(
              (task) =>
                task.kind === "build_base" &&
                task.status !== "completed" &&
                task.checkpoint?.data.center !== undefined,
            );
    const report = await this.#executeTask(
      signal,
      () => this.#baseBuildSkill.run(previous),
      (output) => ({
        outcome: "completed",
        evidenceKind: "minecraft_snapshot",
        confirmedState: {
          verifiedBlocks: output.verifiedBlocks,
          totalBlocks: output.totalBlocks,
        },
        summary: `小規模拠点を完成させ、${String(output.totalBlocks)}か所すべてのブロックをゲーム内で確認しました。`,
      }),
    );
    if (report.outcome === "completed") return report;
    const task = this.#tasks.current;
    const verified =
      task?.kind === "build_base" && Array.isArray(task.checkpoint?.verified)
        ? task.checkpoint.verified.length
        : 0;
    const reason =
      task?.kind === "build_base" &&
      typeof task.checkpoint?.suspendReason === "string"
        ? task.checkpoint.suspendReason
        : undefined;
    return {
      ...report,
      confirmedState: { verifiedBlocks: verified, totalBlocks: 23 },
      nextActions: ["安全状態と資材を確認した後、拠点設営の再開を依頼する"],
      summary: `拠点は途中です。確認済み${String(verified)}/23か所。${reason ?? report.summary} 安全状態と資材を再確認して続きから再開できます。`,
    };
  }

  public async smeltItem(
    input: SmeltItemInput,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    const current = await this.#minecraft.observe();
    if (input.furnace !== null && input.furnace !== undefined) {
      this.#assertActionDistance(
        current,
        input.furnace,
        "SMELT_DISTANCE_EXCEEDED",
      );
    }
    const baseline = countInventory(current, input.output);
    return this.#executeTask(
      signal,
      () =>
        this.#runGeneralTask(
          "smelt_item",
          input,
          signal,
          async (actionSignal) => ({
            produced: await this.#minecraft.smeltItem(input, actionSignal),
          }),
        ),
      (_output, after) => {
        const held =
          after === null ? null : countInventory(after, input.output);
        const produced = held === null ? null : Math.max(0, held - baseline);
        if (held === null || produced === null || produced < input.count) {
          return {
            outcome: "failed",
            failureCategory: "inventory",
            failureCode: "SMELT_OUTPUT_NOT_VERIFIED",
            summary: "精錬後の所持品増加を確認できませんでした。",
          };
        }
        return {
          outcome: "completed",
          evidenceKind: "inventory_delta",
          confirmedState: {
            item: input.output,
            input: input.input,
            output: input.output,
            requestedCount: input.count,
            smeltedCount: produced,
            heldCount: held,
          },
          summary: `${input.input}を${input.output}へ${String(produced)}個精錬し、所持品で確認しました。`,
        };
      },
      current,
    );
  }

  async #deliverLogs(
    resource: string,
    count: number,
    gather: boolean,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    if (!isGatherableLog(resource))
      throw new AppError({
        category: "validation",
        code: "UNSUPPORTED_GATHER_RESOURCE",
        message: "対象外の資源です。",
        retryable: false,
      });
    const targets = this.delivery.list();
    const home = targets.find((target) => target.kind === "home"),
      chest = targets.find((target) => target.kind === "chest");
    if (!home || !chest)
      throw new AppError({
        category: "validation",
        code: "DELIVERY_TARGET_NOT_REGISTERED",
        message:
          "帰還拠点と指定チェストを先に登録してください。収納先は推測しません。",
        retryable: false,
      });
    let receipt: DepositResult | undefined;
    const report = await this.#executeTask(
      signal,
      () =>
        this.#deliverySkill.run(
          {
            resource,
            count,
            gather,
            requester: this.#ownerUsername,
            home,
            chest,
          },
          (result) => {
            receipt = result;
          },
        ),
      (output) => ({
        outcome: "completed",
        evidenceKind: "inventory_delta",
        confirmedState: { ...output },
        summary: `登録拠点への帰還と指定チェストへの${String(output.deposited)}個の収納を観測しました。${resource}の残り所持数は${String(output.heldCount)}個です。`,
      }),
    );
    if (report.outcome === "completed") return report;
    return {
      ...report,
      confirmedState: { ...report.confirmedState, ...receipt },
      summary: receipt?.verified
        ? `収納は途中で終了しました。確認できた収納数は${String(receipt.deposited)}個、未収納は${String(receipt.remaining)}個、${resource}の残り所持数は${String(receipt.heldCount)}個です。`
        : `帰還・収納を完了できませんでした（${report.failureCode ?? "UNVERIFIED"}）。収納数は未確認です。`,
      nextActions: [
        "登録先と現在の所持品を確認し、残りの数量を新しい依頼として指示してください。過去の収納数は加算しません。",
      ],
    };
  }

  public async returnToOwner(
    safeDistance: number,
    signal: AbortSignal,
  ): Promise<ActionReport> {
    const report = await this.#executeTask(
      signal,
      () =>
        this.#returnToPlayer.run({
          username: this.#ownerUsername,
          range: safeDistance,
          maxAttempts: this.#retryLimit + 1,
        }),
      (output) => ({
        outcome: "completed",
        confirmedState: {
          distance: output.distance,
          usedDescent: output.usedDescent,
          predictedMaxDamage: output.predictedMaxDamage,
          healthBefore: output.healthBefore,
          minimumObservedHealth: output.minimumObservedHealth,
          healthAfter: output.healthAfter,
        },
        summary: output.usedDescent
          ? `安全を確認した降下で利用者の場所へ戻りました。距離${output.distance.toFixed(1)}ブロック、Botの体力は降下中に最低${output.minimumObservedHealth}、帰還時${output.healthAfter}を観測しました。`
          : `歩ける経路で指定利用者の現在位置へ戻り、距離${output.distance.toFixed(1)}ブロックを観測しました。`,
      }),
    );
    if (report.failureCode !== "SAFE_DESCENT_BLOCKED") return report;
    const reason = report.confirmedState?.reason;
    const explanation =
      reason === "health_too_low"
        ? "Botの体力に安全余裕が足りません。"
        : reason === "drop_too_high"
          ? "確認できた落差が軽微な損傷の上限を超えます。"
          : reason === "hostile_nearby"
            ? "降りる先の近くに敵を確認しました。"
            : reason === "landing_unsafe"
              ? "降りる先の足場または通り道を安全と確認できません。"
              : reason === "no_descent"
                ? "歩ける道も安全な降り道も見つかっていません。"
                : "降りる先までの地形を十分に確認できません。";
    const nextAction =
      reason === "health_too_low"
        ? "体力が回復したら周囲を再確認して帰還を試します。"
        : reason === "hostile_nearby"
          ? "敵が離れたら周囲を再確認して帰還を試します。"
          : "利用者が近くに来るか、安全な通路や着地点ができれば再確認して帰還を試します。";
    return {
      ...report,
      summary: `高所からの帰還を試しましたが、${explanation} いまはその場で待機しています。${nextAction}`,
      nextActions: [nextAction],
    };
  }

  public async currentPosition(): Promise<Position> {
    const snapshot = await this.#minecraft.observe();
    return { ...snapshot.position, dimension: snapshot.dimension };
  }

  #assertActionDistance(
    current: WorldSnapshot,
    target: { readonly x: number; readonly y: number; readonly z: number },
    code: string,
  ): void {
    const targetPosition = { x: target.x, y: target.y, z: target.z };
    const targetDistance = distance(current.position, targetPosition);
    if (targetDistance <= this.#configuredMaxMoveDistance()) return;
    throw new AppError({
      category: "validation",
      code,
      message: "操作対象が許可された距離の外にあります。",
      retryable: false,
      failedAt: "precondition",
      confirmedState: { distance: targetDistance },
    });
  }

  #configuredMaxMoveDistance(): number {
    return this.#maxMoveDistance;
  }

  async #runGeneralTask<Input, Output>(
    kind: string,
    input: Input,
    externalSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Output>,
  ): Promise<TaskRecord<Input, Output>> {
    return this.#tasks.run(kind, input, async (context) => {
      const lease = this.#arbiter.acquire(
        `task:${context.taskId}`,
        actionPriorities.task,
      );
      const signal = AbortSignal.any([
        context.signal,
        externalSignal,
        lease.signal,
      ]);
      try {
        return await operation(signal);
      } finally {
        lease.release();
      }
    });
  }

  async #executeTask<Input, Output>(
    externalSignal: AbortSignal,
    run: () => Promise<TaskRecord<Input, Output>>,
    success: (
      output: Output,
      after: WorldSnapshot | null,
    ) => Pick<
      ActionReport,
      | "outcome"
      | "failureCategory"
      | "failureCode"
      | "confirmedState"
      | "evidenceKind"
      | "summary"
    >,
    capturedBefore?: WorldSnapshot,
    allowHostileResponse = false,
  ): Promise<ActionReport> {
    const beforeSnapshot = capturedBefore ?? (await this.#tryObserveSnapshot());
    const before =
      beforeSnapshot === null ? null : this.#statusFromSnapshot(beforeSnapshot);
    if (externalSignal.aborted) {
      return {
        before,
        after: before,
        outcome: "cancelled",
        failureCategory: "cancelled",
        failureCode: "ACTION_CANCELLED_BEFORE_START",
        failureRetryable: false,
        failedAt: "precondition",
        nextActions: ["新しい依頼として再度指示する"],
        summary: "停止指示済みのためMinecraft作業を開始しませんでした。",
      };
    }
    if (this.#requiresSafetyResumeGate()) {
      const danger = observedCurrentDanger(
        beforeSnapshot,
        this.#hungerThreshold,
        allowHostileResponse,
      );
      if (
        beforeSnapshot === null ||
        !beforeSnapshot.connected ||
        !beforeSnapshot.spawned ||
        danger !== null
      ) {
        return {
          before,
          after: before,
          outcome: "failed",
          failureCategory: "safety",
          failureCode: "SUSPENDED_TASK_UNSAFE_TO_RESUME",
          failureRetryable: true,
          failedAt: "precondition",
          nextActions: ["現在の危険がなくなったことを確認してから再開する"],
          summary:
            beforeSnapshot === null ||
            !beforeSnapshot.connected ||
            !beforeSnapshot.spawned
              ? "Botの現在の安全状態を確認できないため、作業を再開しませんでした。"
              : `${danger} 安全を確認できないため、作業を再開しませんでした。`,
        };
      }
    }

    const timeoutSignal = AbortSignal.timeout(this.#taskTimeoutMs);
    const cancellationSignal = AbortSignal.any([externalSignal, timeoutSignal]);
    let cancellation: Promise<void> | undefined;
    const cancel = (): void => {
      const reason = timeoutSignal.aborted
        ? "設定された作業時間を超過"
        : "利用者または上位処理による停止";
      cancellation = this.#tasks
        .cancel(reason, timeoutSignal.aborted ? "TASK_TIMEOUT" : undefined)
        .catch((error: unknown) => {
          this.#logger.error(
            {
              errorType: error instanceof Error ? error.name : "UnknownError",
            },
            "task cancellation persistence failed",
          );
        });
    };
    cancellationSignal.addEventListener("abort", cancel, { once: true });

    let record: TaskRecord<Input, Output>;
    try {
      record = await run();
      await cancellation;
    } finally {
      cancellationSignal.removeEventListener("abort", cancel);
    }
    const afterSnapshot = await this.#tryObserveSnapshot();
    if (afterSnapshot !== null) this.#syncLifeState(afterSnapshot);
    const after =
      afterSnapshot === null ? null : this.#statusFromSnapshot(afterSnapshot);

    if (record.status === "completed" && record.output !== undefined) {
      return { before, after, ...success(record.output, afterSnapshot) };
    }
    if (record.status === "cancelled") {
      const timedOut = timeoutSignal.aborted;
      return {
        before,
        after,
        outcome: "cancelled",
        failureCategory: timedOut ? "timeout" : "cancelled",
        failureCode: timedOut ? "TASK_TIMEOUT" : "TASK_CANCELLED",
        failureRetryable: timedOut,
        failedAt: record.phase,
        nextActions: timedOut
          ? ["状態を再観測し、範囲または数量を小さくして再依頼する"]
          : ["必要なら新しい依頼として再開する"],
        summary: timedOut
          ? "設定された時間内に完了しなかったため作業を停止しました。"
          : "停止指示によりMinecraft作業を中断しました。",
      };
    }
    if (record.status === "suspended") {
      const recovery = suspendedTaskRecovery(
        record,
        afterSnapshot,
        this.#hungerThreshold,
      );
      return {
        before,
        after,
        outcome: "failed",
        failureCategory: "safety",
        failureCode: "TASK_SUSPENDED_FOR_SAFETY",
        failureRetryable: true,
        failedAt: record.phase,
        nextActions: recovery.nextActions,
        summary: recovery.summary,
      };
    }
    return {
      before,
      after,
      outcome: "failed",
      failureCategory: mapFailureCategory(record.failure?.category),
      failureCode: record.failure?.code ?? "TASK_NOT_COMPLETED",
      failureRetryable: record.failure?.retryable ?? false,
      failedAt: record.failure?.failedAt ?? record.phase,
      ...(record.failure?.confirmedState === undefined
        ? {}
        : { confirmedState: record.failure.confirmedState }),
      nextActions:
        record.failure?.code === "ASCENT_RETURN_UNCONFIRMED"
          ? ["歩いて戻れる道や安全な退避先を確保できたら再確認する"]
          : failureNextActions(record.failure?.category),
      summary:
        record.failure?.code === "ASCENT_RETURN_UNCONFIRMED"
          ? "高所へ進む経路から安全に戻れる道を確認できなかったため、移動を止めました。歩いて戻れる道や安全な退避先ができれば再確認します。"
          : record.failure?.code
            ? `Minecraft作業の完了を確認できませんでした（${record.failure.code}）。`
            : "Minecraft作業の完了を確認できませんでした。",
    };
  }

  async #tryObserveSnapshot(): Promise<WorldSnapshot | null> {
    try {
      return await this.#minecraft.observe();
    } catch {
      return null;
    }
  }

  async #tryObserveStatus(): Promise<GameStatus | null> {
    const snapshot = await this.#tryObserveSnapshot();
    return snapshot === null ? null : this.#statusFromSnapshot(snapshot);
  }

  #statusFromSnapshot(snapshot: WorldSnapshot): GameStatus {
    const inventory: Record<string, number> = {};
    for (const item of snapshot.inventory) {
      inventory[item.name] = (inventory[item.name] ?? 0) + item.count;
    }
    const task = this.#latestTaskForStatus();
    return {
      observedAt: snapshot.observedAt,
      subject: snapshot.subject,
      source: snapshot.source,
      requesterVitals: "unobserved",
      connected: snapshot.connected,
      spawned: snapshot.spawned,
      health: snapshot.health,
      food: snapshot.food,
      oxygen: snapshot.oxygen,
      oxygenState: snapshot.oxygenState,
      inWater: snapshot.inWater,
      inLava: snapshot.inLava,
      suffocating: snapshot.suffocating,
      position: { ...snapshot.position, dimension: snapshot.dimension },
      inventory,
      armor: snapshot.armor,
      activeTaskState: activeTaskState(task, snapshot, this.#hungerThreshold),
      activeTaskSummary: activeTaskSummary(
        task,
        snapshot,
        this.#hungerThreshold,
      ),
      latestTaskState: latestTaskState(task, snapshot, this.#hungerThreshold),
    };
  }

  #latestTaskForStatus(): TaskStateForSummary | undefined {
    const active = this.#tasks.current;
    const activeSummary =
      active === undefined
        ? undefined
        : {
            kind: active.kind,
            status: active.status,
            phase: active.phase,
            updatedAt: active.updatedAt,
            ...(active.failure === undefined
              ? {}
              : { failureCategory: active.failure.category }),
            ...(active.failure === undefined
              ? {}
              : { failureCode: active.failure.code }),
            ...(active.checkpoint === undefined
              ? {}
              : { checkpoint: active.checkpoint }),
          };
    let persisted: TaskStateForSummary | undefined;
    if (this.#playerId !== undefined) {
      try {
        const latest = this.#memory.listRecentTaskRuns(this.#playerId, 1)[0];
        if (latest !== undefined) persisted = persistedTaskState(latest);
      } catch {
        // A status question remains useful when the durable task read is
        // temporarily unavailable; the live task state is still authoritative.
      }
    }
    if (activeSummary !== undefined) return activeSummary;
    if (persisted === undefined) return undefined;
    return terminalTaskStatuses.has(persisted.status)
      ? persisted
      : { ...persisted, persistedWithoutRuntime: true };
  }

  #requiresSafetyResumeGate(): boolean {
    const current = this.#tasks.current;
    if (current !== undefined) {
      return (
        current.status === "suspended" ||
        (current.status === "cancelled" &&
          typeof current.checkpoint?.suspendReason === "string")
      );
    }
    if (this.#playerId === undefined) return false;
    try {
      const latest = this.#memory.listRecentTaskRuns(this.#playerId, 1)[0];
      return (
        latest !== undefined &&
        (["queued", "running", "suspended"].includes(latest.status) ||
          (latest.status === "cancelled" &&
            typeof latest.checkpoint?.data.suspendReason === "string"))
      );
    } catch {
      // Without a durable task read, a restart cannot rule out a suspension.
      return true;
    }
  }

  #syncLifeState(snapshot: WorldSnapshot): void {
    try {
      const current = this.#memory.getLifeState();
      this.#memory.saveLifeState({
        currentInterests: current?.currentInterests ?? [],
        longTermGoals: current?.longTermGoals ?? [],
        ...(current?.homeBase === undefined
          ? {}
          : { homeBase: current.homeBase }),
        possessions: snapshot.inventory.map(({ name, count }) => ({
          name,
          quantity: count,
        })),
      });
    } catch (error) {
      this.#logger.error(
        {
          category: "persistence",
          code: "LIFE_STATE_SYNC_FAILED",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "life state synchronization failed",
      );
    }
  }
}

function isGatherableLog(resource: string): resource is GatherableLog {
  return (gatherableLogs as readonly string[]).includes(resource);
}

function mapFailureCategory(
  category: DomainErrorCategory | undefined,
): ErrorCategory {
  return category ?? "internal";
}

function failureNextActions(
  category: DomainErrorCategory | undefined,
): readonly string[] {
  switch (category) {
    case "connection":
      return ["接続設定と再接続状態を確認する"];
    case "observation":
      return ["利用者と対象が観測範囲内にいる状態で再試行する"];
    case "path":
      return ["障害物を確認し、より近い目的地から再試行する"];
    case "resource":
      return ["探索範囲または対象資源を見直す"];
    case "inventory":
      return ["所持品とdropの状態を再観測する"];
    case "timeout":
      return ["作業範囲または数量を小さくして再試行する"];
    case "cancelled":
      return ["必要なら新しい依頼として再開する"];
    case "persistence":
      return ["SQLiteの保存先と整合性を確認する"];
    case "safety":
      return ["安全状態を再観測して再開可否を判断する"];
    case "permission":
    case "validation":
    case "llm":
    case undefined:
      return ["状態と依頼内容を確認してから再試行する"];
  }
}

interface SuspendedTaskRecovery {
  readonly summary: string;
  readonly nextActions: readonly string[];
}

function suspendedTaskRecovery(
  task: TaskStateForSummary,
  snapshot?: WorldSnapshot | null,
  hungerThreshold = 14,
): SuspendedTaskRecovery {
  const reason = task.checkpoint?.suspendReason;
  const actionLabel = task.kind === "follow_player" ? "追従" : "作業";
  const currentDanger = observedCurrentDanger(snapshot, hungerThreshold);
  if (reason === "reflex:stuck") {
    return {
      summary: `移動中にBotの位置が変わらず、${actionLabel}を一時停止しました。${currentDanger ?? "通れない地形の詳細はまだ確認できていません。"} 通れる道を確保できたら「続けて」で再開できます。`,
      nextActions: [
        "通れる道と周囲の安全を確認する",
        "状況が変わったら「続けて」で再開する",
      ],
    };
  }
  if (reason === "reflex:hazard") {
    return {
      summary: `直前にBotの周囲で危険を確認し、作業を一時停止しました。${currentDanger ?? "今回の観測だけでは危険が続いているか確認できません。"} 安全が確認できたら「続けて」で再開できます。`,
      nextActions: [
        "Botの周囲の安全を再確認する",
        "安全になったら「続けて」で再開する",
      ],
    };
  }
  if (reason === "reflex:hostile") {
    return {
      summary: `直前にBotの近くで敵を確認し、作業を一時停止しました。${currentDanger ?? (snapshot?.connected !== true ? "現在の周囲はまだ観測できていません。" : "今回の観測では近くの敵を確認していません。")} 敵から距離を取れたら「続けて」で再開できます。`,
      nextActions: [
        "敵から距離を取り周囲の安全を確認する",
        "安全になったら「続けて」で再開する",
      ],
    };
  }
  if (reason === "reflex:damage") {
    return {
      summary: `直前にBotの体力が減ったため、作業を一時停止しました。${currentDanger ?? "今回の観測だけでは被害の原因を特定できません。"} 原因を確かめ、安全になったら「続けて」で再開できます。`,
      nextActions: [
        "Botの周囲と被害の原因を確認する",
        "安全になったら「続けて」で再開する",
      ],
    };
  }
  if (reason === "reflex:hunger") {
    return {
      summary: `直前にBotの空腹を確認し、作業を一時停止しました。${currentDanger ?? (snapshot?.connected === true ? "今回の観測では空腹が解消しています。" : "現在の空腹状態はまだ観測できていません。")} 安全を確認できたら「続けて」で再開できます。`,
      nextActions: [
        "Botの食料と空腹状態を確認する",
        "食料を確保した後に「続けて」で再開する",
      ],
    };
  }
  return {
    summary:
      "作業を一時停止しました。停止の詳しい原因はまだ確認できていません。Botの状態を確かめてから「続けて」で再開できます。",
    nextActions: ["Botの状態を確認する", "安全なら「続けて」で再開する"],
  };
}

function observedCurrentDanger(
  snapshot?: WorldSnapshot | null,
  hungerThreshold = 14,
  allowHostileResponse = false,
): string | null {
  if (snapshot === undefined || snapshot === null) return null;
  if (snapshot.inLava || snapshot.onFire || snapshot.suffocating) {
    return "今もBotの周囲に環境上の危険を観測しています。";
  }
  if (snapshot.velocityY <= -1.2) {
    return "Botが今も落下しているため、移動の安全を確認できません。";
  }
  if (snapshot.inWater && snapshot.oxygenState !== "normal") {
    return "Botは水中にいて、呼吸の安全を確認できません。";
  }
  if (
    !allowHostileResponse &&
    snapshot.nearbyEntities.some(
      (entity) => entity.hostile && entity.distance <= 8,
    )
  ) {
    return "今もBotの近くに敵を観測しています。";
  }
  if (snapshot.food <= hungerThreshold) {
    return "Botは今も空腹で、安全に作業できる状態を確認できません。";
  }
  return null;
}

function activeTaskState(
  task: TaskStateForSummary | undefined,
  snapshot: WorldSnapshot,
  hungerThreshold: number,
): string | null {
  if (
    task === undefined ||
    task.persistedWithoutRuntime === true ||
    terminalTaskStatuses.has(task.status)
  )
    return null;
  if (task.status === "suspended") {
    return suspendedTaskRecovery(task, snapshot, hungerThreshold).summary;
  }
  return `${task.kind}:${task.phase}:${task.status}`;
}

function activeTaskSummary(
  task: TaskStateForSummary | undefined,
  snapshot: WorldSnapshot,
  hungerThreshold: number,
): string | null {
  if (
    task === undefined ||
    task.persistedWithoutRuntime === true ||
    terminalTaskStatuses.has(task.status)
  )
    return null;
  if (task.status === "suspended") {
    return suspendedTaskRecovery(task, snapshot, hungerThreshold).summary;
  }
  if (task.status === "queued") {
    return "Minecraft作業の開始を待っています。";
  }
  switch (task.kind) {
    case "follow_player":
      return "利用者への追従を続けています。";
    case "gather_resource":
      return "資源の収集を続けています。";
    case "move_to":
      return "指定場所への移動を続けています。";
    case "return_to_player":
      return "利用者の場所への帰還を続けています。";
    default:
      return "Minecraft作業を続けています。";
  }
}

function latestTaskState(
  task: TaskStateForSummary | undefined,
  snapshot: WorldSnapshot,
  hungerThreshold: number,
): string | null {
  if (task === undefined) return null;
  if (task.persistedWithoutRuntime === true) {
    return "前回のMinecraft作業は途中と記録されていますが、現在その作業が続いていることは確認できません。状態を確認してから、必要ならもう一度指示してください。";
  }
  if (task.status === "completed") return "直前のMinecraft作業は完了しました。";
  if (task.status === "failed") {
    const reason = taskFailureReason(task.failureCategory, task.failureCode);
    return reason === undefined
      ? "直前のMinecraft作業は完了を確認できませんでした。"
      : "直前のMinecraft作業は完了を確認できませんでした。" + reason;
  }
  if (task.status === "cancelled") {
    const reason = taskFailureReason(task.failureCategory, task.failureCode);
    return reason === undefined
      ? "直前のMinecraft作業は停止しました。"
      : "直前のMinecraft作業は停止しました。" + reason;
  }
  if (task.status === "suspended")
    return suspendedTaskRecovery(task, snapshot, hungerThreshold).summary;
  if (task.status === "queued") return "Minecraft作業の開始を待っています。";
  return activeTaskSummary(task, snapshot, hungerThreshold);
}

function persistedTaskState(task: TaskRunRecord): TaskStateForSummary {
  const suspendReason = task.checkpoint?.data.suspendReason;
  return {
    kind: task.kind,
    status: task.status,
    phase: task.phase,
    updatedAt: task.updatedAt,
    ...(task.failure === undefined
      ? {}
      : { failureCategory: task.failure.category }),
    ...(task.failure === undefined ? {} : { failureCode: task.failure.code }),
    ...(typeof suspendReason === "string"
      ? { checkpoint: { suspendReason } }
      : {}),
  };
}

function taskFailureReason(
  category: string | undefined,
  code: string | undefined,
): string | undefined {
  switch (category) {
    case "connection":
      return "Minecraftへの接続を確認できませんでした。";
    case "observation":
      return "Minecraftの状態を確認できませんでした。";
    case "path":
      return "経路を確認できませんでした。";
    case "resource":
      return "必要な資源を確認できませんでした。";
    case "inventory":
      return "所持品の状態を確認できませんでした。";
    case "timeout":
      return "設定時間内に完了しませんでした。";
    case "cancelled":
      if (code === "TASK_TIMEOUT") {
        return "設定時間内に完了しませんでした。";
      }
      if (code === "TASK_REPLACED_AFTER_SUSPENSION") {
        return "安全待機中に別の依頼へ切り替えました。";
      }
      return "停止指示で中断しました。";
    case "safety":
      return "安全確認のため停止しました。";
    case "permission":
    case "validation":
    case "llm":
    case "persistence":
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function formatCoordinates(position: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): string {
  return `(${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`;
}

function candidateBlockPosition(
  candidate: GeneralActionCandidate,
): { x: number; y: number; z: number } | undefined {
  const position = candidate.args.position;
  if (
    position === null ||
    typeof position !== "object" ||
    Array.isArray(position)
  )
    return undefined;
  const { x, y, z } = position as Record<string, unknown>;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number" ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(z)
  )
    return undefined;
  return { x, y, z };
}

function boundedApproachPoint(
  origin: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  maxStep: number,
): { x: number; y: number; z: number } {
  const span = distance(origin, target);
  if (span <= maxStep) return target;
  const fraction = maxStep / span;
  return {
    x: Math.round(origin.x + (target.x - origin.x) * fraction),
    y: Math.round(origin.y + (target.y - origin.y) * fraction),
    z: Math.round(origin.z + (target.z - origin.z) * fraction),
  };
}

function splitMinecraftChat(message: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of message) {
    if (current.length + character.length > 240) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
