import type { MineflayerPlayerBody } from "../../src/minecraft/player-body.js";
import type { PlayerBodyObservation } from "../../src/minecraft/player-body-observation.js";
import type { PlayerEvidence } from "./ai-player-live.js";

export const COMPANION_PROACTIVE_TARGETS = [
  { targetCase: "companion_proactive_food", phase: "food" },
  { targetCase: "companion_proactive_bed", phase: "bed" },
] as const;

export type CompanionProactiveTargetCase =
  (typeof COMPANION_PROACTIVE_TARGETS)[number]["targetCase"];
export type CompanionProactivePhase =
  (typeof COMPANION_PROACTIVE_TARGETS)[number]["phase"];
export interface CompanionProactivePosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const COMPANION_PROACTIVE_CASE_BUDGET = {
  llmCalls: 80,
  totalTokens: 800_000,
} as const;
export const COMPANION_PROACTIVE_CASE_DEADLINE_MS = 20 * 60_000;
export const COMPANION_PROACTIVE_RUN_BUDGET = {
  durationMs: 25 * 60_000,
  ...COMPANION_PROACTIVE_CASE_BUDGET,
} as const;

export function isCompanionProactiveTarget(
  targetCase: string | undefined,
): targetCase is CompanionProactiveTargetCase {
  return COMPANION_PROACTIVE_TARGETS.some(
    ({ targetCase: candidate }) => targetCase === candidate,
  );
}

export function companionProactivePhaseForTarget(
  targetCase: CompanionProactiveTargetCase,
): CompanionProactivePhase {
  const target = COMPANION_PROACTIVE_TARGETS.find(
    (candidate) => candidate.targetCase === targetCase,
  );
  if (target === undefined) throw new Error("Unknown proactive target");
  return target.phase;
}

export interface CompanionProactiveAction {
  readonly kind: string;
  readonly status: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sameLife: boolean;
  readonly recoveryRequired: boolean;
  readonly operationEntityId?: number;
  readonly observedEffectType?: string;
  readonly observedEffectEntityId?: number;
}

export interface CompanionProactivePort {
  readonly targetCase: CompanionProactiveTargetCase;
  readonly botName: string;
  readonly body: MineflayerPlayerBody;
  readonly rcon: {
    command(command: string, timeoutMs?: number): Promise<string>;
  };
  readonly responses: () => readonly {
    readonly at: number;
    readonly text: string;
  }[];
  readonly readPlayer: () => Promise<PlayerEvidence>;
  readonly observeForPlayer: (
    timeoutMs: number,
    predicate: (player: PlayerEvidence) => boolean | Promise<boolean>,
  ) => Promise<PlayerEvidence | undefined>;
  readonly sendOwnerChat: (text: string) => void;
  readonly readHealth: () => Promise<number>;
  readonly readFoodLevel: () => Promise<number>;
  readonly readInventoryCount: (item: string) => Promise<number>;
  readonly readPosition: () => Promise<CompanionProactivePosition>;
  readonly countTaggedDrop: (
    tag: string,
    item: string,
    center: CompanionProactivePosition,
  ) => Promise<number>;
  readonly readTaggedDropPosition: (
    tag: string,
    item: string,
    center: CompanionProactivePosition,
  ) => Promise<CompanionProactivePosition>;
  readonly isBlock: (
    position: CompanionProactivePosition,
    block: string,
  ) => Promise<boolean>;
  readonly captureActions: () => Readonly<{
    actions: CompanionProactiveAction[];
    restore: () => void;
  }>;
  readonly setGamerule: (
    rule: "advanceTime" | "spawnMobs" | "naturalRegeneration",
    value: boolean,
  ) => Promise<void>;
  readonly updateDiagnostic: (
    update: Readonly<Record<string, boolean | number | string>>,
  ) => void;
}

export class CompanionProactiveAcceptanceError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "CompanionProactiveAcceptanceError";
  }
}

export function proactiveFoodUseConfirmed(input: {
  readonly freshPurposeDecision: boolean;
  readonly preObservationConfirmed: boolean;
  readonly movementTowardDropObserved: boolean;
  readonly approachAction: CompanionProactiveAction | undefined;
  readonly targetEntityId: number;
  readonly bodyInventoryIncreaseObserved: boolean;
  readonly serverInventoryIncreaseObserved: boolean;
  readonly consumeAction: CompanionProactiveAction | undefined;
  readonly dropCountAfter: number;
  readonly foodBefore: number;
  readonly foodAfter: number;
  readonly bodyFoodAfter: number | null;
}): boolean {
  const approach = input.approachAction;
  const consume = input.consumeAction;
  return (
    input.freshPurposeDecision &&
    input.preObservationConfirmed &&
    input.movementTowardDropObserved &&
    isFoodApproachOrCollectionAction(approach, input.targetEntityId) &&
    input.bodyInventoryIncreaseObserved &&
    input.serverInventoryIncreaseObserved &&
    consume?.kind === "consume" &&
    consume.status === "successful" &&
    consume.sameLife &&
    !consume.recoveryRequired &&
    input.dropCountAfter === 0 &&
    input.foodAfter > input.foodBefore &&
    input.bodyFoodAfter === input.foodAfter
  );
}

function isFoodApproachOrCollectionAction(
  action: CompanionProactiveAction | undefined,
  targetEntityId: number,
): boolean {
  if (
    action?.status !== "successful" ||
    !action.sameLife ||
    action.recoveryRequired
  )
    return false;
  if (
    action.kind === "move_to" ||
    action.kind === "move_relative" ||
    action.kind === "control"
  )
    return true;
  return (
    action.kind === "collect_item" &&
    action.operationEntityId === targetEntityId &&
    action.observedEffectType === "item_collected" &&
    action.observedEffectEntityId === targetEntityId
  );
}

export function proactiveBedCompletionConfirmed(input: {
  readonly oneOwnerPrompt: boolean;
  readonly ownerGoalAccepted: boolean;
  readonly freshPurposeDecision: boolean;
  readonly sameOwnerGoalAcrossWork: boolean;
  readonly successfulCraft: boolean;
  readonly serverCraftingTable: boolean;
  readonly serverBed: boolean;
  readonly targetOwnerGoalCompleted: boolean;
}): boolean {
  return Object.values(input).every(Boolean);
}

export async function runCompanionProactiveAcceptanceCase(
  port: CompanionProactivePort,
): Promise<Readonly<Record<string, boolean | number | string>>> {
  return companionProactivePhaseForTarget(port.targetCase) === "food"
    ? runFoodPhase(port)
    : runBedPhase(port);
}

function freshPurposeDecision(
  before: PlayerEvidence,
  after: PlayerEvidence,
): boolean {
  const previous = new Set(
    (before.recentAgentActivity ?? []).map(
      ({ runSequence, round }) => `${runSequence}:${round}`,
    ),
  );
  return (after.recentAgentActivity ?? []).some(
    (activity) =>
      activity.role === "purpose" &&
      !previous.has(`${activity.runSequence}:${activity.round}`) &&
      activity.toolCalls.some(
        ({ name, resultClass }) =>
          name === "commit_action_decision" && resultClass === "ok",
      ),
  );
}

function newOwnerGoal(
  before: PlayerEvidence,
  after: PlayerEvidence,
  requestedAt: number,
): PlayerEvidence["goals"][number] | undefined {
  const previous = new Set(before.goals.map(({ id }) => id));
  return after.goals.find(({ id, source, status, updatedAt }) => {
    const updated = Date.parse(updatedAt ?? "");
    return (
      source === "owner" &&
      status === "active" &&
      !previous.has(id) &&
      Number.isFinite(updated) &&
      updated >= requestedAt
    );
  });
}

async function runFoodPhase(
  port: CompanionProactivePort,
): Promise<Readonly<Record<string, boolean | number | string>>> {
  const capture = port.captureActions();
  const tag = "ai_e2e_proactive_food";
  let origin: CompanionProactivePosition | undefined;
  let touchedDrop = false;
  const responseBaseline = port.responses().length;
  try {
    await prepareArena(port);
    await port.rcon.command(
      `effect give ${port.botName} minecraft:hunger 120 8 true`,
    );
    const hungerDeadline = Date.now() + 45_000;
    let foodBefore = await port.readFoodLevel();
    while (foodBefore > 15 && Date.now() < hungerDeadline) {
      await sleep(500);
      foodBefore = await port.readFoodLevel();
    }
    if (foodBefore < 12 || foodBefore > 15)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_FOOD_HUNGER_FIXTURE_UNAVAILABLE",
      );
    await port.rcon.command(`effect clear ${port.botName} minecraft:hunger`);
    const bodyBefore = await port.body.observe();
    const healthBefore = await port.readHealth();
    foodBefore = await port.readFoodLevel();
    if (
      foodBefore < 12 ||
      foodBefore > 15 ||
      bodyBefore.self.food !== foodBefore ||
      bodyBefore.self.health === null ||
      Math.abs(bodyBefore.self.health - healthBefore) > 1
    ) {
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_FOOD_BODY_BASELINE_UNCONFIRMED",
      );
    }
    const serverInventoryBefore = await port.readInventoryCount("golden_apple");
    const bodyInventoryBefore = bodyBefore.self.inventory
      .filter(({ name }) => name === "golden_apple")
      .reduce((total, { count }) => total + count, 0);
    if (serverInventoryBefore !== 0 || bodyInventoryBefore !== 0)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_FOOD_INVENTORY_BASELINE_NOT_EMPTY",
      );
    origin = await port.readPosition();
    if (distance(origin, bodyBefore.self.position) > 0.75)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_FOOD_POSITION_BASELINE_UNCONFIRMED",
      );
    // Face the known open fixture lane before spawning the item. This is fixture
    // setup, and captured actions start only after the item exists.
    await port.rcon.command(
      `tp ${port.botName} ${origin.x} ${origin.y} ${origin.z} -90 0`,
    );
    const fixtureCenter = await port.readPosition();
    origin = fixtureCenter;
    const fixtureAt = Date.now();
    touchedDrop = true;
    await port.rcon.command(
      `summon minecraft:item ${fixtureCenter.x + 4} ${fixtureCenter.y} ${fixtureCenter.z + 0.2} {Item:{id:"minecraft:golden_apple",count:1b},Age:-32768s,Tags:["${tag}"]}`,
    );
    const dropBefore = await port.countTaggedDrop(
      tag,
      "golden_apple",
      fixtureCenter,
    );
    if (dropBefore !== 1)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_FOOD_DROP_FIXTURE_UNAVAILABLE",
      );
    const dropPosition = await port.readTaggedDropPosition(
      tag,
      "golden_apple",
      fixtureCenter,
    );
    const preObservation = await port.body.observe();
    const playerPositionBefore = await port.readPosition();
    const startDistance = distance(playerPositionBefore, dropPosition);
    const bodyServerPositionAligned =
      distance(playerPositionBefore, preObservation.self.position) <= 0.75;
    const visibleDrops = preObservation.perception.entities.filter(
      ({ name, droppedItem, position }) =>
        name === "item" &&
        droppedItem?.name === "golden_apple" &&
        distance(position, dropPosition) <= 0.75,
    );
    const visibleDrop = visibleDrops[0];
    const preServerInventory = await port.readInventoryCount("golden_apple");
    const preBodyInventory = preObservation.self.inventory
      .filter(({ name }) => name === "golden_apple")
      .reduce((total, { count }) => total + count, 0);
    const preObservationConfirmed =
      visibleDrops.length === 1 &&
      visibleDrop !== undefined &&
      visibleDrop.droppedItem?.count === 1 &&
      visibleDrop.distance >= 3 &&
      visibleDrop.distance <= 5 &&
      startDistance >= 3 &&
      startDistance <= 5 &&
      bodyServerPositionAligned &&
      distance(visibleDrop.position, dropPosition) <= 0.75 &&
      preServerInventory === 0 &&
      preBodyInventory === 0;
    port.updateDiagnostic({
      proactivePhase: "food",
      ownerPromptCount: 0,
      fixtureActionsExcludedFromAcceptance: true,
      preObservationConfirmed,
      preObservationVisible: visibleDrop !== undefined,
      preObservationInventoryEmpty:
        preServerInventory === 0 && preBodyInventory === 0,
      bodyServerPositionAligned,
      startDistance,
      bodyDropDistance: visibleDrop?.distance ?? -1,
      serverDropCountBefore: dropBefore,
    });
    if (!preObservationConfirmed)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_FOOD_DROP_NOT_VISIBLE_OR_AUTO_PICKED",
      );
    const playerBefore = await port.readPlayer();
    const targetEntityId = visibleDrop.id;
    let bodyAfter: PlayerBodyObservation | undefined;
    let foodAfter = foodBefore;
    let healthAfter = healthBefore;
    let bodyInventoryIncreaseObserved = false;
    let serverInventoryIncreaseObserved = false;
    let movementTowardDropObserved = false;
    let distanceAfter = startDistance;
    const after = await port.observeForPlayer(12 * 60_000, async (player) => {
      bodyAfter = await port.body.observe();
      const inventory = await port.readInventoryCount("golden_apple");
      const bodyInventory = bodyAfter.self.inventory
        .filter(({ name }) => name === "golden_apple")
        .reduce((total, { count }) => total + count, 0);
      serverInventoryIncreaseObserved ||= inventory > serverInventoryBefore;
      bodyInventoryIncreaseObserved ||= bodyInventory > bodyInventoryBefore;
      foodAfter = await port.readFoodLevel();
      healthAfter = await port.readHealth();
      const positionAfter = await port.readPosition();
      distanceAfter = distance(positionAfter, dropPosition);
      movementTowardDropObserved ||= distanceAfter < startDistance - 0.01;
      const approachAction = capture.actions.find(
        (action) =>
          isFoodApproachOrCollectionAction(action, targetEntityId) &&
          Date.parse(action.startedAt) >= fixtureAt,
      );
      const matchingCollectItemActionObserved = capture.actions.some(
        (action) =>
          action.kind === "collect_item" &&
          action.status === "successful" &&
          action.sameLife &&
          !action.recoveryRequired &&
          action.operationEntityId === targetEntityId &&
          action.observedEffectType === "item_collected" &&
          action.observedEffectEntityId === targetEntityId &&
          Date.parse(action.startedAt) >= fixtureAt,
      );
      const consume = capture.actions.find(
        (action) =>
          action.kind === "consume" &&
          action.status === "successful" &&
          Date.parse(action.startedAt) >= fixtureAt,
      );
      const freshDecision = freshPurposeDecision(playerBefore, player);
      const dropAfter =
        consume === undefined
          ? undefined
          : await port.countTaggedDrop(tag, "golden_apple", fixtureCenter);
      const bodyFoodAfter = bodyAfter.self.food;
      const bodyHealthAfter = bodyAfter.self.health;
      port.updateDiagnostic({
        proactivePhase: "food",
        ownerPromptCount: 0,
        ownerReplyCount: port.responses().length - responseBaseline,
        freshPurposeDecisionObserved: freshDecision,
        preObservationConfirmed,
        movementTowardDropObserved,
        startDistance,
        distanceAfter,
        successfulBodyApproachActionObserved: approachAction !== undefined,
        bodyApproachActionKind: approachAction?.kind ?? "none",
        matchingCollectItemActionObserved,
        bodyInventoryIncreaseObserved,
        serverInventoryIncreaseObserved,
        successfulConsumeActionObserved: consume !== undefined,
        serverDropCountAfter: dropAfter ?? -1,
        foodBefore,
        foodAfter,
        bodyFoodAfter: bodyFoodAfter ?? -1,
        bodyFoodServerAligned: bodyFoodAfter === foodAfter,
        healthBefore,
        healthAfter,
        bodyHealthAfter: bodyHealthAfter ?? -1,
        healthRecoveryVerified: false,
      });
      if (
        approachAction === undefined ||
        consume === undefined ||
        dropAfter === undefined
      )
        return false;
      return proactiveFoodUseConfirmed({
        freshPurposeDecision: freshDecision,
        preObservationConfirmed,
        movementTowardDropObserved,
        approachAction,
        targetEntityId,
        bodyInventoryIncreaseObserved,
        serverInventoryIncreaseObserved,
        consumeAction: consume,
        dropCountAfter: dropAfter,
        foodBefore,
        foodAfter,
        bodyFoodAfter,
      });
    });
    if (after === undefined || bodyAfter === undefined)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_FOOD_USE_NOT_CONFIRMED",
      );
    const result = {
      proactivePhase: "food",
      ownerPromptCount: 0,
      freshPurposeDecisionObserved: freshPurposeDecision(playerBefore, after),
      preObservationConfirmed,
      movementTowardDropObserved,
      startDistance,
      distanceAfter,
      successfulBodyApproachActionObserved: capture.actions.some(
        (action) =>
          isFoodApproachOrCollectionAction(action, targetEntityId) &&
          Date.parse(action.startedAt) >= fixtureAt,
      ),
      matchingCollectItemActionObserved: capture.actions.some(
        (action) =>
          action.kind === "collect_item" &&
          action.status === "successful" &&
          action.sameLife &&
          !action.recoveryRequired &&
          action.operationEntityId === targetEntityId &&
          action.observedEffectType === "item_collected" &&
          action.observedEffectEntityId === targetEntityId &&
          Date.parse(action.startedAt) >= fixtureAt,
      ),
      bodyInventoryIncreaseObserved,
      serverInventoryIncreaseObserved,
      successfulConsumeActionObserved: true,
      serverDropCountBefore: dropBefore,
      serverDropCountAfter: await port.countTaggedDrop(
        tag,
        "golden_apple",
        fixtureCenter,
      ),
      foodBefore,
      foodAfter,
      bodyFoodAfter: bodyAfter.self.food ?? -1,
      bodyFoodServerAligned: bodyAfter.self.food === foodAfter,
      healthBefore,
      healthAfter,
      bodyHealthAfter: bodyAfter.self.health ?? -1,
      healthRecoveryVerified: false,
      ownerReplyCount: port.responses().length - responseBaseline,
      sameLife: capture.actions.some(
        ({ kind, status, sameLife }) =>
          kind === "consume" && status === "successful" && sameLife,
      ),
    };
    port.updateDiagnostic(result);
    return result;
  } finally {
    capture.restore();
    if (touchedDrop) {
      await port.rcon
        .command(`kill @e[type=minecraft:item,tag=${tag}]`)
        .catch(() => undefined);
      await port.rcon
        .command(`clear ${port.botName} minecraft:golden_apple`)
        .catch(() => undefined);
      await port.rcon
        .command(`effect clear ${port.botName}`)
        .catch(() => undefined);
      port.updateDiagnostic({
        fixtureCleanupConfirmed:
          origin !== undefined &&
          (await port
            .countTaggedDrop(tag, "golden_apple", origin)
            .catch(() => -1)) === 0,
      });
    }
  }
}

async function runBedPhase(
  port: CompanionProactivePort,
): Promise<Readonly<Record<string, boolean | number | string>>> {
  const capture = port.captureActions();
  const responseBaseline = port.responses().length;
  let tablePosition: CompanionProactivePosition | undefined;
  const bedPositions: CompanionProactivePosition[] = [];
  let cleanupConfirmed = true;
  try {
    await prepareArena(port);
    await port.rcon.command(`give ${port.botName} minecraft:oak_log 2`);
    await port.rcon.command(`give ${port.botName} minecraft:white_wool 3`);
    const logsBefore = await port.readInventoryCount("oak_log");
    const woolBefore = await port.readInventoryCount("white_wool");
    const tableBefore = await port.readInventoryCount("crafting_table");
    const bedBefore = await port.readInventoryCount("white_bed");
    if (
      logsBefore !== 2 ||
      woolBefore !== 3 ||
      tableBefore !== 0 ||
      bedBefore !== 0
    )
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_BED_INPUT_FIXTURE_UNAVAILABLE",
      );
    const before = await port.readPlayer();
    const prompt =
      "手持ちの原木2個と白い羊毛3個でベッドを作り、近くに置いてください。進め方は任せます。途中で確認を求めず、完成まで進めて状態を確かめてください。";
    const sentAt = Date.now();
    port.sendOwnerChat(prompt);
    let acceptedGoal: PlayerEvidence["goals"][number] | undefined;
    const accepted = await port.observeForPlayer(90_000, (player) => {
      acceptedGoal = newOwnerGoal(before, player, sentAt);
      return acceptedGoal !== undefined;
    });
    if (accepted === undefined || acceptedGoal === undefined)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_BED_OWNER_GOAL_NOT_ACCEPTED",
      );
    const goalId = acceptedGoal.id;
    const outcomeBaseline = new Set(
      before.recentOutcomes.map(({ operationId }) => operationId),
    );
    const processedActions = new Set<string>();
    let goalAtWorkCount = 0;
    let successfulCraft = false;
    let freshPurposeObserved = false;
    let tableObserved = false;
    let bedObserved = false;
    let completionObserved = false;
    let logsAfter = logsBefore;
    let woolAfter = woolBefore;
    const complete = await port.observeForPlayer(
      17 * 60_000,
      async (player) => {
        freshPurposeObserved ||= freshPurposeDecision(before, player);
        const goal = player.goals.find(
          ({ id, source }) => id === goalId && source === "owner",
        );
        completionObserved ||=
          goal?.status === "completed" || goal?.status === "complete";
        successfulCraft ||= capture.actions.some(
          ({ kind, status, completedAt }) =>
            kind === "craft" &&
            status === "successful" &&
            Date.parse(completedAt) >= sentAt,
        );
        successfulCraft ||= player.recentOutcomes.some(
          ({ operationId, kind, status }) =>
            !outcomeBaseline.has(operationId) &&
            kind === "craft" &&
            status === "successful",
        );
        for (const action of capture.actions) {
          const key = `${action.kind}:${action.completedAt}`;
          if (
            action.status !== "successful" ||
            processedActions.has(key) ||
            Date.parse(action.completedAt) < sentAt
          )
            continue;
          processedActions.add(key);
          if (
            player.goals.some(
              ({ id, source }) => id === goalId && source === "owner",
            )
          )
            goalAtWorkCount += 1;
        }
        const observation = await port.body.observe();
        for (const block of observation.perception.blocks) {
          if (
            block.name === "crafting_table" &&
            (await port.isBlock(block.position, "crafting_table"))
          ) {
            tableObserved = true;
            tablePosition ??= block.position;
          }
          if (
            block.name === "white_bed" &&
            (await port.isBlock(block.position, "white_bed"))
          ) {
            bedObserved = true;
            if (
              !bedPositions.some(
                (position) => distance(position, block.position) < 0.01,
              )
            )
              bedPositions.push(block.position);
          }
        }
        logsAfter = await port.readInventoryCount("oak_log");
        woolAfter = await port.readInventoryCount("white_wool");
        port.updateDiagnostic({
          proactivePhase: "bed",
          ownerGoalAccepted: true,
          freshPurposeDecisionObserved: freshPurposeObserved,
          sameOwnerGoalWorkSnapshots: goalAtWorkCount,
          successfulCraftObserved: successfulCraft,
          serverCraftingTableObserved: tableObserved,
          serverBedObserved: bedObserved,
          targetOwnerGoalCompletionObserved: completionObserved,
          ownerReplyCount: port.responses().length - responseBaseline,
          logsRemaining: logsAfter,
          woolRemaining: woolAfter,
        });
        return proactiveBedCompletionConfirmed({
          oneOwnerPrompt: true,
          ownerGoalAccepted: true,
          freshPurposeDecision: freshPurposeObserved,
          sameOwnerGoalAcrossWork: goalAtWorkCount >= 2,
          successfulCraft,
          serverCraftingTable: tableObserved,
          serverBed: bedObserved,
          targetOwnerGoalCompleted: completionObserved,
        });
      },
    );
    if (complete === undefined)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_BED_COMPLETION_NOT_CONFIRMED",
      );
    const result = {
      proactivePhase: "bed",
      ownerPromptCount: 1,
      ownerGoalAccepted: true,
      freshPurposeDecisionObserved: freshPurposeObserved,
      sameOwnerGoalWorkSnapshots: goalAtWorkCount,
      sameOwnerGoalRetainedAcrossWork: goalAtWorkCount >= 2,
      successfulCraftObserved: successfulCraft,
      serverCraftingTableObserved: tableObserved,
      serverBedObserved: bedObserved,
      targetOwnerGoalCompletionObserved: completionObserved,
      logsBefore,
      logsAfter,
      woolBefore,
      woolAfter,
      ownerReplyCount: port.responses().length - responseBaseline,
    };
    port.updateDiagnostic(result);
    return result;
  } finally {
    capture.restore();
    for (const position of [...bedPositions, tablePosition].filter(
      (value): value is CompanionProactivePosition => value !== undefined,
    )) {
      await port.rcon
        .command(`setblock ${position.x} ${position.y} ${position.z} air`)
        .catch(() => undefined);
      cleanupConfirmed &&= await port
        .isBlock(position, "air")
        .catch(() => false);
    }
    port.updateDiagnostic({ fixtureCleanupConfirmed: cleanupConfirmed });
  }
}

async function prepareArena(port: CompanionProactivePort): Promise<void> {
  await port.setGamerule("advanceTime", false);
  await port.setGamerule("spawnMobs", false);
  await port.rcon.command("fill -12 64 -12 12 72 12 air");
  await port.rcon.command("fill -12 63 -12 12 63 12 stone");
  await port.rcon.command(`effect clear ${port.botName}`);
  await port.rcon.command(`clear ${port.botName}`);
  await port.rcon.command("time set 1000");
  await port.rcon.command(`tp ${port.botName} 0.5 64 0.5`);
  const player = await port.readPosition();
  const body = (await port.body.observe()).self.position;
  if (distance(player, body) > 0.75)
    throw new CompanionProactiveAcceptanceError(
      "PROACTIVE_FIXTURE_POSITION_UNCONFIRMED",
    );
}

function distance(
  left: CompanionProactivePosition,
  right: CompanionProactivePosition,
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
