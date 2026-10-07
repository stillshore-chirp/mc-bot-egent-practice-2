import type { MineflayerPlayerBody } from "../../src/minecraft/player-body.js";
import type { PlayerBodyObservation } from "../../src/minecraft/player-body-observation.js";
import type { PlayerEvidence } from "./ai-player-live.js";

export const COMPANION_PROACTIVE_TARGETS = [
  { targetCase: "companion_proactive_food", phase: "food" },
  { targetCase: "companion_proactive_bed", phase: "bed" },
  { targetCase: "companion_proactive_threat", phase: "threat" },
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
export const COMPANION_PROACTIVE_FOCUSED_CASE_BUDGET = {
  llmCalls: 32,
  totalTokens: 280_000,
} as const;
export const COMPANION_PROACTIVE_FOCUSED_CASE_DEADLINE_MS = 8 * 60_000;
export const COMPANION_PROACTIVE_FOCUSED_RUN_BUDGET = {
  durationMs: 10 * 60_000,
  ...COMPANION_PROACTIVE_FOCUSED_CASE_BUDGET,
} as const;
export const COMPANION_PROACTIVE_THREAT_CASE_BUDGET =
  COMPANION_PROACTIVE_FOCUSED_CASE_BUDGET;
export const COMPANION_PROACTIVE_THREAT_CASE_DEADLINE_MS =
  COMPANION_PROACTIVE_FOCUSED_CASE_DEADLINE_MS;
export const COMPANION_PROACTIVE_THREAT_RUN_BUDGET =
  COMPANION_PROACTIVE_FOCUSED_RUN_BUDGET;

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

export function parsePlayerGameModeReadback(reply: string): number | undefined {
  const value = /(?:^|:\s*)(\d+)\s*$/u.exec(reply.trim())?.[1];
  if (value === undefined) return undefined;
  const gameMode = Number(value);
  return Number.isSafeInteger(gameMode) ? gameMode : undefined;
}

export interface CompanionProactiveAction {
  readonly kind: string;
  readonly status: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sameLife: boolean;
  readonly recoveryRequired: boolean;
  readonly healthBefore?: number | null;
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
  readonly countTaggedHostile: (
    center: CompanionProactivePosition,
  ) => Promise<number>;
  readonly nearestTaggedHostileDistance: (
    playerPosition: CompanionProactivePosition,
  ) => Promise<number>;
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
  readonly healthUnchanged: boolean;
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
    input.bodyFoodAfter === input.foodAfter &&
    input.healthUnchanged
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

export function proactiveThreatResponseConfirmed(input: {
  readonly ownerPromptCount: number;
  readonly freshPurposeDecision: boolean;
  readonly purposeDecisionLinkedToAction: boolean;
  readonly naturalRegenerationDisabled: boolean;
  readonly freshHostileObservationBefore: boolean;
  readonly bodyHostileCountBefore: number;
  readonly serverHostileCountBefore: number;
  readonly serverDistanceBefore: number;
  readonly bodyDistanceBefore: number;
  readonly bodyServerDistanceAlignedBefore: boolean;
  readonly action: CompanionProactiveAction | undefined;
  readonly actionStartedBeforeDamage: boolean;
  readonly bodyObservationAfterAction: boolean;
  readonly bodyHostileCountAfter: number;
  readonly serverHostileCountAfter: number;
  readonly serverPositionChanged: boolean;
  readonly bodyServerPositionAlignedAfter: boolean;
  readonly bodyDistanceAfter: number;
  readonly serverDistanceAfter: number;
  readonly bodyServerDistanceAlignedAfter: boolean;
  readonly healthBefore: number;
  readonly rconHealthAfter: number;
  readonly bodyHealthBefore: number | null;
  readonly bodyHealthAfter: number | null;
  readonly bodyServerHealthAlignedBefore: boolean;
  readonly bodyServerHealthAlignedAfter: boolean;
}): boolean {
  const action = input.action;
  return (
    input.ownerPromptCount === 0 &&
    input.freshPurposeDecision &&
    input.purposeDecisionLinkedToAction &&
    input.naturalRegenerationDisabled &&
    input.freshHostileObservationBefore &&
    input.serverHostileCountBefore === 1 &&
    input.bodyHostileCountBefore === 1 &&
    input.serverDistanceBefore >= 12 &&
    input.serverDistanceBefore <= 16 &&
    Number.isFinite(input.bodyDistanceBefore) &&
    input.bodyServerDistanceAlignedBefore &&
    action?.status === "successful" &&
    action.sameLife &&
    !action.recoveryRequired &&
    action.healthBefore === input.healthBefore &&
    isThreatPositioningAction(action.kind) &&
    input.actionStartedBeforeDamage &&
    input.bodyObservationAfterAction &&
    input.serverHostileCountAfter === 1 &&
    input.bodyHostileCountAfter === 1 &&
    input.serverPositionChanged &&
    input.bodyServerPositionAlignedAfter &&
    Number.isFinite(input.bodyDistanceAfter) &&
    Number.isFinite(input.serverDistanceAfter) &&
    input.bodyServerDistanceAlignedAfter &&
    input.healthBefore > 0 &&
    input.rconHealthAfter > 0 &&
    input.bodyHealthBefore === input.healthBefore &&
    input.bodyHealthAfter === input.rconHealthAfter &&
    input.bodyServerHealthAlignedBefore &&
    input.bodyServerHealthAlignedAfter
  );
}

function isThreatPositioningAction(kind: string): boolean {
  return kind === "move_to" || kind === "move_relative" || kind === "control";
}

export async function runCompanionProactiveAcceptanceCase(
  port: CompanionProactivePort,
): Promise<Readonly<Record<string, boolean | number | string>>> {
  const phase = companionProactivePhaseForTarget(port.targetCase);
  if (phase === "food") return runFoodPhase(port);
  if (phase === "bed") return runBedPhase(port);
  return runThreatPhase(port);
}

async function runThreatPhase(
  port: CompanionProactivePort,
): Promise<Readonly<Record<string, boolean | number | string>>> {
  const capture = port.captureActions();
  const tag = "ai_e2e_companion_hostile";
  let fixtureTouched = false;
  let cleanupConfirmed = false;
  let fixtureOrigin: CompanionProactivePosition | undefined;
  let result: Readonly<Record<string, boolean | number | string>> | undefined;
  const responseBaseline = port.responses().length;
  try {
    await prepareArena(port, true);
    const positionBefore = await port.readPosition();
    fixtureOrigin = positionBefore;
    const bodyBeforeSpawn = await port.body.observe();
    const healthBefore = await port.readHealth();
    const bodyHealthBefore = bodyBeforeSpawn.self.health;
    if (
      distance(positionBefore, bodyBeforeSpawn.self.position) > 0.75 ||
      healthBefore <= 0 ||
      bodyHealthBefore !== healthBefore
    ) {
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_THREAT_BASELINE_UNCONFIRMED",
      );
    }
    if ((await port.countTaggedHostile(positionBefore)) !== 0)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_THREAT_FIXTURE_BASELINE_NOT_EMPTY",
      );

    const playerBefore = await port.readPlayer();
    const fixtureAt = Date.now();
    fixtureTouched = true;
    await port.rcon.command(
      `summon minecraft:zombie ${positionBefore.x + 14} ${positionBefore.y} ${positionBefore.z} {PersistenceRequired:1b,Tags:["${tag}"]}`,
    );
    const serverCountBefore = await port.countTaggedHostile(positionBefore);
    if (serverCountBefore !== 1)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_THREAT_FIXTURE_COUNT_UNCONFIRMED",
      );
    const positionAfterSpawn = await port.readPosition();
    const serverDistanceAtSpawn =
      await port.nearestTaggedHostileDistance(positionAfterSpawn);

    const hostileObservation = await waitForThreatObservation(
      port,
      fixtureAt,
      5_000,
    );
    if (hostileObservation === undefined)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_THREAT_BODY_OBSERVATION_UNAVAILABLE",
      );
    const aggregate = hostileObservation.perception.nearbyHostiles?.aggregate;
    const bodyHostileCountBefore = aggregate?.clientReceivedHostileCount ?? -1;
    const bodyZombieCountBefore =
      aggregate?.byKind.find(({ name }) => name === "zombie")?.count ?? -1;
    const bodyDistanceBefore = nearestBodyHostileDistance(hostileObservation);
    const serverPositionAtObservation = await port.readPosition();
    const serverDistanceBefore = await port.nearestTaggedHostileDistance(
      serverPositionAtObservation,
    );
    const serverHostileCountAtObservation = await port.countTaggedHostile(
      serverPositionAtObservation,
    );
    const bodyServerPositionAlignedBefore =
      distance(serverPositionAtObservation, hostileObservation.self.position) <=
      0.75;
    const bodyServerDistanceAlignedBefore =
      bodyDistanceBefore !== null &&
      Math.abs(bodyDistanceBefore - serverDistanceBefore) <= 2;
    let firstDamageAt: number | undefined;
    const healthAtHostileObservation = await port.readHealth();
    if (healthAtHostileObservation < healthBefore) firstDamageAt = fixtureAt;
    const preObservationConfirmed =
      Date.parse(hostileObservation.observedAt) >= fixtureAt &&
      bodyHostileCountBefore === 1 &&
      bodyZombieCountBefore === 1 &&
      serverHostileCountAtObservation === 1 &&
      serverDistanceAtSpawn >= 12 &&
      serverDistanceAtSpawn <= 16 &&
      bodyDistanceBefore !== null &&
      bodyServerPositionAlignedBefore;
    port.updateDiagnostic({
      proactivePhase: "threat",
      ownerPromptCount: 0,
      fixtureActionsExcludedFromAcceptance: true,
      fixtureCountBefore: serverCountBefore,
      healthAtHostileObservation,
      bodyHostileCountBefore,
      bodyZombieCountBefore,
      hostileObservationFresh:
        Date.parse(hostileObservation.observedAt) >= fixtureAt,
      startDistance: serverDistanceAtSpawn,
      distanceAtBodyObservation: serverDistanceBefore,
      bodyStartDistance: bodyDistanceBefore ?? -1,
      bodyServerDistanceAlignedBefore,
      bodyServerPositionAlignedBefore,
      healthBefore,
      bodyHealthBefore,
      bodyServerHealthAlignedBefore: bodyHealthBefore === healthBefore,
      preObservationConfirmed,
    });
    if (!preObservationConfirmed)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_THREAT_FIXTURE_NOT_CONFIRMED",
      );

    let latest: Readonly<Record<string, boolean | number | string>> = {};
    let bodyPositionChanged = false;
    const after = await port.observeForPlayer(7 * 60_000, async (player) => {
      const bodyAfter = await port.body.observe();
      const rconHealthAfter = await port.readHealth();
      const bodyHealthAfter = bodyAfter.self.health;
      if (firstDamageAt === undefined && rconHealthAfter < healthBefore)
        firstDamageAt = Date.now();
      const positionAfter = await port.readPosition();
      bodyPositionChanged =
        distance(serverPositionAtObservation, positionAfter) > 0.05;
      const fixtureCountAfter = await port.countTaggedHostile(positionBefore);
      const serverDistanceAfter =
        fixtureCountAfter === 1
          ? await port.nearestTaggedHostileDistance(positionAfter)
          : -1;
      const bodyHostileCountAfter =
        bodyAfter.perception.nearbyHostiles?.aggregate
          ?.clientReceivedHostileCount ?? -1;
      const bodyZombieCountAfter =
        bodyAfter.perception.nearbyHostiles?.aggregate?.byKind.find(
          ({ name }) => name === "zombie",
        )?.count ?? -1;
      const bodyDistanceAfter = nearestBodyHostileDistance(bodyAfter);
      const bodyServerPositionAlignedAfter =
        distance(positionAfter, bodyAfter.self.position) <= 0.75;
      const bodyServerDistanceAlignedAfter =
        bodyDistanceAfter !== null &&
        serverDistanceAfter >= 0 &&
        Math.abs(bodyDistanceAfter - serverDistanceAfter) <= 2;
      const positioningActions = capture.actions.filter(
        ({ kind, startedAt }) =>
          Date.parse(startedAt) >= fixtureAt &&
          Date.parse(startedAt) >= Date.parse(hostileObservation.observedAt) &&
          isThreatPositioningAction(kind),
      );
      const action =
        positioningActions.find(
          ({ status, sameLife, recoveryRequired }) =>
            status === "successful" && sameLife && !recoveryRequired,
        ) ?? positioningActions.at(-1);
      const actionStartedAt = Date.parse(action?.startedAt ?? "");
      const actionCompletedAt = Date.parse(action?.completedAt ?? "");
      const latestBodyAction = capture.actions
        .filter(({ startedAt }) => Date.parse(startedAt) >= fixtureAt)
        .at(-1);
      const purposeDecisionLinkedToAction =
        action !== undefined &&
        isFreshPurposeDecisionForAction(
          playerBefore,
          player,
          action,
          fixtureAt,
        );
      const actionStartedBeforeDamage =
        action !== undefined &&
        (firstDamageAt === undefined || actionStartedAt < firstDamageAt);
      const bodyActionStartHealthMatchesBaseline =
        action?.healthBefore === healthBefore;
      const bodyObservationAfterAction =
        action !== undefined &&
        Number.isFinite(actionCompletedAt) &&
        Date.parse(bodyAfter.observedAt) >= actionCompletedAt;
      const freshDecision = freshPurposeDecision(playerBefore, player);
      const ownerPromptCount = 0;
      const accepted = proactiveThreatResponseConfirmed({
        ownerPromptCount,
        freshPurposeDecision: freshDecision,
        purposeDecisionLinkedToAction,
        naturalRegenerationDisabled: true,
        freshHostileObservationBefore: preObservationConfirmed,
        bodyHostileCountBefore,
        serverHostileCountBefore: serverCountBefore,
        serverDistanceBefore: serverDistanceAtSpawn,
        bodyDistanceBefore,
        bodyServerDistanceAlignedBefore,
        action,
        actionStartedBeforeDamage,
        bodyObservationAfterAction,
        bodyHostileCountAfter,
        serverHostileCountAfter: fixtureCountAfter,
        serverPositionChanged: bodyPositionChanged,
        bodyServerPositionAlignedAfter,
        bodyDistanceAfter: bodyDistanceAfter ?? -1,
        serverDistanceAfter,
        bodyServerDistanceAlignedAfter,
        healthBefore,
        rconHealthAfter,
        bodyHealthBefore,
        bodyHealthAfter,
        bodyServerHealthAlignedBefore: bodyHealthBefore === healthBefore,
        bodyServerHealthAlignedAfter: bodyHealthAfter === rconHealthAfter,
      });
      latest = {
        proactivePhase: "threat",
        ownerPromptCount,
        freshPurposeDecisionObserved: freshDecision,
        purposeDecisionLinkedToBodyAction: purposeDecisionLinkedToAction,
        fixtureCountBefore: serverCountBefore,
        healthAtHostileObservation,
        fixtureCountAfter,
        hostileObservationFresh: true,
        bodyHostileCountBefore,
        bodyZombieCountBefore,
        bodyHostileCountAfter,
        bodyZombieCountAfter,
        startDistance: serverDistanceAtSpawn,
        distanceAtBodyObservation: serverDistanceBefore,
        bodyStartDistance: bodyDistanceBefore,
        distanceAfter: serverDistanceAfter,
        bodyDistanceAfter: bodyDistanceAfter ?? -1,
        bodyServerDistanceAlignedBefore,
        bodyServerDistanceAlignedAfter,
        bodyServerPositionAlignedBefore,
        bodyServerPositionAlignedAfter,
        serverPositionChangeBlocks: distance(
          serverPositionAtObservation,
          positionAfter,
        ),
        bodyPositionChanged,
        bodyActionObserved: action !== undefined,
        bodyActionKind: action?.kind ?? "none",
        bodyActionSuccessful: action?.status === "successful",
        bodyActionSameLife: action?.sameLife === true,
        bodyActionRecoveryRequired: action?.recoveryRequired === true,
        bodyActionIsPositioning: isThreatPositioningAction(action?.kind ?? ""),
        bodyActionStartHealth: action?.healthBefore ?? -1,
        bodyActionStartHealthMatchesBaseline,
        positioningActionCount: positioningActions.length,
        latestBodyActionKind: latestBodyAction?.kind ?? "none",
        bodyActionStartedBeforeDamage: actionStartedBeforeDamage,
        bodyObservationAfterAction,
        firstDamageObserved: firstDamageAt !== undefined,
        firstDamageAfterBodyAction:
          firstDamageAt === undefined ||
          (action !== undefined && actionStartedAt < firstDamageAt),
        ownerReplyCount: port.responses().length - responseBaseline,
        healthBefore,
        healthAfter: rconHealthAfter,
        bodyHealthBefore,
        bodyHealthAfter: bodyHealthAfter ?? -1,
        bodyServerHealthAlignedBefore: bodyHealthBefore === healthBefore,
        bodyServerHealthAlignedAfter: bodyHealthAfter === rconHealthAfter,
        responseConfirmed: accepted,
      };
      port.updateDiagnostic(latest);
      return accepted;
    });
    if (after === undefined)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_THREAT_RESPONSE_NOT_CONFIRMED",
      );
    result = latest;
  } finally {
    capture.restore();
    if (fixtureTouched) {
      await port.rcon
        .command(`kill @e[type=minecraft:zombie,tag=${tag}]`)
        .catch(() => undefined);
      cleanupConfirmed =
        fixtureOrigin !== undefined &&
        (await port.countTaggedHostile(fixtureOrigin).catch(() => -1)) === 0;
    }
    port.updateDiagnostic({ fixtureCleanupConfirmed: cleanupConfirmed });
  }
  if (!cleanupConfirmed)
    throw new CompanionProactiveAcceptanceError(
      "PROACTIVE_THREAT_FIXTURE_CLEANUP_UNCONFIRMED",
    );
  return result;
}

async function waitForThreatObservation(
  port: CompanionProactivePort,
  fixtureAt: number,
  timeoutMs: number,
): Promise<PlayerBodyObservation | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = await port.body.observe();
    const aggregate = observation.perception.nearbyHostiles?.aggregate;
    const fresh = Date.parse(observation.observedAt) >= fixtureAt;
    const zombieCount =
      aggregate?.byKind.find(({ name }) => name === "zombie")?.count ?? 0;
    if (
      fresh &&
      aggregate?.clientReceivedHostileCount === 1 &&
      zombieCount === 1
    )
      return observation;
    await sleep(200);
  }
  return undefined;
}

function nearestBodyHostileDistance(
  observation: PlayerBodyObservation,
): number | null {
  const distances =
    observation.perception.nearbyHostiles?.aggregate?.byDirection
      .map(({ nearestDistance }) => nearestDistance)
      .filter((value): value is number => value !== null) ?? [];
  return distances.length === 0 ? null : Math.min(...distances);
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

function isFreshPurposeDecisionForAction(
  before: PlayerEvidence,
  after: PlayerEvidence,
  action: CompanionProactiveAction,
  fixtureAt: number,
): boolean {
  const priorRevisions = new Set(
    before.recentJudgments.map(({ revision }) => revision),
  );
  const actionStartedAt = Date.parse(action.startedAt);
  return after.recentJudgments.some((judgment) => {
    const decidedAt = Date.parse(judgment.decidedAt ?? "");
    return (
      judgment.revision !== undefined &&
      !priorRevisions.has(judgment.revision) &&
      judgment.kind === "act" &&
      judgment.operationKind === action.kind &&
      Number.isFinite(decidedAt) &&
      decidedAt >= fixtureAt &&
      decidedAt <= actionStartedAt
    );
  });
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
  const foodItem = "bread";
  let origin: CompanionProactivePosition | undefined;
  let touchedDrop = false;
  const responseBaseline = port.responses().length;
  try {
    await prepareArena(port);
    const foodFixtureStartFood = await port.readFoodLevel();
    const foodFixtureStartHealth = await port.readHealth();
    await port.rcon.command(
      `effect give ${port.botName} minecraft:hunger 120 40 true`,
    );
    const hungerDeadline = Date.now() + 45_000;
    const hungerEffectAppliedAt = Date.now();
    let foodBefore = await port.readFoodLevel();
    let hungerSamples = 1;
    while (foodBefore > 8 && Date.now() < hungerDeadline) {
      await sleep(200);
      foodBefore = await port.readFoodLevel();
      hungerSamples += 1;
    }
    const hungerHealthAtStop = await port.readHealth();
    const hungerBandConfirmed = foodBefore >= 6 && foodBefore <= 8;
    port.updateDiagnostic({
      foodFixtureAmplifier: 40,
      foodFixtureDeadlineMs: 45_000,
      foodFixturePollIntervalMs: 200,
      foodFixtureStartFood,
      foodFixtureStartHealth,
      foodFixtureObservedFood: foodBefore,
      foodFixtureObservedHealth: hungerHealthAtStop,
      foodFixtureElapsedMs: Date.now() - hungerEffectAppliedAt,
      foodFixtureSampleCount: hungerSamples,
      foodFixtureBandConfirmed: hungerBandConfirmed,
      foodFixtureHealthPreserved:
        foodFixtureStartHealth === 20 && hungerHealthAtStop === 20,
    });
    if (foodBefore < 6 || foodBefore > 8)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_FOOD_HUNGER_FIXTURE_UNAVAILABLE",
      );
    await port.rcon.command(`effect clear ${port.botName} minecraft:hunger`);
    const bodyBefore = await port.body.observe();
    const healthBefore = await port.readHealth();
    foodBefore = await port.readFoodLevel();
    if (
      foodBefore < 6 ||
      foodBefore > 8 ||
      healthBefore !== 20 ||
      bodyBefore.self.food !== foodBefore ||
      bodyBefore.self.health !== 20
    ) {
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_FOOD_BODY_BASELINE_UNCONFIRMED",
      );
    }
    const serverInventoryBefore = await port.readInventoryCount(foodItem);
    const bodyInventoryBefore = bodyBefore.self.inventory
      .filter(({ name }) => name === foodItem)
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
      `summon minecraft:item ${fixtureCenter.x + 4} ${fixtureCenter.y} ${fixtureCenter.z + 0.2} {Item:{id:"minecraft:${foodItem}",count:1b},Age:-32768s,Tags:["${tag}"]}`,
    );
    const dropBefore = await port.countTaggedDrop(tag, foodItem, fixtureCenter);
    if (dropBefore !== 1)
      throw new CompanionProactiveAcceptanceError(
        "PROACTIVE_FOOD_DROP_FIXTURE_UNAVAILABLE",
      );
    const dropPosition = await port.readTaggedDropPosition(
      tag,
      foodItem,
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
        droppedItem?.name === foodItem &&
        distance(position, dropPosition) <= 0.75,
    );
    const visibleDrop = visibleDrops[0];
    const preServerInventory = await port.readInventoryCount(foodItem);
    const preBodyInventory = preObservation.self.inventory
      .filter(({ name }) => name === foodItem)
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
    const after = await port.observeForPlayer(3 * 60_000, async (player) => {
      bodyAfter = await port.body.observe();
      const inventory = await port.readInventoryCount(foodItem);
      const bodyInventory = bodyAfter.self.inventory
        .filter(({ name }) => name === foodItem)
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
          : await port.countTaggedDrop(tag, foodItem, fixtureCenter);
      const bodyFoodAfter = bodyAfter.self.food;
      const bodyHealthAfter = bodyAfter.self.health;
      const healthUnchanged = healthAfter === 20 && bodyHealthAfter === 20;
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
        bodyHealthServerAligned:
          bodyHealthAfter !== null && bodyHealthAfter === healthAfter,
        healthUnchanged,
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
        healthUnchanged,
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
        foodItem,
        fixtureCenter,
      ),
      foodBefore,
      foodAfter,
      bodyFoodAfter: bodyAfter.self.food ?? -1,
      bodyFoodServerAligned: bodyAfter.self.food === foodAfter,
      healthBefore,
      healthAfter,
      bodyHealthAfter: bodyAfter.self.health ?? -1,
      bodyHealthServerAligned: bodyAfter.self.health === healthAfter,
      healthUnchanged: healthAfter === 20 && bodyAfter.self.health === 20,
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
        .command(`clear ${port.botName} minecraft:${foodItem}`)
        .catch(() => undefined);
      await port.rcon
        .command(`effect clear ${port.botName}`)
        .catch(() => undefined);
      port.updateDiagnostic({
        fixtureCleanupConfirmed:
          origin !== undefined &&
          (await port
            .countTaggedDrop(tag, foodItem, origin)
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

async function prepareArena(
  port: CompanionProactivePort,
  forThreat = false,
): Promise<void> {
  await port.setGamerule("advanceTime", false);
  await port.setGamerule("spawnMobs", false);
  if (forThreat) await port.setGamerule("naturalRegeneration", false);
  const radius = forThreat ? 24 : 12;
  await port.rcon.command(
    `fill -${radius} 64 -${radius} ${radius} 72 ${radius} air`,
  );
  await port.rcon.command(
    `fill -${radius} 63 -${radius} ${radius} 63 ${radius} stone`,
  );
  await port.rcon.command(`effect clear ${port.botName}`);
  await port.rcon.command(`clear ${port.botName}`);
  await port.rcon.command(`time set ${forThreat ? 18_000 : 1_000}`);
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
