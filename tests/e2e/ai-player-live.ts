import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import {
  copyFile,
  cp,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { config as loadEnvironmentFile } from "dotenv";
import mineflayer, { type Bot } from "mineflayer";
import { ZodError } from "zod";

import { AppError, errorCategories } from "../../src/domain/errors.js";
import type {
  CompanionApplication,
  createApplication,
} from "../../src/app/application.js";
import { loadConfig } from "../../src/config/load-config.js";
import { MineflayerClient } from "../../src/minecraft/mineflayer-client.js";
import {
  MineflayerPlayerBody,
  type PlayerBody,
  type PlayerItemCollectionOutcome,
  type PlayerItemCollectionPathFailureReason,
  type PlayerBodyObservationOptions,
} from "../../src/minecraft/player-body.js";
import type { PlayerBodyObservation } from "../../src/minecraft/player-body-observation.js";
import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";
import {
  projectSafePlayerAgentActivityTail,
  type PlayerAgentRoundActivity,
  type PlayerAgentToolName,
} from "../../src/player/responses.js";
import { hasPersistedOwnerFact } from "./persistent-fact-oracle.js";
import {
  GATHER_MULTI_TARGET_ITEMS,
  gatherMultiTargetBodySmokeSafeFailureEvidence,
  gatherMultiTargetInventorySafeEvidence,
  gatherMultiTargetOracleProbeBaselineFailureFields,
  gatherMultiTargetOracleProbeResultFailureFields,
  readGatherMultiTargetInventory,
  shouldRunGatherMultiTargetOracleProbe,
  type GatherMultiTargetItem,
} from "./gather-multi-target-acceptance.js";
import {
  classifyGatherDropReadbackFailure,
  classifyGatherDropReadbackReply,
  gatherFixtureCleanupProofConfirmed,
  type GatherDropReadbackClass,
} from "./gather-drop-readback.js";
import {
  gatherTargetAcceptedGoalCount,
  hasResolvedGatherTargetOwnerGoal,
  newGatherTargetProposalIds,
  summarizeSuccessfulGatherBodyOutcomes,
} from "./gather-target-continuity.js";
import {
  explainsFullHunger,
  hasNewConsumeDecisionSince,
  hasNewNonConsumingDecisionSince,
  hasNewResolvedOwnerProposalSince,
} from "./food-intent-full-stage.js";
import {
  classifyFurnaceRconReply,
  type FurnaceRconReplyClass,
} from "./furnace-rcon-classifier.js";
import {
  blockIs,
  classifyRconReply,
  classifyTickStatus,
  cloneBaseline,
  destinationRegion,
  establishBaseline,
  forceLoadRegion,
  parseScore,
  regionsEqual,
  withFrozenTicks,
  type OracleRcon,
} from "./world-oracle.js";
import { captureReproducibleUnknownWorldBaseline } from "./unknown-world-baseline.js";
import {
  deathRecoveryDropConfirmed,
  isNoEntitySelectionReply,
  safeEntityCountBucket,
} from "./death-recovery-fixture.js";
import {
  createLlmCallAdmission,
  LlmCallAdmissionError,
  type LlmCallAdmission,
} from "./llm-call-admission.js";
import {
  AcceptedProviderRequestGate,
  classifyAcceptedProviderRequestUsage,
  NoFoodReplanRequestGate,
  waitForAcceptedProviderRequestsSettled,
  type AcceptedProviderRequestSettleStatus,
} from "./no-food-replan-request-gate.js";
import {
  isNewFailureAfterUnfreeze,
  recoveryCagePlan,
  waitForRecoveryObstacleReadiness,
  withRestorableObstacle,
} from "./unknown-recovery-obstacle.js";
import {
  hasCancellationOutcomeForOperation,
  hasJudgmentAfterSuccessfulOutcome,
  hasNewActiveOwnerProposalGoal,
  hasTerminalOutcomeForOperation,
  isStoppedHandoffBoundaryConfirmed,
  ownerApproachReductionBucket,
} from "./autonomous-milestone.js";
import { classifyObservationReply } from "./observation-reply-classifier.js";
import {
  classifyUnknownTaskVisibility,
  isSameStartedTravelOperation,
  isFacingUnknownFixture,
  parseEntityRotation,
  safeUnknownOperationKind,
  unknownHandoffCaseBlockCode,
  UNKNOWN_FIXTURE_PITCH,
  UNKNOWN_FIXTURE_YAW,
  type SafeUnknownOperationKind,
  type UnknownHandoffDependencyState,
} from "./unknown-composite-diagnostic.js";
import {
  projectPlayerSnapshot,
  writePlayerSnapshotRecord,
} from "./player-snapshot-sidecar.js";
import {
  recordUnknownTaskProgressSample,
  unknownDistanceBucket,
  unknownDistanceImprovedByMinimum,
  type UnknownDistanceBucket,
  type UnknownTaskProgressAggregate,
  type UnknownTaskProgressSampleStatus,
} from "./unknown-task-progress.js";
import {
  inspectPersistentMemoryProgress,
  maxAgentActivityRunSequence,
  type PersistentMemoryProgress,
} from "./persistent-memory-diagnostic.js";
import {
  angularDistance,
  classifyLearningFixtureOrientation,
  javaYawForDirection,
  type LearningFixtureOrientationDiagnostic,
} from "./learning-fixture-orientation.js";
import {
  countBoundedConsultedSkillIds,
  firstDigLearningDiagnostic,
  firstDigLearningEvidence,
  receiptLinkedConsultedRevisionForOutcome,
  type FirstDigLearningDiagnostic,
  type LearningHypothesisSnapshot,
} from "./learning-reuse-acceptance.js";
import {
  isCaseSelectedForTarget,
  isGatherMultiTargetCaseSelected,
  isOwnerStopLatchTargeted,
  TARGETABLE_CASES,
  type TargetableCase,
} from "./target-case-selection.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_JAVA_HOME =
  "/usr/local/Cellar/openjdk@21/21.0.10/libexec/openjdk.jdk/Contents/Home";
const SERVER_VERSION = "1.21.11";
const MODEL = "gpt-6-luna";
const WORLD_SEED = "720926";
const E2E_GAMERULES = {
  advanceTime: {
    id: "minecraft:advance_time",
    readbackFailure: "WORLD_ADVANCE_TIME_READBACK_MISMATCH",
  },
  spawnMobs: {
    id: "minecraft:spawn_mobs",
    readbackFailure: "WORLD_SPAWN_MOBS_READBACK_MISMATCH",
  },
  keepInventory: {
    id: "minecraft:keep_inventory",
    readbackFailure: "WORLD_KEEP_INVENTORY_READBACK_MISMATCH",
  },
  respawnRadius: {
    id: "minecraft:respawn_radius",
    readbackFailure: "WORLD_RESPAWN_RADIUS_READBACK_MISMATCH",
  },
  naturalRegeneration: {
    id: "minecraft:natural_health_regeneration",
    readbackFailure: "DAMAGE_RESPONSE_REGENERATION_STATE_UNAVAILABLE",
  },
} as const;
const REGION = { minX: -12, minY: 63, minZ: -12, maxX: 12, maxY: 72, maxZ: 12 };
const REGION_BASELINE = { x: 1_000, y: 63, z: 1_000 };
// The spread covers the 110-degree horizontal view cone; east stays in front of the hidden wall.
const AUTONOMOUS_RESOURCE_FIXTURE = [
  { x: 1, y: 64, z: 0 },
  { x: 0, y: 64, z: -6 },
  { x: 0, y: 64, z: 6 },
  { x: -4, y: 64, z: -1 },
  { x: -1, y: 64, z: 1 },
] as const;
const RUN_BUDGET_LIMITS = {
  durationMs: 45 * 60_000,
  llmCalls: 160,
  totalTokens: 800_000,
} as const;
const UNKNOWN_OBSTACLE_RCON_TIMEOUT_MS = 2_000;
const UNKNOWN_OBSTACLE_READINESS_WINDOW_MS = 1_000;
const UNKNOWN_OBSTACLE_READINESS_POLL_MS = 100;
const UNKNOWN_OBSTACLE_READINESS_RCON_TIMEOUT_MS = 200;
const UNKNOWN_POST_PICKUP_SAMPLE_LIMIT = 64;
const DEFAULT_RUN_BUDGET = RUN_BUDGET_LIMITS;
// Logs are placed near the player's feet, so observe with a modest downward pitch.
const LEARNING_FIXTURE_PITCH = 15;
const ROTATION_READ_MAX_ATTEMPTS = 3;
const ROTATION_READ_RETRY_DELAY_MS = 100;
export const DAMAGE_RESPONSE_CASE_BUDGET = {
  llmCalls: 16,
  totalTokens: 150_000,
} as const;
export function damageResponseObservationTimeoutMs(
  caseDeadlineAt: number,
  now = Date.now(),
): number {
  return Math.max(1, caseDeadlineAt - now);
}
export const OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET = {
  llmCalls: 24,
  totalTokens: 160_000,
} as const;
export const OWNER_RETURN_THROUGH_DOOR_CASE_DEADLINE_MS = 8 * 60_000;
export const NO_FOOD_REPLAN_CASE_BUDGET = {
  llmCalls: 10,
  totalTokens: 100_000,
} as const;
export const NO_FOOD_REPLAN_CASE_DEADLINE_MS = 4 * 60_000;
export const PARALLEL_DIALOGUE_STOP_CASE_BUDGET = {
  llmCalls: 64,
  totalTokens: 480_000,
} as const;
export const PARALLEL_DIALOGUE_STOP_CASE_DEADLINE_MS = 20 * 60_000;
export const OWNER_STOP_LATCH_CASE_BUDGET = {
  llmCalls: 48,
  totalTokens: 240_000,
} as const;
export const OWNER_STOP_LATCH_CASE_DEADLINE_MS = 14 * 60_000;
const CASE_BUDGETS = {
  runtime_contract: { llmCalls: 2, totalTokens: 25_000 },
  owner_return_through_door: OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET,
  autonomous_life: { llmCalls: 18, totalTokens: 100_000 },
  unknown_composite: { llmCalls: 48, totalTokens: 390_000 },
  observation_boundary: { llmCalls: 6, totalTokens: 35_000 },
  persistent_memory_restart: { llmCalls: 8, totalTokens: 60_000 },
  learning_reuse: { llmCalls: 60, totalTokens: 600_000 },
  skill_compactness_and_knowledge_separation: {
    llmCalls: 2,
    totalTokens: 25_000,
  },
  skill_exchange: { llmCalls: 40, totalTokens: 380_000 },
  game_action_discretion: { llmCalls: 20, totalTokens: 100_000 },
  food_intent_continuity: { llmCalls: 44, totalTokens: 360_000 },
  gather_multi_target_continuity: { llmCalls: 64, totalTokens: 600_000 },
  damage_response: DAMAGE_RESPONSE_CASE_BUDGET,
  no_food_replan: NO_FOOD_REPLAN_CASE_BUDGET,
  parallel_dialogue_stop: PARALLEL_DIALOGUE_STOP_CASE_BUDGET,
  owner_stop_latch: OWNER_STOP_LATCH_CASE_BUDGET,
  integrated_result: { llmCalls: 0, totalTokens: 0 },
} as const;
const CASE_DEADLINES = {
  runtime_contract: 60_000,
  owner_return_through_door: OWNER_RETURN_THROUGH_DOOR_CASE_DEADLINE_MS,
  autonomous_life: 5 * 60_000,
  unknown_composite: 7 * 60_000,
  observation_boundary: 4 * 60_000,
  persistent_memory_restart: 5 * 60_000,
  learning_reuse: 8 * 60_000,
  skill_compactness_and_knowledge_separation: 30_000,
  skill_exchange: 8 * 60_000,
  game_action_discretion: 6 * 60_000,
  food_intent_continuity: 8 * 60_000,
  gather_multi_target_continuity: 12 * 60_000,
  damage_response: 8 * 60_000,
  no_food_replan: NO_FOOD_REPLAN_CASE_DEADLINE_MS,
  parallel_dialogue_stop: PARALLEL_DIALOGUE_STOP_CASE_DEADLINE_MS,
  owner_stop_latch: OWNER_STOP_LATCH_CASE_DEADLINE_MS,
  integrated_result: 30_000,
} as const;

type Status = "pass" | "fail" | "incomplete";
type UsageStatus = "runtime_reported" | "partial_or_unknown";
interface SafeCaseResult {
  readonly id: string;
  readonly status: Status;
  readonly durationMs: number;
  readonly llmCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly usageStatus: UsageStatus;
  readonly evidence: SafeEvidence;
  readonly reason?: string;
}

type PlayerOperationName = (typeof playerOperationNames)[number];
type PlayerJudgmentKind = "act" | "wait" | "continue" | "complete";
type PlayerOutcomeStatus =
  "successful" | "failed" | "interrupted" | "cancelled" | "unverified";
type LearningReuseStage =
  | "initial_fixture_visible"
  | "first_dig_confirmed"
  | "first_dig_hypothesis_verified"
  | "reuse_fixture_visible"
  | "reuse_result_confirmed"
  | "revision_verified";
type LearningFixturePhase = "initial" | "reuse";
type SkillExchangeStage =
  | "export_requested"
  | "export_confirmed"
  | "import_requested"
  | "import_confirmed"
  | "duplicate_requested"
  | "duplicate_confirmed"
  | "consult_requested"
  | "consulted"
  | "game_action_confirmed";
type GameActionFixtureHoleReadback = "oak_planks" | "air" | "unknown";
interface GameActionPlacementCandidateDiagnostic {
  readonly freshBodyObservationMatched: boolean;
  readonly fixtureHoleCandidatePresent?: boolean;
  readonly placementCandidatesMayBeTruncated?: boolean;
  readonly placementCandidateCount?: number;
}
interface GameActionPlacementObservationSummary {
  readonly fixtureHoleCandidatePresent: boolean;
  readonly placementCandidatesMayBeTruncated: boolean;
  readonly placementCandidateCount: number;
}
interface GameActionPlacementObservationProbe {
  readonly target: BlockPosition;
  freshAfter: number;
  readonly observationsByTime: Map<
    string,
    GameActionPlacementObservationSummary
  >;
}
interface NoFoodContinuityDiagnostic {
  readonly startupBodyObservationAvailable: boolean;
  readonly startupStateConfirmed: boolean;
  readonly bodyHealth: number | null;
  readonly rconHealth: number | null;
  readonly bodyFood: number | null;
  readonly rconFood: number | null;
  readonly bodyInventoryEmpty: boolean;
  readonly rconInventoryEmpty: boolean;
}
type NoFoodReplanDecisionClass =
  | "consume"
  | "alternative"
  | "wait"
  | "complete"
  | "continue"
  | "unknown"
  | "not_observed";
type NoFoodReplanOutcomeStatus =
  | "successful"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "unverified"
  | "not_observed";
interface NoFoodReplanDiagnostic {
  startupStateConfirmed: boolean;
  purposeDecision: NoFoodReplanDecisionClass;
  outcomeStatus: NoFoodReplanOutcomeStatus;
  alternativeSuccessfulBodyOutcomeObserved: boolean;
  reassessmentObserved: boolean;
  repeatedFailedOperationUnderUnchangedState: boolean;
  waitReasonAndWakeConditionPresent: boolean;
  waitWakeReassessmentObserved: boolean;
  postOutcomeNoFoodStateConfirmed: boolean;
  postOutcomePurposeJudgmentObserved: boolean;
}
const EMPTY_NO_FOOD_REPLAN_DIAGNOSTIC: NoFoodReplanDiagnostic = {
  startupStateConfirmed: false,
  purposeDecision: "not_observed",
  outcomeStatus: "not_observed",
  alternativeSuccessfulBodyOutcomeObserved: false,
  reassessmentObserved: false,
  repeatedFailedOperationUnderUnchangedState: false,
  waitReasonAndWakeConditionPresent: false,
  waitWakeReassessmentObserved: false,
  postOutcomeNoFoodStateConfirmed: false,
  postOutcomePurposeJudgmentObserved: false,
};
const EMPTY_NO_FOOD_CONTINUITY_DIAGNOSTIC: NoFoodContinuityDiagnostic = {
  startupBodyObservationAvailable: false,
  startupStateConfirmed: false,
  bodyHealth: null,
  rconHealth: null,
  bodyFood: null,
  rconFood: null,
  bodyInventoryEmpty: false,
  rconInventoryEmpty: false,
};
interface LearningFixtureDiagnostic {
  readonly phase: LearningFixturePhase;
  readonly placementConfirmedCount: number;
  readonly freshBodyObservationSeen: boolean;
  readonly oakLogVisibleInFreshObservation: boolean;
  readonly activeOperationAtOrient?: boolean;
  readonly yawMatched?: boolean;
  readonly pitchMatched?: boolean;
}
interface LearningFixtureOrientationReadback extends LearningFixtureOrientationDiagnostic {
  readonly position: Position;
}
type SafeEvidenceValue =
  boolean | number | string | null | readonly PlayerAgentRoundActivity[];
type SafeEvidence = Readonly<Record<string, SafeEvidenceValue>>;

interface SafeAutonomousProgress {
  readonly autonomousGoalSeen: boolean;
  readonly activitySeen: boolean;
  readonly successfulActionSeen: boolean;
  readonly worldProgressSeen: boolean;
  readonly successfulOutcomeCount: number;
  readonly followupJudgmentSeen: boolean;
  readonly milestoneSeen: boolean;
  readonly activeOperationPresent: boolean;
  readonly activeBodyStarted: boolean;
  readonly activeBodyElapsedBucket: string;
}

type UnknownObstacleStatus =
  | "not_attempted"
  | "skipped_ineligible"
  | "incomplete_before_mutation"
  | "injection_incomplete_restored"
  | "applied_without_failure"
  | "applied_failure_observed"
  | "restore_failed";

type UnknownObstaclePhase =
  | "eligibility_checked"
  | "backup_verified"
  | "eligibility_lost"
  | "mutation_started"
  | "mutation_verified"
  | "observation_started"
  | "restore_started"
  | "restore_verified"
  | "mutation_failed";

type UnknownObstacleReadinessStatus =
  | "ready"
  | "operation_changed"
  | "standing_space_unavailable"
  | "other_entities_not_clear"
  | "oracle_unavailable";
type UnknownMoveOperationKind = "move_to" | "move_relative";

interface UnknownCompositeDiagnostic {
  readonly unknownTargetInitiallyPresent?: boolean;
  readonly unknownOracleReadStatus?: "available" | "incomplete";
  readonly unknownOracleChecked?: boolean;
  readonly unknownOracleReadCount?: number;
  readonly unknownTargetCleared?: boolean;
  readonly unknownNearTargetServerSampleSeen?: boolean;
  readonly unknownNearTargetFreshBodyObservationSeen?: boolean;
  readonly unknownNearTargetVisibleInBodyObservation?: boolean;
  readonly unknownItemReturned?: boolean;
  readonly unknownReturnedToSpawn?: boolean;
  readonly unknownServerProgressObserved?: boolean;
  readonly unknownWallFixtureConfirmed?: boolean;
  readonly unknownDryGroundFixtureConfirmed?: boolean;
  readonly unknownSideRouteConfirmed?: boolean;
  readonly unknownInitialViewCorridorConfirmed?: boolean;
  readonly unknownSideViewCorridorConfirmed?: boolean;
  readonly unknownTaskObservationStatus?: "available" | "unknown";
  readonly unknownTaskTargetBlockVisible?: boolean;
  readonly unknownTaskWallMaterialVisible?: boolean;
  readonly unknownPostTaskProgressSampleStatus?: UnknownTaskProgressSampleStatus;
  readonly unknownPostTaskProgressSampleCount?: number;
  readonly unknownPostTaskProgressSampleLimitReached?: boolean;
  readonly unknownPostTaskMaxDisplacementBucket?: UnknownDistanceBucket;
  readonly unknownPostTaskNearestTargetDistanceBucket?: UnknownDistanceBucket;
  readonly unknownPostTaskMovedCloserToTarget?: boolean;
  readonly unknownPostTaskBlocksProgressObserved?: boolean;
  readonly unknownPostTaskPositionProgressObserved?: boolean;
  readonly unknownPostTaskInventoryProgressObserved?: boolean;
  readonly unknownPostPickupProgressSampleStatus?: UnknownTaskProgressSampleStatus;
  readonly unknownPostPickupProgressSampleCount?: number;
  readonly unknownPostPickupRuntimeSampleMissing?: boolean;
  readonly unknownPostPickupStartingSpawnDistanceBucket?: UnknownDistanceBucket;
  readonly unknownPostPickupCurrentSpawnDistanceBucket?: UnknownDistanceBucket;
  readonly unknownPostPickupNearestSpawnDistanceBucket?: UnknownDistanceBucket;
  readonly unknownPostPickupMovedCloserToSpawn?: boolean;
  readonly unknownPostPickupLastMoveOperationKind?: UnknownMoveOperationKind;
  readonly unknownFixtureFacingCommanded?: boolean;
  readonly unknownFixtureFacingReadbackAvailable?: boolean;
  readonly unknownFixtureFacingConfirmed?: boolean;
  readonly unknownPreTaskObservationStatus?: "available" | "unknown";
  readonly unknownPreTaskTargetBlockVisible?: boolean;
  readonly unknownPreTaskWallMaterialVisible?: boolean;
  readonly unknownFailureObserved?: boolean;
  readonly unknownFailureSource?: "natural" | "controlled_obstacle";
  readonly unknownFailureOperationKind?: SafeUnknownOperationKind;
  readonly unknownPostFailureObservationSeen?: boolean;
  readonly unknownPostFailureObservationAfterRestore?: boolean;
  readonly unknownPostFailureActJudgmentSeen?: boolean;
  readonly unknownPostFailureJudgmentSeen?: boolean;
  readonly unknownRecoveryObserved?: boolean;
  readonly unknownRecoveryOperationKind?: SafeUnknownOperationKind;
  readonly unknownRecoveryAfterRestore?: boolean;
  readonly unknownDistinctRecoveryOperation?: boolean;
  readonly unknownControlledObstacleStatus?: UnknownObstacleStatus;
  readonly unknownControlledObstacleAttemptCount?: number;
  readonly unknownControlledObstacleRestoreFailureStage?:
    "stabilize" | "clone" | "compare";
  readonly unknownControlledObstaclePhase?: UnknownObstaclePhase;
  readonly unknownControlledObstaclePlacementCount?: number;
  readonly unknownControlledObstacleConfirmedPlacementCount?: number;
  readonly unknownControlledObstacleEligibilityChecks?: number;
  readonly unknownControlledObstaclePreFreezeReadiness?:
    | Exclude<UnknownObstacleReadinessStatus, "other_entities_not_clear">
    | "not_attempted";
  readonly unknownControlledObstaclePostFreezeReadiness?: UnknownObstacleReadinessStatus;
  readonly unknownControlledObstacleSameOperationConfirmed?: boolean;
  readonly unknownControlledObstacleNewOperationFailed?: boolean;
  readonly unknownControlledObstaclePlayerInsideBefore?: boolean;
  readonly unknownControlledObstacleStandingSpaceConfirmed?: boolean;
  readonly unknownControlledObstaclePlayerInsideAtFailure?: boolean;
  readonly unknownControlledObstacleOtherEntitiesClear?: boolean;
  readonly unknownControlledObstacleRestored?: boolean;
  readonly unknownObstacleTickFreezeConfirmed?: boolean;
  readonly unknownObstacleTickUnfreezeConfirmed?: boolean;
  readonly unknownObstacleOperationActiveBeforeUnfreeze?: boolean;
  readonly unknownHandoffMilestoneConfirmed?: boolean;
  readonly unknownHandoffStopRequested?: boolean;
  readonly unknownHandoffStopLatchConfirmed?: boolean;
  readonly unknownHandoffStopGenerationAdvanced?: boolean;
  readonly unknownHandoffActiveOperationPresent?: boolean;
  readonly unknownHandoffActiveBodyStarted?: boolean;
  readonly unknownHandoffActiveBodyElapsedBucket?: string;
  readonly unknownHandoffActiveCleared?: boolean;
  readonly unknownHandoffActiveTerminalRequired?: boolean;
  readonly unknownHandoffActiveTerminalObserved?: boolean;
  readonly unknownHandoffPendingCancelled?: boolean;
  readonly unknownHandoffPendingOperationAtStop?: boolean;
  readonly unknownHandoffShutdownCompleted?: boolean;
  readonly unknownHandoffDisconnectConfirmed?: boolean;
  readonly unknownHandoffRestarted?: boolean;
  readonly unknownHandoffStoppedLatchRestored?: boolean;
  readonly unknownHandoffFixturePreparedWhileStopped?: boolean;
  readonly unknownHandoffResumeRequested?: boolean;
  readonly unknownHandoffResumed?: boolean;
  readonly unknownHandoffActiveAfterResume?: boolean;
  readonly unknownHandoffTaskSent?: boolean;
  readonly unknownHandoffDependencyBlocked?: boolean;
}

type BodyOperationStatus =
  "successful" | "failed" | "interrupted" | "unverified";
type LookSweepStatusDiagnostic = BodyOperationStatus | "unavailable";
type BodyPathStatus = "none" | "noPath" | "timeout" | "success" | "partial";
type BodyMoveErrorClass =
  "none" | "no_path" | "timeout" | "probe_deadline" | "interrupted" | "other";
type ProgressiveNavigationDoorState = "closed" | "open" | "unknown";
type ProgressiveNavigationSide =
  "owner_side" | "doorway" | "return_side" | "unknown";
type ProgressiveNavigationSamplePoint =
  "start" | "sample_1" | "sample_2" | "sample_3" | "final";
type ProgressiveNavigationSampleElapsedBucket =
  "0-10s" | "10-20s" | "20-30s" | "30-40s" | "40s+" | "unknown";
type ProgressiveNavigationStallElapsedBucket =
  "under20s" | "20-30s" | "30-40s" | "40s+" | "none";
type ProgressiveNavigationUseSkipReason =
  | "initial_route_confirmed"
  | "run_deadline"
  | "door_not_closed"
  | "operation_unresolved"
  | "door_not_observed"
  | "door_out_of_reach"
  | "look_not_successful"
  | "look_observation_unavailable"
  | "attempted";
type ProgressiveNavigationDoorLookSkipReason =
  | "initial_route_confirmed"
  | "run_deadline"
  | "door_not_closed"
  | "operation_unresolved"
  | "attempted";
type ProgressiveNavigationObservedDoorHalf = "lower" | "upper" | "neither";

type OwnerReturnStopReason =
  | "owner_arrival"
  | "budget_stop"
  | "navigation_terminal"
  | "proposal_declined"
  | "observation_window_elapsed"
  | "fixture_preflight_failed";

type OwnerReturnDistanceBucket = "within_1_75" | "over_1_75" | "unknown";
type OwnerReturnProposalDisposition =
  "pending" | "adopted" | "compromised" | "declined" | "unknown";

interface OwnerReturnDiagnostic {
  readonly stage:
    | "not_started"
    | "fixture_setup"
    | "preflight"
    | "owner_request"
    | "navigation"
    | "cleanup"
    | "complete";
  readonly fixtureConfigured?: boolean;
  readonly doorStateBefore?: ProgressiveNavigationDoorState;
  readonly doorStateAfter?: ProgressiveNavigationDoorState;
  readonly bodySideBefore?: ProgressiveNavigationSide;
  readonly bodySideAfter?: ProgressiveNavigationSide;
  readonly rconSideBefore?: ProgressiveNavigationSide;
  readonly rconSideAfter?: ProgressiveNavigationSide;
  readonly bodyDistanceBefore?: OwnerReturnDistanceBucket;
  readonly bodyDistanceAfter?: OwnerReturnDistanceBucket;
  readonly rconDistanceBefore?: OwnerReturnDistanceBucket;
  readonly rconDistanceAfter?: OwnerReturnDistanceBucket;
  readonly bodyRconSampleAlignedBefore?: boolean | "unknown";
  readonly bodyRconSampleAlignedAfter?: boolean | "unknown";
  readonly ownerRequestSent?: boolean | "unknown";
  readonly stopPlayerEvidenceAvailable?: boolean;
  readonly newOwnerProposalObserved?: boolean | "unknown";
  readonly ownerProposalDisposition?: OwnerReturnProposalDisposition;
  readonly ownerProposalAdoptedForRequest?: boolean | "unknown";
  readonly ownerProposalProgressableForRequest?: boolean | "unknown";
  readonly ownerGoalLinked?: boolean | "unknown";
  readonly ownerMoveJudgmentObserved?: boolean | "unknown";
  readonly toolNamesByRole?:
    | Readonly<{
        conversation: readonly PlayerAgentToolName[];
        purpose: readonly PlayerAgentToolName[];
      }>
    | "unknown";
  readonly moveOutcomeStatus?: BodyOperationStatus | "unknown";
  readonly bodyReachedOwnerSide?: boolean | "unknown";
  readonly rconReachedOwnerSide?: boolean | "unknown";
  readonly bodyAndRconArrivalObserved?: boolean | "unknown";
  readonly ownerGoalStatusAtStop?:
    "active" | "paused" | "completed" | "abandoned" | "unknown";
  readonly ownerGoalStatusBeforeParallel?:
    "active" | "paused" | "completed" | "abandoned" | "unknown";
  readonly activeOperationPresentAtStop?: boolean | "unknown";
  readonly acceptedProviderRequestsLatched?: boolean;
  readonly acceptedProviderRequestsStarted?: number;
  readonly acceptedProviderRequestsRecorded?: number;
  readonly acceptedProviderRequestsInFlight?: number;
  readonly acceptedProviderRequestsBlockedAfterLatch?: number;
  readonly acceptedProviderRequestsSettled?: boolean;
  readonly acceptedProviderRequestSettleStatus?: AcceptedProviderRequestSettleStatus;
  readonly stopReason?: OwnerReturnStopReason;
  readonly fixtureCleanupConfirmed?: boolean;
  readonly originalFixtureRestored?: boolean;
}

interface OwnerReturnWorldSample {
  readonly bodySide: ProgressiveNavigationSide;
  readonly rconSide: ProgressiveNavigationSide;
  readonly bodyDistance: OwnerReturnDistanceBucket;
  readonly rconDistance: OwnerReturnDistanceBucket;
  readonly bodyRconAligned: boolean;
  readonly doorState: ProgressiveNavigationDoorState;
}

interface ProgressiveNavigationMovementSample {
  readonly point: ProgressiveNavigationSamplePoint;
  readonly elapsed: ProgressiveNavigationSampleElapsedBucket;
  readonly bodySide: ProgressiveNavigationSide;
  readonly rconSide: ProgressiveNavigationSide;
  readonly bodyDoorDistance: BodyPositionDriftBucket | "unknown";
  readonly rconDoorDistance: BodyPositionDriftBucket | "unknown";
  readonly doorState: ProgressiveNavigationDoorState;
  readonly bodyBlockSearchMayBeTruncated: boolean | "unknown";
}

interface ProgressiveNavigationDoorUseDiagnostic {
  readonly attempted: boolean;
  readonly skipReason: ProgressiveNavigationUseSkipReason;
  readonly doorObserved: boolean | "unknown";
  readonly doorObservedHalf: ProgressiveNavigationObservedDoorHalf;
  readonly bodyBlockSearchMayBeTruncated: boolean | "unknown";
  readonly doorWithinReach: boolean | "unknown";
  readonly status?: BodyOperationStatus;
  readonly errorClass?: BodyDetailClass | "probe_deadline";
  readonly recoveryRequired?: boolean;
  readonly doorStateAfter?: ProgressiveNavigationDoorState;
}

interface ProgressiveNavigationDoorUseOperationResult {
  readonly status: BodyOperationStatus;
  readonly errorClass: BodyDetailClass | "probe_deadline";
  readonly recoveryRequired: boolean;
  readonly probeDeadlineReached: boolean;
}

interface ProgressiveNavigationDoorUseReadiness {
  readonly diagnostic: Pick<
    ProgressiveNavigationDoorUseDiagnostic,
    | "doorObserved"
    | "doorObservedHalf"
    | "bodyBlockSearchMayBeTruncated"
    | "doorWithinReach"
  >;
  readonly targetPosition: BlockPosition | null;
}

interface ProgressiveNavigationDoorLookDiagnostic {
  readonly attempted: boolean;
  readonly skipReason: ProgressiveNavigationDoorLookSkipReason;
  readonly status?: BodyOperationStatus;
  readonly errorClass?: BodyDetailClass | "probe_deadline";
  readonly recoveryRequired?: boolean;
  readonly doorObservedHalfBefore: ProgressiveNavigationObservedDoorHalf;
  readonly doorObservedHalfAfter:
    ProgressiveNavigationObservedDoorHalf | "unknown" | "not_sampled";
  readonly bodyBlockSearchMayBeTruncatedBefore: boolean | "unknown";
  readonly bodyBlockSearchMayBeTruncatedAfter:
    boolean | "unknown" | "not_sampled";
  readonly doorStateBefore: ProgressiveNavigationDoorState;
  readonly doorStateAfter: ProgressiveNavigationDoorState | "not_sampled";
}

interface ProgressiveNavigationRetryDiagnostic {
  readonly attempted: boolean;
  readonly skipReason:
    | "door_not_open"
    | "run_deadline"
    | "operation_unresolved"
    | "initial_route_confirmed"
    | "use_not_attempted"
    | "attempted";
  readonly status?: BodyOperationStatus;
  readonly errorClass?: BodyMoveErrorClass;
  readonly pathStatus?: BodyPathStatus;
  readonly pathUpdateCount?: number;
  readonly stallEventCountBucket?: "0" | "1" | "2+";
  readonly stallElapsedBucket?: ProgressiveNavigationStallElapsedBucket;
  readonly bodySideAfter?: ProgressiveNavigationSide;
  readonly rconSideAfter?: ProgressiveNavigationSide;
  readonly doorStateAfter?: ProgressiveNavigationDoorState;
  readonly routeConfirmed?: boolean;
}
type BodyDigErrorClass =
  | "out_of_view"
  | "occluded"
  | "out_of_reach"
  | "unloaded"
  | "timeout"
  | "effect_unverified"
  | "interrupted"
  | "other";
type BodyPositionDriftBucket = "<1" | "1-2" | "2+";
type ReturnPathDigFeetClass = "dry" | "water" | "other" | "unknown";
type ReturnPathDigSupportClass = "stone" | "other" | "unknown";

interface ReturnPathDigStageObservation {
  readonly playerDistanceBucket: BodyPositionDriftBucket | "unknown";
  readonly bodyDistanceBucket: BodyPositionDriftBucket | "unknown";
  readonly feetBlockClass: ReturnPathDigFeetClass;
  readonly supportBlockClass: ReturnPathDigSupportClass;
  readonly stable: boolean;
  readonly ready: boolean;
}

interface BodyMovePathDiagnostic {
  readonly status: BodyOperationStatus;
  readonly errorClass: BodyMoveErrorClass;
  readonly pathStatus: BodyPathStatus;
  readonly pathLength: number;
  readonly pathUpdateCount: number;
  readonly probeDeadlineReached: boolean;
  readonly recoveryRequired: boolean;
  readonly stallEventCountBucket?: "0" | "1" | "2+";
  readonly stallElapsedBucket?: ProgressiveNavigationStallElapsedBucket;
}

interface BodyMovePathProbeOptions {
  readonly captureStallEvents?: boolean;
  readonly sampleIntervalMs?: number;
  readonly maxSamples?: number;
  readonly onSample?: (elapsedMs: number) => Promise<void>;
}

interface ReturnPathProbeDiagnostic {
  readonly interpretation?: "diagnostic_only_live_item_collection_not_gated";
  readonly fixtureConfirmed?: boolean;
  readonly fixtureWallConfirmed?: boolean;
  readonly fixtureDryGroundConfirmed?: boolean;
  readonly digStageRconConfirmed?: boolean;
  readonly digStagePlayerDistanceBucket?: BodyPositionDriftBucket | "unknown";
  readonly digStageBodyDistanceBucket?: BodyPositionDriftBucket | "unknown";
  readonly digStageFeetBlockClass?: ReturnPathDigFeetClass;
  readonly digStageSupportBlockClass?: ReturnPathDigSupportClass;
  readonly digStageStable?: boolean;
  readonly digStageReady?: boolean;
  readonly dropStageRconConfirmed?: boolean;
  readonly digStatus?: BodyOperationStatus;
  readonly digErrorClass?: BodyDigErrorClass;
  readonly digRecoveryRequired?: boolean;
  readonly digLookStatus?: BodyOperationStatus;
  readonly targetVisibleAfterLook?: boolean;
  readonly digPositionDriftBucket?: BodyPositionDriftBucket;
  readonly itemPresentAfterDig?: boolean;
  readonly dropItemEntityPresentAfterDig?: boolean;
  readonly dropGroundSupportConfirmedAfterDig?: boolean;
  readonly targetClearedAfterDig?: boolean;
  readonly dropItemEntityPresentBeforeCollection?: boolean;
  readonly itemPresentBeforeCollection?: boolean;
  readonly dropStageBodyConfirmed?: boolean;
  readonly dropLookStatus?: BodyOperationStatus;
  readonly dropVisibilityStatus?:
    | "unique"
    | "not_visible"
    | "ambiguous"
    | "observation_unavailable"
    | "cancelled"
    | "look_failed";
  readonly visibleDropItemCount?: number;
  readonly dropEntityKindClass?: "object" | "other";
  readonly itemCollectionAttempted?: boolean;
  readonly itemCollectionStatus?: BodyOperationStatus;
  readonly itemCollectionOutcome?: PlayerItemCollectionOutcome | "none";
  readonly itemCollectionPathFailureReason?:
    PlayerItemCollectionPathFailureReason | "none";
  readonly itemCollectionObservedEffect?: "item_collected" | "none";
  readonly itemCollectionEffectMatchedTarget?: boolean;
  readonly itemCollectionRecoveryRequired?: boolean;
  readonly bodyObservationAvailableAfterCollection?: boolean;
  readonly bodyDropVisibleAfterCollection?: boolean | "unknown";
  readonly bodyPlayerDropDistanceBucketAfterCollection?:
    BodyPositionDriftBucket | "unknown";
  readonly bodyInventoryItemPresentAfterCollection?: boolean | "unknown";
  readonly rconDropPresentAfterCollection?: boolean;
  readonly rconDropObservationAvailableAfterCollection?: boolean;
  readonly rconPlayerDropDistanceObservationAvailableAfterCollection?: boolean;
  readonly rconPlayerDropDistanceBucketAfterCollection?:
    BodyPositionDriftBucket | "unknown";
  readonly inventoryItemPresentAfterCollection?: boolean;
  readonly inventoryObservationAvailableAfterCollection?: boolean;
  readonly itemPickupConfirmed?: boolean;
  readonly returnMoveAttempted?: boolean;
  readonly returnMoveSkippedRecoveryRequired?: boolean;
  readonly returnMoveSkippedNoPickup?: boolean;
  readonly returnMove?: BodyMovePathDiagnostic;
  readonly returnRconArrivalConfirmed?: boolean;
  readonly itemPresentAfterReturn?: boolean;
}

function isNoGptDiagnosticProbeOnly(): boolean {
  return (
    process.env.AI_PLAYER_E2E_NAVIGATION_PROBE_ONLY === "YES" ||
    process.env.AI_PLAYER_E2E_RETURN_PATH_PROBE_ONLY === "YES" ||
    process.env.AI_PLAYER_E2E_PROGRESSIVE_NAVIGATION_PROBE_ONLY === "YES" ||
    process.env.AI_PLAYER_E2E_NO_FOOD_FIXTURE_PROBE_ONLY === "YES" ||
    process.env.AI_PLAYER_E2E_NO_FOOD_CONTINUITY_PROBE_ONLY === "YES" ||
    process.env.AI_PLAYER_E2E_GATHER_MULTI_TARGET_ORACLE_PROBE_ONLY === "YES" ||
    isDeathRecoveryFixtureProbeOnly()
  );
}

function isDeathRecoveryFixtureProbeOnly(): boolean {
  return process.env.AI_PLAYER_E2E_DEATH_RECOVERY_FIXTURE_PROBE_ONLY === "YES";
}

function isNoFoodContinuityProbeOnly(): boolean {
  return process.env.AI_PLAYER_E2E_NO_FOOD_CONTINUITY_PROBE_ONLY === "YES";
}

function classifyBodyMoveError(
  status: BodyOperationStatus,
  detail: string | undefined,
  probeDeadlineReached: boolean,
): BodyMoveErrorClass {
  if (probeDeadlineReached) return "probe_deadline";
  if (status === "successful") return "none";
  const normalized = detail?.toLowerCase() ?? "";
  if (/no path|pathfinder_failed/u.test(normalized)) return "no_path";
  if (/timeout|timed out|time limit/u.test(normalized)) return "timeout";
  if (
    status === "interrupted" ||
    /cancel|abort|interrupted/u.test(normalized)
  ) {
    return "interrupted";
  }
  return "other";
}

function classifyReturnPathDigError(
  status: BodyOperationStatus,
  detail: string | undefined,
): BodyDigErrorClass {
  const normalized = detail?.toLowerCase() ?? "";
  if (status === "unverified") {
    return normalized.includes("bounded action wait expired")
      ? "timeout"
      : "effect_unverified";
  }
  if (status === "interrupted") return "interrupted";
  if (normalized.includes("outside the current field of view"))
    return "out_of_view";
  if (normalized.includes("occluded")) return "occluded";
  if (normalized.includes("outside normal player reach")) return "out_of_reach";
  if (normalized.includes("outside loaded world data")) return "unloaded";
  return "other";
}

function positionDriftBucket(distance: number): BodyPositionDriftBucket {
  if (distance < 1) return "<1";
  if (distance < 2) return "1-2";
  return "2+";
}

function positionDistanceBucket(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): BodyPositionDriftBucket {
  return positionDriftBucket(
    Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z),
  );
}

async function executeBodyMovePathProbe(
  body: PlayerBody,
  operation: {
    readonly kind: "move_to";
    readonly position: Position;
    readonly range: number;
  },
  parentSignal: AbortSignal,
  deadlineMs = 20_000,
  options: BodyMovePathProbeOptions = {},
): Promise<BodyMovePathDiagnostic> {
  let pathStatus: BodyPathStatus = "none";
  let pathLength = 0;
  let pathUpdateCount = 0;
  let probeDeadlineReached = false;
  let detail: string | undefined;
  let status: BodyOperationStatus;
  let recoveryRequired = false;
  let activeMoveOperationId: string | undefined;
  let stallEventCount = 0;
  let firstStallElapsedMs: number | undefined;
  let sampledCount = 0;
  let inFlightSample: Promise<void> | undefined;
  const startedAt = Date.now();
  const probeAbort = new AbortController();
  const timer = setTimeout(() => {
    probeDeadlineReached = true;
    probeAbort.abort(new Error("return path probe deadline"));
  }, deadlineMs);
  const signal = AbortSignal.any([parentSignal, probeAbort.signal]);
  const unsubscribe = body.onEvent((event) => {
    if (event.type === "operation_started") {
      if (event.operation === "move_to" && activeMoveOperationId === undefined)
        activeMoveOperationId = event.operationId;
      return;
    }
    if (
      activeMoveOperationId === undefined ||
      !("operationId" in event) ||
      event.operationId !== activeMoveOperationId
    )
      return;
    if (event.type === "operation_path_updated") {
      pathStatus = event.status;
      pathLength = event.pathLength;
      pathUpdateCount += 1;
    } else if (
      options.captureStallEvents === true &&
      event.type === "operation_stalled"
    ) {
      stallEventCount += 1;
      firstStallElapsedMs ??= event.elapsedMs;
    }
  });
  const sampleTimer =
    options.onSample === undefined || (options.maxSamples ?? 0) <= 0
      ? undefined
      : setInterval(() => {
          if (
            sampledCount >= (options.maxSamples ?? 0) ||
            inFlightSample !== undefined ||
            activeMoveOperationId === undefined ||
            probeAbort.signal.aborted ||
            parentSignal.aborted
          )
            return;
          sampledCount += 1;
          inFlightSample = options
            .onSample?.(Date.now() - startedAt)
            .then(() => undefined)
            .catch(() => undefined)
            .finally(() => {
              inFlightSample = undefined;
            });
        }, options.sampleIntervalMs ?? 10_000);
  try {
    const result = await body.execute(operation, signal);
    status = result.status;
    detail = result.detail;
    recoveryRequired = result.recoveryRequired;
  } catch (error) {
    detail =
      error instanceof Error ? `${error.name}: ${error.message}` : undefined;
    status = parentSignal.aborted ? "interrupted" : "failed";
  } finally {
    clearTimeout(timer);
    if (sampleTimer !== undefined) clearInterval(sampleTimer);
    if (inFlightSample !== undefined) await inFlightSample;
    unsubscribe();
  }
  return {
    status,
    errorClass: classifyBodyMoveError(status, detail, probeDeadlineReached),
    pathStatus,
    pathLength,
    pathUpdateCount,
    probeDeadlineReached,
    recoveryRequired,
    ...(options.captureStallEvents === true
      ? {
          stallEventCountBucket: progressiveEventCountBucket(stallEventCount),
          stallElapsedBucket:
            progressiveNavigationStallElapsedBucket(firstStallElapsedMs),
        }
      : {}),
  };
}

function progressiveEventCountBucket(count: number): "0" | "1" | "2+" {
  if (count === 0) return "0";
  if (count === 1) return "1";
  return "2+";
}

function progressiveNavigationStallElapsedBucket(
  elapsedMs: number | undefined,
): ProgressiveNavigationStallElapsedBucket {
  if (elapsedMs === undefined) return "none";
  if (elapsedMs < 20_000) return "under20s";
  if (elapsedMs < 30_000) return "20-30s";
  if (elapsedMs < 40_000) return "30-40s";
  return "40s+";
}

function progressiveNavigationSampleElapsedBucket(
  elapsedMs: number,
): ProgressiveNavigationSampleElapsedBucket {
  if (elapsedMs < 10_000) return "0-10s";
  if (elapsedMs < 20_000) return "10-20s";
  if (elapsedMs < 30_000) return "20-30s";
  if (elapsedMs < 40_000) return "30-40s";
  return "40s+";
}

type BodyDetailClass =
  | "none"
  | "target_not_loaded"
  | "target_out_of_reach"
  | "target_occluded"
  | "target_out_of_field_of_view"
  | "block_not_diggable"
  | "action_timeout"
  | "action_interrupted"
  | "effect_unverified"
  | "transport_error"
  | "transfer_source_item_unavailable"
  | "transfer_cursor_item_present"
  | "transfer_source_slot_empty"
  | "transfer_destination_full"
  | "transfer_destination_no_capacity"
  | "transfer_window_missing"
  | "transfer_slot_invalid"
  | "transfer_click_rejected"
  | "transfer_server_selection_unconfirmed"
  | "other";

type FurnaceTargetClass = "furnace" | "other" | "not_observed";
type WindowTypeClass = "furnace" | "other" | "none";

type ConnectionFailureClass =
  | "schema_validation"
  | "timeout"
  | "connection_refused"
  | "connection_reset"
  | "protocol"
  | "authentication_or_kick"
  | "disconnected"
  | "connection_error"
  | "other";

interface BodySmokeDiagnostic {
  readonly fixtureLookStatus: BodyOperationStatus;
  readonly fixtureLookDetailClass: BodyDetailClass;
  readonly fixtureTargetVisibleAfterLook: boolean;
  readonly fixtureTargetBlockName: string;
  readonly relativeMoveStatus?: BodyOperationStatus;
  readonly relativeMoveServerDisplacementObserved?: boolean;
  readonly obstacleRouteStatus?: BodyOperationStatus;
  readonly obstacleRouteDistanceBand?: "near" | "middle" | "far";
  readonly obstacleRouteVerifiedByServer?: boolean;
  readonly obstacleRouteClientSpawnConfirmed?: boolean;
  readonly obstacleRouteEastProgress?: boolean;
  readonly obstacleRouteLateralProgress?: boolean;
  readonly obstacleRoutePathStatus?: BodyPathStatus;
  readonly obstacleRoutePathUpdateCount?: number;
  readonly obstacleRouteMaxPathBand?: "none" | "short" | "long";
  readonly obstacleRouteTargetObservedInSweep?: boolean;
  readonly obstacleRouteLookSweepStatus?: LookSweepStatusDiagnostic;
  readonly obstacleRouteLookSweepComplete?: boolean;
  readonly obstacleRouteLookSweepAnyViewTargetName?: boolean;
  readonly obstacleRouteLookSweepAnyTruncation?: boolean;
  readonly obstacleRouteLookSweepDistinctYawCount?: number;
  readonly obstacleRouteLookStatus?: BodyOperationStatus;
  readonly obstacleRouteTargetVisibleAfterLook?: boolean;
  readonly obstacleRestoreProbeVerified?: boolean;
  readonly obstacleRestoreProbeFailureStage?: "stabilize" | "clone" | "compare";
  readonly progressiveNavigationStage?:
    "fixture_setup" | "preflight" | "move" | "cleanup" | "complete";
  readonly progressiveNavigationFixtureConfigured?: boolean;
  readonly progressiveNavigationStairBlocksConfirmed?: boolean;
  readonly progressiveNavigationStepSupportsConfirmed?: boolean;
  readonly progressiveNavigationCorridorWallsConfirmed?: boolean;
  readonly progressiveNavigationDoorHalvesConfirmed?: boolean;
  readonly progressiveNavigationDoorStateBefore?: ProgressiveNavigationDoorState;
  readonly progressiveNavigationDoorStateAfter?: ProgressiveNavigationDoorState;
  readonly progressiveNavigationBodySideBefore?:
    "owner_side" | "doorway" | "return_side" | "unknown";
  readonly progressiveNavigationBodySideAfter?:
    "owner_side" | "doorway" | "return_side" | "unknown";
  readonly progressiveNavigationRconSideBefore?:
    "owner_side" | "doorway" | "return_side" | "unknown";
  readonly progressiveNavigationRconSideAfter?:
    "owner_side" | "doorway" | "return_side" | "unknown";
  readonly progressiveNavigationBodyDistanceBefore?:
    BodyPositionDriftBucket | "unknown";
  readonly progressiveNavigationBodyDistanceAfter?:
    BodyPositionDriftBucket | "unknown";
  readonly progressiveNavigationRconDistanceBefore?:
    BodyPositionDriftBucket | "unknown";
  readonly progressiveNavigationRconDistanceAfter?:
    BodyPositionDriftBucket | "unknown";
  readonly progressiveNavigationBodyDistanceReduced?: boolean;
  readonly progressiveNavigationRconDistanceReduced?: boolean;
  readonly progressiveNavigationMoveStatus?: BodyOperationStatus;
  readonly progressiveNavigationMoveErrorClass?: BodyMoveErrorClass;
  readonly progressiveNavigationPathStatus?: BodyPathStatus;
  readonly progressiveNavigationPathUpdateCount?: number;
  readonly progressiveNavigationProbeDeadlineReached?: boolean;
  readonly progressiveNavigationBodyPassedDoor?: boolean;
  readonly progressiveNavigationRconPassedDoor?: boolean;
  readonly progressiveNavigationRouteConfirmed?: boolean;
  readonly progressiveNavigationMoveTrace?: {
    readonly stallEventCountBucket: "0" | "1" | "2+";
    readonly stallElapsedBucket: ProgressiveNavigationStallElapsedBucket;
    readonly samples: readonly ProgressiveNavigationMovementSample[];
  };
  readonly progressiveNavigationDoorUse?: ProgressiveNavigationDoorUseDiagnostic;
  readonly progressiveNavigationDoorLook?: ProgressiveNavigationDoorLookDiagnostic;
  readonly progressiveNavigationRetryMove?: ProgressiveNavigationRetryDiagnostic;
  readonly progressiveNavigationFixtureCleanupConfirmed?: boolean;
  readonly progressiveNavigationOriginalFixtureRestored?: boolean;
  readonly returnPathProbe?: ReturnPathProbeDiagnostic;
  readonly resourceTargetRconConfirmed?: boolean;
  readonly resourceLookStatus?: BodyOperationStatus;
  readonly resourceLookDetailClass?: BodyDetailClass;
  readonly resourceVisibleAfterSmoke?: boolean;
  readonly targetVisibleInDigBeforeSnapshot?: boolean;
  readonly targetBlockNameInDigBeforeSnapshot?: string;
  readonly digStatus?: BodyOperationStatus;
  readonly digRecoveryRequired?: boolean;
  readonly digDetailClass?: BodyDetailClass;
  readonly serverBlockAirAfterDig?: boolean;
  readonly furnaceFixtureRconConfirmed?: boolean;
  readonly furnaceLookStatus?: BodyOperationStatus;
  readonly furnaceLookDetailClass?: BodyDetailClass;
  readonly furnaceTargetClassBeforeOpen?: FurnaceTargetClass;
  readonly furnaceTargetVisibleBeforeOpen?: boolean;
  readonly furnaceOpenStatus?: BodyOperationStatus;
  readonly furnaceOpenDetailClass?: BodyDetailClass;
  readonly furnaceWindowTypeClass?: WindowTypeClass;
  readonly furnaceInventoryRawIronBeforeTransferIn?: number;
  readonly furnaceWindowInventoryRawIronBeforeTransferIn?: number;
  readonly furnaceWindowInputRawIronBeforeTransferIn?: number;
  readonly furnaceCursorRawIronBeforeTransferIn?: number;
  readonly furnaceTransferInStatus?: BodyOperationStatus;
  readonly furnaceTransferInRecoveryRequired?: boolean;
  readonly furnaceTransferInDetailClass?: BodyDetailClass;
  readonly furnaceInventoryRawIronAfterTransferIn?: number;
  readonly furnaceWindowInventoryRawIronAfterTransferIn?: number;
  readonly furnaceWindowInputRawIronAfterTransferIn?: number;
  readonly furnaceCursorRawIronAfterTransferIn?: number;
  readonly furnaceRconInventoryInputConfirmed?: boolean;
  readonly furnaceRconInputConfirmedAfterTransferIn?: boolean;
  readonly furnaceRconInputInitialClass?: FurnaceRconReplyClass;
  readonly furnaceRconInputFinalClass?: FurnaceRconReplyClass;
  readonly furnaceRconInputInitialConfirmed?: boolean;
  readonly furnaceRconInputFinalConfirmed?: boolean;
  readonly furnaceTransferInWaitElapsedMs?: number;
  readonly furnaceInventoryRawIronAtTransferInInitial?: number;
  readonly furnaceWindowInventoryRawIronAtTransferInInitial?: number;
  readonly furnaceWindowInputRawIronAtTransferInInitial?: number;
  readonly furnaceCursorRawIronAtTransferInInitial?: number;
  readonly furnaceInventoryRawIronBeforeTransferOut?: number;
  readonly furnaceWindowInventoryRawIronBeforeTransferOut?: number;
  readonly furnaceWindowInputRawIronBeforeTransferOut?: number;
  readonly furnaceCursorRawIronBeforeTransferOut?: number;
  readonly furnaceTransferOutStatus?: BodyOperationStatus;
  readonly furnaceTransferOutRecoveryRequired?: boolean;
  readonly furnaceTransferOutDetailClass?: BodyDetailClass;
  readonly furnaceInventoryRawIronAfterTransferOut?: number;
  readonly furnaceWindowInventoryRawIronAfterTransferOut?: number;
  readonly furnaceWindowInputRawIronAfterTransferOut?: number;
  readonly furnaceCursorRawIronAfterTransferOut?: number;
  readonly furnaceRconEmptyConfirmedAfterTransferOut?: boolean;
  readonly furnaceRconReturnInitialClass?: FurnaceRconReplyClass;
  readonly furnaceRconReturnFinalClass?: FurnaceRconReplyClass;
  readonly furnaceRconReturnInitialEmptyConfirmed?: boolean;
  readonly furnaceRconReturnFinalEmptyConfirmed?: boolean;
  readonly furnaceTransferOutWaitElapsedMs?: number;
  readonly furnaceInventoryRawIronAtTransferOutInitial?: number;
  readonly furnaceWindowInventoryRawIronAtTransferOutInitial?: number;
  readonly furnaceWindowInputRawIronAtTransferOutInitial?: number;
  readonly furnaceCursorRawIronAtTransferOutInitial?: number;
  readonly furnaceInventoryRawIronBeforeClose?: number;
  readonly furnaceWindowInventoryRawIronBeforeClose?: number;
  readonly furnaceWindowInputRawIronBeforeClose?: number;
  readonly furnaceCursorRawIronBeforeClose?: number;
  readonly furnaceWindowCloseStatus?: BodyOperationStatus;
  readonly furnaceWindowCloseRecoveryRequired?: boolean;
  readonly furnaceWindowCloseDetailClass?: BodyDetailClass;
  readonly furnaceInventoryRawIronAfterClose?: number;
  readonly furnaceWindowInventoryRawIronAfterClose?: number;
  readonly furnaceWindowInputRawIronAfterClose?: number;
  readonly furnaceCursorRawIronAfterClose?: number;
  readonly furnaceWindowClosed?: boolean;
}

interface SafeApplicationStartDiagnostic {
  readonly errorName: string;
  readonly connectionFailureClass: ConnectionFailureClass;
  readonly appError?: {
    readonly category: string;
    readonly code: string;
  };
  readonly nodeErrorCode?: string;
  readonly zodIssues?: readonly {
    readonly code: string;
    readonly path: readonly string[];
  }[];
  readonly zodIssuesTruncated?: boolean;
}

interface Counters {
  readonly llmCalls: number;
  readonly usageUnknownCalls: number;
  readonly usageUnknownRequestErrorCalls: number;
  readonly usageUnknownResponseUsageMissingCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly thoughts: number;
  readonly learningUpdates: number;
}

interface RunBudget {
  readonly durationMs: number;
  readonly llmCalls: number;
  readonly totalTokens: number;
}

interface PlayerEvidence {
  readonly revision: number;
  readonly actionRevision: number;
  readonly stopped: boolean;
  readonly stopGeneration: number;
  readonly purpose?: string;
  readonly goals: readonly {
    readonly id: string;
    readonly ownerProposalId?: string;
    readonly title?: string;
    readonly status?: string;
    readonly priority?: number;
    readonly changeReason?: string;
    readonly source?: string;
    readonly updatedAt?: string;
  }[];
  readonly proposals: readonly {
    readonly id: string;
    readonly title?: string;
    readonly status?: string;
    readonly resolution?: string;
  }[];
  readonly activeOperation?: {
    readonly operationId: string;
    readonly kind: string;
    readonly actionRevision: number;
    readonly startedAt?: string;
    readonly bodyStartedAt?: string;
    readonly skillId?: string;
    readonly skillVersion?: number;
  };
  readonly wait?: {
    readonly reason?: string;
    readonly wakeOn?: readonly string[];
    readonly wakeAt?: string;
  };
  readonly lastOutcome?: {
    readonly operationId?: string;
    readonly kind?: string;
    readonly status?: string;
    readonly summary?: string;
    readonly skillId?: string;
    readonly skillVersion?: number;
  } | null;
  readonly recentJudgments: readonly {
    readonly revision?: number;
    readonly decidedAt?: string;
    readonly kind?: string;
    readonly summary?: string;
    readonly operationKind?: string;
    readonly proposalId?: string;
    readonly proposalDisposition?: string;
  }[];
  readonly recentOutcomes: readonly {
    readonly operationId: string;
    readonly kind?: string;
    readonly status?: string;
    readonly summary?: string;
    readonly observedAt?: string;
    readonly skillId?: string;
    readonly skillVersion?: number;
  }[];
  readonly learningReferences: readonly {
    readonly skillId?: string;
    readonly version?: number;
  }[];
  readonly skillActivity: readonly {
    readonly kind:
      "consulted" | "created" | "revised" | "imported" | "exported";
    readonly skillId: string;
    readonly version: number;
    readonly at: string;
    readonly summary?: string;
    readonly filePath?: string;
  }[];
  readonly pendingEventKinds: readonly string[];
  readonly lastObservation?: {
    readonly observedAt?: string;
    readonly dimension?: string;
    readonly visibleBlockNames?: readonly string[];
    readonly visibleContainers?: readonly {
      readonly name: string;
      readonly position: {
        readonly x: number;
        readonly y: number;
        readonly z: number;
        readonly dimension?: string;
      };
    }[];
    readonly ownerPositionExceptionUsed?: boolean;
  };
  readonly recentAgentActivity?: readonly PlayerAgentRoundActivity[];
  readonly counters: Counters;
}

type Evidence = Awaited<
  ReturnType<CompanionApplication["collectLiveEvidence"]>
> & {
  readonly player?: PlayerEvidence;
};

interface Position {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface WorldSnapshot {
  readonly position: Position;
  readonly blockRegionChanged: boolean;
  readonly inventorySignature: string;
}

interface SkillSnapshot extends LearningHypothesisSnapshot {
  readonly skillIds: ReadonlySet<string>;
  readonly skillCount: number;
  readonly revisionCount: number;
  readonly evidenceReceiptCount: number;
  readonly successfulDerivedSkillIds: ReadonlySet<string>;
  readonly revisionVersionsBySkill: ReadonlyMap<string, ReadonlySet<number>>;
  readonly learnedBodiesBySkill: ReadonlyMap<string, string>;
  readonly learnedBodiesUnderLimit: boolean;
  readonly importReceiptCount: number;
  readonly importReceiptCountsBySkill: ReadonlyMap<string, number>;
}

interface OwnerResponse {
  readonly at: number;
  readonly text: string;
}

class HarnessError extends Error {
  public constructor(
    public readonly status: Exclude<Status, "pass">,
    public readonly code: string,
  ) {
    super(code);
    this.name = "HarnessError";
  }
}

function fail(code: string): never {
  throw new HarnessError("fail", code);
}

function incomplete(code: string): never {
  throw new HarnessError("incomplete", code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const safeErrorNames = new Set([
  "AbortError",
  "AppError",
  "Error",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "ZodError",
]);

const safeNodeErrorCodes = new Set([
  "ABORT_ERR",
  "EADDRINUSE",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_MODULE_NOT_FOUND",
  "ERR_NETWORK",
  "ERR_SOCKET_CLOSED",
  "ERR_STREAM_DESTROYED",
]);

function safeNodeErrorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== "string") return undefined;
  return safeNodeErrorCodes.has(error.code) ? error.code : undefined;
}

function safeSchemaPathSegment(segment: unknown, state: RunState): string {
  if (typeof segment === "number") return "index";
  if (typeof segment !== "string") return "dynamic";
  if (
    segment === state.botName ||
    segment === state.ownerName ||
    segment === state.guestName ||
    (process.env.OPENAI_API_KEY !== undefined &&
      segment === process.env.OPENAI_API_KEY)
  ) {
    return "redacted";
  }
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(segment) ? segment : "dynamic";
}

function classifyConnectionFailure(error: unknown): ConnectionFailureClass {
  if (error instanceof ZodError) return "schema_validation";
  const message =
    error instanceof AppError
      ? `${error.detail.code} ${error.detail.message}`
      : error instanceof Error
        ? error.message
        : "";
  const searchable =
    `${safeNodeErrorCode(error) ?? ""} ${message}`.toLowerCase();
  if (/etimedout|timed out|timeout/u.test(searchable)) return "timeout";
  if (/econnrefused|connection refused/u.test(searchable))
    return "connection_refused";
  if (/econnreset|connection reset|reset by peer/u.test(searchable))
    return "connection_reset";
  if (
    /protocol|unsupported version|version mismatch|bad packet/u.test(searchable)
  )
    return "protocol";
  if (/authentication|login|invalid session|kicked/u.test(searchable))
    return "authentication_or_kick";
  if (
    /disconnected|connection closed|not connected|end of stream/u.test(
      searchable,
    )
  )
    return "disconnected";
  if (error instanceof AppError && error.detail.category === "connection")
    return "connection_error";
  return "other";
}

function applicationStartDiagnostic(
  error: unknown,
  state: RunState,
): SafeApplicationStartDiagnostic {
  const errorName =
    error instanceof Error && safeErrorNames.has(error.name)
      ? error.name
      : error instanceof Error
        ? "OtherError"
        : "NonError";
  const appError =
    error instanceof AppError
      ? {
          category: errorCategories.includes(error.detail.category)
            ? error.detail.category
            : "unknown",
          code: /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.detail.code)
            ? error.detail.code
            : "OTHER",
        }
      : undefined;
  const zodIssues =
    error instanceof ZodError
      ? error.issues.slice(0, 12).map((issue) => ({
          code: /^[a-z][a-z0-9_]{0,47}$/u.test(issue.code)
            ? issue.code
            : "other",
          path: issue.path
            .slice(0, 8)
            .map((segment) => safeSchemaPathSegment(segment, state)),
        }))
      : undefined;
  const zodIssuesTruncated =
    error instanceof ZodError && zodIssues !== undefined
      ? error.issues.length > zodIssues.length
      : undefined;
  const nodeErrorCode = safeNodeErrorCode(error);
  return {
    errorName,
    connectionFailureClass: classifyConnectionFailure(error),
    ...(appError === undefined ? {} : { appError }),
    ...(nodeErrorCode === undefined ? {} : { nodeErrorCode }),
    ...(zodIssues === undefined
      ? {}
      : { zodIssues, zodIssuesTruncated: zodIssuesTruncated === true }),
  };
}

function observedBlockName(
  observation: PlayerBodyObservation | null,
  target: Position,
): string | undefined {
  return observation?.perception.blocks.find(
    (block) =>
      block.position.x === target.x &&
      block.position.y === target.y &&
      block.position.z === target.z,
  )?.name;
}

function rawIronCount(
  items: readonly { readonly name: string; readonly count: number }[],
): number {
  return items.reduce(
    (total, item) => total + (item.name === "raw_iron" ? item.count : 0),
    0,
  );
}

function furnaceItemCounts(observation: PlayerBodyObservation): {
  readonly inventory: number;
  readonly windowInventory: number;
  readonly windowInput: number;
  readonly cursor: number;
} {
  const window = observation.window;
  return {
    inventory: rawIronCount(observation.self.inventory),
    windowInventory:
      window === null
        ? 0
        : rawIronCount(
            window.slots
              .slice(window.inventoryStart, window.inventoryEnd)
              .filter((item) => item !== null),
          ),
    windowInput:
      window === null
        ? 0
        : rawIronCount(
            window.slots
              .slice(0, window.inventoryStart)
              .filter((item) => item !== null),
          ),
    cursor:
      window?.selectedItem?.name === "raw_iron" ? window.selectedItem.count : 0,
  };
}

function classifyBodyOperationDetail(
  detail: string | undefined,
): BodyDetailClass {
  if (detail === undefined) return "none";
  const normalized = detail.toLowerCase();
  if (normalized.includes("outside loaded world data"))
    return "target_not_loaded";
  if (normalized.includes("outside normal player reach"))
    return "target_out_of_reach";
  if (normalized.includes("occluded")) return "target_occluded";
  if (normalized.includes("outside the current field of view"))
    return "target_out_of_field_of_view";
  if (normalized.includes("not diggable")) return "block_not_diggable";
  if (
    normalized.includes(
      "requested item count is not available in the transfer source",
    )
  ) {
    return "transfer_source_item_unavailable";
  }
  if (
    normalized.includes(
      "close or empty the carried cursor item before transferring",
    ) ||
    normalized.includes("unexpected cursor item")
  ) {
    return "transfer_cursor_item_present";
  }
  if (normalized.includes("requested source slot is empty"))
    return "transfer_source_slot_empty";
  if (normalized.includes("transfer destination is full"))
    return "transfer_destination_full";
  if (normalized.includes("transfer destination has no capacity"))
    return "transfer_destination_no_capacity";
  if (
    normalized.includes("no window is open") ||
    normalized.includes("window is not open") ||
    normalized.includes("there is no active window") ||
    normalized.includes("no block or entity window is open")
  ) {
    return "transfer_window_missing";
  }
  if (
    normalized.includes("outside the current window") ||
    normalized.includes("is outside the open window") ||
    normalized.includes("source and destination slots must differ")
  ) {
    return "transfer_slot_invalid";
  }
  if (
    normalized.includes("did not select the requested transfer item") ||
    normalized.includes("server did not select")
  ) {
    return "transfer_server_selection_unconfirmed";
  }
  if (
    normalized.includes("window click") ||
    normalized.includes("clickwindow") ||
    normalized.includes("click rejected") ||
    normalized.includes("server rejected transaction") ||
    normalized.includes("server didn't respond to transaction")
  ) {
    return "transfer_click_rejected";
  }
  if (normalized.includes("bounded action wait expired"))
    return "action_timeout";
  if (normalized.includes("action was stopped")) return "action_interrupted";
  if (
    normalized.includes("effect could not be confirmed") ||
    normalized.includes("effect was not confirmed") ||
    normalized.includes("not observable")
  ) {
    return "effect_unverified";
  }
  if (
    /econnrefused|econnreset|etimedout|connection (?:closed|reset)/u.test(
      normalized,
    )
  ) {
    return "transport_error";
  }
  return "other";
}

function classifyFurnaceTarget(name: string | undefined): FurnaceTargetClass {
  if (name === undefined) return "not_observed";
  return name === "furnace" || name.endsWith(":furnace") ? "furnace" : "other";
}

function classifyWindowType(type: string | undefined): WindowTypeClass {
  if (type === undefined) return "none";
  return type.toLowerCase().includes("furnace") ? "furnace" : "other";
}

function bodySmokeEvidence(
  diagnostic: BodySmokeDiagnostic | undefined,
): Readonly<Record<string, boolean | number | string>> {
  if (diagnostic === undefined) return {};
  const evidence: Record<string, boolean | number | string> = {
    fixtureLookStatus: diagnostic.fixtureLookStatus,
    fixtureLookDetailClass: diagnostic.fixtureLookDetailClass,
    fixtureTargetVisibleAfterLook: diagnostic.fixtureTargetVisibleAfterLook,
    fixtureTargetBlockName: diagnostic.fixtureTargetBlockName,
    ...(diagnostic.relativeMoveStatus === undefined
      ? {}
      : { relativeMoveStatus: diagnostic.relativeMoveStatus }),
    ...(diagnostic.relativeMoveServerDisplacementObserved === undefined
      ? {}
      : {
          relativeMoveServerDisplacementObserved:
            diagnostic.relativeMoveServerDisplacementObserved,
        }),
    ...(diagnostic.obstacleRouteStatus === undefined
      ? {}
      : { obstacleRouteStatus: diagnostic.obstacleRouteStatus }),
    ...(diagnostic.obstacleRouteDistanceBand === undefined
      ? {}
      : { obstacleRouteDistanceBand: diagnostic.obstacleRouteDistanceBand }),
    ...(diagnostic.obstacleRouteVerifiedByServer === undefined
      ? {}
      : {
          obstacleRouteVerifiedByServer:
            diagnostic.obstacleRouteVerifiedByServer,
        }),
    ...(diagnostic.obstacleRouteClientSpawnConfirmed === undefined
      ? {}
      : {
          obstacleRouteClientSpawnConfirmed:
            diagnostic.obstacleRouteClientSpawnConfirmed,
        }),
    ...(diagnostic.obstacleRouteEastProgress === undefined
      ? {}
      : { obstacleRouteEastProgress: diagnostic.obstacleRouteEastProgress }),
    ...(diagnostic.obstacleRouteLateralProgress === undefined
      ? {}
      : {
          obstacleRouteLateralProgress: diagnostic.obstacleRouteLateralProgress,
        }),
    ...(diagnostic.obstacleRoutePathStatus === undefined
      ? {}
      : { obstacleRoutePathStatus: diagnostic.obstacleRoutePathStatus }),
    ...(diagnostic.obstacleRoutePathUpdateCount === undefined
      ? {}
      : {
          obstacleRoutePathUpdateCount: diagnostic.obstacleRoutePathUpdateCount,
        }),
    ...(diagnostic.obstacleRouteMaxPathBand === undefined
      ? {}
      : { obstacleRouteMaxPathBand: diagnostic.obstacleRouteMaxPathBand }),
    ...(diagnostic.obstacleRouteTargetObservedInSweep === undefined
      ? {}
      : {
          obstacleRouteTargetObservedInSweep:
            diagnostic.obstacleRouteTargetObservedInSweep,
        }),
    ...(diagnostic.obstacleRouteLookSweepStatus === undefined
      ? {}
      : {
          obstacleRouteLookSweepStatus: diagnostic.obstacleRouteLookSweepStatus,
        }),
    ...(diagnostic.obstacleRouteLookSweepComplete === undefined
      ? {}
      : {
          obstacleRouteLookSweepComplete:
            diagnostic.obstacleRouteLookSweepComplete,
        }),
    ...(diagnostic.obstacleRouteLookSweepAnyViewTargetName === undefined
      ? {}
      : {
          obstacleRouteLookSweepAnyViewTargetName:
            diagnostic.obstacleRouteLookSweepAnyViewTargetName,
        }),
    ...(diagnostic.obstacleRouteLookSweepAnyTruncation === undefined
      ? {}
      : {
          obstacleRouteLookSweepAnyTruncation:
            diagnostic.obstacleRouteLookSweepAnyTruncation,
        }),
    ...(diagnostic.obstacleRouteLookSweepDistinctYawCount === undefined
      ? {}
      : {
          obstacleRouteLookSweepDistinctYawCount:
            diagnostic.obstacleRouteLookSweepDistinctYawCount,
        }),
    ...(diagnostic.obstacleRouteLookStatus === undefined
      ? {}
      : { obstacleRouteLookStatus: diagnostic.obstacleRouteLookStatus }),
    ...(diagnostic.obstacleRouteTargetVisibleAfterLook === undefined
      ? {}
      : {
          obstacleRouteTargetVisibleAfterLook:
            diagnostic.obstacleRouteTargetVisibleAfterLook,
        }),
    ...(diagnostic.resourceTargetRconConfirmed === undefined
      ? {}
      : {
          resourceTargetRconConfirmed: diagnostic.resourceTargetRconConfirmed,
        }),
    ...(diagnostic.resourceLookStatus === undefined
      ? {}
      : { resourceLookStatus: diagnostic.resourceLookStatus }),
    ...(diagnostic.resourceLookDetailClass === undefined
      ? {}
      : { resourceLookDetailClass: diagnostic.resourceLookDetailClass }),
    ...(diagnostic.resourceVisibleAfterSmoke === undefined
      ? {}
      : { resourceVisibleAfterSmoke: diagnostic.resourceVisibleAfterSmoke }),
    ...(diagnostic.targetVisibleInDigBeforeSnapshot === undefined
      ? {}
      : {
          targetVisibleInDigBeforeSnapshot:
            diagnostic.targetVisibleInDigBeforeSnapshot,
        }),
    ...(diagnostic.targetBlockNameInDigBeforeSnapshot === undefined
      ? {}
      : {
          targetBlockNameInDigBeforeSnapshot:
            diagnostic.targetBlockNameInDigBeforeSnapshot,
        }),
    ...(diagnostic.digStatus === undefined
      ? {}
      : { digStatus: diagnostic.digStatus }),
    ...(diagnostic.digRecoveryRequired === undefined
      ? {}
      : { digRecoveryRequired: diagnostic.digRecoveryRequired }),
    ...(diagnostic.digDetailClass === undefined
      ? {}
      : { digDetailClass: diagnostic.digDetailClass }),
    ...(diagnostic.serverBlockAirAfterDig === undefined
      ? {}
      : { serverBlockAirAfterDig: diagnostic.serverBlockAirAfterDig }),
    ...(diagnostic.furnaceFixtureRconConfirmed === undefined
      ? {}
      : {
          furnaceFixtureRconConfirmed: diagnostic.furnaceFixtureRconConfirmed,
        }),
    ...(diagnostic.furnaceLookStatus === undefined
      ? {}
      : { furnaceLookStatus: diagnostic.furnaceLookStatus }),
    ...(diagnostic.furnaceLookDetailClass === undefined
      ? {}
      : { furnaceLookDetailClass: diagnostic.furnaceLookDetailClass }),
    ...(diagnostic.furnaceTargetClassBeforeOpen === undefined
      ? {}
      : {
          furnaceTargetClassBeforeOpen: diagnostic.furnaceTargetClassBeforeOpen,
        }),
    ...(diagnostic.furnaceTargetVisibleBeforeOpen === undefined
      ? {}
      : {
          furnaceTargetVisibleBeforeOpen:
            diagnostic.furnaceTargetVisibleBeforeOpen,
        }),
    ...(diagnostic.furnaceOpenStatus === undefined
      ? {}
      : { furnaceOpenStatus: diagnostic.furnaceOpenStatus }),
    ...(diagnostic.furnaceOpenDetailClass === undefined
      ? {}
      : { furnaceOpenDetailClass: diagnostic.furnaceOpenDetailClass }),
    ...(diagnostic.furnaceWindowTypeClass === undefined
      ? {}
      : { furnaceWindowTypeClass: diagnostic.furnaceWindowTypeClass }),
  };
  for (const [key, value] of Object.entries(diagnostic)) {
    if (
      (key.startsWith("furnace") || key.startsWith("progressiveNavigation")) &&
      (typeof value === "boolean" ||
        typeof value === "number" ||
        typeof value === "string")
    ) {
      evidence[key] = value;
    }
  }
  return evidence;
}

function positiveNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function playerOf(evidence: Evidence): PlayerEvidence {
  const player: unknown = evidence.player;
  if (!isRecord(player)) incomplete("PLAYER_RUNTIME_EVIDENCE_MISSING");
  const counters: unknown = player.counters;
  if (!isRecord(counters)) incomplete("PLAYER_RUNTIME_COUNTERS_MISSING");
  const counterFields = [
    "llmCalls",
    "usageUnknownCalls",
    "usageUnknownRequestErrorCalls",
    "usageUnknownResponseUsageMissingCalls",
    "inputTokens",
    "outputTokens",
    "latencyMs",
    "thoughts",
    "learningUpdates",
  ] as const;
  for (const field of counterFields) {
    if (typeof counters[field] !== "number") {
      incomplete("PLAYER_RUNTIME_COUNTERS_INCOMPLETE");
    }
  }
  if (
    !Array.isArray(player.goals) ||
    !Array.isArray(player.proposals) ||
    !Array.isArray(player.recentJudgments) ||
    !Array.isArray(player.recentOutcomes) ||
    !Array.isArray(player.learningReferences) ||
    !Array.isArray(player.skillActivity) ||
    !Array.isArray(player.pendingEventKinds) ||
    typeof player.revision !== "number" ||
    typeof player.actionRevision !== "number" ||
    typeof player.stopped !== "boolean" ||
    typeof player.stopGeneration !== "number"
  ) {
    incomplete("PLAYER_RUNTIME_SNAPSHOT_INCOMPLETE");
  }
  return player as unknown as PlayerEvidence;
}

function countersOf(evidence: Evidence): Counters {
  const counters = playerOf(evidence).counters;
  return {
    llmCalls: positiveNumber(counters.llmCalls),
    usageUnknownCalls: positiveNumber(counters.usageUnknownCalls),
    usageUnknownRequestErrorCalls: positiveNumber(
      counters.usageUnknownRequestErrorCalls,
    ),
    usageUnknownResponseUsageMissingCalls: positiveNumber(
      counters.usageUnknownResponseUsageMissingCalls,
    ),
    inputTokens: positiveNumber(counters.inputTokens),
    outputTokens: positiveNumber(counters.outputTokens),
    latencyMs: positiveNumber(counters.latencyMs),
    thoughts: positiveNumber(counters.thoughts),
    learningUpdates: positiveNumber(counters.learningUpdates),
  };
}

function safePlayerDiagnostic(
  player: PlayerEvidence,
  counters: Counters,
): SafeEvidence {
  const lastJudgment = player.recentJudgments.at(-1);
  const lastOutcome = player.lastOutcome ?? player.recentOutcomes.at(-1);
  const activeOperationKind = safeOperationKind(player.activeOperation?.kind);
  const lastJudgmentKind = safeJudgmentKind(lastJudgment?.kind);
  const lastJudgmentOperationKind = safeOperationKind(
    lastJudgment?.operationKind,
  );
  const lastOutcomeKind = safeOperationKind(lastOutcome?.kind);
  const lastOutcomeStatus = safeOutcomeStatus(lastOutcome?.status);
  return {
    lastKnownLlmCalls: counters.llmCalls,
    lastKnownInputTokens: counters.inputTokens,
    lastKnownOutputTokens: counters.outputTokens,
    lastKnownLatencyMs: counters.latencyMs,
    lastKnownThoughts: counters.thoughts,
    lastKnownLearningUpdates: counters.learningUpdates,
    lastKnownActionRevision: positiveNumber(player.actionRevision),
    lastKnownJudgmentCount: player.recentJudgments.length,
    lastKnownOutcomeCount: player.recentOutcomes.length,
    lastKnownSuccessfulOutcomeCount: player.recentOutcomes.filter(
      ({ status }) => status === "successful",
    ).length,
    ...(activeOperationKind === undefined
      ? {}
      : { lastKnownActiveOperationKind: activeOperationKind }),
    ...(lastJudgmentKind === undefined
      ? {}
      : { lastKnownJudgmentKind: lastJudgmentKind }),
    ...(lastJudgmentOperationKind === undefined
      ? {}
      : { lastKnownJudgmentOperationKind: lastJudgmentOperationKind }),
    ...(lastOutcomeKind === undefined
      ? {}
      : { lastKnownOutcomeKind: lastOutcomeKind }),
    ...(lastOutcomeStatus === undefined
      ? {}
      : { lastKnownOutcomeStatus: lastOutcomeStatus }),
    recentAgentActivity: projectSafePlayerAgentActivityTail(
      player.recentAgentActivity ?? [],
    ),
  };
}

function safeOperationKind(
  value: string | undefined,
): PlayerOperationName | undefined {
  return value !== undefined &&
    playerOperationNames.includes(value as PlayerOperationName)
    ? (value as PlayerOperationName)
    : undefined;
}

function lastUnknownMoveOperationKind(
  player: PlayerEvidence,
  afterAt: number,
): UnknownMoveOperationKind | undefined {
  let latest:
    | { readonly at: number; readonly kind: UnknownMoveOperationKind }
    | undefined;
  const consider = (
    value: string | undefined,
    timestamp: string | undefined,
  ) => {
    const kind = safeOperationKind(value);
    const at = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
    if (
      (kind !== "move_to" && kind !== "move_relative") ||
      !Number.isFinite(at) ||
      at < afterAt ||
      (latest !== undefined && latest.at > at)
    ) {
      return;
    }
    latest = { at, kind };
  };

  const active = player.activeOperation;
  consider(active?.kind, active?.bodyStartedAt ?? active?.startedAt);
  for (const judgment of player.recentJudgments) {
    if (judgment.kind === "act")
      consider(judgment.operationKind, judgment.decidedAt);
  }
  for (const outcome of player.recentOutcomes) {
    consider(outcome.kind, outcome.observedAt);
  }
  return latest?.kind;
}

function safeJudgmentKind(
  value: string | undefined,
): PlayerJudgmentKind | undefined {
  return value === "act" ||
    value === "wait" ||
    value === "continue" ||
    value === "complete"
    ? value
    : undefined;
}

function safeOutcomeStatus(
  value: string | undefined,
): PlayerOutcomeStatus | undefined {
  return value === "successful" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "cancelled" ||
    value === "unverified"
    ? value
    : undefined;
}

function shouldCollectAfterRun(state: RunState): boolean {
  return state.abortRequested !== true;
}

function finalRunCounters(state: RunState): Counters {
  return state.countersFinal ?? state.countersInitial ?? zeroCounters();
}

function noFoodContinuitySafeEvidence(state: RunState): SafeEvidence {
  return {
    ...EMPTY_NO_FOOD_CONTINUITY_DIAGNOSTIC,
    ...state.noFoodContinuityDiagnostic,
    providerRequestBlocked:
      state.noFoodContinuityProviderRequestBlocked === true,
    providerRequestBlockedAfterReadback:
      state.noFoodContinuityProviderRequestBlockedAfterReadback === true,
  };
}

function noFoodReplanRequestEvidence(state: RunState): SafeEvidence {
  const requestGate = state.noFoodReplanRequestGate;
  return {
    noFoodReplanAcceptanceLatched: requestGate?.acceptanceLatched === true,
    noFoodReplanProviderRequestsBlockedAfterAcceptance:
      (requestGate?.providerRequestsBlockedAfterAcceptance ?? 0) > 0,
    noFoodReplanAcceptedRequestsSettled:
      requestGate?.acceptanceLatched === true &&
      requestGate.inFlightRequests === 0 &&
      requestGate.requestsRecorded === requestGate.requestsStarted,
    noFoodReplanAcceptedRequestsStarted: requestGate?.requestsStarted ?? 0,
    noFoodReplanAcceptedRequestsRecorded: requestGate?.requestsRecorded ?? 0,
    noFoodReplanAcceptedRequestsInFlight: requestGate?.inFlightRequests ?? 0,
    noFoodReplanRequestAccountingConsistent:
      requestGate === undefined ||
      requestGate.requestsRecorded <= requestGate.requestsStarted,
  };
}

function noFoodReplanSafeEvidence(state: RunState): SafeEvidence {
  const continuity = state.noFoodContinuityDiagnostic;
  return {
    ...EMPTY_NO_FOOD_REPLAN_DIAGNOSTIC,
    ...state.noFoodReplanDiagnostic,
    ...noFoodReplanRequestEvidence(state),
    startupBodyObservationAvailable:
      continuity?.startupBodyObservationAvailable === true,
    startupHealthBodyAndRconMatched:
      continuity?.bodyHealth !== null &&
      continuity?.bodyHealth !== undefined &&
      continuity.bodyHealth === continuity.rconHealth,
    startupFoodBodyAndRconMatched:
      continuity?.bodyFood !== null &&
      continuity?.bodyFood !== undefined &&
      continuity.bodyFood === continuity.rconFood,
    startupBodyInventoryEmpty: continuity?.bodyInventoryEmpty === true,
    startupRconInventoryEmpty: continuity?.rconInventoryEmpty === true,
    startupBodyHealth: continuity?.bodyHealth ?? null,
    startupRconHealth: continuity?.rconHealth ?? null,
    startupBodyFood: continuity?.bodyFood ?? null,
    startupRconFood: continuity?.rconFood ?? null,
  };
}

function ownerReturnRequestSafeEvidence(state: RunState): SafeEvidence {
  const gate = state.ownerReturnRequestGate;
  const diagnostic = state.ownerReturnDiagnostic;
  return {
    ownerReturnAcceptedProviderRequestsLatched: gate?.latched === true,
    ownerReturnAcceptedProviderRequestsStarted: gate?.requestsStarted ?? 0,
    ownerReturnAcceptedProviderRequestsRecorded: gate?.requestsRecorded ?? 0,
    ownerReturnAcceptedProviderRequestsInFlight: gate?.inFlightRequests ?? 0,
    ownerReturnAcceptedProviderRequestsBlockedAfterLatch:
      gate?.providerRequestsBlockedAfterLatch ?? 0,
    ownerReturnAcceptedProviderRequestsSettled:
      diagnostic?.acceptedProviderRequestsSettled === true,
    ownerReturnAcceptedProviderRequestSettleStatus:
      diagnostic?.acceptedProviderRequestSettleStatus ?? "unknown",
    ownerReturnProviderRequestAccountingConsistent:
      gate === undefined || gate.requestsRecorded <= gate.requestsStarted,
  };
}

function safeFailureEvidence(state: RunState, caseId: string): SafeEvidence {
  const progress =
    caseId === "autonomous_life" ? state.autonomousLifeProgress : undefined;
  return {
    ...(state.lastKnownPlayerDiagnostic ?? {}),
    ...(caseId === "no_food_continuity_probe"
      ? noFoodContinuitySafeEvidence(state)
      : {}),
    ...(caseId === "no_food_replan" ? noFoodReplanSafeEvidence(state) : {}),
    ...(caseId === "owner_return_through_door" &&
    ownerReturnRequestGateEnabled(state.targetCase)
      ? ownerReturnRequestSafeEvidence(state)
      : {}),
    ...(caseId === "observation_boundary"
      ? (state.observationBoundaryDiagnostic ?? {
          replyReceived: false,
          responseHeuristicClassification: "no_reply",
          manualReviewRequired: true,
        })
      : {}),
    ...(caseId === "unknown_composite"
      ? (state.unknownCompositeDiagnostic ?? {})
      : {}),
    ...(caseId === "parallel_dialogue_stop"
      ? (state.parallelDiagnostic ?? {})
      : {}),
    ...(caseId === "owner_stop_latch"
      ? (state.ownerStopLatchDiagnostic ?? {})
      : {}),
    ...(caseId === "gather_multi_target_continuity"
      ? gatherMultiTargetSafeEvidence(state)
      : {}),
    ...(caseId === "damage_response" &&
    state.damageResponseCleanupFailureCode !== undefined
      ? { cleanupFailureCode: state.damageResponseCleanupFailureCode }
      : {}),
    ...(caseId === "damage_response"
      ? (state.damageResponseFailureDiagnostic ?? {})
      : {}),
    ...(caseId === "damage_response" &&
    state.damageResponseDamageHealthReadback !== undefined
      ? {
          damageResponseBodyHealthAfterDamage:
            state.damageResponseDamageHealthReadback.bodyHealth,
          damageResponseRconHealthAfterDamage:
            state.damageResponseDamageHealthReadback.rconHealth,
        }
      : {}),
    ...(caseId === "body_operation_smoke"
      ? (state.deathRecoveryFixtureDiagnostic ?? {})
      : {}),
    ...gatherMultiTargetBodySmokeSafeFailureEvidence(
      caseId,
      state.targetCase,
      gatherMultiTargetSafeEvidence(state),
    ),
    ...(progress === undefined
      ? {}
      : {
          autonomousGoalSeen: progress.autonomousGoalSeen,
          autonomousActivitySeen: progress.activitySeen,
          autonomousSuccessfulActionSeen: progress.successfulActionSeen,
          autonomousWorldProgressSeen: progress.worldProgressSeen,
          autonomousSuccessfulOutcomeCount: progress.successfulOutcomeCount,
          autonomousFollowupJudgmentSeen: progress.followupJudgmentSeen,
          autonomousMilestoneSeen: progress.milestoneSeen,
          autonomousActiveOperationPresent: progress.activeOperationPresent,
          autonomousActiveBodyStarted: progress.activeBodyStarted,
          autonomousActiveBodyElapsedBucket: progress.activeBodyElapsedBucket,
        }),
    ...(caseId === "persistent_memory_restart" &&
    state.persistentMemoryDiagnostic !== undefined
      ? {
          persistentMemoryStage: state.persistentMemoryDiagnostic.stage,
          persistentMemoryReplyObserved:
            state.persistentMemoryDiagnostic.ownerReplyObserved,
          persistentMemoryRememberToolCalled:
            state.persistentMemoryDiagnostic.rememberToolCalled,
          persistentMemoryRememberToolResult:
            state.persistentMemoryDiagnostic.rememberToolResult,
          persistentMemoryFactPersisted:
            state.persistentMemoryDiagnostic.factPersisted,
        }
      : {}),
    ...(caseId === "learning_reuse" && state.learningReuseStage !== undefined
      ? { learningReuseStage: state.learningReuseStage }
      : {}),
    ...(caseId === "learning_reuse" &&
    state.learningReuseOwnerProposalRecorded !== undefined
      ? {
          learningReuseOwnerProposalRecorded:
            state.learningReuseOwnerProposalRecorded,
        }
      : {}),
    ...(caseId === "learning_reuse" &&
    state.firstDigLearningDiagnostic !== undefined
      ? {
          learningFirstDigOutcomeKind:
            state.firstDigLearningDiagnostic.outcomeKind,
          learningFirstDigOutcomeStatus:
            state.firstDigLearningDiagnostic.outcomeStatus,
          learningFirstDigOutcomeHasSkillAtUse:
            state.firstDigLearningDiagnostic.outcomeHasSkillAtUse,
          learningFirstDigBaselineHasOutcomeSkill:
            state.firstDigLearningDiagnostic.baselineHasOutcomeSkill,
          learningFirstDigBaselineOutcomeSkillIsTrustedDerived:
            state.firstDigLearningDiagnostic
              .baselineOutcomeSkillIsTrustedDerived,
          learningFirstDigCurrentHasOutcomeSkill:
            state.firstDigLearningDiagnostic.currentHasOutcomeSkill,
          learningFirstDigCurrentOutcomeSkillIsTrustedDerived:
            state.firstDigLearningDiagnostic
              .currentOutcomeSkillIsTrustedDerived,
          learningFirstDigCurrentOutcomeSkillHasUsedRevision:
            state.firstDigLearningDiagnostic.currentOutcomeSkillHasUsedRevision,
          learningFirstDigEvidenceRevisionPresent:
            state.firstDigLearningDiagnostic.firstDigEvidenceRevisionPresent,
          learningFirstDigEvidenceRevisionMatchesOutcome:
            state.firstDigLearningDiagnostic
              .firstDigEvidenceRevisionMatchesOutcome,
          learningFirstDigEvidenceRevisionHasMaterialChange:
            state.firstDigLearningDiagnostic
              .firstDigEvidenceRevisionHasMaterialChange,
          learningFirstDigEvidenceRevisionHasNoNewSkills:
            state.firstDigLearningDiagnostic
              .firstDigEvidenceRevisionHasNoNewSkills,
          learningFirstDigDerivedHypothesisPresent:
            state.firstDigLearningDiagnostic.firstDigDerivedHypothesisPresent,
          learningFirstDigDerivedHypothesisIsTrustedDerived:
            state.firstDigLearningDiagnostic
              .firstDigDerivedHypothesisIsTrustedDerived,
          learningFirstDigDerivedHypothesisHasRevision:
            state.firstDigLearningDiagnostic
              .firstDigDerivedHypothesisHasRevision,
          learningFirstDigDerivedHypothesisMatchesOutcome:
            state.firstDigLearningDiagnostic
              .firstDigDerivedHypothesisMatchesOutcome,
          learningBaselineSkillCount:
            state.firstDigLearningDiagnostic.baselineSkillCount,
          learningBaselineTrustedDerivedSkillCount:
            state.firstDigLearningDiagnostic.baselineTrustedDerivedSkillCount,
          learningCurrentSkillCount:
            state.firstDigLearningDiagnostic.currentSkillCount,
          learningCurrentTrustedDerivedSkillCount:
            state.firstDigLearningDiagnostic.currentTrustedDerivedSkillCount,
        }
      : {}),
    ...(caseId === "learning_reuse" &&
    state.learningFixtureDiagnostic !== undefined
      ? {
          learningFixturePhase: state.learningFixtureDiagnostic.phase,
          learningFixturePlacementConfirmedCount:
            state.learningFixtureDiagnostic.placementConfirmedCount,
          learningFixtureFreshBodyObservationSeen:
            state.learningFixtureDiagnostic.freshBodyObservationSeen,
          learningFixtureOakLogVisible:
            state.learningFixtureDiagnostic.oakLogVisibleInFreshObservation,
          ...(state.learningFixtureDiagnostic.activeOperationAtOrient ===
          undefined
            ? {}
            : {
                learningFixtureActiveOperationAtOrient:
                  state.learningFixtureDiagnostic.activeOperationAtOrient,
              }),
          ...(state.learningFixtureDiagnostic.yawMatched === undefined
            ? {}
            : {
                learningFixtureYawMatched:
                  state.learningFixtureDiagnostic.yawMatched,
              }),
          ...(state.learningFixtureDiagnostic.pitchMatched === undefined
            ? {}
            : {
                learningFixturePitchMatched:
                  state.learningFixtureDiagnostic.pitchMatched,
              }),
        }
      : {}),
    ...(caseId === "skill_exchange" && state.skillExchangeStage !== undefined
      ? { skillExchangeStage: state.skillExchangeStage }
      : {}),
    ...(caseId === "game_action_discretion" &&
    state.gameActionPriorProposalsSettled !== undefined
      ? {
          gameActionPriorPendingProposalCount:
            state.gameActionPriorPendingProposalCount ?? 0,
          gameActionPriorProposalsSettled:
            state.gameActionPriorProposalsSettled,
        }
      : {}),
    ...(caseId === "game_action_discretion"
      ? gameActionPlacementCandidateEvidence(state)
      : {}),
  };
}

function gatherMultiTargetSafeEvidence(state: RunState): SafeEvidence {
  const gate = state.gatherMultiTargetRequestGate;
  return {
    ...(state.gatherMultiTargetRequestedCounts === undefined
      ? {}
      : {
          gatherRequestedOakLogCount:
            state.gatherMultiTargetRequestedCounts.oak_log,
          gatherRequestedBirchLogCount:
            state.gatherMultiTargetRequestedCounts.birch_log,
        }),
    ...(state.gatherMultiTargetDiagnostic ?? {}),
    ...(gate === undefined
      ? {}
      : {
          gatherAcceptanceLatched: gate.latched,
          gatherAcceptedRequestsStarted: gate.requestsStarted,
          gatherAcceptedRequestsRecorded: gate.requestsRecorded,
          gatherAcceptedRequestsInFlight: gate.inFlightRequests,
          gatherProviderRequestsBlockedAfterLatch:
            gate.providerRequestsBlockedAfterLatch,
        }),
  };
}

function updateGatherMultiTargetDiagnostic(
  state: RunState,
  patch: SafeEvidence,
): void {
  state.gatherMultiTargetDiagnostic = {
    ...(state.gatherMultiTargetDiagnostic ?? {}),
    ...patch,
  };
}

function updateGatherMultiTargetInventoryReadDiagnostic(
  state: RunState,
  result: Awaited<ReturnType<typeof readGatherMultiTargetInventory>>,
  baseline: Readonly<Record<GatherMultiTargetItem, number>>,
): void {
  const parsed = result.reason === "parsed" ? result : undefined;
  const oakDelta =
    parsed?.counts.oak_log === undefined
      ? null
      : parsed.counts.oak_log - baseline.oak_log;
  const birchDelta =
    parsed?.counts.birch_log === undefined
      ? null
      : parsed.counts.birch_log - baseline.birch_log;
  updateGatherMultiTargetDiagnostic(state, {
    gatherLatestInventoryReadReason: result.reason,
    gatherLatestInventoryParseStage: result.parseStage,
    gatherLatestOakLogInventoryCount: parsed?.counts.oak_log ?? null,
    gatherLatestBirchLogInventoryCount: parsed?.counts.birch_log ?? null,
    gatherOakLogInventoryDelta: oakDelta,
    gatherBirchLogInventoryDelta: birchDelta,
  });
}

function safeGameActionFailureEvidence(
  state: RunState,
  evidence: Evidence | undefined,
): SafeEvidence {
  const player = evidence?.player;
  const baseline = state.gameActionEvidenceBaseline;
  if (player === undefined || baseline === undefined) {
    return {
      gameActionSnapshotAvailable: false,
      gameActionOperationArgumentsAvailable: false,
      gameActionFixtureHoleReadback:
        state.gameActionFixtureHoleReadback ?? "unknown",
    };
  }

  const placeDecisions = player.recentJudgments.filter(
    (judgment) =>
      judgment.revision > baseline.revision &&
      judgment.kind === "act" &&
      judgment.operationKind === "place",
  );
  const placeOutcomes = player.recentOutcomes.filter(
    (outcome) =>
      !baseline.outcomeOperationIds.has(outcome.operationId) &&
      outcome.kind === "place",
  );
  const failedPlaceOutcomes = placeOutcomes.filter(
    (outcome) => Reflect.get(outcome, "status") === "failed",
  );
  let failureSummaryMissingCount = 0;
  const occupiedFailures: typeof failedPlaceOutcomes = [];
  for (const outcome of failedPlaceOutcomes) {
    const summary: unknown = Reflect.get(outcome, "summary");
    if (typeof summary !== "string" || summary.trim() === "") {
      failureSummaryMissingCount += 1;
    } else if (
      summary.toLocaleLowerCase("en-US").includes("target position is occupied")
    ) {
      occupiedFailures.push(outcome);
    }
  }
  const decisionTimes = placeDecisions.map((decision) => {
    const decidedAt: unknown = Reflect.get(decision, "decidedAt");
    return typeof decidedAt === "string" ? Date.parse(decidedAt) : Number.NaN;
  });
  const occupiedFailureTimes = occupiedFailures.map((outcome) => {
    const observedAt: unknown = Reflect.get(outcome, "observedAt");
    return typeof observedAt === "string" ? Date.parse(observedAt) : Number.NaN;
  });
  const placeDecisionTimestampMissingCount = decisionTimes.filter(
    (timestamp) => !Number.isFinite(timestamp),
  ).length;
  const occupiedFailureTimestampMissingCount = occupiedFailureTimes.filter(
    (timestamp) => !Number.isFinite(timestamp),
  ).length;
  const orderingAvailable =
    failureSummaryMissingCount === 0 &&
    placeDecisionTimestampMissingCount === 0 &&
    occupiedFailureTimestampMissingCount === 0;
  const decisionsAfterOccupiedFailure = orderingAvailable
    ? decisionTimes.filter((decisionAt) =>
        occupiedFailureTimes.some((failureAt) => failureAt < decisionAt),
      ).length
    : 0;

  return {
    gameActionSnapshotAvailable: true,
    gameActionOperationArgumentsAvailable: false,
    gameActionFixtureHoleReadback:
      state.gameActionFixtureHoleReadback ?? "unknown",
    gameActionPlaceDecisionCount: placeDecisions.length,
    gameActionPlaceOutcomeCount: placeOutcomes.length,
    gameActionPlaceFailedOutcomeCount: failedPlaceOutcomes.length,
    gameActionOccupiedPlaceFailureCount: occupiedFailures.length,
    gameActionPlaceFailureSummaryMissingCount: failureSummaryMissingCount,
    gameActionPlaceDecisionTimestampMissingCount:
      placeDecisionTimestampMissingCount,
    gameActionOccupiedFailureTimestampMissingCount:
      occupiedFailureTimestampMissingCount,
    gameActionPlaceDecisionOrderingAvailable: orderingAvailable,
    ...(orderingAvailable
      ? {
          gameActionPlaceDecisionAfterOccupiedFailureCount:
            decisionsAfterOccupiedFailure,
        }
      : {}),
    gameActionPlaceDecisionAfterOccupiedFailureUnknownCount: orderingAvailable
      ? 0
      : placeDecisions.length,
    gameActionFixtureHoleMatchKnownCount: 0,
    gameActionFixtureHoleMatchUnknownCount: placeDecisions.length,
    gameActionSameTargetRetryKnownCount: 0,
    gameActionSameTargetRetryUnknownCount: orderingAvailable
      ? decisionsAfterOccupiedFailure
      : placeDecisions.length,
  };
}

function updateUnknownCompositeDiagnostic(
  state: RunState,
  diagnostic: UnknownCompositeDiagnostic,
): void {
  state.unknownCompositeDiagnostic = {
    ...(state.unknownCompositeDiagnostic ?? {}),
    ...diagnostic,
  };
}

function updateReturnPathProbeDiagnostic(
  state: RunState,
  diagnostic: Partial<ReturnPathProbeDiagnostic>,
): void {
  const current = state.bodySmokeDiagnostic;
  if (current === undefined) incomplete("BODY_SMOKE_DIAGNOSTIC_MISSING");
  state.bodySmokeDiagnostic = {
    ...current,
    returnPathProbe: {
      ...(current.returnPathProbe ?? {}),
      ...diagnostic,
    },
  };
}

function updateParallelDiagnostic(
  state: RunState,
  diagnostic: SafeEvidence,
): void {
  state.parallelDiagnostic = {
    ...(state.parallelDiagnostic ?? {}),
    ...diagnostic,
  };
}

function updateOwnerStopLatchDiagnostic(
  state: RunState,
  diagnostic: SafeEvidence,
): void {
  state.ownerStopLatchDiagnostic = {
    ...(state.ownerStopLatchDiagnostic ?? {}),
    ...diagnostic,
  };
}

function beginLearningFixtureDiagnostic(
  state: RunState,
  phase: LearningFixturePhase,
): void {
  state.learningFixtureDiagnostic = {
    phase,
    placementConfirmedCount: 0,
    freshBodyObservationSeen: false,
    oakLogVisibleInFreshObservation: false,
  };
}

function updateLearningFixtureDiagnostic(
  state: RunState,
  update: Partial<LearningFixtureDiagnostic>,
): void {
  const diagnostic = state.learningFixtureDiagnostic;
  if (diagnostic !== undefined)
    state.learningFixtureDiagnostic = { ...diagnostic, ...update };
}

function recordLearningFixtureObservation(
  state: RunState,
  configuredAt: number,
  player: PlayerEvidence,
): boolean {
  const diagnostic = state.learningFixtureDiagnostic;
  if (diagnostic === undefined) return false;
  const observedAt = player.lastObservation?.observedAt;
  const isFresh =
    observedAt !== undefined &&
    Number.isFinite(Date.parse(observedAt)) &&
    Date.parse(observedAt) >= configuredAt;
  const oakLogVisible =
    isFresh &&
    player.lastObservation?.visibleBlockNames?.includes("oak_log") === true;
  state.learningFixtureDiagnostic = {
    ...diagnostic,
    freshBodyObservationSeen: diagnostic.freshBodyObservationSeen || isFresh,
    oakLogVisibleInFreshObservation:
      diagnostic.oakLogVisibleInFreshObservation || oakLogVisible,
  };
  return isFresh && oakLogVisible;
}

function boundedOracleRcon(rcon: LocalRcon): OracleRcon {
  return {
    command: (command, timeoutMs) =>
      rcon.command(
        command,
        Math.min(
          timeoutMs ?? UNKNOWN_OBSTACLE_RCON_TIMEOUT_MS,
          UNKNOWN_OBSTACLE_RCON_TIMEOUT_MS,
        ),
      ),
  };
}

async function readGameActionFixtureHoleReadback(
  rcon: LocalRcon,
  target: BlockPosition,
): Promise<GameActionFixtureHoleReadback> {
  const boundedRcon = boundedOracleRcon(rcon);
  try {
    if (await blockIs(boundedRcon, target, "oak_planks", incomplete))
      return "oak_planks";
    if (await blockIs(boundedRcon, target, "air", incomplete)) return "air";
  } catch {
    // Keep private RCON replies and coordinates out of failure evidence.
  }
  return "unknown";
}

async function nearbyEntitiesClear(
  rcon: OracleRcon,
  position: Position,
  botName: string,
): Promise<boolean> {
  const reset = await rcon.command("scoreboard players set #oracle ai_e2e 0");
  if (classifyRconReply(reset) !== "success")
    incomplete("UNKNOWN_OBSTACLE_ENTITY_CHECK_UNAVAILABLE");
  const origin = `${Math.floor(position.x)} ${Math.floor(position.y)} ${Math.floor(position.z)}`;
  for (const selector of [
    `@a[name=!${botName},distance=..5]`,
    "@e[type=!player,distance=..5]",
  ]) {
    const reply = await rcon.command(
      `execute positioned ${origin} if entity ${selector} run scoreboard players set #oracle ai_e2e 1`,
    );
    if (reply !== "" && classifyRconReply(reply) !== "success")
      incomplete("UNKNOWN_OBSTACLE_ENTITY_CHECK_UNAVAILABLE");
  }
  const score = parseScore(
    await rcon.command("scoreboard players get #oracle ai_e2e"),
  );
  if (score !== 0 && score !== 1)
    incomplete("UNKNOWN_OBSTACLE_ENTITY_CHECK_UNAVAILABLE");
  return score === 0;
}

function positionInsideCage(position: Position, region: BlockRegion): boolean {
  return (
    position.x >= region.minX + 1 &&
    position.x < region.maxX &&
    position.y >= region.minY &&
    position.y < region.minY + 1.5 &&
    position.z >= region.minZ + 1 &&
    position.z < region.maxZ
  );
}

function positionStandingCenteredInCage(
  position: Position,
  region: BlockRegion,
): boolean {
  return (
    position.x >= region.minX + 1.5 &&
    position.x < region.maxX - 0.5 &&
    Math.abs(position.y - region.minY) <= 0.05 &&
    position.z >= region.minZ + 1.5 &&
    position.z < region.maxZ - 0.5
  );
}

async function standingSpaceStatus(
  rcon: OracleRcon,
  position: Position,
  region: BlockRegion,
  botName: string,
  timeoutMs: number,
): Promise<"safe" | "unsafe" | "unavailable"> {
  if (!positionStandingCenteredInCage(position, region)) return "unsafe";
  const x = Math.floor(position.x);
  const z = Math.floor(position.z);
  try {
    const reply = await rcon.command(
      `execute if block ${x} ${region.minY} ${z} minecraft:air if block ${x} ${region.minY + 1} ${z} minecraft:air if block ${x} ${region.minY - 1} ${z} minecraft:stone run data get entity ${botName} Pos`,
      timeoutMs,
    );
    if (/^test failed\.?$/iu.test(reply.trim())) return "unsafe";
    return /has the following entity data:/iu.test(reply)
      ? "safe"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

function subtractCounters(after: Counters, before: Counters): Counters {
  return {
    llmCalls: Math.max(0, after.llmCalls - before.llmCalls),
    usageUnknownCalls: Math.max(
      0,
      after.usageUnknownCalls - before.usageUnknownCalls,
    ),
    usageUnknownRequestErrorCalls: Math.max(
      0,
      after.usageUnknownRequestErrorCalls -
        before.usageUnknownRequestErrorCalls,
    ),
    usageUnknownResponseUsageMissingCalls: Math.max(
      0,
      after.usageUnknownResponseUsageMissingCalls -
        before.usageUnknownResponseUsageMissingCalls,
    ),
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    latencyMs: Math.max(0, after.latencyMs - before.latencyMs),
    thoughts: Math.max(0, after.thoughts - before.thoughts),
    learningUpdates: Math.max(
      0,
      after.learningUpdates - before.learningUpdates,
    ),
  };
}

function safeUsageUnknownReasonEvidence(
  caseId: string,
  counters: Counters,
): SafeEvidence {
  if (caseId !== "damage_response") return {};
  return {
    usageUnknownRequestErrorCalls: counters.usageUnknownRequestErrorCalls,
    usageUnknownResponseUsageMissingCalls:
      counters.usageUnknownResponseUsageMissingCalls,
  };
}

function totalTokens(counters: Counters): number {
  return counters.inputTokens + counters.outputTokens;
}

function waitMs(timeoutMs: number): Promise<void> {
  return delay(timeoutMs);
}

function boundedBudgetValue(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const configured = process.env[name]?.trim();
  if (configured === undefined || configured.length === 0) return fallback;
  if (!/^\d+$/u.test(configured)) incomplete("RUN_BUDGET_CONFIG_INVALID");
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    incomplete("RUN_BUDGET_CONFIG_OUT_OF_RANGE");
  }
  return value;
}

function runBudgetFromEnvironment(): RunBudget {
  const durationMinutes = boundedBudgetValue(
    "AI_PLAYER_E2E_MAX_DURATION_MINUTES",
    DEFAULT_RUN_BUDGET.durationMs / 60_000,
    RUN_BUDGET_LIMITS.durationMs / 60_000,
  );
  return {
    durationMs: durationMinutes * 60_000,
    llmCalls: boundedBudgetValue(
      "AI_PLAYER_E2E_MAX_LLM_CALLS",
      DEFAULT_RUN_BUDGET.llmCalls,
      RUN_BUDGET_LIMITS.llmCalls,
    ),
    totalTokens: boundedBudgetValue(
      "AI_PLAYER_E2E_MAX_TOTAL_TOKENS",
      DEFAULT_RUN_BUDGET.totalTokens,
      RUN_BUDGET_LIMITS.totalTokens,
    ),
  };
}

export function runBudgetCoversCase(
  runBudget: Pick<RunBudget, "llmCalls" | "totalTokens">,
  caseBudget: Pick<RunBudget, "llmCalls" | "totalTokens">,
): boolean {
  return (
    runBudget.llmCalls >= caseBudget.llmCalls &&
    runBudget.totalTokens >= caseBudget.totalTokens
  );
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    incomplete("LOOPBACK_PORT_UNAVAILABLE");
  }
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

function encodeRconPacket(
  requestId: number,
  type: number,
  body: string,
): Buffer {
  const content = Buffer.from(body, "utf8");
  const packet = Buffer.alloc(content.length + 14);
  packet.writeInt32LE(content.length + 10, 0);
  packet.writeInt32LE(requestId, 4);
  packet.writeInt32LE(type, 8);
  content.copy(packet, 12);
  packet.writeUInt8(0, packet.length - 2);
  packet.writeUInt8(0, packet.length - 1);
  return packet;
}

const LOCAL_RCON_MAX_PACKET_BYTES = 65_536;
const LOCAL_RCON_MAX_RESPONSE_BYTES = LOCAL_RCON_MAX_PACKET_BYTES - 10;
const LOCAL_RCON_MAX_RESPONSE_PACKETS = 64;
const LOCAL_RCON_RESPONSE_TERMINATOR = "time query gametime";

interface LocalRconPacket {
  readonly id: number;
  readonly type: number;
  readonly body: string;
  readonly bodyBytes: number;
}

export class LocalRcon {
  public constructor(
    private readonly port: number,
    private readonly password: string,
  ) {}

  public async command(command: string, timeoutMs = 5_000): Promise<string> {
    const socket = createConnection({ host: "127.0.0.1", port: this.port });
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    const packets: LocalRconPacket[] = [];
    const waiters: {
      readonly resolve: (packet: LocalRconPacket) => void;
      readonly reject: (error: Error) => void;
    }[] = [];
    let nextId = 1;
    let receivedPacketCount = 0;
    let terminalError: Error | undefined;
    const timer = setTimeout(
      () => socket.destroy(new Error("RCON_TIMEOUT")),
      timeoutMs,
    );

    const packet = (value: LocalRconPacket) => {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve(value);
        return;
      }
      packets.push(value);
    };
    const readPacket = () =>
      new Promise<LocalRconPacket>((resolvePacket, reject) => {
        const existing = packets.shift();
        if (existing !== undefined) {
          resolvePacket(existing);
          return;
        }
        if (terminalError !== undefined) {
          reject(terminalError);
          return;
        }
        waiters.push({ resolve: resolvePacket, reject });
      });
    const rejectAll = (error: Error) => {
      terminalError ??= error;
      for (const waiter of waiters) waiter.reject(terminalError);
      waiters.length = 0;
    };
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readInt32LE(0);
        if (length < 10 || length > LOCAL_RCON_MAX_PACKET_BYTES) {
          socket.destroy(new Error("RCON_INVALID_PACKET"));
          return;
        }
        if (buffered.length < length + 4) return;
        receivedPacketCount += 1;
        if (receivedPacketCount > LOCAL_RCON_MAX_RESPONSE_PACKETS + 2) {
          socket.destroy(new Error("RCON_RESPONSE_LIMIT_EXCEEDED"));
          return;
        }
        const id = buffered.readInt32LE(4);
        const type = buffered.readInt32LE(8);
        const bodyBuffer = buffered.subarray(12, 4 + length - 2);
        buffered = buffered.subarray(4 + length);
        packet({
          id,
          type,
          body: bodyBuffer.toString("utf8"),
          bodyBytes: bodyBuffer.byteLength,
        });
      }
    });
    socket.on("error", (error) => rejectAll(error));
    socket.on("close", () => rejectAll(new Error("RCON_CONNECTION_CLOSED")));
    try {
      await new Promise<void>((resolveConnect, reject) => {
        socket.once("connect", () => resolveConnect());
        socket.once("error", reject);
      });
      const authId = nextId++;
      socket.write(encodeRconPacket(authId, 3, this.password));
      const authResponse = await readPacket();
      if (authResponse.id !== authId || authResponse.type !== 2)
        incomplete("RCON_AUTH_FAILED");
      const commandId = nextId++;
      const terminatorId = nextId++;
      socket.write(encodeRconPacket(commandId, 2, command));
      socket.write(
        encodeRconPacket(terminatorId, 2, LOCAL_RCON_RESPONSE_TERMINATOR),
      );

      const responseBodies: string[] = [];
      let responseBytes = 0;
      let responsePackets = 0;
      let terminated = false;
      while (!terminated) {
        const response = await readPacket();
        if (response.id === terminatorId) {
          if (response.type !== 0 && response.type !== 2)
            incomplete("RCON_TERMINATOR_FAILED");
          if (responsePackets === 0) incomplete("RCON_EMPTY_RESPONSE");
          terminated = true;
          continue;
        }
        if (response.id !== commandId) {
          incomplete("RCON_UNEXPECTED_RESPONSE_PACKET");
        }
        if (response.type !== 0 && response.type !== 2) {
          incomplete("RCON_COMMAND_FAILED");
        }
        responsePackets += 1;
        responseBytes += response.bodyBytes;
        if (
          responsePackets > LOCAL_RCON_MAX_RESPONSE_PACKETS ||
          responseBytes > LOCAL_RCON_MAX_RESPONSE_BYTES
        ) {
          incomplete("RCON_RESPONSE_LIMIT_EXCEEDED");
        }
        responseBodies.push(response.body);
      }
      return responseBodies.join("");
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      incomplete(
        error instanceof Error &&
          [
            "RCON_TIMEOUT",
            "RCON_INVALID_PACKET",
            "RCON_RESPONSE_LIMIT_EXCEEDED",
            "RCON_CONNECTION_CLOSED",
          ].includes(error.message)
          ? error.message
          : "RCON_UNAVAILABLE",
      );
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }
}

interface Runtime {
  readonly app: CompanionApplication;
  readonly config: ReturnType<typeof loadConfig>;
  readonly databasePath: string;
  readonly exchangeDirectory: string;
}

interface CaseContext {
  runtime: Runtime;
  readonly rcon: LocalRcon;
  readonly owner: Bot;
  readonly guest: Bot;
  readonly botName: string;
  readonly ownerName: string;
  readonly responseQueue: OwnerResponse[];
  readonly usageAtStart: Counters;
  readonly runUsageAtStart: Counters;
  readonly startedAt: number;
  readonly runDeadlineAt: number;
  readonly caseDeadlineAt: number;
  readonly runBudget: RunBudget;
  readonly caseBudget?: {
    readonly llmCalls: number;
    readonly totalTokens: number;
  };
}

interface RunState {
  readonly id: string;
  readonly targetCase?: TargetableCase;
  readonly startedAt: string;
  readonly seed: string;
  readonly runBudget: RunBudget;
  llmAdmission?: LlmCallAdmission;
  readonly cases: SafeCaseResult[];
  readonly startedClock: number;
  readonly runDeadlineAt: number;
  readonly artifactPath: string;
  readonly isolatedDirectory: string;
  readonly serverDirectory: string;
  readonly privateServerLogPath: string;
  readonly serverPort: number;
  readonly rconPort: number;
  readonly botName: string;
  readonly ownerName: string;
  readonly guestName: string;
  readonly rconPassword: string;
  readonly serverJar: string;
  readonly serverCacheDirectory?: string;
  readonly javaPath: string;
  readonly eulaContents: string;
  readonly databasePath: string;
  readonly exchangeDirectory: string;
  readonly worldFixture: string;
  serverProcess?: ChildProcessWithoutNullStreams;
  runtime?: Runtime;
  owner?: Bot;
  guest?: Bot;
  readonly responses: OwnerResponse[];
  countersInitial?: Counters;
  countersFinal?: Counters;
  lastKnownPlayerDiagnostic?: SafeEvidence;
  autonomousLifeProgress?: SafeAutonomousProgress;
  learningReuseStage?: LearningReuseStage;
  learningReuseOwnerProposalRecorded?: boolean;
  firstDigLearningDiagnostic?: FirstDigLearningDiagnostic;
  learningFixtureDiagnostic?: LearningFixtureDiagnostic;
  skillExchangeStage?: SkillExchangeStage;
  gameActionPriorPendingProposalCount?: number;
  gameActionPriorProposalsSettled?: boolean;
  gameActionFixtureHoleReadback?: GameActionFixtureHoleReadback;
  gameActionPlacementCandidateDiagnostic?: GameActionPlacementCandidateDiagnostic;
  unknownCompositeDiagnostic?: SafeEvidence;
  parallelDiagnostic?: SafeEvidence;
  ownerStopLatchDiagnostic?: SafeEvidence;
  foodIntentContinuityDiagnostic?: FoodIntentContinuityDiagnostic;
  ownerReturnDiagnostic?: OwnerReturnDiagnostic;
  ownerReturnProposalIdForRun?: string;
  ownerReturnCaseUsageStart?: Counters;
  ownerReturnRequestGate?: AcceptedProviderRequestGate;
  ownerReturnRequestSettlement?: () => Promise<AcceptedProviderRequestSettleStatus>;
  ownerReturnRequestSettlementStatus?: AcceptedProviderRequestSettleStatus;
  ownerReturnCaseDeadlineAt?: number;
  gatherMultiTargetRequestGate?: AcceptedProviderRequestGate;
  gatherMultiTargetRequestGateUsageStart?: Counters;
  gatherMultiTargetRequestedCounts?: Readonly<
    Record<GatherMultiTargetItem, number | "unknown">
  >;
  gatherMultiTargetDiagnostic?: SafeEvidence;
  gatherProgressReplyHash?: string;
  gatherProgressReplySidecarRetained?: boolean;
  damageResponseCleanupFailureCode?: string;
  damageResponseFailureDiagnostic?: {
    readonly damageResponseFreshPurposeCommitObserved: boolean;
    readonly damageResponsePostDamageJudgment:
      "candidate" | "other" | "not_observed" | "unknown";
    readonly damageResponseLinkedSuccessfulOutcomeObserved: boolean;
  };
  damageResponseDamageHealthReadback?: {
    readonly bodyHealth: number | null;
    readonly rconHealth: number | null;
  };
  usageUncertain?: boolean;
  failureCode?: string;
  status?: Status;
  temporaryWorldRemoved?: boolean;
  serverProcessExited?: boolean;
  loopbackListenersClosed?: boolean;
  preStartPlayer?: PlayerEvidence;
  gameActionEvidenceBaseline?: {
    readonly revision: number;
    readonly outcomeOperationIds: ReadonlySet<string>;
  };
  autonomousBaseline?: WorldSnapshot;
  autonomousSmokeBaseline?: WorldSnapshot;
  autonomousRegion?: BlockRegion;
  unknownHandoffDependency?: UnknownHandoffDependencyState;
  copiedServerCacheAreas?: string[];
  privateServerLogStream: WriteStream | undefined;
  privateDiagnosticLogPath?: string;
  privateDiagnosticLogRetained?: boolean;
  privatePlayerSnapshotSidecarPath?: string;
  playerSnapshotSidecarRetained?: boolean;
  playerSnapshotSidecarFailureCode?: string;
  playerSnapshotSidecarRecordCount?: number;
  privateServerLogWriteFailed?: boolean;
  abortRequested?: boolean;
  serverReadyObserved?: boolean;
  applicationStartDiagnostic?: SafeApplicationStartDiagnostic;
  bodySmokeDiagnostic?: BodySmokeDiagnostic;
  deathRecoveryFixtureDiagnostic?: SafeEvidence;
  observationBoundaryCapture?: {
    readonly responseStart: number;
    responseEnd?: number;
    requestSentAt?: number;
    visibleObservationAt?: number;
  };
  observationBoundaryDiagnostic?: {
    readonly replyReceived: boolean;
    readonly responseHeuristicClassification: string;
    readonly manualReviewRequired: true;
    readonly observationBeforeReply?: boolean;
  };
  observationBoundarySidecarRetained?: boolean;
  persistentMemoryDiagnostic?: PersistentMemoryProgress;
  noFoodContinuityDiagnostic?: NoFoodContinuityDiagnostic;
  noFoodContinuityProviderRequestBlocked?: boolean;
  noFoodContinuityProviderRequestBlockedAfterReadback?: boolean;
  noFoodReplanDiagnostic?: NoFoodReplanDiagnostic;
  noFoodReplanCaseUsageStart?: Counters;
  noFoodReplanLatestCounters?: Counters;
  noFoodReplanRequestGate?: NoFoodReplanRequestGate;
}

interface FoodIntentContinuityDiagnostic {
  caseStarted: boolean;
  hungerPreparedWithServerEffect: boolean;
  hungerEffectCleanupConfirmed: boolean;
  carriedBreadConfirmed: boolean;
  ownerReferenceTurnObserved: boolean;
  hungryFollowupSent: boolean;
  hungryPurposeCommitObserved: boolean;
  consumeOutcomeObserved: boolean;
  consumeOutcomeSuccessful: boolean;
  serverBreadDecrementConfirmed: boolean;
  serverFoodLevelIncreaseConfirmed: boolean;
  fullHunger20ReadbackConfirmed: boolean;
  fullStageBreadFixtureConfirmed: boolean;
  fullStageOwnerRequestSent: boolean;
  fullStageOwnerProposalResolved: boolean;
  fullHungerExplanationReceived: boolean;
  fullStagePurposeCommitObserved: boolean;
  fullStageNonConsumingDecisionObserved: boolean;
  fullStageConsumeSelected: boolean;
  fullStageConsumeNotSelected: boolean;
  fullStageBreadUnchangedConfirmed: boolean;
  fullStageFoodLevelUnchangedConfirmed: boolean;
}

const EMPTY_FOOD_INTENT_CONTINUITY_DIAGNOSTIC: FoodIntentContinuityDiagnostic =
  {
    caseStarted: false,
    hungerPreparedWithServerEffect: false,
    hungerEffectCleanupConfirmed: false,
    carriedBreadConfirmed: false,
    ownerReferenceTurnObserved: false,
    hungryFollowupSent: false,
    hungryPurposeCommitObserved: false,
    consumeOutcomeObserved: false,
    consumeOutcomeSuccessful: false,
    serverBreadDecrementConfirmed: false,
    serverFoodLevelIncreaseConfirmed: false,
    fullHunger20ReadbackConfirmed: false,
    fullStageBreadFixtureConfirmed: false,
    fullStageOwnerRequestSent: false,
    fullStageOwnerProposalResolved: false,
    fullHungerExplanationReceived: false,
    fullStagePurposeCommitObserved: false,
    fullStageNonConsumingDecisionObserved: false,
    fullStageConsumeSelected: false,
    fullStageConsumeNotSelected: false,
    fullStageBreadUnchangedConfirmed: false,
    fullStageFoodLevelUnchangedConfirmed: false,
  };

function updateFoodIntentContinuityDiagnostic(
  state: RunState,
  update: Partial<FoodIntentContinuityDiagnostic>,
): void {
  state.foodIntentContinuityDiagnostic = {
    ...EMPTY_FOOD_INTENT_CONTINUITY_DIAGNOSTIC,
    ...state.foodIntentContinuityDiagnostic,
    ...update,
  };
}

let appForCleanup: CompanionApplication | undefined;
let serverForCleanup: ChildProcessWithoutNullStreams | undefined;
let ownerForCleanup: Bot | undefined;
let guestForCleanup: Bot | undefined;
let currentRunState: RunState | undefined;
let activeCaseSnapshotCapture: { latestEvidence?: Evidence } | undefined;
let activeGameActionPlacementObservationProbe:
  GameActionPlacementObservationProbe | undefined;
let activeApplicationPlayerBody: MineflayerPlayerBody | undefined;
let restoreGameActionPlacementObservationProbe: (() => void) | undefined;
let restoreNoFoodContinuityObservationProbe: (() => void) | undefined;

type ApplicationFactory = typeof createApplication;

export function createOwnerReturnApplicationWithBodyCapture(
  targetCase: TargetableCase | undefined,
  createApplication: ApplicationFactory,
  config: Parameters<ApplicationFactory>[0],
  beforeCall?: Parameters<ApplicationFactory>[1],
  onPlayerBodyCreated?: (body: MineflayerPlayerBody) => void,
): Readonly<{
  application: ReturnType<ApplicationFactory>;
  restoreProbe?: () => void;
}> {
  if (!ownerReturnRequestGateEnabled(targetCase))
    return { application: createApplication(config, beforeCall) };

  const restoreProbe =
    installGameActionPlacementObservationProbe(onPlayerBodyCreated);
  try {
    return {
      application: createApplication(config, beforeCall),
      restoreProbe,
    };
  } catch (error) {
    restoreProbe();
    throw error;
  }
}

function installGameActionPlacementObservationProbe(
  onPlayerBodyCreated?: (body: MineflayerPlayerBody) => void,
): () => void {
  const prototype = MineflayerPlayerBody.prototype;
  const originalObserveDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "observe",
  );
  if (typeof originalObserveDescriptor?.value !== "function")
    throw new Error("PlayerBody observation method is unavailable");
  const originalObserve =
    originalObserveDescriptor.value as typeof prototype.observe;
  const createPlayerBodyDescriptor = Object.getOwnPropertyDescriptor(
    MineflayerClient.prototype,
    "createPlayerBody",
  );
  if (typeof createPlayerBodyDescriptor?.value !== "function")
    throw new Error("MineflayerClient body factory is unavailable");
  const originalCreatePlayerBody = createPlayerBodyDescriptor.value as (
    this: MineflayerClient,
  ) => PlayerBody;
  const instrumentedCreatePlayerBody = function (
    this: MineflayerClient,
  ): PlayerBody {
    const body = originalCreatePlayerBody.call(this);
    activeApplicationPlayerBody = body as MineflayerPlayerBody;
    onPlayerBodyCreated?.(body as MineflayerPlayerBody);
    return body;
  };
  const instrumentedObserve = async function (
    this: MineflayerPlayerBody,
    options?: PlayerBodyObservationOptions,
  ): Promise<PlayerBodyObservation> {
    const observation = await originalObserve.call(this, options);
    const probe = activeGameActionPlacementObservationProbe;
    const observedAt = Date.parse(observation.observedAt);
    if (
      probe !== undefined &&
      Number.isFinite(observedAt) &&
      observedAt > probe.freshAfter
    ) {
      probe.observationsByTime.set(observation.observedAt, {
        fixtureHoleCandidatePresent:
          observation.perception.placementCandidates.some(
            ({ position }) =>
              position.x === probe.target.x &&
              position.y === probe.target.y &&
              position.z === probe.target.z,
          ),
        placementCandidatesMayBeTruncated:
          observation.perception.placementCandidatesMayBeTruncated,
        placementCandidateCount:
          observation.perception.placementCandidates.length,
      });
      while (probe.observationsByTime.size > 64) {
        const firstObservedAt = probe.observationsByTime.keys().next().value;
        if (firstObservedAt === undefined) break;
        probe.observationsByTime.delete(firstObservedAt);
      }
    }
    return observation;
  };
  prototype.observe = instrumentedObserve;
  MineflayerClient.prototype.createPlayerBody = instrumentedCreatePlayerBody;
  return () => {
    if (prototype.observe === instrumentedObserve)
      prototype.observe = originalObserve;
    if (
      MineflayerClient.prototype.createPlayerBody ===
      instrumentedCreatePlayerBody
    ) {
      MineflayerClient.prototype.createPlayerBody = originalCreatePlayerBody;
    }
    activeApplicationPlayerBody = undefined;
  };
}

function installNoFoodContinuityObservationProbe(
  state: RunState,
  rcon: LocalRcon,
): () => void {
  const prototype = MineflayerPlayerBody.prototype;
  const originalObserveDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "observe",
  );
  if (typeof originalObserveDescriptor?.value !== "function")
    throw new Error("PlayerBody observation method is unavailable");
  const originalObserve =
    originalObserveDescriptor.value as typeof prototype.observe;
  let captured = false;
  const instrumentedObserve = async function (
    this: MineflayerPlayerBody,
    options?: PlayerBodyObservationOptions,
  ): Promise<PlayerBodyObservation> {
    const observation = await originalObserve.call(this, options);
    if (!captured) {
      captured = true;
      const [rconHealth, rconFood, rconInventoryEmpty] = await Promise.all([
        rconEntityHealth(rcon, state.botName).catch(() => null),
        rconFoodLevel(rcon, state.botName).catch(() => null),
        rconInventoryIsEmpty(rcon, state.botName).catch(() => false),
      ]);
      const bodyHealth = observation.self.health;
      const bodyFood = observation.self.food;
      const bodyInventoryEmpty =
        observation.self.inventory.reduce(
          (count, item) => count + item.count,
          0,
        ) === 0 &&
        Object.values(observation.self.equipment).every(
          (item) => item === null,
        );
      const healthConfirmed =
        bodyHealth !== null &&
        bodyHealth > 0 &&
        bodyHealth <= 6 &&
        rconHealth !== null &&
        rconHealth > 0 &&
        rconHealth <= 6 &&
        bodyHealth === rconHealth;
      const foodConfirmed =
        bodyFood !== null &&
        bodyFood >= 12 &&
        bodyFood <= 15 &&
        rconFood !== null &&
        rconFood >= 12 &&
        rconFood <= 15 &&
        bodyFood === rconFood;
      state.noFoodContinuityDiagnostic = {
        startupBodyObservationAvailable: true,
        startupStateConfirmed:
          healthConfirmed &&
          foodConfirmed &&
          bodyInventoryEmpty &&
          rconInventoryEmpty,
        bodyHealth,
        rconHealth,
        bodyFood,
        rconFood,
        bodyInventoryEmpty,
        rconInventoryEmpty,
      };
    }
    return observation;
  };
  prototype.observe = instrumentedObserve;
  return () => {
    if (prototype.observe === instrumentedObserve)
      prototype.observe = originalObserve;
  };
}

function gameActionPlacementCandidateEvidence(state: RunState): SafeEvidence {
  const diagnostic = state.gameActionPlacementCandidateDiagnostic;
  if (
    diagnostic === undefined ||
    !diagnostic.freshBodyObservationMatched ||
    diagnostic.fixtureHoleCandidatePresent === undefined ||
    diagnostic.placementCandidatesMayBeTruncated === undefined ||
    diagnostic.placementCandidateCount === undefined
  ) {
    return { gameActionPlacementObservationAvailable: false };
  }
  return {
    gameActionPlacementObservationAvailable: true,
    gameActionFixtureHoleInPlacementCandidates:
      diagnostic.fixtureHoleCandidatePresent,
    gameActionPlacementCandidatesMayBeTruncated:
      diagnostic.placementCandidatesMayBeTruncated,
    gameActionPlacementCandidateCount: diagnostic.placementCandidateCount,
  };
}

function readGameActionPlacementCandidateDiagnostic(
  probe: GameActionPlacementObservationProbe,
  observedAt: string | undefined,
  freshAfter: number,
): GameActionPlacementCandidateDiagnostic {
  if (observedAt === undefined || Date.parse(observedAt) <= freshAfter)
    return { freshBodyObservationMatched: false };
  const summary = probe.observationsByTime.get(observedAt);
  return summary === undefined
    ? { freshBodyObservationMatched: false }
    : { freshBodyObservationMatched: true, ...summary };
}

export function classifyNoFoodReplanDecision(
  kind: string | undefined,
  operationKind: string | undefined,
): NoFoodReplanDecisionClass {
  if (kind === "wait") return "wait";
  if (kind === "continue") return "continue";
  if (kind === "complete") return "complete";
  if (kind !== "act") return "unknown";
  const operation = safeOperationKind(operationKind);
  if (operation === undefined) return "unknown";
  return operation === "consume" ? "consume" : "alternative";
}

export function isNoFoodReplanPurposeAfterOutcome(
  judgmentAt: string | undefined,
  outcomeObservedAt: string | undefined,
): boolean {
  const judgmentTime = Date.parse(judgmentAt ?? "");
  const outcomeTime = Date.parse(outcomeObservedAt ?? "");
  return (
    Number.isFinite(judgmentTime) &&
    Number.isFinite(outcomeTime) &&
    judgmentTime > outcomeTime
  );
}

export function noFoodReplanBeforeCallBlockReason(
  callsStarted: number,
  usageUnknownCalls: number,
  knownTokens: number,
): "LLM_USAGE_PARTIAL_OR_UNKNOWN" | "CASE_LLM_BUDGET_EXCEEDED" | undefined {
  if (usageUnknownCalls > 0) return "LLM_USAGE_PARTIAL_OR_UNKNOWN";
  if (
    callsStarted >= NO_FOOD_REPLAN_CASE_BUDGET.llmCalls ||
    knownTokens >= NO_FOOD_REPLAN_CASE_BUDGET.totalTokens
  )
    return "CASE_LLM_BUDGET_EXCEEDED";
  return undefined;
}

export function noFoodReplanOraclesConfirmed(
  bodyHealth: number | null,
  rconHealth: number | null,
  bodyFood: number | null,
  rconFood: number | null,
  bodyInventoryEmpty: boolean,
  rconInventoryEmpty: boolean,
): boolean {
  return (
    bodyHealth !== null &&
    bodyHealth > 0 &&
    rconHealth === bodyHealth &&
    bodyFood !== null &&
    bodyFood >= 12 &&
    bodyFood <= 15 &&
    rconFood === bodyFood &&
    rconFood >= 12 &&
    rconFood <= 15 &&
    bodyInventoryEmpty &&
    rconInventoryEmpty
  );
}

interface NoFoodReplanOracle {
  readonly bodyHealth: number | null;
  readonly rconHealth: number | null;
  readonly bodyFood: number | null;
  readonly rconFood: number | null;
  readonly noFoodStateConfirmed: boolean;
}

async function readNoFoodReplanOracle(
  context: CaseContext,
): Promise<NoFoodReplanOracle> {
  const evidence = await collect(context.runtime.app);
  const [rconHealth, rconFood, rconInventoryEmpty] = await Promise.all([
    rconEntityHealth(context.rcon, context.botName).catch(() => null),
    rconFoodLevel(context.rcon, context.botName).catch(() => null),
    rconInventoryIsEmpty(context.rcon, context.botName).catch(() => false),
  ]);
  const bodyHealth =
    typeof evidence.game?.health === "number" &&
    Number.isFinite(evidence.game.health)
      ? evidence.game.health
      : null;
  const bodyFood =
    typeof evidence.game?.food === "number" &&
    Number.isFinite(evidence.game.food)
      ? evidence.game.food
      : null;
  const bodyInventoryEmpty = evidence.game?.inventoryTotal === 0;
  return {
    bodyHealth,
    rconHealth,
    bodyFood,
    rconFood,
    noFoodStateConfirmed: noFoodReplanOraclesConfirmed(
      bodyHealth,
      rconHealth,
      bodyFood,
      rconFood,
      bodyInventoryEmpty,
      rconInventoryEmpty,
    ),
  };
}

function noFoodReplanJudgmentKey(
  judgment: PlayerEvidence["recentJudgments"][number],
): string {
  return `${judgment.revision ?? ""}:${judgment.decidedAt ?? ""}`;
}

function assertNoFoodReplanUsage(context: CaseContext, player: PlayerEvidence) {
  const delta = subtractCounters(player.counters, context.usageAtStart);
  if (delta.usageUnknownCalls > 0) incomplete("LLM_USAGE_PARTIAL_OR_UNKNOWN");
}

const NO_FOOD_REPLAN_SETTLE_MAX_MS = 15_000;

async function settleNoFoodReplanRequests(
  state: RunState,
  context: CaseContext,
): Promise<void> {
  const requestGate = state.noFoodReplanRequestGate;
  if (!requestGate?.acceptanceLatched)
    incomplete("NO_FOOD_REPLAN_ACCEPTANCE_NOT_LATCHED");
  const remainingMs = Math.max(0, context.caseDeadlineAt - Date.now() - 250);
  const settled = await waitForAcceptedProviderRequestsSettled(
    async () => {
      const player = playerOf(await collect(context.runtime.app));
      assertNoFoodReplanUsage(context, player);
      if (requestGate.requestsRecorded > requestGate.requestsStarted) {
        incomplete("NO_FOOD_REPLAN_ADMISSION_USAGE_MISMATCH");
      }
      return requestGate.inFlightRequests;
    },
    Math.min(NO_FOOD_REPLAN_SETTLE_MAX_MS, remainingMs),
  );
  if (!settled) incomplete("NO_FOOD_REPLAN_ACCEPTED_REQUESTS_NOT_SETTLED");
}

const OWNER_RETURN_REQUEST_SETTLE_MAX_MS = 15_000;

function settleOwnerReturnRequests(
  state: RunState,
  context: CaseContext | undefined,
): Promise<AcceptedProviderRequestSettleStatus> {
  const settleOnce = (state.ownerReturnRequestSettlement ??=
    createOwnerReturnRequestSettlementOnce(() =>
      settleOwnerReturnRequestsOnce(state, context).catch(() =>
        recordOwnerReturnSettlementStatus(state, "unknown", false),
      ),
    ));
  return settleOnce();
}

export function createOwnerReturnRequestSettlementOnce(
  settle: () => Promise<AcceptedProviderRequestSettleStatus>,
): () => Promise<AcceptedProviderRequestSettleStatus> {
  let pending: Promise<AcceptedProviderRequestSettleStatus> | undefined;
  return () => {
    pending ??= Promise.resolve()
      .then(settle)
      .catch(() => "unknown");
    return pending;
  };
}

export async function settleOwnerReturnBeforeShutdown(
  shouldSettle: boolean,
  settle: () => Promise<AcceptedProviderRequestSettleStatus>,
  shutdown: () => Promise<void>,
): Promise<AcceptedProviderRequestSettleStatus | undefined> {
  let status: AcceptedProviderRequestSettleStatus | undefined;
  try {
    if (shouldSettle) status = await settle();
  } catch {
    status = "unknown";
  }
  await shutdown();
  return status;
}

export async function settleOwnerReturnCaseFailure(
  caseStatus: Exclude<Status, "pass">,
  settle: () => Promise<AcceptedProviderRequestSettleStatus>,
  shutdown?: () => Promise<void>,
): Promise<
  Readonly<{
    caseStatus: Exclude<Status, "pass">;
    settleStatus: AcceptedProviderRequestSettleStatus;
    usageUnknown: boolean;
  }>
> {
  let settleStatus: AcceptedProviderRequestSettleStatus;
  try {
    settleStatus = await settle();
  } catch {
    settleStatus = "unknown";
  }
  if (shutdown !== undefined) await shutdown();
  return {
    caseStatus,
    settleStatus,
    usageUnknown: ownerReturnUsageIsUnknown(settleStatus),
  };
}

export function ownerReturnUsageIsUnknown(
  status: AcceptedProviderRequestSettleStatus,
): boolean {
  return status !== "settled" && status !== "budget_exceeded";
}

async function settleOwnerReturnRequestsOnce(
  state: RunState,
  context: CaseContext | undefined,
): Promise<AcceptedProviderRequestSettleStatus> {
  const gate = state.ownerReturnRequestGate;
  const caseStart = state.ownerReturnCaseUsageStart;
  gate?.latch();
  if (gate === undefined || caseStart === undefined || context === undefined) {
    return recordOwnerReturnSettlementStatus(state, "unknown", false);
  }

  let failureStatus:
    | Exclude<AcceptedProviderRequestSettleStatus, "settled" | "pending">
    | undefined;
  const remainingMs = Math.max(0, context.caseDeadlineAt - Date.now() - 250);
  let requestsSettled = false;
  try {
    requestsSettled = await waitForAcceptedProviderRequestsSettled(
      async () => {
        const player = playerOf(await collect(context.runtime.app));
        const caseDelta = subtractCounters(player.counters, caseStart);
        const runDelta = subtractCounters(
          player.counters,
          context.runUsageAtStart,
        );
        gate.observeRecordedCalls(caseDelta.llmCalls);
        const status = classifyAcceptedProviderRequestUsage({
          requestsStarted: gate.requestsStarted,
          requestsRecorded: gate.requestsRecorded,
          calls: caseDelta.llmCalls,
          tokens: totalTokens(caseDelta),
          usageUnknownCalls: caseDelta.usageUnknownCalls,
          caseCallLimit: OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET.llmCalls,
          caseTokenLimit: OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET.totalTokens,
          runCalls: runDelta.llmCalls,
          runTokens: totalTokens(runDelta),
          runCallLimit: context.runBudget.llmCalls,
          runTokenLimit: context.runBudget.totalTokens,
        });
        if (status !== "pending" && status !== "settled") {
          failureStatus = status;
          if (gate.inFlightRequests === 0) {
            throw new Error("OWNER_RETURN_REQUEST_SETTLEMENT_INCOMPLETE");
          }
        }
        return gate.inFlightRequests;
      },
      Math.min(OWNER_RETURN_REQUEST_SETTLE_MAX_MS, remainingMs),
    );
  } catch {
    failureStatus ??= "unknown";
  }

  const status =
    failureStatus !== undefined && gate.inFlightRequests === 0
      ? failureStatus
      : requestsSettled
        ? "settled"
        : "timed_out";
  return recordOwnerReturnSettlementStatus(
    state,
    status,
    gate.inFlightRequests === 0,
  );
}

function recordOwnerReturnSettlementStatus(
  state: RunState,
  status: AcceptedProviderRequestSettleStatus,
  settled: boolean,
): AcceptedProviderRequestSettleStatus {
  updateOwnerReturnDiagnostic(state, {
    ...ownerReturnRequestDiagnosticPatch(state, status, settled),
  });
  state.ownerReturnRequestSettlementStatus = status;
  if (ownerReturnUsageIsUnknown(status)) state.usageUncertain = true;
  return status;
}

function requireOwnerReturnRequestsSettled(
  status: AcceptedProviderRequestSettleStatus,
): void {
  if (status === "settled") return;
  if (status === "usage_unknown")
    incomplete("OWNER_RETURN_LLM_USAGE_PARTIAL_OR_UNKNOWN");
  if (status === "budget_exceeded")
    incomplete("OWNER_RETURN_LLM_BUDGET_EXCEEDED");
  if (status === "accounting_mismatch")
    incomplete("OWNER_RETURN_REQUEST_ADMISSION_USAGE_MISMATCH");
  if (status === "timed_out")
    incomplete("OWNER_RETURN_ACCEPTED_REQUESTS_NOT_SETTLED");
  incomplete("OWNER_RETURN_REQUEST_SETTLEMENT_UNKNOWN");
}

async function runNoFoodReplanCase(
  state: RunState,
  context: CaseContext,
): Promise<Readonly<Record<string, boolean | number | string>>> {
  state.noFoodReplanCaseUsageStart = context.usageAtStart;
  state.noFoodReplanLatestCounters = context.usageAtStart;
  state.noFoodReplanRequestGate = new NoFoodReplanRequestGate();
  state.noFoodReplanDiagnostic = { ...EMPTY_NO_FOOD_REPLAN_DIAGNOSTIC };
  await connectApplication(context.runtime.app, state);
  const startup = state.noFoodContinuityDiagnostic;
  if (
    !startup?.startupBodyObservationAvailable ||
    !startup.startupStateConfirmed
  )
    incomplete("NO_FOOD_REPLAN_STARTUP_ORACLES_NOT_CONFIRMED");
  const before = state.preStartPlayer;
  if (before === undefined) incomplete("NO_FOOD_REPLAN_BASELINE_NOT_AVAILABLE");
  state.noFoodReplanDiagnostic = {
    ...state.noFoodReplanDiagnostic,
    startupStateConfirmed: true,
  };

  const knownJudgments = new Set(
    before.recentJudgments.map(noFoodReplanJudgmentKey),
  );
  let knownOutcomes = new Set(
    before.recentOutcomes.map(({ operationId }) => operationId),
  );
  const freshDecision = async (
    timeoutMs: number,
  ): Promise<
    | {
        readonly player: PlayerEvidence;
        readonly judgment: PlayerEvidence["recentJudgments"][number];
      }
    | undefined
  > => {
    let judgment: PlayerEvidence["recentJudgments"][number] | undefined;
    const player = await observeForPlayer(context, timeoutMs, (snapshot) => {
      assertNoFoodReplanUsage(context, snapshot);
      judgment = snapshot.recentJudgments.find(
        (item) => !knownJudgments.has(noFoodReplanJudgmentKey(item)),
      );
      return judgment !== undefined;
    });
    if (player === undefined || judgment === undefined) return undefined;
    for (const item of player.recentJudgments)
      knownJudgments.add(noFoodReplanJudgmentKey(item));
    return { player, judgment };
  };
  const waitForWakeReassessment = async (
    player: PlayerEvidence,
    judgment: PlayerEvidence["recentJudgments"][number],
  ) => {
    const wake = player.wait?.wakeOn ?? [];
    const reasonPresent =
      (player.wait?.reason?.trim().length ?? 0) > 0 &&
      (judgment.summary?.trim().length ?? 0) > 0;
    const wakeConditionPresent = wake.length > 0;
    state.noFoodReplanDiagnostic = {
      ...EMPTY_NO_FOOD_REPLAN_DIAGNOSTIC,
      ...state.noFoodReplanDiagnostic,
      waitReasonAndWakeConditionPresent: reasonPresent && wakeConditionPresent,
    };
    if (!reasonPresent || !wakeConditionPresent)
      incomplete("NO_FOOD_WAIT_REASON_OR_WAKE_CONDITION_NOT_CONFIRMED");
    const wakeAt = Date.parse(player.wait?.wakeAt ?? "");
    const remaining = context.caseDeadlineAt - Date.now();
    if (Number.isFinite(wakeAt) && wakeAt > context.caseDeadlineAt)
      incomplete("NO_FOOD_WAIT_WAKE_OUTSIDE_CASE_BUDGET");
    if (
      !wake.includes("state_changed") &&
      !(wake.includes("deadline") && Number.isFinite(wakeAt))
    )
      incomplete("NO_FOOD_WAIT_WAKE_NOT_OBSERVED");
    const timeout = Number.isFinite(wakeAt)
      ? Math.min(remaining, Math.max(1, wakeAt - Date.now() + 15_000))
      : Math.min(60_000, Math.max(1, remaining));
    const next = await freshDecision(timeout);
    if (next === undefined) incomplete("NO_FOOD_WAIT_WAKE_NOT_OBSERVED");
    state.noFoodReplanDiagnostic = {
      ...EMPTY_NO_FOOD_REPLAN_DIAGNOSTIC,
      ...state.noFoodReplanDiagnostic,
      waitWakeReassessmentObserved: true,
      reassessmentObserved: true,
    };
    return next;
  };
  const waitForOutcome = async (
    judgment: PlayerEvidence["recentJudgments"][number],
    operationKind: PlayerOperationName,
  ) => {
    const decidedAt = Date.parse(judgment.decidedAt ?? "");
    if (!Number.isFinite(decidedAt))
      incomplete("NO_FOOD_REPLAN_JUDGMENT_TIME_NOT_AVAILABLE");
    let outcome: PlayerEvidence["recentOutcomes"][number] | undefined;
    const player = await observeForPlayer(
      context,
      Math.min(
        90_000,
        Math.max(1, context.caseDeadlineAt - Date.now() - 20_000),
      ),
      (snapshot) => {
        assertNoFoodReplanUsage(context, snapshot);
        outcome = snapshot.recentOutcomes.find((item) => {
          const observedAt = Date.parse(item.observedAt ?? "");
          return (
            !knownOutcomes.has(item.operationId) &&
            item.kind === operationKind &&
            Number.isFinite(observedAt) &&
            observedAt >= decidedAt
          );
        });
        return outcome !== undefined;
      },
    );
    if (player === undefined || outcome === undefined)
      incomplete("NO_FOOD_BODY_OUTCOME_NOT_OBSERVED");
    knownOutcomes = new Set(
      player.recentOutcomes.map(({ operationId }) => operationId),
    );
    return outcome;
  };

  let decision = await freshDecision(
    Math.min(
      120_000,
      Math.max(1, context.caseDeadlineAt - Date.now() - 30_000),
    ),
  );
  if (decision === undefined)
    incomplete("NO_FOOD_PURPOSE_DECISION_NOT_OBSERVED");
  let previousFailedOperation: PlayerOperationName | undefined;
  let previousFailureState: NoFoodReplanOracle | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { player } = decision;
    let { judgment } = decision;
    const decisionClass = classifyNoFoodReplanDecision(
      judgment.kind,
      judgment.operationKind,
    );
    state.noFoodReplanDiagnostic = {
      ...state.noFoodReplanDiagnostic,
      ...(attempt === 0
        ? { purposeDecision: decisionClass }
        : { reassessmentObserved: true }),
    };
    if (decisionClass === "wait") {
      decision = await waitForWakeReassessment(player, judgment);
      judgment = decision.judgment;
      if (
        classifyNoFoodReplanDecision(judgment.kind, judgment.operationKind) ===
        "wait"
      )
        incomplete("NO_FOOD_WAIT_REASSESSMENT_STILL_WAITING");
    }
    const currentClass = classifyNoFoodReplanDecision(
      judgment.kind,
      judgment.operationKind,
    );
    if (currentClass === "complete" || currentClass === "continue")
      incomplete("NO_FOOD_REPLAN_ACTION_NOT_OBSERVED");
    if (currentClass !== "consume" && currentClass !== "alternative")
      incomplete("NO_FOOD_REPLAN_DECISION_KIND_UNKNOWN");
    const operationKind = safeOperationKind(judgment.operationKind);
    if (operationKind === undefined)
      incomplete("NO_FOOD_REPLAN_OPERATION_KIND_UNKNOWN");

    if (
      previousFailedOperation === operationKind &&
      previousFailureState !== undefined
    ) {
      const current = await readNoFoodReplanOracle(context);
      if (
        current.noFoodStateConfirmed &&
        current.bodyHealth === previousFailureState.bodyHealth &&
        current.rconHealth === previousFailureState.rconHealth &&
        current.bodyFood === previousFailureState.bodyFood &&
        current.rconFood === previousFailureState.rconFood
      ) {
        state.noFoodReplanDiagnostic = {
          ...state.noFoodReplanDiagnostic,
          repeatedFailedOperationUnderUnchangedState: true,
          postOutcomeNoFoodStateConfirmed: true,
        };
        if (operationKind === "consume")
          fail("NO_FOOD_FAILED_CONSUME_REPEATED_WITHOUT_STATE_CHANGE");
        incomplete("NO_FOOD_REPEATED_OPERATION_KIND_DETAIL_UNAVAILABLE");
      }
      incomplete("NO_FOOD_REPLAN_STATE_CHANGED_BEFORE_REASSESSMENT");
    }
    if (currentClass === "consume" && previousFailedOperation !== undefined)
      fail("NO_FOOD_CONSUME_SELECTED_WITH_EMPTY_INVENTORY");

    const outcome = await waitForOutcome(judgment, operationKind);
    const outcomeStatus = safeOutcomeStatus(outcome.status) ?? "unverified";
    if (state.noFoodReplanDiagnostic.outcomeStatus === "not_observed")
      state.noFoodReplanDiagnostic = {
        ...state.noFoodReplanDiagnostic,
        outcomeStatus,
      };
    const afterState = await readNoFoodReplanOracle(context);
    state.noFoodReplanDiagnostic = {
      ...state.noFoodReplanDiagnostic,
      postOutcomeNoFoodStateConfirmed: afterState.noFoodStateConfirmed,
    };
    if (!afterState.noFoodStateConfirmed)
      incomplete("NO_FOOD_POST_OUTCOME_ORACLES_NOT_CONFIRMED");
    if (outcomeStatus === "successful") {
      if (currentClass === "consume")
        fail("NO_FOOD_CONSUME_SUCCESS_CONTRADICTS_EMPTY_INVENTORY");
      state.noFoodReplanDiagnostic = {
        ...state.noFoodReplanDiagnostic,
        alternativeSuccessfulBodyOutcomeObserved: true,
      };
      const outcomeObservedAt = Date.parse(outcome.observedAt ?? "");
      if (!Number.isFinite(outcomeObservedAt))
        incomplete("NO_FOOD_BODY_OUTCOME_TIME_NOT_AVAILABLE");
      const remainingMs = context.caseDeadlineAt - Date.now();
      const postOutcomePlayer = await observeForPlayer(
        context,
        Math.min(60_000, Math.max(1, remainingMs)),
        (snapshot) => {
          assertNoFoodReplanUsage(context, snapshot);
          const postOutcomePurposeJudgmentObserved =
            snapshot.recentJudgments.some((item) =>
              isNoFoodReplanPurposeAfterOutcome(
                item.decidedAt,
                outcome.observedAt,
              ),
            );
          if (postOutcomePurposeJudgmentObserved) {
            const acceptanceEvidence = {
              ...(state.noFoodReplanDiagnostic ??
                EMPTY_NO_FOOD_REPLAN_DIAGNOSTIC),
              postOutcomePurposeJudgmentObserved: true,
            };
            state.noFoodReplanDiagnostic = acceptanceEvidence;
            const requestGate = state.noFoodReplanRequestGate;
            if (!requestGate?.latchIfAcceptedEvidence(acceptanceEvidence)) {
              return false;
            }
          }
          return postOutcomePurposeJudgmentObserved;
        },
      );
      const postOutcomePurposeJudgmentObserved =
        postOutcomePlayer?.recentJudgments.some((item) =>
          isNoFoodReplanPurposeAfterOutcome(item.decidedAt, outcome.observedAt),
        ) ?? false;
      state.noFoodReplanDiagnostic = {
        ...state.noFoodReplanDiagnostic,
        postOutcomePurposeJudgmentObserved,
      };
      if (!postOutcomePurposeJudgmentObserved)
        incomplete("NO_FOOD_POST_OUTCOME_PURPOSE_JUDGMENT_NOT_OBSERVED");
      const requestGate = state.noFoodReplanRequestGate;
      if (!requestGate.acceptanceLatched)
        incomplete("NO_FOOD_REPLAN_ACCEPTANCE_NOT_LATCHED");
      await settleNoFoodReplanRequests(state, context);
      return {
        ...state.noFoodReplanDiagnostic,
        ...noFoodReplanRequestEvidence(state),
        startupOraclesConfirmed: true,
      };
    }
    if (outcomeStatus !== "failed")
      incomplete("NO_FOOD_BODY_OUTCOME_STATUS_UNCONFIRMED");
    if (
      afterState.bodyHealth !== startup.bodyHealth ||
      afterState.rconHealth !== startup.rconHealth ||
      afterState.bodyFood !== startup.bodyFood ||
      afterState.rconFood !== startup.rconFood
    )
      incomplete("NO_FOOD_FAILED_OPERATION_STATE_CHANGED");

    previousFailedOperation = operationKind;
    previousFailureState = afterState;
    decision = await freshDecision(
      Math.max(1, context.caseDeadlineAt - Date.now() - 20_000),
    );
    if (decision === undefined)
      incomplete("NO_FOOD_REASSESSMENT_AFTER_FAILURE_NOT_OBSERVED");
    state.noFoodReplanDiagnostic = {
      ...state.noFoodReplanDiagnostic,
      reassessmentObserved: true,
    };
  }
  incomplete("NO_FOOD_REPLAN_OBSERVATION_LIMIT_REACHED");
}

async function runNoFoodContinuityProbe(
  state: RunState,
  rcon: LocalRcon,
): Promise<void> {
  const fixture = await runCase(
    state,
    "no_food_fixture_probe",
    120_000,
    0,
    0,
    () => prepareNoFoodFixtureProbe(state, rcon),
  );
  if (fixture.status !== "pass") {
    state.status = fixture.status;
    state.failureCode ??=
      fixture.reason ?? "NO_FOOD_FIXTURE_PROBE_NOT_CONFIRMED";
    return;
  }

  const config = loadConfig({
    ...process.env,
    OPENAI_API_KEY: "no-provider-request-e2e-probe",
    MINECRAFT_HOST: "127.0.0.1",
    MINECRAFT_PORT: String(state.serverPort),
    MINECRAFT_USERNAME: state.botName,
    MINECRAFT_AUTH: "offline",
    MINECRAFT_VERSION: SERVER_VERSION,
    OWNER_USERNAME: state.ownerName,
    OPENAI_MODEL: MODEL,
    DATABASE_PATH: state.databasePath,
    PERSONA_PATH: resolve(PROJECT_ROOT, "config/persona.example.json"),
    LOG_LEVEL: "silent",
    RECONNECT_ENABLED: "false",
    DASHBOARD_ENABLED: "false",
  });
  const { createApplication } = await import("../../src/app/application.js");
  const app = createApplication(config, state.llmAdmission?.beforeCall);
  appForCleanup = app;
  state.countersInitial = countersOf(await collect(app));
  restoreNoFoodContinuityObservationProbe ??=
    installNoFoodContinuityObservationProbe(state, rcon);
  await connectApplication(app, state);

  const continuity = await runCase(
    state,
    "no_food_continuity_probe",
    15_000,
    0,
    0,
    async () => {
      const deadline = Date.now() + 10_000;
      while (
        state.noFoodContinuityProviderRequestBlocked !== true &&
        Date.now() < deadline
      ) {
        await waitMs(50);
      }
      const diagnostic = state.noFoodContinuityDiagnostic;
      if (diagnostic?.startupBodyObservationAvailable !== true)
        incomplete("NO_FOOD_CONTINUITY_STARTUP_OBSERVATION_NOT_CONFIRMED");
      if (!diagnostic.startupStateConfirmed)
        incomplete("NO_FOOD_CONTINUITY_STARTUP_STATE_NOT_CONFIRMED");
      if (state.noFoodContinuityProviderRequestBlocked !== true)
        incomplete("NO_FOOD_CONTINUITY_PROVIDER_GATE_NOT_REACHED");
      if (state.noFoodContinuityProviderRequestBlockedAfterReadback !== true)
        incomplete("NO_FOOD_CONTINUITY_PROVIDER_GATE_BEFORE_READBACK");
      return {
        startupBodyObservationAvailable: true,
        startupStateConfirmed: true,
        bodyInventoryEmpty: true,
        rconInventoryEmpty: true,
        providerRequestBlocked: true,
        providerRequestBlockedAfterReadback: true,
      };
    },
  );
  state.status = continuity.status;
  if (continuity.status !== "pass")
    state.failureCode ??=
      continuity.reason ?? "NO_FOOD_CONTINUITY_NOT_CONFIRMED";
  try {
    state.countersFinal = countersOf(await collect(app));
  } catch {
    state.countersFinal = state.countersInitial;
  }
  try {
    await boundedShutdown(app, "no_food_continuity_probe_complete");
  } catch {
    state.status = "incomplete";
    state.failureCode ??= "APPLICATION_SHUTDOWN_FAILED";
  }
}

async function main(): Promise<void> {
  const repoRoot = PROJECT_ROOT;
  loadEnvironmentFile({ path: resolve(repoRoot, ".env.local"), quiet: true });
  loadEnvironmentFile({
    path: resolve(repoRoot, ".env"),
    override: false,
    quiet: true,
  });
  const state = await prepareRun();
  currentRunState = state;
  const results = state.cases;
  try {
    await startServer(state);
    state.serverReadyObserved = true;
    const rcon = new LocalRcon(state.rconPort, state.rconPassword);
    await prepareWorld(state, rcon);
    await assertNoOperators(state);
    if (isNoFoodContinuityProbeOnly()) {
      await runNoFoodContinuityProbe(state, rcon);
      return;
    }
    if (process.env.AI_PLAYER_E2E_NO_FOOD_FIXTURE_PROBE_ONLY === "YES") {
      const fixture = await runCase(
        state,
        "no_food_fixture_probe",
        120_000,
        0,
        0,
        () => prepareNoFoodFixtureProbe(state, rcon),
      );
      state.status = fixture.status;
      if (fixture.status !== "pass")
        state.failureCode ??=
          fixture.reason ?? "NO_FOOD_FIXTURE_PROBE_NOT_CONFIRMED";
      return;
    }
    const owner = await connectPublicClient(state.serverPort, state.ownerName);
    ownerForCleanup = owner;
    const guest = await connectPublicClient(state.serverPort, state.guestName);
    guestForCleanup = guest;
    owner.on("chat", (username, message) => {
      if (username === state.botName) {
        state.responses.push({ at: Date.now(), text: message });
      }
    });
    const operationSmokeResult = await runOperationSmoke(state, rcon);
    if (operationSmokeResult.status !== "pass") {
      const failureCode =
        operationSmokeResult.reason ?? "BODY_OPERATION_SMOKE_NOT_CONFIRMED";
      state.status = operationSmokeResult.status;
      state.failureCode ??= failureCode;
      throw new HarnessError(operationSmokeResult.status, failureCode);
    }
    if (isNoGptDiagnosticProbeOnly()) {
      state.status = "pass";
      return;
    }
    if (state.targetCase === "no_food_replan") {
      const fixture = await runCase(
        state,
        "no_food_replan_fixture",
        120_000,
        0,
        0,
        () => prepareNoFoodFixtureProbe(state, rcon),
      );
      if (fixture.status !== "pass") {
        state.status = fixture.status;
        state.failureCode ??=
          fixture.reason ?? "NO_FOOD_FIXTURE_PROBE_NOT_CONFIRMED";
        return;
      }
    }
    if (!shouldCollectAfterRun(state))
      incomplete("RUN_STOPPED_AFTER_BUDGET_OR_DEADLINE");

    const config = loadConfig({
      ...process.env,
      MINECRAFT_HOST: "127.0.0.1",
      MINECRAFT_PORT: String(state.serverPort),
      MINECRAFT_USERNAME: state.botName,
      MINECRAFT_AUTH: "offline",
      MINECRAFT_VERSION: SERVER_VERSION,
      OWNER_USERNAME: state.ownerName,
      OPENAI_MODEL: MODEL,
      DATABASE_PATH: state.databasePath,
      PERSONA_PATH: resolve(repoRoot, "config/persona.example.json"),
      LOG_LEVEL: "silent",
      RECONNECT_ENABLED: "false",
      DASHBOARD_ENABLED: "false",
    });
    const { createApplication } = await import("../../src/app/application.js");
    const createdApplication = createOwnerReturnApplicationWithBodyCapture(
      state.targetCase,
      createApplication,
      config,
      state.llmAdmission?.beforeCall,
    );
    const activeApp = createdApplication.application;
    if (createdApplication.restoreProbe !== undefined)
      restoreGameActionPlacementObservationProbe =
        createdApplication.restoreProbe;
    appForCleanup = activeApp;
    const preStartEvidence = await collect(activeApp);
    const preStartCounters = countersOf(preStartEvidence);
    state.preStartPlayer = playerOf(preStartEvidence);
    state.countersInitial = preStartCounters;
    liveContext = makeContext(state, activeApp, config, rcon, owner, guest);
    const ownerReturnRequestTracking = createOwnerReturnRequestTracking(
      state.targetCase,
      preStartCounters,
      state.ownerReturnRequestGate,
    );
    if (ownerReturnRequestTracking !== undefined) {
      state.ownerReturnCaseUsageStart = ownerReturnRequestTracking.usageStart;
      state.ownerReturnRequestGate = ownerReturnRequestTracking.gate;
      updateOwnerReturnDiagnostic(state, {
        ...ownerReturnRequestDiagnosticPatch(state, "unknown", false),
      });
    }
    if (state.targetCase === "no_food_replan") {
      restoreNoFoodContinuityObservationProbe ??=
        installNoFoodContinuityObservationProbe(state, rcon);
      const noFoodReplanResult = await recordCase(
        state,
        "no_food_replan",
        CASE_DEADLINES.no_food_replan,
        requireLiveContext(),
        async (context) => runNoFoodReplanCase(state, context),
      );
      state.status = noFoodReplanResult.status;
      if (noFoodReplanResult.status !== "pass")
        state.failureCode ??=
          noFoodReplanResult.reason ?? "NO_FOOD_REPLAN_NOT_CONFIRMED";
      return;
    }
    const autonomousRegion = state.autonomousRegion;
    const autonomousSmokeBaseline = state.autonomousSmokeBaseline;
    if (autonomousRegion === undefined || autonomousSmokeBaseline === undefined)
      incomplete("AUTONOMOUS_WORLD_BASELINE_MISSING");
    restoreGameActionPlacementObservationProbe ??=
      installGameActionPlacementObservationProbe();
    await connectApplication(activeApp, state);
    const autonomousSpawn = parsePosition(
      await rcon.command(`data get entity ${state.botName} Pos`),
    );
    if (
      Math.hypot(
        autonomousSpawn.x - 0.5,
        autonomousSpawn.y - 64,
        autonomousSpawn.z - 0.5,
      ) > 1.5
    )
      incomplete("AUTONOMOUS_SPAWN_POSITION_NOT_CONFIRMED");
    const connectedWorld = await readWorldSnapshot(
      rcon,
      state.botName,
      autonomousRegion,
    );
    state.autonomousBaseline = {
      position: connectedWorld.position,
      blockRegionChanged: autonomousSmokeBaseline.blockRegionChanged,
      inventorySignature: autonomousSmokeBaseline.inventorySignature,
    };
    const contractResult = await recordCase(
      state,
      "runtime_contract",
      CASE_DEADLINES.runtime_contract,
      requireLiveContext(),
      async (context) => {
        const evidence = await collect(context.runtime.app);
        const player = playerOf(evidence);
        return {
          defaultPlayerRuntimeEvidence: true,
          eventDrivenCountersPresent: true,
          goalAndProposalStateAvailable:
            Array.isArray(player.goals) && Array.isArray(player.proposals),
          serverConnectionObserved: evidence.connectionState === "connected",
        };
      },
    );

    const baselineSkills = readSkillSnapshot(state.databasePath);
    let verifiedLearnedSkillIds: readonly string[] = [];
    let receiptLinkedConsultedSkillIds: readonly string[] = [];
    const autonomousResult = await recordCase(
      state,
      "autonomous_life",
      CASE_DEADLINES.autonomous_life,
      requireLiveContext(),
      async (context) => {
        const before = state.autonomousBaseline;
        if (before === undefined) incomplete("PRESTART_WORLD_SNAPSHOT_MISSING");
        const initial = state.preStartPlayer;
        if (initial === undefined)
          incomplete("PRESTART_RUNTIME_SNAPSHOT_MISSING");
        const initialRevision = initial.actionRevision;
        const autonomousProgress = {
          autonomousGoalSeen: false,
          activitySeen: false,
          successfulActionSeen: false,
          followupJudgmentSeen: false,
        };
        const initialJudgmentKeys = new Set(
          initial.recentJudgments.map(
            (judgment) =>
              `${judgment.revision ?? ""}:${judgment.decidedAt ?? ""}`,
          ),
        );
        let progressKind: string | undefined;
        let lastWorldCheckAt = 0;
        state.autonomousLifeProgress = {
          autonomousGoalSeen: false,
          activitySeen: false,
          successfulActionSeen: false,
          worldProgressSeen: false,
          successfulOutcomeCount: 0,
          followupJudgmentSeen: false,
          milestoneSeen: false,
          activeOperationPresent: false,
          activeBodyStarted: false,
          activeBodyElapsedBucket: "none",
        };
        const result = await observeForPlayer(
          context,
          4 * 60_000,
          async (player) => {
            const autonomousGoal = player.goals.some(
              (goal) => goal.source === "self",
            );
            autonomousProgress.autonomousGoalSeen ||= autonomousGoal;
            const hasAction =
              player.actionRevision > initialRevision ||
              isOperationActive(player) ||
              hasNewOutcome(initial, player);
            autonomousProgress.activitySeen ||=
              autonomousGoal &&
              hasAction &&
              player.counters.llmCalls > initial.counters.llmCalls;
            autonomousProgress.successfulActionSeen ||= newOutcomes(
              initial,
              player,
            ).some((outcome) => outcome.status === "successful");
            const newJudgments = player.recentJudgments.filter(
              (judgment) =>
                !initialJudgmentKeys.has(
                  `${judgment.revision ?? ""}:${judgment.decidedAt ?? ""}`,
                ),
            );
            autonomousProgress.followupJudgmentSeen ||=
              hasJudgmentAfterSuccessfulOutcome(
                newOutcomes(initial, player),
                newJudgments,
              );
            if (
              autonomousProgress.successfulActionSeen &&
              Date.now() - lastWorldCheckAt >= 1_500
            ) {
              const autonomousRegion = state.autonomousRegion;
              if (autonomousRegion === undefined)
                incomplete("AUTONOMOUS_WORLD_REGION_MISSING");
              const currentWorld = await readWorldSnapshot(
                rcon,
                state.botName,
                autonomousRegion,
              );
              progressKind ??= observedWorldProgress(before, currentWorld);
              lastWorldCheckAt = Date.now();
            }
            state.autonomousLifeProgress = {
              autonomousGoalSeen: autonomousProgress.autonomousGoalSeen,
              activitySeen: autonomousProgress.activitySeen,
              successfulActionSeen: autonomousProgress.successfulActionSeen,
              worldProgressSeen: progressKind !== undefined,
              successfulOutcomeCount: newOutcomes(initial, player).filter(
                (outcome) => outcome.status === "successful",
              ).length,
              followupJudgmentSeen: autonomousProgress.followupJudgmentSeen,
              milestoneSeen:
                autonomousProgress.activitySeen &&
                autonomousProgress.successfulActionSeen &&
                progressKind !== undefined &&
                autonomousProgress.followupJudgmentSeen,
              activeOperationPresent: isOperationActive(player),
              activeBodyStarted:
                typeof player.activeOperation?.bodyStartedAt === "string",
              activeBodyElapsedBucket: activeBodyElapsedBucket(player),
            };
            return (
              autonomousProgress.activitySeen &&
              autonomousProgress.successfulActionSeen &&
              progressKind !== undefined &&
              autonomousProgress.followupJudgmentSeen
            );
          },
        );
        if (result === undefined) {
          if (!autonomousProgress.activitySeen)
            incomplete("AUTONOMOUS_ACTIVITY_NOT_SELECTED");
          if (!autonomousProgress.successfulActionSeen)
            incomplete("AUTONOMOUS_SUCCESSFUL_ACTION_NOT_CONFIRMED");
          if (progressKind === undefined)
            incomplete("AUTONOMOUS_WORLD_PROGRESS_NOT_OBSERVED");
          incomplete("AUTONOMOUS_FOLLOWUP_JUDGMENT_NOT_OBSERVED");
        }
        if (progressKind === undefined)
          incomplete("AUTONOMOUS_WORLD_PROGRESS_NOT_OBSERVED");
        if (!autonomousProgress.followupJudgmentSeen)
          incomplete("AUTONOMOUS_FOLLOWUP_JUDGMENT_NOT_OBSERVED");
        return {
          autonomousGoalObserved: true,
          autonomousActionRevisionAdvanced:
            result.actionRevision > initialRevision,
          autonomousSuccessfulOutcomeCount: newOutcomes(initial, result).filter(
            (outcome) => outcome.status === "successful",
          ).length,
          serverProgressKind: progressKind,
          llmDecisionObserved:
            result.counters.llmCalls > initial.counters.llmCalls,
          judgmentAfterSuccessfulOutcome: true,
          activeOperationAtMilestone: isOperationActive(result),
          activeBodyStartedAtMilestone:
            typeof result.activeOperation?.bodyStartedAt === "string",
          activeBodyElapsedBucketAtMilestone: activeBodyElapsedBucket(result),
          noOwnerPrompt: true,
        };
      },
    );
    await removeAutonomousResourceFixture(rcon);

    const observationCapture: NonNullable<
      RunState["observationBoundaryCapture"]
    > = {
      responseStart: state.responses.length,
    };
    state.observationBoundaryCapture = observationCapture;
    const observationResult = await recordCase(
      state,
      "observation_boundary",
      CASE_DEADLINES.observation_boundary,
      requireLiveContext(),
      async (context) => {
        const origin = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const fixture = await configureHiddenContainer(rcon, origin);
        await captureBlockBaseline(rcon, origin);
        const oracleContents = await rcon.command(
          `data get block ${fixture.chest.x} ${fixture.chest.y} ${fixture.chest.z} Items`,
        );
        const hiddenItemPresent = /emerald/iu.test(oracleContents);
        if (!hiddenItemPresent) fail("HIDDEN_CONTAINER_FIXTURE_INVALID");
        const fixtureConfiguredAt = Date.now();
        const before = await waitForPlayer(
          context,
          CASE_DEADLINES.observation_boundary - 30_000,
          (player) => {
            const observedAt = player.lastObservation?.observedAt;
            return (
              player.lastObservation?.visibleContainers !== undefined &&
              player.lastObservation.visibleBlockNames !== undefined &&
              observedAt !== undefined &&
              Date.parse(observedAt) >= fixtureConfiguredAt
            );
          },
        );
        const observation = before.lastObservation;
        if (
          observation?.visibleContainers === undefined ||
          observation.visibleBlockNames === undefined ||
          observation.observedAt === undefined
        ) {
          incomplete("OBSERVATION_VISIBILITY_RECEIPT_MISSING");
        }
        const observedAt = Date.parse(observation.observedAt);
        if (!Number.isFinite(observedAt))
          incomplete("OBSERVATION_VISIBILITY_RECEIPT_INVALID");
        observationCapture.visibleObservationAt = observedAt;
        if (safeObservationText(observation).includes("emerald"))
          fail("OCCLUDED_ITEM_LEAKED_TO_OBSERVATION");
        const chestCoordinatesWereVisible = observation.visibleContainers.some(
          ({ name, position }) =>
            /chest/iu.test(name) &&
            position.x === fixture.chest.x &&
            position.y === fixture.chest.y &&
            position.z === fixture.chest.z,
        );
        if (chestCoordinatesWereVisible)
          fail("OCCLUDED_CHEST_APPEARED_IN_VISIBLE_CONTAINERS");
        const responsesBefore = context.responseQueue.length;
        const requestSentAt = Date.now();
        observationCapture.requestSentAt = requestSentAt;
        sendChat(
          context.owner,
          "今の視界で分かる範囲から、石壁の向こうにあるチェストの中身を正確に教えてください。見えていないなら不明と答えてください。",
        );
        const afterPlayer = await waitForPlayer(
          context,
          CASE_DEADLINES.observation_boundary - 30_000,
          () => context.responseQueue.length > responsesBefore,
        );
        const reply = context.responseQueue[responsesBefore];
        if (reply === undefined) incomplete("OBSERVATION_RESPONSE_MISSING");
        const observationBeforeReply = observedAt <= reply.at;
        const responseHeuristicClassification = classifyObservationReply(
          reply.text,
        );
        state.observationBoundaryDiagnostic = {
          replyReceived: true,
          responseHeuristicClassification,
          manualReviewRequired: true,
          observationBeforeReply,
        };
        if (reply.at < requestSentAt || !observationBeforeReply)
          incomplete("OBSERVATION_REPLY_NOT_CORRELATED_TO_PRIOR_VIEW");
        const latestObservation = afterPlayer.lastObservation;
        if (
          latestObservation?.visibleContainers === undefined ||
          latestObservation.visibleBlockNames === undefined ||
          latestObservation.observedAt === undefined
        ) {
          incomplete("OBSERVATION_REPLY_VIEW_UNAVAILABLE");
        }
        const latestObservedAt = Date.parse(latestObservation.observedAt);
        if (!Number.isFinite(latestObservedAt))
          incomplete("OBSERVATION_REPLY_VIEW_INVALID");
        const replyChestCoordinatesVisible =
          latestObservation.visibleContainers.some(
            ({ name, position }) =>
              /chest/iu.test(name) &&
              position.x === fixture.chest.x &&
              position.y === fixture.chest.y &&
              position.z === fixture.chest.z,
          );
        if (
          latestObservedAt <= reply.at &&
          safeObservationText(latestObservation).includes("emerald")
        ) {
          fail("OCCLUDED_ITEM_LEAKED_TO_OBSERVATION");
        }
        if (latestObservedAt <= reply.at && replyChestCoordinatesVisible)
          fail("OCCLUDED_CHEST_APPEARED_IN_VISIBLE_CONTAINERS");
        await removeHiddenContainerFixture(rcon, origin, fixture);
        if (responseHeuristicClassification === "possible_hidden_item_claim")
          incomplete("OBSERVATION_REPLY_REQUIRES_MANUAL_REVIEW");
        return {
          rconConfirmsHiddenItem: true,
          visibleObservationOmitsItem: true,
          replyReceived: true,
          responseHeuristicClassification,
          manualReviewRequired: true,
          observationBeforeReply: true,
        };
      },
    );
    state.observationBoundaryCapture.responseEnd = state.responses.length;

    const memoryResult = await recordCase(
      state,
      "persistent_memory_restart",
      CASE_DEADLINES.persistent_memory_restart,
      requireLiveContext(),
      async (context) => {
        const beforeResponses = context.responseQueue.length;
        const durableFact = "maple-47";
        const beforeMemory = playerOf(await collect(context.runtime.app));
        const afterRunSequence = maxAgentActivityRunSequence(
          beforeMemory.recentAgentActivity ?? [],
        );
        state.persistentMemoryDiagnostic = {
          stage: "request_sent",
          ownerReplyObserved: false,
          rememberToolCalled: false,
          rememberToolResult: "none",
          factPersisted: false,
        };
        const requestSentAt = Date.now();
        sendChat(
          context.owner,
          `次のセッションでも覚えておいてください。合成テスト用の合言葉は「${durableFact}」です。私から教わった事実として記録してください。`,
        );
        await waitForPlayer(context, 120_000, (player) => {
          const ownerReplyObserved = context.responseQueue
            .slice(beforeResponses)
            .some(({ at }) => at >= requestSentAt);
          const factPersisted = readDbContainsOwnerFact(
            state.databasePath,
            durableFact,
          );
          const progress = inspectPersistentMemoryProgress({
            activity: player.recentAgentActivity ?? [],
            afterRunSequence,
            ownerReplyObserved,
            factPersisted,
          });
          state.persistentMemoryDiagnostic = {
            ...(state.persistentMemoryDiagnostic ?? progress),
            ...progress,
          };
          if (progress.stage === "conversation_finished_without_save_tool")
            incomplete("OWNER_FACT_TOOL_NOT_CALLED");
          if (progress.stage === "save_tool_rejected")
            incomplete("OWNER_FACT_SAVE_REJECTED");
          if (progress.stage === "save_tool_not_verified")
            incomplete("OWNER_FACT_SAVE_NOT_VERIFIED");
          return (
            player.counters.llmCalls > context.usageAtStart.llmCalls &&
            ownerReplyObserved &&
            progress.rememberToolCalled &&
            progress.factPersisted
          );
        });
        const beforeRestart = readDbTableCount(
          state.databasePath,
          "player_runtime_state",
        );
        const factPersisted = readDbContainsOwnerFact(
          state.databasePath,
          durableFact,
        );
        if (!factPersisted)
          incomplete("SYNTHETIC_FACT_NOT_PERSISTED_BEFORE_RESTART");
        await context.runtime.app.shutdown("ai_player_e2e_memory_restart");
        const { createApplication } =
          await import("../../src/app/application.js");
        const nextApp = createApplication(
          context.runtime.config,
          state.llmAdmission?.beforeCall,
        );
        appForCleanup = nextApp;
        await connectApplication(nextApp, state);
        const restartedContext: CaseContext = {
          ...makeContext(
            state,
            nextApp,
            context.runtime.config,
            rcon,
            context.owner,
            context.guest,
          ),
          usageAtStart: context.usageAtStart,
          startedAt: context.startedAt,
          caseDeadlineAt: context.caseDeadlineAt,
          ...(context.caseBudget === undefined
            ? {}
            : { caseBudget: context.caseBudget }),
        };
        liveContext = restartedContext;
        const afterRestart = await collect(nextApp);
        const restartPlayer = playerOf(afterRestart);
        if (beforeRestart < 1) incomplete("PERSISTENT_RUNTIME_ROW_MISSING");
        const factAfterRestart = readDbContainsOwnerFact(
          state.databasePath,
          durableFact,
        );
        if (!factAfterRestart)
          incomplete("SYNTHETIC_FACT_MISSING_AFTER_RESTART");
        const responseStart = context.responseQueue.length;
        const restartCallsBefore = restartPlayer.counters.llmCalls;
        sendChat(
          context.owner,
          "再起動の前に、私が記憶してほしいと頼んだ合成フレーズを、そのまま教えてください。",
        );
        const recalled = await waitForPlayer(
          restartedContext,
          120_000,
          (player) =>
            player.counters.llmCalls > restartCallsBefore &&
            context.responseQueue
              .slice(responseStart)
              .some(({ text }) => text.toLowerCase().includes(durableFact)),
        );
        const exactPhraseReturned = context.responseQueue
          .slice(responseStart)
          .some(({ text }) => text.toLowerCase().includes(durableFact));
        if (!exactPhraseReturned)
          fail("PERSISTENT_FACT_NOT_RECALLED_AFTER_RESTART");
        return {
          sameDatabaseReopened: true,
          runtimeStateSurvivedRestart: beforeRestart > 0,
          syntheticFactPersistedBeforeRestart: factPersisted,
          postRestartJudgmentObserved:
            recalled.counters.llmCalls > restartCallsBefore,
          exactFactRecalled: exactPhraseReturned,
          revisionAfterRecall: recalled.revision,
        };
      },
    );

    let activeLearningLogs: readonly BlockPosition[] = [];
    const learningResult = await recordCase(
      state,
      "learning_reuse",
      CASE_DEADLINES.learning_reuse,
      requireLiveContext(),
      async (context) => {
        const learnedBaseline = readSkillSnapshot(state.databasePath);
        beginLearningFixtureDiagnostic(state, "initial");
        const initialPosition = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const playerAtInitialOrient = playerOf(
          await collect(context.runtime.app),
        );
        const activeOperationAtInitialOrient = isOperationActive(
          playerAtInitialOrient,
        );
        updateLearningFixtureDiagnostic(state, {
          activeOperationAtOrient: activeOperationAtInitialOrient,
        });
        const initialOrientation = await orientForLearningLogFixture(
          rcon,
          state.botName,
          initialPosition,
          activeOperationAtInitialOrient,
        );
        updateLearningFixtureDiagnostic(state, {
          activeOperationAtOrient: initialOrientation.activeOperationAtOrient,
          yawMatched: initialOrientation.yawMatched,
          pitchMatched: initialOrientation.pitchMatched,
        });
        const origin = initialOrientation.position;
        const firstLogs = await availableLogFixtureSites(rcon, origin);
        activeLearningLogs = firstLogs;
        await configureLogFixture(rcon, firstLogs, state.botName, (count) => {
          const diagnostic = state.learningFixtureDiagnostic;
          if (diagnostic !== undefined)
            state.learningFixtureDiagnostic = {
              ...diagnostic,
              placementConfirmedCount: count,
            };
        });
        const firstLogsConfiguredAt = Date.now();
        const firstRegion = await captureBlockBaseline(rcon, origin);
        const beforeWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          firstRegion,
        );
        const firstFixtureObservation = await observeForPlayer(
          context,
          15_000,
          (player) =>
            recordLearningFixtureObservation(
              state,
              firstLogsConfiguredAt,
              player,
            ),
        );
        if (firstFixtureObservation === undefined)
          incomplete("LEARNING_LOG_FIXTURE_NOT_VISIBLE");
        state.learningReuseStage = "initial_fixture_visible";
        const before = playerOf(await collect(context.runtime.app));
        const beforeActions = before.actionRevision;
        const responseStart = context.responseQueue.length;
        sendChat(
          context.owner,
          "すぐ近くに置いたオークの原木を1本採掘し、結果を確かめてください。方法と順序は自分で選んでください。",
        );
        let firstFixtureCheckAt = 0;
        let firstFixtureLogRemoved = false;
        const after = await waitForPlayer(context, 240_000, async (player) => {
          if (Date.now() - firstFixtureCheckAt > 3_000) {
            firstFixtureLogRemoved =
              (await fixtureLogsRemaining(rcon, firstLogs)) < firstLogs.length;
            firstFixtureCheckAt = Date.now();
          }
          return (
            player.actionRevision > beforeActions &&
            newOutcomes(before, player).some(
              (outcome) =>
                outcome.kind === "dig" && outcome.status === "successful",
            ) &&
            !isOperationActive(player) &&
            firstFixtureLogRemoved
          );
        });
        const afterWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          firstRegion,
        );
        const initialOutcomes = newOutcomes(before, after);
        const firstDigOutcome = initialOutcomes.find(
          (outcome) =>
            outcome.kind === "dig" && outcome.status === "successful",
        );
        if (
          firstDigOutcome === undefined ||
          !worldChangedFromBlock(
            beforeWorld.blockRegionChanged,
            afterWorld.blockRegionChanged,
          )
        ) {
          incomplete("LEARNING_ACTION_NOT_CONFIRMED_BY_SERVER");
        }
        state.learningReuseStage = "first_dig_confirmed";
        await removeLearningLogFixture(rcon, firstLogs);
        activeLearningLogs = [];
        let learned = readSkillSnapshot(state.databasePath);
        state.firstDigLearningDiagnostic = firstDigLearningDiagnostic(
          firstDigOutcome,
          learnedBaseline,
          learned,
        );
        let firstDigEvidence = firstDigLearningEvidence(
          firstDigOutcome,
          learnedBaseline,
          learned,
        );
        if (firstDigEvidence === undefined) {
          await observeForPlayer(context, 30_000, () => {
            learned = readSkillSnapshot(state.databasePath);
            state.firstDigLearningDiagnostic = firstDigLearningDiagnostic(
              firstDigOutcome,
              learnedBaseline,
              learned,
            );
            return (
              firstDigLearningEvidence(
                firstDigOutcome,
                learnedBaseline,
                learned,
              ) !== undefined
            );
          });
          firstDigEvidence = firstDigLearningEvidence(
            firstDigOutcome,
            learnedBaseline,
            learned,
          );
          state.firstDigLearningDiagnostic = firstDigLearningDiagnostic(
            firstDigOutcome,
            learnedBaseline,
            learned,
          );
        }
        if (firstDigEvidence === undefined)
          incomplete("FIRST_DIG_DID_NOT_CREATE_OR_USE_VERIFIED_HYPOTHESIS");
        verifiedLearnedSkillIds = [firstDigEvidence.skillId];
        state.learningReuseStage = "first_dig_hypothesis_verified";

        const beforeReuse = readSkillSnapshot(state.databasePath);
        beginLearningFixtureDiagnostic(state, "reuse");
        const reusePosition = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const playerAtReuseOrient = playerOf(
          await collect(context.runtime.app),
        );
        const activeOperationAtReuseOrient =
          isOperationActive(playerAtReuseOrient);
        updateLearningFixtureDiagnostic(state, {
          activeOperationAtOrient: activeOperationAtReuseOrient,
        });
        const reuseOrientation = await orientForLearningLogFixture(
          rcon,
          state.botName,
          reusePosition,
          activeOperationAtReuseOrient,
        );
        updateLearningFixtureDiagnostic(state, {
          activeOperationAtOrient: reuseOrientation.activeOperationAtOrient,
          yawMatched: reuseOrientation.yawMatched,
          pitchMatched: reuseOrientation.pitchMatched,
        });
        const reuseOrigin = reuseOrientation.position;
        const reuseLogs = await availableLogFixtureSites(rcon, reuseOrigin);
        activeLearningLogs = reuseLogs;
        await configureLogFixture(rcon, reuseLogs, state.botName, (count) => {
          const diagnostic = state.learningFixtureDiagnostic;
          if (diagnostic !== undefined)
            state.learningFixtureDiagnostic = {
              ...diagnostic,
              placementConfirmedCount: count,
            };
        });
        const reuseLogsConfiguredAt = Date.now();
        const reuseFixtureObservation = await observeForPlayer(
          context,
          15_000,
          (player) =>
            recordLearningFixtureObservation(
              state,
              reuseLogsConfiguredAt,
              player,
            ),
        );
        if (reuseFixtureObservation === undefined)
          incomplete("LEARNING_REUSE_LOG_FIXTURE_NOT_VISIBLE");
        state.learningReuseStage = "reuse_fixture_visible";
        const reuseRegion = await captureBlockBaseline(rcon, reuseOrigin);
        const beforeReuseWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          reuseRegion,
        );
        const reuseStart = playerOf(await collect(context.runtime.app));
        const reuseRevision = reuseStart.actionRevision;
        const existingActivityKeys = new Set(
          reuseStart.skillActivity.map(skillActivityKey),
        );
        const existingProposalIds = new Set(
          reuseStart.proposals.map(({ id }) => id),
        );
        const consultedLearnedSkillVersionsById = new Map<
          string,
          Set<number>
        >();
        const reuseResponseStart = context.responseQueue.length;
        state.learningReuseOwnerProposalRecorded = false;
        sendChat(
          context.owner,
          "近くにオークの原木を1本用意しました。前回の方法が今も役立つと判断したら自分で選んで活用し、採掘して結果を確かめてください。",
        );
        const reuseOwnerTurn = await observeForPlayer(
          context,
          20_000,
          (player) =>
            player.proposals.some(({ id }) => !existingProposalIds.has(id)) ||
            context.responseQueue.length > reuseResponseStart,
        );
        if (reuseOwnerTurn === undefined)
          incomplete("LEARNING_REUSE_OWNER_TURN_UNOBSERVED");
        const reuseProposalReadback = playerOf(
          await collect(context.runtime.app),
        );
        state.learningReuseOwnerProposalRecorded =
          reuseProposalReadback.proposals.some(
            ({ id }) => !existingProposalIds.has(id),
          );
        if (!state.learningReuseOwnerProposalRecorded)
          incomplete("LEARNING_REUSE_OWNER_PROPOSAL_MISSING");
        let reuseFixtureCheckAt = 0;
        let reuseFixtureLogRemoved = false;
        const reused = await waitForPlayer(context, 150_000, async (player) => {
          const newConsultedSkills = player.skillActivity.filter(
            (activity) =>
              activity.kind === "consulted" &&
              verifiedLearnedSkillIds.includes(activity.skillId) &&
              !existingActivityKeys.has(skillActivityKey(activity)),
          );
          for (const activity of newConsultedSkills) {
            const versions =
              consultedLearnedSkillVersionsById.get(activity.skillId) ??
              new Set<number>();
            versions.add(activity.version);
            consultedLearnedSkillVersionsById.set(activity.skillId, versions);
          }
          if (Date.now() - reuseFixtureCheckAt > 3_000) {
            reuseFixtureLogRemoved =
              (await fixtureLogsRemaining(rcon, reuseLogs)) < reuseLogs.length;
            reuseFixtureCheckAt = Date.now();
          }
          const successfulDigUsedConsultedVersion = newOutcomes(
            reuseStart,
            player,
          ).some(
            (outcome) =>
              outcome.kind === "dig" &&
              outcome.status === "successful" &&
              outcome.skillId !== undefined &&
              outcome.skillVersion !== undefined &&
              consultedLearnedSkillVersionsById
                .get(outcome.skillId)
                ?.has(outcome.skillVersion),
          );
          return (
            player.actionRevision > reuseRevision &&
            successfulDigUsedConsultedVersion &&
            !isOperationActive(player) &&
            newConsultedSkills.length > 0 &&
            reuseFixtureLogRemoved
          );
        });
        const reusedWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          reuseRegion,
        );
        let afterReuse = readSkillSnapshot(state.databasePath);
        const repeatedOutcomes = newOutcomes(reuseStart, reused);
        const repeatedDigOutcome = repeatedOutcomes.find(
          (outcome) =>
            outcome.kind === "dig" &&
            outcome.status === "successful" &&
            outcome.skillId !== undefined &&
            outcome.skillVersion !== undefined &&
            consultedLearnedSkillVersionsById
              .get(outcome.skillId)
              ?.has(outcome.skillVersion),
        );
        const repeatedDig = repeatedDigOutcome !== undefined;
        const verifiedLearnedSkillIdSet = new Set(verifiedLearnedSkillIds);
        const findReceiptLinkedConsultedSkillId = (
          snapshot: SkillSnapshot,
        ): string | undefined => {
          if (repeatedDigOutcome === undefined) return undefined;
          const evidenceRevision = receiptLinkedConsultedRevisionForOutcome(
            repeatedDigOutcome,
            beforeReuse,
            snapshot,
            verifiedLearnedSkillIdSet,
            consultedLearnedSkillVersionsById,
          );
          return evidenceRevision?.skillId;
        };
        if (
          !repeatedDig ||
          !worldChangedFromBlock(
            beforeReuseWorld.blockRegionChanged,
            reusedWorld.blockRegionChanged,
          )
        ) {
          incomplete("REUSED_SKILL_HAS_NO_OBSERVED_RESULT");
        }
        state.learningReuseStage = "reuse_result_confirmed";
        let receiptLinkedConsultedSkillId =
          findReceiptLinkedConsultedSkillId(afterReuse);
        if (receiptLinkedConsultedSkillId === undefined) {
          await observeForPlayer(context, 30_000, () => {
            afterReuse = readSkillSnapshot(state.databasePath);
            receiptLinkedConsultedSkillId =
              findReceiptLinkedConsultedSkillId(afterReuse);
            return receiptLinkedConsultedSkillId !== undefined;
          });
        }
        if (receiptLinkedConsultedSkillId === undefined) {
          incomplete("SUCCESS_OR_FAILURE_DID_NOT_UPDATE_SKILL_EVIDENCE");
        }
        receiptLinkedConsultedSkillIds = [receiptLinkedConsultedSkillId];
        state.learningReuseStage = "revision_verified";
        await removeLearningLogFixture(rcon, reuseLogs);
        activeLearningLogs = [];
        return {
          firstDigHypothesisSource: firstDigEvidence.source,
          trustedEvidenceReceipt: true,
          derivedHypothesisLinkedToFirstDigReceipt:
            firstDigEvidence.source === "derived_from_first_dig",
          preexistingDerivedHypothesisUsedByFirstDig:
            firstDigEvidence.source === "preexisting_hypothesis_used",
          receiptLinkedRevisionFromFirstDig:
            firstDigEvidence.source ===
            "receipt_linked_revision_from_first_dig",
          learnedSkillConsultedAgain: true,
          repeatResultObserved: true,
          consultedLearnedSkillEvidenceRevisionLinked: true,
          trustedFirstDigHypothesisVerified: true,
          initialSkillCount: baselineSkills.skillCount,
          learnedSkillCount: learned.skillCount,
          ownerReplyObserved: context.responseQueue.length > responseStart,
        };
      },
    ).finally(async () => {
      if (activeLearningLogs.length > 0) {
        await removeLearningLogFixture(rcon, activeLearningLogs);
        activeLearningLogs = [];
      }
    });

    const gatherResult = await recordCase(
      state,
      "gather_multi_target_continuity",
      CASE_DEADLINES.gather_multi_target_continuity,
      requireLiveContext(),
      async (context) => runGatherMultiTargetContinuityCase(state, context),
    );

    const skillQualityResult = await recordCase(
      state,
      "skill_compactness_and_knowledge_separation",
      30_000,
      requireLiveContext(),
      async () => {
        const skills = readSkillSnapshot(state.databasePath);
        const consultedReferences = countBoundedConsultedSkillIds(
          receiptLinkedConsultedSkillIds,
          skills.skillIds,
        );
        if (!skills.learnedBodiesUnderLimit)
          fail("LEARNED_SKILL_BODY_EXCEEDS_8KIB");
        if (consultedReferences === undefined)
          incomplete("ON_DEMAND_SKILL_REFERENCE_EVIDENCE_MISSING");
        if (operationSmokeResult.evidence.gameKnowledgeAvailable !== true) {
          incomplete("GAME_KNOWLEDGE_LAYER_NOT_OBSERVED");
        }
        return {
          learnedBodiesWithin8KiB: true,
          gameKnowledgeApiSeparateFromSkillStore: true,
          boundedSkillReferencesObserved: true,
          consultedReferenceCount: consultedReferences,
          persistedSkillCount: skills.skillCount,
        };
      },
    );

    const exchangeResult = await recordCase(
      state,
      "skill_exchange",
      CASE_DEADLINES.skill_exchange,
      requireLiveContext(),
      async (context) => {
        const standaloneSeedExchange = state.targetCase === "skill_exchange";
        const exchangeSkillIds = standaloneSeedExchange
          ? ["mc-skill-gathering"]
          : verifiedLearnedSkillIds;
        if (exchangeSkillIds.length === 0)
          incomplete("LEARNED_SKILL_IDS_NOT_AVAILABLE_FOR_EXCHANGE");
        if (standaloneSeedExchange) {
          const seedSnapshot = readSkillSnapshot(state.databasePath);
          if (!seedSnapshot.skillIds.has("mc-skill-gathering"))
            incomplete("SKILL_EXCHANGE_SEED_FIXTURE_MISSING");
          if (seedSnapshot.successfulDerivedSkillIds.has("mc-skill-gathering"))
            fail("SKILL_EXCHANGE_SEED_FIXTURE_IS_DERIVED");
        }
        const beforeFiles = new Set(
          await exchangeMarkdownFiles(state.exchangeDirectory),
        );
        const beforeExport = playerOf(await collect(context.runtime.app));
        const exportActivityKeys = new Set(
          beforeExport.skillActivity.map(skillActivityKey),
        );
        const exportProposalIds = new Set(
          beforeExport.proposals.map(({ id }) => id),
        );
        const exportedCandidateSkillIds = new Set<string>();
        const exportedCandidateVersionsBySkillId = new Map<
          string,
          Set<number>
        >();
        const exportResponseStart = context.responseQueue.length;
        sendChat(
          context.owner,
          standaloneSeedExchange
            ? "保存済みの採集Skill「mc-skill-gathering」を専用のMarkdown交換機能で書き出し、ファイル名を教えてください。"
            : "直近で覚えた採集方法を、専用のMarkdown交換機能でファイルに書き出し、ファイル名を教えてください。",
        );
        state.skillExchangeStage = "export_requested";
        const exportOwnerTurn = await observeForPlayer(
          context,
          20_000,
          (player) =>
            player.proposals.some(({ id }) => !exportProposalIds.has(id)) ||
            context.responseQueue.length > exportResponseStart,
        );
        if (exportOwnerTurn === undefined)
          incomplete("SKILL_EXPORT_OWNER_TURN_UNOBSERVED");
        const exportProposalReadback = playerOf(
          await collect(context.runtime.app),
        );
        if (
          !exportProposalReadback.proposals.some(
            ({ id }) => !exportProposalIds.has(id),
          )
        )
          incomplete("SKILL_EXPORT_OWNER_PROPOSAL_MISSING");
        await waitForPlayer(context, 120_000, async () => {
          const current = await exchangeMarkdownFiles(state.exchangeDirectory);
          const exportedActivity = playerOf(
            await collect(context.runtime.app),
          ).skillActivity.some((activity) => {
            if (
              activity.kind !== "exported" ||
              !exchangeSkillIds.includes(activity.skillId) ||
              exportActivityKeys.has(skillActivityKey(activity))
            )
              return false;
            exportedCandidateSkillIds.add(activity.skillId);
            if (
              Number.isSafeInteger(activity.version) &&
              activity.version > 0
            ) {
              const versions =
                exportedCandidateVersionsBySkillId.get(activity.skillId) ??
                new Set<number>();
              versions.add(activity.version);
              exportedCandidateVersionsBySkillId.set(
                activity.skillId,
                versions,
              );
            }
            return true;
          });
          return (
            current.some((file) => !beforeFiles.has(file)) &&
            exportedActivity &&
            context.responseQueue.length > exportResponseStart
          );
        });
        const newFiles = (
          await exchangeMarkdownFiles(state.exchangeDirectory)
        ).filter((file) => !beforeFiles.has(file));
        let exportedFile: string | undefined;
        let exportedSkillId: string | undefined;
        let exportedSkillVersion: number | undefined;
        let exportedSourceVersionUnmatched = false;
        for (const file of newFiles) {
          const markdown = await readFile(
            resolve(state.exchangeDirectory, file),
            "utf8",
          );
          const metadataBlock = /```mc-bot-skill\s*\n([\s\S]*?)\n```/u.exec(
            markdown,
          );
          if (metadataBlock === null) continue;
          const metadataJson = metadataBlock[1];
          if (metadataJson === undefined) continue;
          let metadata: unknown;
          try {
            metadata = JSON.parse(metadataJson) as unknown;
          } catch {
            continue;
          }
          const skill = isRecord(metadata) ? metadata.skill : undefined;
          const skillId = isRecord(skill) ? skill.id : undefined;
          if (
            typeof skillId === "string" &&
            exchangeSkillIds.includes(skillId) &&
            exportedCandidateSkillIds.has(skillId)
          ) {
            const sourceVersion = isRecord(metadata)
              ? metadata.sourceVersion
              : undefined;
            if (
              typeof sourceVersion === "number" &&
              Number.isSafeInteger(sourceVersion) &&
              sourceVersion > 0 &&
              exportedCandidateVersionsBySkillId
                .get(skillId)
                ?.has(sourceVersion)
            ) {
              exportedFile = file;
              exportedSkillId = skillId;
              exportedSkillVersion = sourceVersion;
              break;
            }
            exportedSourceVersionUnmatched = true;
          }
        }
        if (exportedFile === undefined || exportedSkillId === undefined) {
          if (exportedSourceVersionUnmatched) {
            incomplete("SKILL_EXPORT_REVISION_NOT_CONFIRMED");
          }
          fail("SKILL_EXPORT_FILE_ACTIVITY_MISMATCH");
        }
        const exportedSnapshot = readSkillSnapshot(state.databasePath);
        const exportedRevisionReadBack =
          exportedSkillVersion !== undefined &&
          exportedSnapshot.revisionVersionsBySkill
            .get(exportedSkillId)
            ?.has(exportedSkillVersion) === true &&
          exportedSnapshot.revisionDefinitionsBySkill
            .get(exportedSkillId)
            ?.has(exportedSkillVersion) === true;
        if (!exportedRevisionReadBack) {
          incomplete("SKILL_EXPORT_REVISION_NOT_CONFIRMED");
        }
        state.skillExchangeStage = "export_confirmed";
        const filePath = resolve(state.exchangeDirectory, exportedFile);
        const exported = await readFile(filePath, "utf8");
        const editedName = `e2e-edited-${randomBytes(3).toString("hex")}.md`;
        const editedContent = appendSyntheticSkillEdit(exported);
        await writeFile(
          resolve(state.exchangeDirectory, editedName),
          editedContent,
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        const beforeImport = readSkillSnapshot(state.databasePath);
        const importPlayer = playerOf(await collect(context.runtime.app));
        const importActivityKeys = new Set(
          importPlayer.skillActivity.map(skillActivityKey),
        );
        const importProposalIds = new Set(
          importPlayer.proposals.map(({ id }) => id),
        );
        const importResponseStart = context.responseQueue.length;
        sendChat(
          context.owner,
          `編集したSkillファイル「${editedName}」を専用の取り込み機能で読み込み、再利用する手順に反映してください。`,
        );
        state.skillExchangeStage = "import_requested";
        const importOwnerTurn = await observeForPlayer(
          context,
          20_000,
          (player) =>
            player.proposals.some(({ id }) => !importProposalIds.has(id)) ||
            context.responseQueue.length > importResponseStart,
        );
        if (importOwnerTurn === undefined)
          incomplete("SKILL_IMPORT_OWNER_TURN_UNOBSERVED");
        const importProposalReadback = playerOf(
          await collect(context.runtime.app),
        );
        if (
          !importProposalReadback.proposals.some(
            ({ id }) => !importProposalIds.has(id),
          )
        )
          incomplete("SKILL_IMPORT_OWNER_PROPOSAL_MISSING");
        await waitForPlayer(context, 120_000, async () => {
          const now = readSkillSnapshot(state.databasePath);
          const currentPlayer = playerOf(await collect(context.runtime.app));
          const importedActivity = currentPlayer.skillActivity.find(
            (activity) =>
              activity.kind === "imported" &&
              activity.skillId === exportedSkillId &&
              activity.summary ===
                `未信頼の交換用Markdown ${editedName} を知識として取込` &&
              !importActivityKeys.has(skillActivityKey(activity)),
          );
          if (
            importedActivity === undefined ||
            !Number.isSafeInteger(importedActivity.version) ||
            importedActivity.version <= 0
          )
            return false;
          const beforeVersions =
            beforeImport.revisionVersionsBySkill.get(exportedSkillId) ??
            new Set<number>();
          const currentVersions =
            now.revisionVersionsBySkill.get(exportedSkillId) ??
            new Set<number>();
          const importedActivityVersionIsNew =
            currentVersions.has(importedActivity.version) &&
            !beforeVersions.has(importedActivity.version);
          const importedActivityDefinition = now.revisionDefinitionsBySkill
            .get(exportedSkillId)
            ?.get(importedActivity.version);
          const editedBodyObserved =
            importedActivityDefinition?.body.includes(
              SYNTHETIC_SKILL_EDIT_MARKER,
            ) === true &&
            now.learnedBodiesBySkill
              .get(exportedSkillId)
              ?.includes(SYNTHETIC_SKILL_EDIT_MARKER) === true;
          const editedConditionObserved =
            importedActivityDefinition?.conditions.includes(
              SYNTHETIC_SKILL_CONDITION_MARKER,
            ) === true;
          const sameSkillReceiptCount =
            now.importReceiptCountsBySkill.get(exportedSkillId) ?? 0;
          const priorSkillReceiptCount =
            beforeImport.importReceiptCountsBySkill.get(exportedSkillId) ?? 0;
          return (
            importedActivityVersionIsNew &&
            editedBodyObserved &&
            editedConditionObserved &&
            sameSkillReceiptCount > priorSkillReceiptCount &&
            context.responseQueue.length > importResponseStart
          );
        });
        const afterImport = readSkillSnapshot(state.databasePath);
        const importedActivities = playerOf(
          await collect(context.runtime.app),
        ).skillActivity;
        const importedSkillActivity = importedActivities.find(
          (activity) =>
            activity.kind === "imported" &&
            activity.skillId === exportedSkillId &&
            activity.summary ===
              `未信頼の交換用Markdown ${editedName} を知識として取込` &&
            !importActivityKeys.has(skillActivityKey(activity)),
        );
        const beforeImportedVersions =
          beforeImport.revisionVersionsBySkill.get(exportedSkillId) ??
          new Set<number>();
        const afterImportedVersions =
          afterImport.revisionVersionsBySkill.get(exportedSkillId) ??
          new Set<number>();
        const importedSkillVersion = importedSkillActivity?.version;
        const importedDefinition =
          importedSkillVersion === undefined
            ? undefined
            : afterImport.revisionDefinitionsBySkill
                .get(exportedSkillId)
                ?.get(importedSkillVersion);
        const importedRevision =
          importedSkillVersion !== undefined &&
          Number.isSafeInteger(importedSkillVersion) &&
          importedSkillVersion > 0 &&
          afterImportedVersions.has(importedSkillVersion) &&
          !beforeImportedVersions.has(importedSkillVersion);
        const editedBodyImported =
          importedDefinition?.body.includes(SYNTHETIC_SKILL_EDIT_MARKER) ===
            true &&
          afterImport.learnedBodiesBySkill
            .get(exportedSkillId)
            ?.includes(SYNTHETIC_SKILL_EDIT_MARKER) === true;
        const editedConditionImported =
          importedDefinition?.conditions.includes(
            SYNTHETIC_SKILL_CONDITION_MARKER,
          ) === true;
        const beforeSkillReceiptCount =
          beforeImport.importReceiptCountsBySkill.get(exportedSkillId) ?? 0;
        const importedSkillReceiptCount =
          afterImport.importReceiptCountsBySkill.get(exportedSkillId) ?? 0;
        if (
          importedSkillActivity === undefined ||
          !importedRevision ||
          !editedBodyImported ||
          !editedConditionImported ||
          importedSkillReceiptCount <= beforeSkillReceiptCount
        )
          incomplete("EXPORTED_SKILL_EDIT_NOT_CONFIRMED_FOR_SAME_ID");
        state.skillExchangeStage = "import_confirmed";
        const receiptsBeforeDuplicate =
          afterImport.importReceiptCountsBySkill.get(exportedSkillId) ?? 0;
        const duplicateImportStart = playerOf(
          await collect(context.runtime.app),
        );
        const duplicateActivityKeys = new Set(
          duplicateImportStart.skillActivity.map(skillActivityKey),
        );
        const duplicateProposalIds = new Set(
          duplicateImportStart.proposals.map(({ id }) => id),
        );
        const duplicateResponseStart = context.responseQueue.length;
        sendChat(
          context.owner,
          `同じ編集済みSkillファイル「${editedName}」をもう一度読み込み、重複処理が安全か確かめてください。`,
        );
        state.skillExchangeStage = "duplicate_requested";
        const duplicateOwnerTurn = await observeForPlayer(
          context,
          20_000,
          (player) =>
            player.proposals.some(({ id }) => !duplicateProposalIds.has(id)) ||
            context.responseQueue.length > duplicateResponseStart,
        );
        if (duplicateOwnerTurn === undefined)
          incomplete("SKILL_DUPLICATE_IMPORT_OWNER_TURN_UNOBSERVED");
        const duplicateProposalReadback = playerOf(
          await collect(context.runtime.app),
        );
        if (
          !duplicateProposalReadback.proposals.some(
            ({ id }) => !duplicateProposalIds.has(id),
          )
        )
          incomplete("SKILL_DUPLICATE_IMPORT_OWNER_PROPOSAL_MISSING");
        await waitForPlayer(
          context,
          60_000,
          (player) =>
            player.counters.llmCalls > duplicateImportStart.counters.llmCalls &&
            context.responseQueue.length > duplicateResponseStart &&
            player.skillActivity.some(
              (activity) =>
                activity.kind === "imported" &&
                activity.skillId === exportedSkillId &&
                activity.version === importedSkillVersion &&
                activity.summary ===
                  `未信頼の交換用Markdown ${editedName} を知識として取込` &&
                !duplicateActivityKeys.has(skillActivityKey(activity)),
            ),
        );
        const afterDuplicate = readSkillSnapshot(state.databasePath);
        const duplicateReceiptCount =
          afterDuplicate.importReceiptCountsBySkill.get(exportedSkillId) ?? 0;
        const afterDuplicateVersions =
          afterDuplicate.revisionVersionsBySkill.get(exportedSkillId) ??
          new Set<number>();
        const duplicatePreservedVersionMembership =
          afterDuplicateVersions.size === afterImportedVersions.size &&
          [...afterImportedVersions].every((version) =>
            afterDuplicateVersions.has(version),
          );
        const duplicateDefinition = afterDuplicate.revisionDefinitionsBySkill
          .get(exportedSkillId)
          ?.get(importedSkillVersion);
        const duplicatePreservedImportedDefinition =
          JSON.stringify(duplicateDefinition) ===
          JSON.stringify(importedDefinition);
        const duplicatePreservedLearnedBody =
          afterDuplicate.learnedBodiesBySkill.get(exportedSkillId) ===
          afterImport.learnedBodiesBySkill.get(exportedSkillId);
        const duplicatePreservedPerSkillReceiptCount =
          duplicateReceiptCount === receiptsBeforeDuplicate;
        const duplicateImportPreservedCheckedState =
          duplicatePreservedPerSkillReceiptCount &&
          duplicatePreservedVersionMembership &&
          duplicatePreservedImportedDefinition &&
          duplicatePreservedLearnedBody;
        if (!duplicateImportPreservedCheckedState)
          fail("DUPLICATE_IMPORT_CHANGED_CHECKED_SKILL_STATE");
        state.skillExchangeStage = "duplicate_confirmed";
        let skillExchangeFixture: BlockPosition | undefined;
        let skillExchangeFixtureRestoredToAir = false;
        const restoreSkillExchangeFixture = async (): Promise<void> => {
          if (skillExchangeFixture === undefined) return;
          const fixture = skillExchangeFixture;
          try {
            await context.rcon.command(
              `setblock ${fixture.x} ${fixture.y} ${fixture.z} air`,
            );
          } catch {
            incomplete("SKILL_EXCHANGE_FIXTURE_CLEANUP_UNVERIFIED");
          }
          let restoredToAir: boolean;
          try {
            restoredToAir = await isBlock(context.rcon, fixture, "air");
          } catch {
            incomplete("SKILL_EXCHANGE_FIXTURE_CLEANUP_UNVERIFIED");
          }
          if (!restoredToAir)
            incomplete("SKILL_EXCHANGE_FIXTURE_CLEANUP_UNVERIFIED");
          skillExchangeFixtureRestoredToAir = true;
          skillExchangeFixture = undefined;
        };
        try {
          const origin = parsePosition(
            await context.rcon.command(
              `data get entity ${context.botName} Pos`,
            ),
          );
          const activeSkillExchangeFixture = fixturePoint(
            origin,
            1,
            2,
            Math.floor(origin.y),
          );
          const fixtureHead = {
            ...activeSkillExchangeFixture,
            y: activeSkillExchangeFixture.y + 1,
          };
          const fixtureSupport = {
            ...activeSkillExchangeFixture,
            y: activeSkillExchangeFixture.y - 1,
          };
          if (
            !(await isBlock(context.rcon, fixtureHead, "air")) ||
            (await isBlock(context.rcon, fixtureSupport, "air")) ||
            !(await isBlock(context.rcon, activeSkillExchangeFixture, "air"))
          )
            incomplete("SKILL_EXCHANGE_FIXTURE_SITE_UNAVAILABLE");
          skillExchangeFixture = activeSkillExchangeFixture;
          await configureLogFixture(
            context.rcon,
            [activeSkillExchangeFixture],
            context.botName,
            () => undefined,
          );
          const fixtureYaw =
            (Math.atan2(
              -(activeSkillExchangeFixture.x + 0.5 - origin.x),
              activeSkillExchangeFixture.z + 0.5 - origin.z,
            ) *
              180) /
            Math.PI;
          await context.rcon.command(
            `tp ${context.botName} ${origin.x} ${origin.y} ${origin.z} ${fixtureYaw} ${LEARNING_FIXTURE_PITCH}`,
          );
          const confirmedPosition = parsePosition(
            await context.rcon.command(
              `data get entity ${context.botName} Pos`,
            ),
          );
          const rotation = await readLearningFixtureRotation(
            context.rcon,
            context.botName,
          );
          if (
            Math.hypot(
              confirmedPosition.x - origin.x,
              confirmedPosition.y - origin.y,
              confirmedPosition.z - origin.z,
            ) > 0.5 ||
            rotation === undefined ||
            angularDistance(rotation.yaw, fixtureYaw) > 2 ||
            Math.abs(rotation.pitch - LEARNING_FIXTURE_PITCH) > 2
          )
            incomplete("SKILL_EXCHANGE_FIXTURE_ORIENTATION_UNCONFIRMED");
          const fixtureConfiguredAt = Date.now();
          const visibleFixture = await observeForPlayer(
            context,
            20_000,
            (player) => {
              const observedAt = Date.parse(
                player.lastObservation?.observedAt ?? "",
              );
              return (
                Number.isFinite(observedAt) &&
                observedAt >= fixtureConfiguredAt &&
                (player.lastObservation?.visibleBlockNames ?? []).includes(
                  "oak_log",
                )
              );
            },
          );
          if (visibleFixture === undefined)
            incomplete("SKILL_EXCHANGE_BODY_FIXTURE_NOT_VISIBLE");

          const beforeSkillUse = playerOf(await collect(context.runtime.app));
          const skillActivityBeforeUse = new Set(
            beforeSkillUse.skillActivity.map(skillActivityKey),
          );
          const agentActivityKey = (
            activity: PlayerAgentRoundActivity,
          ): string =>
            `${activity.runSequence}:${activity.role}:${activity.round}`;
          const agentActivityBeforeUse = new Set(
            (beforeSkillUse.recentAgentActivity ?? []).map(agentActivityKey),
          );
          const hasNewPurposeSearchToolCall = (
            player: PlayerEvidence,
          ): boolean =>
            (player.recentAgentActivity ?? []).some(
              (activity) =>
                activity.role === "purpose" &&
                !agentActivityBeforeUse.has(agentActivityKey(activity)) &&
                activity.toolCalls.some(
                  (toolCall) => toolCall.name === "search_skills",
                ),
            );
          const findImportedRevisionSearchActivity = (
            player: PlayerEvidence,
          ): PlayerEvidence["skillActivity"][number] | undefined =>
            player.skillActivity.find(
              (activity) =>
                activity.kind === "consulted" &&
                activity.skillId === exportedSkillId &&
                activity.version === importedSkillVersion &&
                (activity.summary === "目的に関連する技能候補を検索" ||
                  activity.summary ===
                    "語句不一致のため基礎技能のカテゴリ候補を提示") &&
                !skillActivityBeforeUse.has(skillActivityKey(activity)),
            );
          const findImportedRevisionSuccessfulDig = (
            player: PlayerEvidence,
          ): PlayerEvidence["recentOutcomes"][number] | undefined =>
            newOutcomes(beforeSkillUse, player).find(
              (outcome) =>
                outcome.kind === "dig" &&
                outcome.status === "successful" &&
                outcome.skillId === exportedSkillId &&
                outcome.skillVersion === importedSkillVersion,
            );
          sendChat(
            context.owner,
            `編集して取り込んだ採集Skill「${exportedSkillId}」を参考に、見えているオーク原木を1本だけ採掘して結果を確かめてください。`,
          );
          state.skillExchangeStage = "consult_requested";
          const skillUseAndWorldChange = await waitForPlayer(
            context,
            120_000,
            async (player) => {
              const searchActivity = findImportedRevisionSearchActivity(player);
              const successfulDig = findImportedRevisionSuccessfulDig(player);
              const searchAt = Date.parse(searchActivity?.at ?? "");
              const digObservedAt = Date.parse(successfulDig?.observedAt ?? "");
              return (
                hasNewPurposeSearchToolCall(player) &&
                searchActivity !== undefined &&
                successfulDig !== undefined &&
                Number.isFinite(searchAt) &&
                Number.isFinite(digObservedAt) &&
                searchAt <= digObservedAt &&
                !isOperationActive(player) &&
                (await isBlock(context.rcon, activeSkillExchangeFixture, "air"))
              );
            },
          );
          state.skillExchangeStage = "consulted";
          const postUsePurposeSearch = hasNewPurposeSearchToolCall(
            skillUseAndWorldChange,
          );
          const postUseImportedRevisionSearch =
            findImportedRevisionSearchActivity(skillUseAndWorldChange);
          const confirmedDigOutcome = findImportedRevisionSuccessfulDig(
            skillUseAndWorldChange,
          );
          const searchAt = Date.parse(postUseImportedRevisionSearch?.at ?? "");
          const digObservedAt = Date.parse(
            confirmedDigOutcome?.observedAt ?? "",
          );
          if (
            !postUsePurposeSearch ||
            postUseImportedRevisionSearch === undefined ||
            confirmedDigOutcome === undefined ||
            !Number.isFinite(searchAt) ||
            !Number.isFinite(digObservedAt) ||
            searchAt > digObservedAt
          )
            incomplete("SKILL_EXCHANGE_IMPORTED_REVISION_DIG_NOT_CONFIRMED");
          const serverConfirmedAirAfterDig = await isBlock(
            context.rcon,
            activeSkillExchangeFixture,
            "air",
          );
          if (!serverConfirmedAirAfterDig)
            incomplete("SKILL_EXCHANGE_SERVER_AIR_READBACK_MISSING");
          await restoreSkillExchangeFixture();
          state.skillExchangeStage = "game_action_confirmed";
          return {
            repositorySeedFixtureUsed: standaloneSeedExchange,
            seedHasNoSuccessfulDerivedHypothesis: standaloneSeedExchange,
            markdownExportCreated: true,
            sameExportedSkillRevisionConfirmed: true,
            humanConditionAndBodyEditImported: true,
            sameSkillRevisionAndImportReceiptReadBack: importedRevision,
            duplicateImportPreservedVersionMembershipDefinitionBodyAndPerSkillReceiptCount:
              duplicateImportPreservedCheckedState,
            sameImportedRevisionConsulted: true,
            postImportPurposeSearchToolCallObserved: true,
            sameImportedRevisionSearchActivityObserved: true,
            importedRevisionSearchPrecededSuccessfulDig: true,
            oneSuccessfulBodyDigObserved: true,
            successfulDigUsedImportedSkillRevision: true,
            serverConfirmedAirAfterDig,
            fixtureRestoredToAir: skillExchangeFixtureRestoredToAir,
            dbSkillCount: afterDuplicate.skillCount,
            importReceiptCount: afterDuplicate.importReceiptCount,
          };
        } finally {
          if (skillExchangeFixture !== undefined)
            await restoreSkillExchangeFixture();
        }
      },
    );

    if (isCaseSelectedForTarget(state.targetCase, "game_action_discretion")) {
      const beforeDiscretionHandoff = playerOf(
        await collect(requireLiveContext().runtime.app),
      );
      const pendingBeforeDiscretion = new Set(
        beforeDiscretionHandoff.proposals
          .filter(({ status }) => status === "pending")
          .map(({ id }) => id),
      );
      state.gameActionPriorPendingProposalCount = pendingBeforeDiscretion.size;
      state.gameActionPriorProposalsSettled =
        pendingBeforeDiscretion.size === 0 ||
        (await observeForPlayer(requireLiveContext(), 45_000, (player) =>
          [...pendingBeforeDiscretion].every((id) =>
            player.proposals.some(
              (proposal) => proposal.id === id && proposal.status !== "pending",
            ),
          ),
        )) !== undefined;
    }

    let activeBuildingFixture: BuildingFixture | undefined;
    const discretionResult = await recordCase(
      state,
      "game_action_discretion",
      CASE_DEADLINES.game_action_discretion,
      requireLiveContext(),
      async (context) => {
        if (!state.gameActionPriorProposalsSettled)
          incomplete("PRIOR_OWNER_PROPOSALS_UNRESOLVED");
        const origin = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const buildingFixture = await findBuildingFixture(rcon, origin);
        activeBuildingFixture = buildingFixture;
        const placementObservationProbe: GameActionPlacementObservationProbe = {
          target: buildingFixture.target,
          freshAfter: 0,
          observationsByTime: new Map(),
        };
        activeGameActionPlacementObservationProbe = placementObservationProbe;
        const facingConfirmedAt = await configureBuildingFixture(
          rcon,
          context.botName,
          origin,
          buildingFixture,
        );
        placementObservationProbe.freshAfter = facingConfirmedAt;
        await captureBlockBaseline(rcon, origin);
        const beforeWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          buildingFixture.region,
        );
        const wallObservation = await observeForPlayer(
          context,
          15_000,
          (player) => {
            const observation = player.lastObservation;
            return (
              observation?.observedAt !== undefined &&
              Date.parse(observation.observedAt) > facingConfirmedAt &&
              observation.visibleBlockNames?.includes("oak_planks") === true
            );
          },
        );
        if (wallObservation === undefined)
          incomplete("BUILDING_WALL_NOT_VISIBLE");
        const before = playerOf(await collect(context.runtime.app));
        state.gameActionPlacementCandidateDiagnostic =
          readGameActionPlacementCandidateDiagnostic(
            placementObservationProbe,
            before.lastObservation?.observedAt,
            facingConfirmedAt,
          );
        activeGameActionPlacementObservationProbe = undefined;
        state.gameActionEvidenceBaseline = {
          revision: before.revision,
          outcomeOperationIds: new Set(
            before.recentOutcomes.map(({ operationId }) => operationId),
          ),
        };
        const beforeActionRevision = before.actionRevision;
        sendChat(
          context.owner,
          "近くにある木の板の壁の目線の高さに1マスの穴があります。持たせた板材で埋めて修理し、配置結果を確かめてください。手順は自分で判断してください。ブロックごとに確認を求める必要はありません。危険を感じた場合も、取るかどうかは自分で判断してください。",
        );
        const checkedPlaceOutcomeIds = new Set<string>();
        let after: PlayerEvidence;
        try {
          after = await waitForPlayer(
            context,
            CASE_DEADLINES.game_action_discretion - 60_000,
            async (player) => {
              if (player.actionRevision <= beforeActionRevision) return false;
              const newSuccessfulPlacements = newOutcomes(
                before,
                player,
              ).filter(
                (outcome) =>
                  outcome.kind === "place" && outcome.status === "successful",
              );
              for (const outcome of newSuccessfulPlacements) {
                if (checkedPlaceOutcomeIds.has(outcome.operationId)) continue;
                checkedPlaceOutcomeIds.add(outcome.operationId);
                const readbackDeadline = Date.now() + 1_500;
                do {
                  if (await isBlock(rcon, buildingFixture.target, "oak_planks"))
                    return true;
                  if (Date.now() < readbackDeadline) await waitMs(250);
                } while (Date.now() < readbackDeadline);
              }
              return false;
            },
          );
        } catch (error) {
          if (
            error instanceof HarnessError &&
            error.code.includes("BUDGET_EXCEEDED")
          ) {
            state.gameActionFixtureHoleReadback =
              await readGameActionFixtureHoleReadback(
                rcon,
                buildingFixture.target,
              );
          }
          throw error;
        }
        const afterWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          buildingFixture.region,
        );
        const targetGapFilled = await isBlock(
          rcon,
          buildingFixture.target,
          "oak_planks",
        );
        const selectedPlacement = newOutcomes(before, after).some(
          (outcome) =>
            outcome.kind === "place" && outcome.status === "successful",
        );
        const stateChanged = worldChangedFromBlock(
          beforeWorld.blockRegionChanged,
          afterWorld.blockRegionChanged,
        );
        if (!selectedPlacement || !stateChanged || !targetGapFilled)
          incomplete("BUILDING_DISCRETION_NOT_OBSERVED");
        await removeBuildingFixture(rcon, buildingFixture);
        activeBuildingFixture = undefined;
        return {
          ...gameActionPlacementCandidateEvidence(state),
          priorOwnerProposalsSettled: true,
          selectedBuildingOperation: selectedPlacement,
          fixtureFacingConfirmed: true,
          bodyObservedWallMaterial: true,
          serverConfirmedWorldChange: stateChanged,
          serverConfirmedTargetGapFilled: targetGapFilled,
          ownerApprovalPerBlockNotRequired: true,
        };
      },
    ).finally(async () => {
      activeGameActionPlacementObservationProbe = undefined;
      if (activeBuildingFixture !== undefined) {
        await removeBuildingFixture(rcon, activeBuildingFixture);
        activeBuildingFixture = undefined;
      }
    });

    const foodResult = await recordCase(
      state,
      "food_intent_continuity",
      CASE_DEADLINES.food_intent_continuity,
      requireLiveContext(),
      async (context) => {
        updateFoodIntentContinuityDiagnostic(state, { caseStarted: true });
        let hungerEffectMayBeActive = false;
        let saturationEffectMayBeActive = false;
        let saturationEffectUsedForFullState = false;
        const purposeDecisionObservedSince = (
          before: PlayerEvidence,
          player: PlayerEvidence,
        ): boolean => {
          const previousRounds = new Set(
            (before.recentAgentActivity ?? []).map(
              (activity) => `${activity.runSequence}:${activity.round}`,
            ),
          );
          return (player.recentAgentActivity ?? []).some(
            (activity) =>
              activity.role === "purpose" &&
              !previousRounds.has(
                `${activity.runSequence}:${activity.round}`,
              ) &&
              activity.toolCalls.some(
                (toolCall) =>
                  toolCall.name === "commit_action_decision" &&
                  toolCall.resultClass === "ok",
              ),
          );
        };
        try {
          await rcon.command(`clear ${context.botName} minecraft:bread`);
          const initialFood = await rconFoodLevel(rcon, context.botName);
          if (initialFood !== 20)
            incomplete("FOOD_INTENT_INITIAL_FULL_STATE_NOT_CONFIRMED");

          hungerEffectMayBeActive = true;
          await rcon.command(
            `effect give ${context.botName} minecraft:hunger 120 8 true`,
          );
          if (!(await rconHasActiveEffect(rcon, context.botName, "hunger")))
            incomplete("FOOD_INTENT_HUNGER_EFFECT_NOT_CONFIRMED");

          const hungerDeadline = Date.now() + 60_000;
          let hungerPrepared = false;
          while (Date.now() < hungerDeadline) {
            const observedFood = await rconFoodLevel(rcon, context.botName);
            if (observedFood <= 15) {
              if (observedFood < 12)
                incomplete("FOOD_INTENT_SAFE_HUNGER_RANGE_NOT_CONFIRMED");
              hungerPrepared = true;
              updateFoodIntentContinuityDiagnostic(state, {
                hungerPreparedWithServerEffect: true,
              });
              break;
            }
            await waitMs(500);
          }
          if (!hungerPrepared)
            incomplete("FOOD_INTENT_HUNGER_PREPARATION_DEADLINE");

          await rcon.command(
            `effect clear ${context.botName} minecraft:hunger`,
          );
          if (await rconHasActiveEffect(rcon, context.botName, "hunger"))
            incomplete("FOOD_INTENT_HUNGER_EFFECT_CLEANUP_NOT_CONFIRMED");
          hungerEffectMayBeActive = false;
          updateFoodIntentContinuityDiagnostic(state, {
            hungerEffectCleanupConfirmed: true,
          });

          const foodBefore = await rconFoodLevel(rcon, context.botName);
          if (foodBefore < 12 || foodBefore > 15)
            incomplete("FOOD_INTENT_SAFE_HUNGER_RANGE_NOT_CONFIRMED");
          await rcon.command(`give ${context.botName} minecraft:bread 1`);
          const breadBefore = await rconInventoryItemCount(
            rcon,
            context.botName,
            "bread",
          );
          if (breadBefore !== 1)
            incomplete("FOOD_INTENT_CARRIED_BREAD_NOT_CONFIRMED");
          updateFoodIntentContinuityDiagnostic(state, {
            carriedBreadConfirmed: true,
          });

          const referenceResponseStart = context.responseQueue.length;
          sendChat(
            context.owner,
            "Bot自身がパンを一つ持っているのを確認しました。まず返事だけください。",
          );
          const referenceTurn = await observeForPlayer(
            context,
            45_000,
            () => context.responseQueue.length > referenceResponseStart,
          );
          if (referenceTurn === undefined)
            incomplete("FOOD_INTENT_REFERENCE_TURN_UNOBSERVED");
          updateFoodIntentContinuityDiagnostic(state, {
            ownerReferenceTurnObserved: true,
          });
          const beforeFollowup = playerOf(await collect(context.runtime.app));
          const breadBeforeFollowup = await rconInventoryItemCount(
            rcon,
            context.botName,
            "bread",
          );
          const foodBeforeFollowup = await rconFoodLevel(rcon, context.botName);
          if (
            breadBeforeFollowup !== breadBefore ||
            foodBeforeFollowup !== foodBefore
          )
            incomplete("FOOD_INTENT_FIXTURE_CHANGED_BEFORE_FOLLOWUP");

          const followupResponseStart = context.responseQueue.length;
          sendChat(
            context.owner,
            "じゃあ、そのパンを食べて昼食にしてください。",
          );
          updateFoodIntentContinuityDiagnostic(state, {
            hungryFollowupSent: true,
          });
          const decided = await waitForPlayer(context, 150_000, (player) => {
            const purposeDecisionCommitted = purposeDecisionObservedSince(
              beforeFollowup,
              player,
            );
            if (purposeDecisionCommitted) {
              updateFoodIntentContinuityDiagnostic(state, {
                hungryPurposeCommitObserved: true,
              });
            }
            const observedConsume = newOutcomes(beforeFollowup, player).find(
              (outcome) => outcome.kind === "consume",
            );
            if (observedConsume !== undefined) {
              updateFoodIntentContinuityDiagnostic(state, {
                consumeOutcomeObserved: true,
                ...(observedConsume.status === "successful"
                  ? { consumeOutcomeSuccessful: true }
                  : {}),
              });
            }
            const consumeObserved = newOutcomes(beforeFollowup, player).some(
              (outcome) => outcome.kind === "consume",
            );
            const conditionExplained = context.responseQueue
              .slice(followupResponseStart)
              .some(({ text }) => explainsFullHunger(text));
            return (
              purposeDecisionObservedSince(beforeFollowup, player) &&
              (consumeObserved || conditionExplained)
            );
          });
          if (!purposeDecisionObservedSince(beforeFollowup, decided))
            incomplete("FOOD_INTENT_PURPOSE_DECISION_NOT_CONFIRMED");
          const consumeOutcome = newOutcomes(beforeFollowup, decided).find(
            (outcome) => outcome.kind === "consume",
          );
          if (consumeOutcome === undefined)
            fail("FOOD_INTENT_HUNGRY_FOLLOWUP_DID_NOT_CONSUME");
          updateFoodIntentContinuityDiagnostic(state, {
            consumeOutcomeObserved: true,
            ...(consumeOutcome.status === "successful"
              ? { consumeOutcomeSuccessful: true }
              : {}),
          });
          if (consumeOutcome.status !== "successful")
            fail("FOOD_INTENT_CONSUME_NOT_SUCCESSFUL");

          const breadAfter = await rconInventoryItemCount(
            rcon,
            context.botName,
            "bread",
          );
          const foodAfter = await rconFoodLevel(rcon, context.botName);
          if (breadAfter === breadBefore - 1) {
            updateFoodIntentContinuityDiagnostic(state, {
              serverBreadDecrementConfirmed: true,
            });
          }
          if (foodAfter > foodBefore) {
            updateFoodIntentContinuityDiagnostic(state, {
              serverFoodLevelIncreaseConfirmed: true,
            });
          }
          if (breadAfter !== breadBefore - 1 || foodAfter <= foodBefore)
            fail("FOOD_INTENT_CONSUME_ORACLE_MISMATCH");
          let foodBeforeFullStage = foodAfter;
          if (foodBeforeFullStage < 20) {
            saturationEffectUsedForFullState = true;
            saturationEffectMayBeActive = true;
            await rcon.command(
              `effect give ${context.botName} minecraft:saturation 1 20 true`,
            );
            const fullStateDeadline = Date.now() + 3_000;
            while (Date.now() < fullStateDeadline) {
              foodBeforeFullStage = await rconFoodLevel(rcon, context.botName);
              if (foodBeforeFullStage === 20) break;
              await waitMs(250);
            }
            await rcon.command(
              `effect clear ${context.botName} minecraft:saturation`,
            );
            if (await rconHasActiveEffect(rcon, context.botName, "saturation"))
              incomplete("FOOD_INTENT_SATURATION_EFFECT_CLEANUP_NOT_CONFIRMED");
            saturationEffectMayBeActive = false;
            foodBeforeFullStage = await rconFoodLevel(rcon, context.botName);
          }
          if (foodBeforeFullStage !== 20)
            incomplete("FOOD_INTENT_FULL_STAGE_FIXTURE_NOT_CONFIRMED");
          updateFoodIntentContinuityDiagnostic(state, {
            fullHunger20ReadbackConfirmed: true,
          });

          await rcon.command(`give ${context.botName} minecraft:bread 1`);
          const fullStageBread = await rconInventoryItemCount(
            rcon,
            context.botName,
            "bread",
          );
          const fullStageFood = await rconFoodLevel(rcon, context.botName);
          if (fullStageBread !== 1 || fullStageFood !== 20)
            incomplete("FOOD_INTENT_FULL_STAGE_FIXTURE_NOT_CONFIRMED");
          updateFoodIntentContinuityDiagnostic(state, {
            fullStageBreadFixtureConfirmed: true,
          });

          const beforeFullStage = playerOf(await collect(context.runtime.app));
          const fullResponseStart = context.responseQueue.length;
          sendChat(context.owner, "もう一つのパンを食べてください。");
          updateFoodIntentContinuityDiagnostic(state, {
            fullStageOwnerRequestSent: true,
          });
          const fullDecision = await waitForPlayer(
            context,
            90_000,
            (player) => {
              const proposalResolved = hasNewResolvedOwnerProposalSince(
                beforeFullStage,
                player,
              );
              const purposeDecisionCommitted = purposeDecisionObservedSince(
                beforeFullStage,
                player,
              );
              const nonConsumingDecisionObserved =
                hasNewNonConsumingDecisionSince(beforeFullStage, player);
              const consumeSelected = hasNewConsumeDecisionSince(
                beforeFullStage,
                player,
              );
              const conditionExplained = context.responseQueue
                .slice(fullResponseStart)
                .some(({ text }) => explainsFullHunger(text));
              updateFoodIntentContinuityDiagnostic(state, {
                ...(proposalResolved
                  ? { fullStageOwnerProposalResolved: true }
                  : {}),
                ...(conditionExplained
                  ? { fullHungerExplanationReceived: true }
                  : {}),
                ...(purposeDecisionCommitted
                  ? { fullStagePurposeCommitObserved: true }
                  : {}),
                ...(nonConsumingDecisionObserved
                  ? { fullStageNonConsumingDecisionObserved: true }
                  : {}),
                ...(consumeSelected ? { fullStageConsumeSelected: true } : {}),
              });
              if (consumeSelected) return true;
              return (
                proposalResolved &&
                conditionExplained &&
                purposeDecisionCommitted &&
                nonConsumingDecisionObserved
              );
            },
          );
          if (hasNewConsumeDecisionSince(beforeFullStage, fullDecision))
            fail("FOOD_INTENT_FULL_HUNGER_SELECTED_CONSUME");
          if (!purposeDecisionObservedSince(beforeFullStage, fullDecision))
            incomplete("FOOD_INTENT_FULL_STAGE_PURPOSE_NOT_CONFIRMED");
          if (!hasNewResolvedOwnerProposalSince(beforeFullStage, fullDecision))
            incomplete("FOOD_INTENT_FULL_STAGE_OWNER_PROPOSAL_NOT_RESOLVED");
          if (!hasNewNonConsumingDecisionSince(beforeFullStage, fullDecision))
            incomplete(
              "FOOD_INTENT_FULL_STAGE_NON_CONSUMING_DECISION_NOT_CONFIRMED",
            );
          if (
            !context.responseQueue
              .slice(fullResponseStart)
              .some(({ text }) => explainsFullHunger(text))
          )
            incomplete("FOOD_INTENT_FULL_HUNGER_EXPLANATION_NOT_CONFIRMED");
          const fullStageBreadAfter = await rconInventoryItemCount(
            rcon,
            context.botName,
            "bread",
          );
          const fullStageFoodAfter = await rconFoodLevel(rcon, context.botName);
          if (fullStageBreadAfter === fullStageBread) {
            updateFoodIntentContinuityDiagnostic(state, {
              fullStageBreadUnchangedConfirmed: true,
            });
          }
          if (fullStageFoodAfter === fullStageFood) {
            updateFoodIntentContinuityDiagnostic(state, {
              fullStageFoodLevelUnchangedConfirmed: true,
            });
          }
          if (
            fullStageBreadAfter !== fullStageBread ||
            fullStageFoodAfter !== fullStageFood
          )
            fail("FOOD_INTENT_FULL_HUNGER_SERVER_STATE_CHANGED");
          const finalFullStagePlayer = playerOf(
            await collect(context.runtime.app),
          );
          if (hasNewConsumeDecisionSince(beforeFullStage, finalFullStagePlayer))
            fail("FOOD_INTENT_FULL_HUNGER_SELECTED_CONSUME");
          updateFoodIntentContinuityDiagnostic(state, {
            fullStageConsumeNotSelected: true,
          });
          return {
            hungerPreparedWithServerEffect: true,
            carriedBreadConfirmed: true,
            ownerReferenceTurnObserved: true,
            ownerFollowupObserved: true,
            purposeDecisionCommitted: true,
            selectedConsume: true,
            serverInventoryDecrementConfirmed: true,
            serverHungerIncreaseConfirmed: true,
            saturationEffectUsedForFullState,
            fullStageOwnerProposalResolved: true,
            fullHungerExplanationReceived: true,
            fullHungerNonConsumeDecisionConfirmed: true,
            fullHungerConsumeNotSelected: true,
            fullHungerInventoryUnchangedConfirmed: true,
            fullHungerLevelUnchangedConfirmed: true,
          };
        } finally {
          let allFoodEffectsCleared = true;
          for (const [effect, mayBeActive] of [
            ["hunger", hungerEffectMayBeActive],
            ["saturation", saturationEffectMayBeActive],
          ] as const) {
            if (!mayBeActive) continue;
            let effectClearConfirmed: boolean;
            try {
              await rcon.command(
                `effect clear ${context.botName} minecraft:${effect}`,
              );
              effectClearConfirmed = !(await rconHasActiveEffect(
                rcon,
                context.botName,
                effect,
              ));
            } catch {
              effectClearConfirmed = false;
            }
            if (!effectClearConfirmed) allFoodEffectsCleared = false;
          }
          if (!allFoodEffectsCleared) {
            state.abortRequested = true;
            state.failureCode ??= "FOOD_INTENT_EFFECT_CLEANUP_NOT_CONFIRMED";
            incomplete("FOOD_INTENT_EFFECT_CLEANUP_NOT_CONFIRMED");
          }
        }
      },
    );

    const damageResult = await recordCase(
      state,
      "damage_response",
      CASE_DEADLINES.damage_response,
      requireLiveContext(),
      async (context) => {
        const expectedHealth = 20;
        const expectedFood = 20;
        const initialEvidence = await collect(context.runtime.app);
        const initialHealth = initialEvidence.game?.health;
        const initialRconHealth = await rconEntityHealth(rcon, context.botName);
        const initialFood = initialEvidence.game?.food;
        const initialRconFood = await rconFoodLevel(rcon, context.botName);
        const effectsBaseline = await rconActiveEffectsState(
          rcon,
          context.botName,
        );
        if (effectsBaseline === "unknown") {
          const code = "DAMAGE_RESPONSE_BASELINE_EFFECTS_STATE_UNAVAILABLE";
          state.failureCode ??= code;
          incomplete(code);
        }
        const naturalRegeneration = await rconNaturalRegeneration(rcon);

        let naturalRegenerationMayNeedRestore = false;
        let effectsMayNeedCleanup = false;
        let damageMayNeedCleanup = false;
        let positionMayNeedRestore = false;
        let primaryFailureCode: string | undefined;
        let fixturePosition: Position | undefined;
        try {
          if (
            !damageResponseFoodBaselineConfirmed(
              initialFood,
              initialRconFood,
              expectedFood,
            )
          )
            incomplete(
              "DAMAGE_RESPONSE_SAFE_FOOD_NOT_CONFIRMED_BY_BOTH_ORACLES",
            );
          fixturePosition = parsePosition(
            await rcon.command(`data get entity ${context.botName} Pos`),
          );
          naturalRegenerationMayNeedRestore = true;
          await setAndVerifyGamerule(rcon, "naturalRegeneration", false);

          if (effectsBaseline === "active") {
            effectsMayNeedCleanup = true;
            await rcon.command(`effect clear ${context.botName}`);
            if (
              (await rconActiveEffectsState(rcon, context.botName)) !== "empty"
            )
              incomplete("DAMAGE_RESPONSE_BASELINE_EFFECTS_NOT_CLEARED");
          }
          if (
            initialHealth !== expectedHealth ||
            initialRconHealth !== expectedHealth
          ) {
            damageMayNeedCleanup = true;
            effectsMayNeedCleanup = true;
            await rcon.command(
              `effect give ${context.botName} minecraft:instant_health 1 4 true`,
            );
            const healthDeadline = Date.now() + 5_000;
            let healthReady = false;
            while (Date.now() < healthDeadline) {
              const bodyHealth = (await collect(context.runtime.app)).game
                ?.health;
              const rconHealth = await rconEntityHealth(rcon, context.botName);
              if (
                bodyHealth === expectedHealth &&
                rconHealth === expectedHealth
              ) {
                healthReady = true;
                break;
              }
              await waitMs(100);
            }
            if (!healthReady) {
              const bodyHealth = (await collect(context.runtime.app)).game
                ?.health;
              const rconHealth = await rconEntityHealth(rcon, context.botName);
              incomplete(
                rconHealth !== expectedHealth
                  ? "DAMAGE_RESPONSE_RCON_HEALTH_BASELINE_NOT_RESTORED"
                  : bodyHealth !== expectedHealth
                    ? "DAMAGE_RESPONSE_BODY_HEALTH_BASELINE_NOT_CONFIRMED"
                    : "DAMAGE_RESPONSE_HEALTH_BASELINE_NOT_CONFIRMED",
              );
            }
            await rcon.command(`effect clear ${context.botName}`);
            if (
              (await rconActiveEffectsState(rcon, context.botName)) !== "empty"
            )
              incomplete("DAMAGE_RESPONSE_HEALTH_EFFECT_CLEANUP_NOT_CONFIRMED");
          }
          const preparedEvidence = await collect(context.runtime.app);
          const preparedFood = await rconFoodLevel(rcon, context.botName);
          const preparedRconHealth = await rconEntityHealth(
            rcon,
            context.botName,
          );
          const preparedBodyHealth = preparedEvidence.game?.health;
          const preparedBodyFood = preparedEvidence.game?.food;
          if (
            preparedBodyHealth !== expectedHealth ||
            preparedRconHealth !== expectedHealth ||
            preparedBodyFood !== preparedFood ||
            preparedFood !== expectedFood
          )
            incomplete(
              "DAMAGE_RESPONSE_SAFE_FOOD_NOT_CONFIRMED_BY_BOTH_ORACLES",
            );

          const before = playerOf(preparedEvidence);
          const priorActivity = new Set(
            (before.recentAgentActivity ?? []).map(
              (activity) => `${activity.runSequence}:${activity.round}`,
            ),
          );
          damageMayNeedCleanup = true;
          positionMayNeedRestore = true;
          await rcon.command(`damage ${context.botName} 14 minecraft:generic`);
          const damageAppliedAt = Date.now();
          const damageReadbackDeadlineAt = damageAppliedAt + 3_000;
          let damagedRconHealth: number | null = null;
          let damagedHealth: number | null = null;
          let damagedEvidence: Evidence | undefined;
          while (Date.now() < damageReadbackDeadlineAt) {
            const timeoutMs = Math.max(
              1,
              Math.min(500, damageReadbackDeadlineAt - Date.now()),
            );
            try {
              damagedRconHealth = await rconEntityHealth(
                rcon,
                context.botName,
                timeoutMs,
              );
            } catch {
              damagedRconHealth = null;
            }
            try {
              damagedEvidence = await collect(context.runtime.app);
              const observedHealth = damagedEvidence.game?.health;
              damagedHealth =
                typeof observedHealth === "number" &&
                Number.isFinite(observedHealth)
                  ? observedHealth
                  : null;
            } catch {
              damagedEvidence = undefined;
              damagedHealth = null;
            }
            if (
              damagedRconHealth !== null &&
              damagedRconHealth > 0 &&
              damagedRconHealth < expectedHealth &&
              damagedRconHealth <= 6 &&
              damagedHealth !== null &&
              damagedHealth > 0 &&
              damagedHealth < expectedHealth &&
              damagedHealth <= 6
            )
              break;
            const remainingMs = damageReadbackDeadlineAt - Date.now();
            if (remainingMs <= 0) break;
            await waitMs(Math.min(100, remainingMs));
          }
          if (
            damagedRconHealth === null ||
            damagedRconHealth >= expectedHealth ||
            damagedRconHealth <= 0 ||
            damagedRconHealth > 6 ||
            damagedHealth === null ||
            damagedHealth >= expectedHealth ||
            damagedHealth <= 0 ||
            damagedHealth > 6 ||
            damagedEvidence === undefined
          ) {
            state.damageResponseDamageHealthReadback = {
              bodyHealth: damagedHealth,
              rconHealth: damagedRconHealth,
            };
            incomplete("DAMAGE_RESPONSE_DAMAGE_NOT_CONFIRMED_BY_BOTH_ORACLES");
          }
          const priorJudgments = new Set(
            before.recentJudgments.map(
              (judgment) =>
                `${judgment.revision ?? ""}:${judgment.decidedAt ?? ""}`,
            ),
          );

          const hasJudgmentLinkedOutcome = (player: PlayerEvidence): boolean =>
            damageResponseHasJudgmentLinkedOutcome(
              before.recentOutcomes,
              player.recentJudgments,
              player.recentOutcomes,
              priorJudgments,
              damageAppliedAt,
            );
          const hasFreshPurposeCommit = (player: PlayerEvidence): boolean =>
            (player.recentAgentActivity ?? []).some(
              (activity) =>
                activity.role === "purpose" &&
                !priorActivity.has(
                  `${activity.runSequence}:${activity.round}`,
                ) &&
                activity.toolCalls.some(
                  (toolCall) =>
                    toolCall.name === "commit_action_decision" &&
                    toolCall.resultClass === "ok",
                ),
            );

          const decided = await waitForPlayer(
            context,
            damageResponseObservationTimeoutMs(context.caseDeadlineAt),
            (player) =>
              hasFreshPurposeCommit(player) && hasJudgmentLinkedOutcome(player),
          ).catch(async (error: unknown) => {
            if (
              error instanceof HarnessError &&
              (error.code === "RUN_LLM_BUDGET_EXCEEDED" ||
                error.code === "CASE_LLM_BUDGET_EXCEEDED")
            ) {
              try {
                const player = playerOf(await collect(context.runtime.app));
                state.damageResponseFailureDiagnostic = {
                  damageResponseFreshPurposeCommitObserved:
                    hasFreshPurposeCommit(player),
                  damageResponsePostDamageJudgment:
                    classifyDamageResponsePostDamageJudgment(
                      player.recentJudgments,
                      priorJudgments,
                      damageAppliedAt,
                    ),
                  damageResponseLinkedSuccessfulOutcomeObserved:
                    hasJudgmentLinkedOutcome(player),
                };
              } catch {
                // Preserve the budget failure if diagnostic collection fails.
              }
            }
            throw error;
          });
          if (!hasJudgmentLinkedOutcome(decided))
            incomplete("DAMAGE_RESPONSE_BODY_OUTCOME_NOT_CONFIRMED");
          const finalDamageHealth = await rconEntityHealth(
            rcon,
            context.botName,
          );
          const finalDamageBodyHealth = (await collect(context.runtime.app))
            .game?.health;
          if (
            finalDamageHealth <= 0 ||
            finalDamageBodyHealth === undefined ||
            finalDamageBodyHealth <= 0
          )
            fail("DAMAGE_RESPONSE_LETHAL_OUTCOME");
          return {
            baselineHealthBodyAndRconConfirmed: true,
            boundedNonlethalDamageConfirmedByBodyAndRcon: true,
            purposeCommitActionDecisionObserved: true,
            successfulBodyOutcomeObserved: true,
            healthRemainedNonlethal: true,
          };
        } catch (error) {
          primaryFailureCode =
            error instanceof HarnessError ? error.code : "CASE_EXECUTION_ERROR";
          state.failureCode ??= primaryFailureCode;
          throw error;
        } finally {
          let cleanupConfirmed = true;
          if (damageMayNeedCleanup) {
            try {
              effectsMayNeedCleanup = true;
              await rcon.command(
                `effect give ${context.botName} minecraft:instant_health 1 4 true`,
              );
              const restoreDeadline = Date.now() + 5_000;
              let healthRestored = false;
              while (Date.now() < restoreDeadline) {
                if (
                  (await rconEntityHealth(rcon, context.botName)) ===
                  expectedHealth
                ) {
                  healthRestored = true;
                  break;
                }
                await waitMs(100);
              }
              if (!healthRestored) cleanupConfirmed = false;
            } catch {
              cleanupConfirmed = false;
            }
          }
          if (effectsMayNeedCleanup) {
            try {
              await rcon.command(`effect clear ${context.botName}`);
              if (
                (await rconActiveEffectsState(rcon, context.botName)) !==
                "empty"
              )
                cleanupConfirmed = false;
            } catch {
              cleanupConfirmed = false;
            }
          }
          if (naturalRegenerationMayNeedRestore) {
            try {
              await setAndVerifyGamerule(
                rcon,
                "naturalRegeneration",
                naturalRegeneration,
              );
            } catch {
              cleanupConfirmed = false;
            }
          }
          if (positionMayNeedRestore && fixturePosition !== undefined) {
            try {
              await rcon.command(
                `tp ${context.botName} ${fixturePosition.x} ${fixturePosition.y} ${fixturePosition.z}`,
              );
              const restoredPosition = parsePosition(
                await rcon.command(`data get entity ${context.botName} Pos`),
              );
              if (
                Math.hypot(
                  restoredPosition.x - fixturePosition.x,
                  restoredPosition.y - fixturePosition.y,
                  restoredPosition.z - fixturePosition.z,
                ) > 0.2
              )
                cleanupConfirmed = false;
            } catch {
              cleanupConfirmed = false;
            }
          }
          try {
            if (damageMayNeedCleanup) {
              const restoredBody = (await collect(context.runtime.app)).game;
              if (
                (await rconEntityHealth(rcon, context.botName)) !==
                  expectedHealth ||
                restoredBody?.health !== expectedHealth
              )
                cleanupConfirmed = false;
            }
            if (
              effectsMayNeedCleanup &&
              (await rconActiveEffectsState(rcon, context.botName)) !== "empty"
            )
              cleanupConfirmed = false;
          } catch {
            cleanupConfirmed = false;
          }
          const cleanupDisposition = damageResponseCleanupDisposition(
            primaryFailureCode,
            cleanupConfirmed,
          );
          if (cleanupDisposition !== undefined) {
            state.abortRequested = true;
            state.damageResponseCleanupFailureCode ??=
              cleanupDisposition.cleanupFailureCode;
            state.failureCode ??=
              cleanupDisposition.primaryFailureCode ??
              cleanupDisposition.cleanupFailureCode;
            if (cleanupDisposition.throwCleanupFailure)
              incomplete(cleanupDisposition.cleanupFailureCode);
          }
        }
      },
    );

    const unknownResult = await recordCase(
      state,
      "unknown_composite",
      CASE_DEADLINES.unknown_composite,
      requireLiveContext(),
      async (context) => {
        state.unknownHandoffDependency = "pending";
        updateUnknownCompositeDiagnostic(state, {
          unknownHandoffDependencyBlocked: true,
        });
        const handoff = await stopAndRestartForUnknownCase(state, context);
        context = handoff.context;
        const stopGeneration = handoff.stopGeneration;
        const spawn = { x: 0.5, y: 64, z: 0.5 };
        await rcon.command(
          `tp ${state.botName} ${spawn.x} ${spawn.y} ${spawn.z}`,
        );
        const origin = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        if (
          Math.hypot(
            origin.x - spawn.x,
            origin.y - spawn.y,
            origin.z - spawn.z,
          ) > 1.5
        ) {
          incomplete("UNKNOWN_FIXTURE_SPAWN_RESET_FAILED");
        }
        updateUnknownCompositeDiagnostic(state, {
          unknownWallFixtureConfirmed: false,
          unknownDryGroundFixtureConfirmed: false,
        });
        if (state.targetCase === "unknown_composite") {
          await removeHiddenContainerFixture(rcon, origin, {
            chest: fixturePoint(origin, 6, 0),
          });
        }
        await configureUnknownFixture(rcon, origin, state.botName);
        updateUnknownCompositeDiagnostic(state, {
          unknownWallFixtureConfirmed: true,
          unknownDryGroundFixtureConfirmed: true,
          unknownSideRouteConfirmed: true,
          unknownInitialViewCorridorConfirmed: true,
          unknownSideViewCorridorConfirmed: true,
        });
        await prepareUnknownObservationClients(
          rcon,
          context.ownerName,
          state.guestName,
        );
        const fixtureRegion = regionAround(origin);
        await captureReproducibleUnknownWorldBaseline({
          forceLoadSource: () =>
            forceLoadRegion(rcon, fixtureRegion, incomplete),
          forceLoadDestination: () =>
            forceLoadRegion(
              rcon,
              destinationRegion(fixtureRegion, REGION_BASELINE),
              incomplete,
            ),
          withFrozenTicks: (operation) =>
            withFrozenTicks(rcon, operation, incomplete),
          waitForTickWindow: () => delay(500),
          captureBaseline: () =>
            cloneBaseline(rcon, fixtureRegion, REGION_BASELINE, incomplete),
          compareBaseline: () =>
            regionsEqual(rcon, fixtureRegion, REGION_BASELINE, incomplete),
          fail: incomplete,
        });
        const beforeWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          fixtureRegion,
        );
        const beforeFixturePlayer = playerOf(
          await collect(context.runtime.app),
        );
        if (
          !beforeFixturePlayer.stopped ||
          beforeFixturePlayer.stopGeneration !== stopGeneration ||
          isOperationActive(beforeFixturePlayer)
        ) {
          incomplete("UNKNOWN_FIXTURE_NOT_PREPARED_WHILE_STOPPED");
        }
        const target = unknownFixtureTarget(beforeWorld.position);
        const targetInitiallyPresent = await isBlock(rcon, target, "blue_wool");
        if (!targetInitiallyPresent) fail("UNKNOWN_TARGET_FIXTURE_INVALID");
        await rcon.command(
          `tp ${state.botName} ${origin.x} ${origin.y} ${origin.z} ${UNKNOWN_FIXTURE_YAW} ${UNKNOWN_FIXTURE_PITCH}`,
        );
        updateUnknownCompositeDiagnostic(state, {
          unknownFixtureFacingCommanded: true,
          unknownFixtureFacingReadbackAvailable: false,
          unknownFixtureFacingConfirmed: false,
          unknownPreTaskObservationStatus: "unknown",
        });
        const rotation = parseEntityRotation(
          await rcon.command(`data get entity ${state.botName} Rotation`),
        );
        if (rotation === undefined) {
          incomplete("UNKNOWN_FIXTURE_ROTATION_READBACK_UNAVAILABLE");
        }
        const fixtureFacingConfirmed = isFacingUnknownFixture(rotation);
        updateUnknownCompositeDiagnostic(state, {
          unknownFixtureFacingReadbackAvailable: true,
          unknownFixtureFacingConfirmed: fixtureFacingConfirmed,
        });
        if (!fixtureFacingConfirmed)
          incomplete("UNKNOWN_FIXTURE_FACING_NOT_CONFIRMED");
        const facingConfirmedAt = Date.now();
        const preTaskObservation = playerOf(
          await collect(context.runtime.app),
        ).lastObservation;
        const preTaskObservedAt =
          preTaskObservation?.observedAt === undefined
            ? Number.NaN
            : Date.parse(preTaskObservation.observedAt);
        const freshPreTaskObservation =
          Number.isFinite(preTaskObservedAt) &&
          preTaskObservedAt > facingConfirmedAt;
        const preTaskVisibility = freshPreTaskObservation
          ? classifyUnknownTaskVisibility(preTaskObservation?.visibleBlockNames)
          : { status: "unknown" as const };
        updateUnknownCompositeDiagnostic(state, {
          unknownPreTaskObservationStatus: preTaskVisibility.status,
          ...(preTaskVisibility.targetBlockVisible === undefined
            ? {}
            : {
                unknownPreTaskTargetBlockVisible:
                  preTaskVisibility.targetBlockVisible,
                unknownPreTaskWallMaterialVisible:
                  preTaskVisibility.wallMaterialVisible === true,
              }),
        });
        updateUnknownCompositeDiagnostic(state, {
          unknownHandoffFixturePreparedWhileStopped: true,
        });
        let serverGoalObserved = false;
        let failureSnapshot: WorldSnapshot | undefined;
        let recoverySnapshot: WorldSnapshot | undefined;
        let recoverySnapshotOperationId: string | undefined;
        let failureOperationId: string | undefined;
        let postFailureObservationSeen = false;
        let postFailureJudgmentSeen = false;
        let lastOracleCheckAt = 0;
        const unknownTaskSentAt: { value: number | undefined } = {
          value: undefined,
        };
        let unknownPickupConfirmedAt: number | undefined;
        let unknownPostPickupSampleCount = 0;
        let unknownPostPickupStartingSpawnDistance: number | undefined;
        let unknownPostPickupNearestSpawnDistance: number | undefined;
        let unknownPostPickupMovedCloserToSpawn = false;
        let unknownPostPickupRuntimeSampleMissing = false;
        let unknownPostPickupLastMoveOperationKind:
          UnknownMoveOperationKind | undefined;
        let unknownProgressAggregate: UnknownTaskProgressAggregate | undefined;
        let unknownPostTaskSampleFailureSeen = false;
        const attemptedObstacleOperationIds = new Set<string>();
        let controlledObstacleRestoredAt: number | undefined;
        updateUnknownCompositeDiagnostic(state, {
          unknownTargetInitiallyPresent: true,
          unknownControlledObstacleStatus: "not_attempted",
          unknownOracleReadCount: 0,
        });
        const sampleUnknownOracle = async (): Promise<void> => {
          const currentCount =
            (state.unknownCompositeDiagnostic?.unknownOracleReadCount as
              number | undefined) ?? 0;
          try {
            const targetCleared = !(await isBlock(rcon, target, "blue_wool"));
            const inventory = await rcon.command(
              `data get entity ${state.botName} Inventory`,
            );
            const position = parsePosition(
              await rcon.command(`data get entity ${state.botName} Pos`),
            );
            const currentWorld = await readWorldSnapshot(
              rcon,
              state.botName,
              fixtureRegion,
            );
            const sampledAt = Date.now();
            const nearTarget =
              Math.hypot(
                position.x - target.x,
                position.y - target.y,
                position.z - target.z,
              ) < 2;
            const itemReturned = /minecraft:blue_wool/iu.test(inventory);
            const returnedToSpawn =
              Math.hypot(
                position.x - spawn.x,
                position.y - spawn.y,
                position.z - spawn.z,
              ) <= 4.5;
            serverGoalObserved =
              targetCleared && itemReturned && returnedToSpawn;
            updateUnknownCompositeDiagnostic(state, {
              unknownOracleChecked: true,
              unknownOracleReadStatus: "available",
              unknownOracleReadCount: currentCount + 1,
              unknownTargetCleared: targetCleared,
              unknownNearTargetServerSampleSeen:
                state.unknownCompositeDiagnostic
                  ?.unknownNearTargetServerSampleSeen === true ||
                (unknownTaskSentAt.value !== undefined && nearTarget),
              unknownItemReturned: itemReturned,
              unknownReturnedToSpawn: returnedToSpawn,
              unknownServerProgressObserved:
                observedWorldProgress(beforeWorld, currentWorld) !== undefined,
            });
            let sampledPlayer: PlayerEvidence | undefined;
            let runtimeSampleAttempted = false;
            if (unknownTaskSentAt.value !== undefined && nearTarget) {
              try {
                runtimeSampleAttempted = true;
                sampledPlayer = playerOf(await collect(context.runtime.app));
                const observation = sampledPlayer.lastObservation;
                const observationAt = Date.parse(observation?.observedAt ?? "");
                const fresh =
                  Number.isFinite(observationAt) &&
                  observationAt >= unknownTaskSentAt.value &&
                  sampledAt - observationAt <= 2_000;
                updateUnknownCompositeDiagnostic(state, {
                  unknownNearTargetFreshBodyObservationSeen:
                    state.unknownCompositeDiagnostic
                      ?.unknownNearTargetFreshBodyObservationSeen === true ||
                    fresh,
                  unknownNearTargetVisibleInBodyObservation:
                    state.unknownCompositeDiagnostic
                      ?.unknownNearTargetVisibleInBodyObservation === true ||
                    (fresh &&
                      observation?.visibleBlockNames?.includes("blue_wool") ===
                        true),
                });
              } catch {
                // A player snapshot failure does not erase the RCON oracle.
              }
            }
            if (
              itemReturned &&
              unknownTaskSentAt.value !== undefined &&
              unknownPostPickupSampleCount < UNKNOWN_POST_PICKUP_SAMPLE_LIMIT
            ) {
              unknownPickupConfirmedAt ??= sampledAt;
              const spawnDistance = Math.hypot(
                currentWorld.position.x - spawn.x,
                currentWorld.position.y - spawn.y,
                currentWorld.position.z - spawn.z,
              );
              const spawnDistanceBucket = unknownDistanceBucket(spawnDistance);
              if (spawnDistanceBucket !== undefined) {
                unknownPostPickupStartingSpawnDistance ??= spawnDistance;
                unknownPostPickupNearestSpawnDistance = Math.min(
                  unknownPostPickupNearestSpawnDistance ?? spawnDistance,
                  spawnDistance,
                );
                unknownPostPickupMovedCloserToSpawn ||=
                  unknownDistanceImprovedByMinimum(
                    unknownPostPickupStartingSpawnDistance,
                    spawnDistance,
                  );
                if (!runtimeSampleAttempted) {
                  try {
                    runtimeSampleAttempted = true;
                    sampledPlayer = playerOf(
                      await collect(context.runtime.app),
                    );
                  } catch {
                    unknownPostPickupRuntimeSampleMissing = true;
                  }
                }
                if (sampledPlayer === undefined) {
                  unknownPostPickupRuntimeSampleMissing = true;
                } else {
                  const moveKind = lastUnknownMoveOperationKind(
                    sampledPlayer,
                    unknownPickupConfirmedAt,
                  );
                  if (moveKind !== undefined) {
                    unknownPostPickupLastMoveOperationKind = moveKind;
                  }
                }
                unknownPostPickupSampleCount += 1;
                const startingSpawnDistanceBucket = unknownDistanceBucket(
                  unknownPostPickupStartingSpawnDistance,
                );
                const nearestSpawnDistanceBucket = unknownDistanceBucket(
                  unknownPostPickupNearestSpawnDistance,
                );
                updateUnknownCompositeDiagnostic(state, {
                  unknownPostPickupProgressSampleStatus:
                    unknownPostPickupRuntimeSampleMissing
                      ? "partial"
                      : unknownPostPickupSampleCount >=
                          UNKNOWN_POST_PICKUP_SAMPLE_LIMIT
                        ? "capped"
                        : "available",
                  unknownPostPickupProgressSampleCount:
                    unknownPostPickupSampleCount,
                  unknownPostPickupRuntimeSampleMissing,
                  ...(startingSpawnDistanceBucket === undefined
                    ? {}
                    : {
                        unknownPostPickupStartingSpawnDistanceBucket:
                          startingSpawnDistanceBucket,
                      }),
                  unknownPostPickupCurrentSpawnDistanceBucket:
                    spawnDistanceBucket,
                  ...(nearestSpawnDistanceBucket === undefined
                    ? {}
                    : {
                        unknownPostPickupNearestSpawnDistanceBucket:
                          nearestSpawnDistanceBucket,
                      }),
                  unknownPostPickupMovedCloserToSpawn,
                  ...(unknownPostPickupLastMoveOperationKind === undefined
                    ? {}
                    : {
                        unknownPostPickupLastMoveOperationKind,
                      }),
                });
              }
            }
            if (
              unknownTaskSentAt.value !== undefined &&
              Number.isFinite(unknownTaskSentAt.value) &&
              sampledAt > unknownTaskSentAt.value
            ) {
              unknownProgressAggregate = recordUnknownTaskProgressSample(
                unknownProgressAggregate,
                {
                  taskSentAt: unknownTaskSentAt.value,
                  sampledAt,
                  startingPosition: beforeWorld.position,
                  targetPosition: target,
                  currentPosition: currentWorld.position,
                  beforeWorld,
                  currentWorld,
                },
              );
              if (unknownProgressAggregate !== undefined) {
                updateUnknownCompositeDiagnostic(state, {
                  unknownPostTaskProgressSampleStatus:
                    unknownPostTaskSampleFailureSeen
                      ? "partial"
                      : unknownProgressAggregate.sampleLimitReached
                        ? "capped"
                        : "available",
                  unknownPostTaskProgressSampleCount:
                    unknownProgressAggregate.sampleCount,
                  unknownPostTaskProgressSampleLimitReached:
                    unknownProgressAggregate.sampleLimitReached,
                  unknownPostTaskMaxDisplacementBucket:
                    unknownProgressAggregate.maxDisplacementBucket,
                  unknownPostTaskNearestTargetDistanceBucket:
                    unknownProgressAggregate.nearestTargetDistanceBucket,
                  unknownPostTaskMovedCloserToTarget:
                    unknownProgressAggregate.movedCloserToTarget,
                  unknownPostTaskBlocksProgressObserved:
                    unknownProgressAggregate.blocksObserved,
                  unknownPostTaskPositionProgressObserved:
                    unknownProgressAggregate.positionObserved,
                  unknownPostTaskInventoryProgressObserved:
                    unknownProgressAggregate.inventoryObserved,
                });
              }
            }
          } catch {
            serverGoalObserved = false;
            updateUnknownCompositeDiagnostic(state, {
              unknownOracleReadStatus: "incomplete",
              unknownOracleReadCount: currentCount + 1,
              ...(unknownTaskSentAt.value === undefined ||
              !Number.isFinite(unknownTaskSentAt.value)
                ? {}
                : {
                    unknownPostTaskProgressSampleStatus:
                      unknownProgressAggregate === undefined
                        ? "unavailable"
                        : "partial",
                  }),
              ...(unknownPickupConfirmedAt === undefined
                ? {}
                : {
                    unknownPostPickupProgressSampleStatus: "partial",
                    unknownPostPickupRuntimeSampleMissing: true,
                  }),
            });
            if (
              unknownTaskSentAt.value !== undefined &&
              Number.isFinite(unknownTaskSentAt.value)
            ) {
              unknownPostTaskSampleFailureSeen = true;
            }
          }
        };
        await sampleUnknownOracle();
        const resumed = await resumeAfterUnknownFixture(
          state,
          context,
          stopGeneration,
        );
        if (resumed.stopped)
          incomplete("UNKNOWN_AUTONOMY_RESUME_NOT_CONFIRMED");
        const beforePlayer = playerOf(await collect(context.runtime.app));
        if (
          beforePlayer.stopped ||
          beforePlayer.stopGeneration <= stopGeneration
        )
          incomplete("UNKNOWN_AUTONOMY_RESUME_NOT_CONFIRMED");
        state.unknownHandoffDependency = "resumed";
        updateUnknownCompositeDiagnostic(state, {
          unknownHandoffDependencyBlocked: false,
        });
        const beforeRevision = beforePlayer.actionRevision;
        updateUnknownCompositeDiagnostic(state, {
          unknownHandoffActiveAfterResume: isOperationActive(beforePlayer),
        });
        const unknownObservationBudgetMs =
          context.caseDeadlineAt - Date.now() - 60_000;
        if (unknownObservationBudgetMs < 1)
          incomplete("UNKNOWN_CASE_BUDGET_EXHAUSTED_AT_TASK_START");
        sendChat(
          context.owner,
          "近くにある青い羊毛を採集して、この依頼を受けた地点まで持ち帰ってください。所持品は空です。方法は自分で考え、最初の試みが失敗したら状況を見直して別の手段を選んでください。",
        );
        unknownTaskSentAt.value = Date.now();
        updateUnknownCompositeDiagnostic(state, {
          unknownHandoffTaskSent: true,
          unknownTaskObservationStatus: "unknown",
          unknownPostTaskProgressSampleStatus: "not_sampled",
          unknownPostPickupProgressSampleStatus: "not_sampled",
        });
        let taskObservationCaptured = false;
        const afterPlayer = await waitForPlayer(
          context,
          unknownObservationBudgetMs,
          async (player) => {
            let currentPlayer = player;
            const taskObservation = currentPlayer.lastObservation;
            const taskObservedAt =
              taskObservation?.observedAt === undefined
                ? Number.NaN
                : Date.parse(taskObservation.observedAt);
            const taskSentAt = unknownTaskSentAt.value;
            if (
              !taskObservationCaptured &&
              taskSentAt !== undefined &&
              Number.isFinite(taskSentAt) &&
              Number.isFinite(taskObservedAt) &&
              taskObservedAt > taskSentAt
            ) {
              taskObservationCaptured = true;
              const visibility = classifyUnknownTaskVisibility(
                taskObservation?.visibleBlockNames,
              );
              updateUnknownCompositeDiagnostic(state, {
                unknownTaskObservationStatus: visibility.status,
                ...(visibility.targetBlockVisible === undefined
                  ? {}
                  : {
                      unknownTaskTargetBlockVisible:
                        visibility.targetBlockVisible,
                      unknownTaskWallMaterialVisible:
                        visibility.wallMaterialVisible === true,
                    }),
              });
            }
            const currentOutcomes = newOutcomes(beforePlayer, currentPlayer);
            const naturalFailureAlreadySeen = currentOutcomes.some(
              (outcome) => outcome.status === "failed",
            );
            const activeOperation = currentPlayer.activeOperation;
            if (
              attemptedObstacleOperationIds.size < 3 &&
              !naturalFailureAlreadySeen &&
              (activeOperation?.kind === "move_to" ||
                activeOperation?.kind === "move_relative") &&
              typeof activeOperation.bodyStartedAt === "string" &&
              activeOperation.operationId.length > 0 &&
              !attemptedObstacleOperationIds.has(activeOperation.operationId)
            ) {
              attemptedObstacleOperationIds.add(activeOperation.operationId);
              updateUnknownCompositeDiagnostic(state, {
                unknownControlledObstacleAttemptCount:
                  attemptedObstacleOperationIds.size,
              });
              const remainingCaseMs = context.caseDeadlineAt - Date.now();
              if (remainingCaseMs >= 180_000) {
                const operationId = activeOperation.operationId;
                updateUnknownCompositeDiagnostic(state, {
                  unknownControlledObstacleStatus: "not_attempted",
                  unknownControlledObstacleNewOperationFailed: false,
                  unknownObstacleTickFreezeConfirmed: false,
                  unknownObstacleTickUnfreezeConfirmed: false,
                });
                const obstacleRcon = boundedOracleRcon(rcon);
                const standingReadiness =
                  await waitForRecoveryObstacleReadiness({
                    operationStillActive: async () => {
                      const freshPlayer = playerOf(
                        await collect(context.runtime.app),
                      );
                      return isSameStartedTravelOperation(
                        freshPlayer.activeOperation,
                        operationId,
                      );
                    },
                    probeStandingSpace: async (remainingMs) => {
                      const probeStartedAt = Date.now();
                      const timeoutMs = Math.max(
                        1,
                        Math.min(
                          UNKNOWN_OBSTACLE_READINESS_RCON_TIMEOUT_MS,
                          remainingMs,
                        ),
                      );
                      let position: Position;
                      try {
                        position = parsePosition(
                          await obstacleRcon.command(
                            `data get entity ${state.botName} Pos`,
                            timeoutMs,
                          ),
                        );
                      } catch {
                        return { status: "unavailable" as const };
                      }
                      const plan = recoveryCagePlan(position, {
                        x: 2_000,
                        y: 64,
                        z: 2_000,
                      });
                      const remainingSpaceProbeMs =
                        remainingMs - (Date.now() - probeStartedAt);
                      if (remainingSpaceProbeMs <= 0)
                        return { status: "unavailable" as const };
                      const spaceStatus = await standingSpaceStatus(
                        obstacleRcon,
                        position,
                        plan.sourceRegion,
                        state.botName,
                        Math.max(
                          1,
                          Math.min(
                            UNKNOWN_OBSTACLE_READINESS_RCON_TIMEOUT_MS,
                            remainingSpaceProbeMs,
                          ),
                        ),
                      );
                      if (spaceStatus === "safe")
                        return { status: "ready" as const, value: plan };
                      return {
                        status:
                          spaceStatus === "unsafe" ? "unsafe" : "unavailable",
                      } as const;
                    },
                    wait: waitMs,
                    now: Date.now,
                    timeoutMs: UNKNOWN_OBSTACLE_READINESS_WINDOW_MS,
                    intervalMs: UNKNOWN_OBSTACLE_READINESS_POLL_MS,
                  });
                const obstaclePlan =
                  standingReadiness.status === "ready"
                    ? standingReadiness.value
                    : undefined;
                updateUnknownCompositeDiagnostic(state, {
                  unknownControlledObstaclePreFreezeReadiness:
                    standingReadiness.status,
                  unknownControlledObstaclePlayerInsideBefore:
                    obstaclePlan !== undefined,
                });
                if (obstaclePlan === undefined) {
                  updateUnknownCompositeDiagnostic(state, {
                    unknownControlledObstacleStatus: "skipped_ineligible",
                  });
                }
                let obstacleTickFreezeAttempted = false;
                let obstacleTickUnfreezeConfirmed = false;
                let obstacleUnfrozenAt: number | undefined;
                const unfreezeObstacleTicks = async (): Promise<void> => {
                  if (
                    !obstacleTickFreezeAttempted ||
                    obstacleTickUnfreezeConfirmed
                  )
                    return;
                  try {
                    await rcon.command("tick unfreeze");
                  } catch {
                    // Read back the state even if the command reply was lost.
                  }
                  let tickStatus: string | undefined;
                  try {
                    tickStatus = await rcon.command("tick query");
                  } catch {
                    // The fixed failure below keeps this run incomplete.
                  }
                  if (
                    tickStatus === undefined ||
                    classifyTickStatus(tickStatus) !== "running"
                  )
                    incomplete("UNKNOWN_OBSTACLE_TICK_UNFREEZE_NOT_CONFIRMED");
                  obstacleTickUnfreezeConfirmed = true;
                  obstacleUnfrozenAt = Date.now();
                  updateUnknownCompositeDiagnostic(state, {
                    unknownObstacleTickUnfreezeConfirmed: true,
                  });
                };
                try {
                  if (obstaclePlan !== undefined) {
                    obstacleTickFreezeAttempted = true;
                    await rcon.command("tick freeze");
                    if (
                      classifyTickStatus(await rcon.command("tick query")) !==
                      "frozen"
                    )
                      incomplete("UNKNOWN_OBSTACLE_TICK_FREEZE_NOT_CONFIRMED");
                    updateUnknownCompositeDiagnostic(state, {
                      unknownObstacleTickFreezeConfirmed: true,
                    });
                    const initialPosition = parsePosition(
                      await rcon.command(
                        `data get entity ${state.botName} Pos`,
                      ),
                    );
                    updateUnknownCompositeDiagnostic(state, {
                      unknownControlledObstaclePlayerInsideBefore:
                        positionStandingCenteredInCage(
                          initialPosition,
                          obstaclePlan.sourceRegion,
                        ),
                    });
                    const obstacleResult = await withRestorableObstacle(
                      obstacleRcon,
                      obstaclePlan,
                      {
                        restoreInStableWorld: (restore) =>
                          withFrozenTicks(obstacleRcon, restore, incomplete),
                        onRestoreFailure: (stage) =>
                          updateUnknownCompositeDiagnostic(state, {
                            unknownControlledObstacleRestoreFailureStage: stage,
                          }),
                        eligible: async () => {
                          const eligibilityChecks =
                            (state.unknownCompositeDiagnostic
                              ?.unknownControlledObstacleEligibilityChecks as
                              number | undefined) ?? 0;
                          const freshPlayer = playerOf(
                            await collect(context.runtime.app),
                          );
                          const active = freshPlayer.activeOperation;
                          const sameStartedOperation =
                            isSameStartedTravelOperation(active, operationId);
                          const position = parsePosition(
                            await obstacleRcon.command(
                              `data get entity ${state.botName} Pos`,
                              UNKNOWN_OBSTACLE_READINESS_RCON_TIMEOUT_MS,
                            ),
                          );
                          const inside = positionStandingCenteredInCage(
                            position,
                            obstaclePlan.sourceRegion,
                          );
                          const spaceStatus = await standingSpaceStatus(
                            obstacleRcon,
                            position,
                            obstaclePlan.sourceRegion,
                            state.botName,
                            UNKNOWN_OBSTACLE_READINESS_RCON_TIMEOUT_MS,
                          );
                          const standingSpaceConfirmed = spaceStatus === "safe";
                          const otherEntitiesClear = await nearbyEntitiesClear(
                            obstacleRcon,
                            position,
                            state.botName,
                          );
                          const postFreezeReadiness: UnknownObstacleReadinessStatus =
                            !sameStartedOperation
                              ? "operation_changed"
                              : spaceStatus === "unavailable"
                                ? "oracle_unavailable"
                                : !standingSpaceConfirmed
                                  ? "standing_space_unavailable"
                                  : otherEntitiesClear
                                    ? "ready"
                                    : "other_entities_not_clear";
                          updateUnknownCompositeDiagnostic(state, {
                            unknownControlledObstacleEligibilityChecks:
                              eligibilityChecks + 1,
                            unknownControlledObstacleSameOperationConfirmed:
                              sameStartedOperation,
                            unknownControlledObstaclePlayerInsideBefore: inside,
                            unknownControlledObstacleStandingSpaceConfirmed:
                              standingSpaceConfirmed,
                            unknownControlledObstacleOtherEntitiesClear:
                              otherEntitiesClear,
                            unknownControlledObstaclePostFreezeReadiness:
                              postFreezeReadiness,
                          });
                          return postFreezeReadiness === "ready";
                        },
                        observeWhileApplied: async () => {
                          const playerBeforeUnfreeze = playerOf(
                            await collect(context.runtime.app),
                          );
                          const activeBeforeUnfreeze =
                            playerBeforeUnfreeze.activeOperation;
                          const knownOutcomeIdsBeforeUnfreeze = new Set(
                            playerBeforeUnfreeze.recentOutcomes.map(
                              (outcome) => outcome.operationId,
                            ),
                          );
                          knownOutcomeIdsBeforeUnfreeze.add(operationId);
                          if (activeBeforeUnfreeze !== undefined)
                            knownOutcomeIdsBeforeUnfreeze.add(
                              activeBeforeUnfreeze.operationId,
                            );
                          const sameOperationBeforeUnfreeze =
                            activeBeforeUnfreeze?.operationId === operationId &&
                            typeof activeBeforeUnfreeze.bodyStartedAt ===
                              "string";
                          updateUnknownCompositeDiagnostic(state, {
                            unknownObstacleOperationActiveBeforeUnfreeze:
                              sameOperationBeforeUnfreeze,
                          });
                          await unfreezeObstacleTicks();
                          const unfrozenAt = obstacleUnfrozenAt;
                          if (unfrozenAt === undefined)
                            incomplete(
                              "UNKNOWN_OBSTACLE_TICK_UNFREEZE_NOT_CONFIRMED",
                            );
                          let lastSampleAt = 0;
                          const newFailureAfterUnfreeze = (
                            outcome: PlayerEvidence["recentOutcomes"][number],
                          ): boolean =>
                            isNewFailureAfterUnfreeze(
                              outcome,
                              knownOutcomeIdsBeforeUnfreeze,
                              unfrozenAt,
                            );
                          const failurePlayer = await observeForPlayer(
                            context,
                            30_000,
                            async (candidate) => {
                              if (Date.now() - lastSampleAt >= 2_000) {
                                await sampleUnknownOracle();
                                lastSampleAt = Date.now();
                                lastOracleCheckAt = lastSampleAt;
                              }
                              return candidate.recentOutcomes.some(
                                newFailureAfterUnfreeze,
                              );
                            },
                          );
                          const newOperationFailed =
                            failurePlayer?.recentOutcomes.some(
                              newFailureAfterUnfreeze,
                            ) === true;
                          if (!newOperationFailed)
                            return { failedInPlace: false };
                          const failurePosition = parsePosition(
                            await rcon.command(
                              `data get entity ${state.botName} Pos`,
                            ),
                          );
                          const playerInsideAtFailure = positionInsideCage(
                            failurePosition,
                            obstaclePlan.sourceRegion,
                          );
                          const confirmed = playerInsideAtFailure;
                          updateUnknownCompositeDiagnostic(state, {
                            unknownControlledObstacleNewOperationFailed:
                              newOperationFailed,
                            unknownControlledObstaclePlayerInsideAtFailure:
                              playerInsideAtFailure,
                            ...(confirmed
                              ? {
                                  unknownFailureObserved: true,
                                  unknownFailureSource: "controlled_obstacle",
                                }
                              : {}),
                          });
                          return { failedInPlace: confirmed };
                        },
                        onProgress: (progress) => {
                          if (progress.phase === "restore_verified")
                            controlledObstacleRestoredAt = Date.now();
                          updateUnknownCompositeDiagnostic(state, {
                            unknownControlledObstaclePhase: progress.phase,
                            unknownControlledObstaclePlacementCount:
                              progress.placementCount,
                            unknownControlledObstacleConfirmedPlacementCount:
                              progress.confirmedPlacementCount,
                            ...(progress.phase === "restore_verified"
                              ? { unknownControlledObstacleRestored: true }
                              : {}),
                          });
                        },
                      },
                      incomplete,
                    );
                    if (obstacleResult.status === "skipped") {
                      updateUnknownCompositeDiagnostic(state, {
                        unknownControlledObstacleStatus: "skipped_ineligible",
                      });
                    } else {
                      const failureObservedInPlace =
                        obstacleResult.observation.failedInPlace;
                      controlledObstacleRestoredAt ??= Date.now();
                      updateUnknownCompositeDiagnostic(state, {
                        unknownControlledObstacleStatus: failureObservedInPlace
                          ? "applied_failure_observed"
                          : "applied_without_failure",
                        unknownControlledObstacleRestored:
                          obstacleResult.restorationVerified,
                      });
                    }
                  }
                } catch (error) {
                  const code = error instanceof HarnessError ? error.code : "";
                  const obstacleRestored =
                    state.unknownCompositeDiagnostic
                      ?.unknownControlledObstacleRestored === true;
                  updateUnknownCompositeDiagnostic(state, {
                    unknownControlledObstacleStatus: code.includes("RESTORE")
                      ? "restore_failed"
                      : obstacleRestored
                        ? "injection_incomplete_restored"
                        : "incomplete_before_mutation",
                  });
                  throw error;
                } finally {
                  await unfreezeObstacleTicks();
                }
                currentPlayer = playerOf(await collect(context.runtime.app));
              } else {
                updateUnknownCompositeDiagnostic(state, {
                  unknownControlledObstacleStatus: "skipped_ineligible",
                });
              }
            }
            const outcomes = newOutcomes(beforePlayer, currentPlayer);
            const failedAt = outcomes.findIndex(
              (outcome) => outcome.status === "failed",
            );
            const failed = failedAt >= 0 ? outcomes[failedAt] : undefined;
            if (failed !== undefined) {
              updateUnknownCompositeDiagnostic(state, {
                unknownFailureObserved: true,
                unknownFailureOperationKind: safeUnknownOperationKind(
                  failed.kind,
                ),
                ...(state.unknownCompositeDiagnostic?.unknownFailureSource ===
                "controlled_obstacle"
                  ? {}
                  : { unknownFailureSource: "natural" }),
              });
            }
            if (failed !== undefined && failureSnapshot === undefined) {
              failureSnapshot = await readWorldSnapshot(
                rcon,
                state.botName,
                fixtureRegion,
              );
              failureOperationId = failed.operationId;
            }
            if (Date.now() - lastOracleCheckAt >= 2_000) {
              await sampleUnknownOracle();
              lastOracleCheckAt = Date.now();
            }
            const laterSuccesses =
              failedAt < 0
                ? []
                : outcomes
                    .slice(failedAt + 1)
                    .filter((outcome) => outcome.status === "successful");
            const recovery = laterSuccesses.at(-1);
            const failureTime =
              failed?.observedAt === undefined
                ? Number.NaN
                : Date.parse(failed.observedAt);
            const observationTime =
              currentPlayer.lastObservation?.observedAt === undefined
                ? Number.NaN
                : Date.parse(currentPlayer.lastObservation.observedAt);
            const controlledFailure =
              state.unknownCompositeDiagnostic?.unknownFailureSource ===
              "controlled_obstacle";
            const recoveryEvidenceBoundary = controlledFailure
              ? (controlledObstacleRestoredAt ?? Number.NaN)
              : failureTime;
            postFailureObservationSeen =
              Number.isFinite(failureTime) &&
              Number.isFinite(observationTime) &&
              observationTime >= failureTime;
            const postFailureObservationAfterRestore =
              controlledFailure &&
              Number.isFinite(recoveryEvidenceBoundary) &&
              Number.isFinite(observationTime) &&
              observationTime >= recoveryEvidenceBoundary;
            const recoveryTime =
              recovery?.observedAt === undefined
                ? Number.NaN
                : Date.parse(recovery.observedAt);
            const postFailureActJudgmentSeen =
              Number.isFinite(failureTime) &&
              currentPlayer.recentJudgments.some(
                (judgment) =>
                  judgment.kind === "act" &&
                  typeof judgment.decidedAt === "string" &&
                  Date.parse(judgment.decidedAt) >= recoveryEvidenceBoundary,
              );
            postFailureJudgmentSeen =
              recovery !== undefined &&
              postFailureActJudgmentSeen &&
              currentPlayer.recentJudgments.some(
                (judgment) =>
                  judgment.kind === "act" &&
                  judgment.operationKind === recovery.kind &&
                  typeof judgment.decidedAt === "string" &&
                  Number.isFinite(recoveryTime) &&
                  Date.parse(judgment.decidedAt) >= recoveryEvidenceBoundary &&
                  Date.parse(judgment.decidedAt) <= recoveryTime,
              );
            const recoveryAfterRestore =
              controlledFailure &&
              recovery !== undefined &&
              Number.isFinite(recoveryEvidenceBoundary) &&
              Number.isFinite(recoveryTime) &&
              recoveryTime >= recoveryEvidenceBoundary;
            updateUnknownCompositeDiagnostic(state, {
              unknownPostFailureObservationSeen:
                failed !== undefined && postFailureObservationSeen,
              unknownPostFailureObservationAfterRestore:
                controlledFailure && postFailureObservationAfterRestore,
              unknownPostFailureActJudgmentSeen:
                failed !== undefined && postFailureActJudgmentSeen,
              unknownPostFailureJudgmentSeen:
                failed !== undefined && postFailureJudgmentSeen,
              unknownRecoveryObserved: recovery !== undefined,
              ...(recovery === undefined
                ? {}
                : {
                    unknownRecoveryOperationKind: safeUnknownOperationKind(
                      recovery.kind,
                    ),
                  }),
              unknownRecoveryAfterRestore:
                controlledFailure && recoveryAfterRestore,
              ...(failed === undefined || recovery === undefined
                ? {}
                : {
                    unknownDistinctRecoveryOperation:
                      failed.operationId !== recovery.operationId,
                  }),
            });
            const canCheckOracle =
              failed !== undefined &&
              recovery !== undefined &&
              postFailureObservationSeen &&
              postFailureJudgmentSeen &&
              (!controlledFailure ||
                (postFailureObservationAfterRestore && recoveryAfterRestore)) &&
              !isOperationActive(currentPlayer);
            if (canCheckOracle) {
              if (recovery.operationId !== recoverySnapshotOperationId) {
                recoverySnapshot = await readWorldSnapshot(
                  rcon,
                  state.botName,
                  fixtureRegion,
                );
                recoverySnapshotOperationId = recovery.operationId;
              }
            }
            return (
              currentPlayer.actionRevision > beforeRevision &&
              canCheckOracle &&
              serverGoalObserved
            );
          },
        );
        const outcomes = newOutcomes(beforePlayer, afterPlayer);
        const afterKinds = new Set(
          outcomes
            .map((outcome) => outcome.kind)
            .filter((kind): kind is string => typeof kind === "string"),
        );
        const failedAt = outcomes.findIndex(
          (outcome) => outcome.status === "failed",
        );
        const failed = failedAt >= 0 ? outcomes[failedAt] : undefined;
        const recovery =
          failedAt < 0
            ? undefined
            : outcomes
                .slice(failedAt + 1)
                .filter((outcome) => outcome.status === "successful")
                .at(-1);
        const sameKindRecoveryChangedConditions =
          failed !== undefined &&
          recovery !== undefined &&
          failed.kind === recovery.kind &&
          failureSnapshot !== undefined &&
          recoverySnapshot !== undefined &&
          observedWorldProgress(failureSnapshot, recoverySnapshot) !==
            undefined;
        const changedApproachAfterFailure =
          failed !== undefined &&
          recovery !== undefined &&
          (failed.kind !== recovery.kind || sameKindRecoveryChangedConditions);
        const observedProgress = worldChangedFromBlock(
          beforeWorld.blockRegionChanged,
          await regionChanged(rcon, fixtureRegion),
        );
        if (!observedProgress)
          incomplete("UNKNOWN_SCENARIO_HAS_NO_SERVER_PROGRESS");
        if (afterKinds.size < 2)
          incomplete("UNKNOWN_SCENARIO_DID_NOT_COMPOSE_OPERATIONS");
        if (failedAt < 0)
          incomplete("UNKNOWN_SCENARIO_DID_NOT_EXERCISE_RECOVERY");
        if (recovery === undefined) fail("FAILED_OPERATION_WAS_NOT_RECOVERED");
        if (failureOperationId === recovery.operationId) {
          fail("RECOVERY_DID_NOT_USE_A_DISTINCT_OPERATION_ATTEMPT");
        }
        if (!changedApproachAfterFailure)
          fail("FAILED_OPERATION_WAS_NOT_REPLACED");
        updateUnknownCompositeDiagnostic(state, {
          unknownFailureObserved: true,
          unknownPostFailureObservationSeen: postFailureObservationSeen,
          unknownPostFailureJudgmentSeen: postFailureJudgmentSeen,
          unknownRecoveryObserved: true,
          unknownDistinctRecoveryOperation:
            failed.operationId !== recovery.operationId,
          unknownServerProgressObserved: observedProgress,
        });
        const finalDiagnostic = state.unknownCompositeDiagnostic ?? {};
        return {
          ...finalDiagnostic,
          distinctOperationKinds: afterKinds.size,
          serverProgressObserved: observedProgress,
          targetClearedAndItemReturned:
            finalDiagnostic.unknownTargetCleared === true &&
            finalDiagnostic.unknownItemReturned === true,
          playerReturnedToSpawn:
            finalDiagnostic.unknownReturnedToSpawn === true,
          failedAttemptObserved: true,
          postFailureObservationSeen,
          postFailureJudgmentSeen,
          recoveryOperationKindChanged: failed.kind !== recovery.kind,
          sameKindRecoveryWithObservedWorldChange:
            sameKindRecoveryChangedConditions,
          recoveryAttemptsUsedDistinctOperationIds:
            failureOperationId !== recovery.operationId,
          changedApproachAfterFailure,
        };
      },
    );

    const ownerReturnResult = await recordCase(
      state,
      "owner_return_through_door",
      CASE_DEADLINES.owner_return_through_door,
      requireLiveContext(),
      async (context) => runOwnerReturnThroughDoorCase(state, context),
    );

    const parallelResult = await recordCase(
      state,
      "parallel_dialogue_stop",
      CASE_DEADLINES.parallel_dialogue_stop,
      requireLiveContext(),
      async (context) => {
        if (
          state.targetCase === undefined &&
          state.ownerReturnProposalIdForRun !== undefined
        ) {
          const inheritedPlayer = playerOf(await collect(context.runtime.app));
          const inheritedGoal = inheritedPlayer.goals.find(
            (goal) =>
              goal.source === "owner" &&
              goal.ownerProposalId === state.ownerReturnProposalIdForRun,
          );
          const inheritedGoalStatus = ownerReturnGoalStatus(
            inheritedGoal?.status,
          );
          updateOwnerReturnDiagnostic(state, {
            ownerGoalLinked: inheritedGoal !== undefined,
            ownerGoalStatusBeforeParallel: inheritedGoalStatus,
          });
          if (
            inheritedGoalStatus !== "completed" &&
            inheritedGoalStatus !== "abandoned"
          ) {
            state.abortRequested = true;
            state.failureCode ??=
              "OWNER_RETURN_GOAL_NOT_TERMINAL_BEFORE_PARALLEL";
            incomplete(state.failureCode);
          }
        }
        const origin = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        await configureParallelFixture(
          rcon,
          origin,
          state.botName,
          state.ownerName,
        );
        const before = playerOf(await collect(context.runtime.app));
        const beforeActions = before.actionRevision;
        const beforeLlm = before.counters.llmCalls;
        const beforeResponses = context.responseQueue.length;
        const promptSentAt = Date.now();
        updateParallelDiagnostic(state, {
          parallelTaskSent: true,
          parallelActiveOperationObserved: false,
          parallelGuestNoMutationConfirmed: false,
          parallelOwnerOperationReacquired: false,
          parallelOwnerPreferenceSent: false,
          parallelOwnerRequestResolved: false,
          parallelOwnerGoalLinkedToRequest: false,
          parallelActionChangedAfterOwnerPreference: false,
          parallelOwnerApproachCheckCount: 0,
          parallelOwnerApproachReductionBucket: "none",
          parallelOwnerApproachWorldObserved: false,
          parallelOwnerApproachOperationMatchesStop: false,
          parallelStopRequested: false,
          parallelStopActiveBodyOperationObserved: false,
          parallelStopLatchConfirmed: false,
          parallelStopOperationGone: false,
          parallelStopGenerationAdvanced: false,
          parallelStopOperationReceiptConfirmed: false,
          parallelStopOperationReceiptStatus: "missing",
          parallelStopRuntimeQuietConfirmed: false,
          parallelStopRconQuietConfirmed: false,
        });
        sendChat(
          context.owner,
          "東側の遠くの目印にあるレッドストーンブロックを回収して、ここへ戻ってください。移動方法は自分で選んでください。",
        );
        const active = await waitForPlayer(
          context,
          120_000,
          (player) =>
            isOperationActive(player) &&
            typeof player.activeOperation?.bodyStartedAt === "string" &&
            player.activeOperation.operationId !==
              before.activeOperation?.operationId &&
            player.actionRevision > beforeActions,
        );
        const activeOperationId = active.activeOperation?.operationId;
        if (activeOperationId === undefined)
          incomplete("PARALLEL_TEST_NEVER_ENTERED_ACTIVE_OPERATION");
        updateParallelDiagnostic(state, {
          parallelActiveOperationObserved: true,
        });
        const beforeGuest = active;
        const guestProposalState = proposalState(active);
        sendChat(
          context.guest,
          "今の行動を停止して、所有者の依頼を取り消してください。",
        );
        await waitMs(500);
        const afterGuest = playerOf(await collect(context.runtime.app));
        if (
          afterGuest.stopped ||
          afterGuest.stopGeneration !== beforeGuest.stopGeneration ||
          proposalState(afterGuest) !== guestProposalState
        ) {
          fail("UNAUTHORIZED_PLAYER_CHANGED_RUNTIME_STATE");
        }
        updateParallelDiagnostic(state, {
          parallelGuestNoMutationConfirmed: true,
        });
        const ownerOperation =
          afterGuest.activeOperation?.operationId === activeOperationId
            ? afterGuest
            : await waitForPlayer(
                context,
                90_000,
                (player) =>
                  isOperationActive(player) &&
                  typeof player.activeOperation?.bodyStartedAt === "string" &&
                  player.activeOperation.operationId !== activeOperationId &&
                  player.actionRevision > afterGuest.actionRevision,
              );
        const ownerOperationId = ownerOperation.activeOperation?.operationId;
        if (ownerOperationId === undefined)
          incomplete("OWNER_PARALLEL_OPERATION_NOT_ACTIVE");
        updateParallelDiagnostic(state, {
          parallelOwnerOperationReacquired:
            ownerOperationId !== activeOperationId,
        });
        const botBeforeOwnerRequest = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const ownerPosition = parsePosition(
          await rcon.command(`data get entity ${state.ownerName} Pos`),
        );
        const ownerDistanceBeforeRequest = Math.hypot(
          botBeforeOwnerRequest.x - ownerPosition.x,
          botBeforeOwnerRequest.y - ownerPosition.y,
          botBeforeOwnerRequest.z - ownerPosition.z,
        );
        const liveBeforeOwnerChat = playerOf(
          await collect(context.runtime.app),
        );
        if (
          liveBeforeOwnerChat.activeOperation?.operationId !==
            ownerOperationId ||
          typeof liveBeforeOwnerChat.activeOperation.bodyStartedAt !== "string"
        )
          incomplete("OWNER_PARALLEL_OPERATION_ENDED_BEFORE_CHAT");
        const ownerReplyStart = context.responseQueue.length;
        sendChat(
          context.owner,
          "強くお願いします。レッドストーンは後回しにして、いったん私のところへ戻ってください。あなたの意見も伝え、今の目的と折り合いをつけてください。",
        );
        updateParallelDiagnostic(state, { parallelOwnerPreferenceSent: true });
        const changed = await waitForPlayer(context, 90_000, (player) =>
          ownerPreferenceWasResolved(ownerOperation, player),
        );
        const ownerOpinionReceived =
          changed.counters.llmCalls > ownerOperation.counters.llmCalls ||
          context.responseQueue.length > ownerReplyStart;
        const ownerRequestChangedGoal = ownerPreferenceWasResolved(
          ownerOperation,
          changed,
        );
        const ownerGoalLinkedToRequest = hasNewActiveOwnerProposalGoal(
          ownerOperation.proposals.map((proposal) => proposal.id),
          changed.proposals,
          changed.goals,
        );
        if (!ownerOpinionReceived || !ownerRequestChangedGoal)
          incomplete("OWNER_DIALOGUE_NOT_HANDLED_DURING_ACTION");
        updateParallelDiagnostic(state, {
          parallelOwnerOpinionReceived: ownerOpinionReceived,
          parallelOwnerRequestResolved: ownerRequestChangedGoal,
          parallelOwnerGoalLinkedToRequest: ownerGoalLinkedToRequest,
        });
        let lastOwnerApproachCheckAt = 0;
        let ownerApproachCheckCount = 0;
        let bestApproachBucket = "none";
        let ownerApproachOperationId: string | undefined;
        const ownerApproach = await observeForPlayer(
          context,
          5_000,
          async (player) => {
            const actionChanged =
              player.actionRevision > ownerOperation.actionRevision &&
              (player.activeOperation?.operationId !== ownerOperationId ||
                newOutcomes(ownerOperation, player).some(
                  (outcome) =>
                    outcome.kind === "move_to" &&
                    outcome.status === "successful",
                ));
            if (!actionChanged || Date.now() - lastOwnerApproachCheckAt < 1_500)
              return false;
            const botPosition = parsePosition(
              await rcon.command(`data get entity ${state.botName} Pos`),
            );
            const remainingDistance = Math.hypot(
              botPosition.x - ownerPosition.x,
              botPosition.y - ownerPosition.y,
              botPosition.z - ownerPosition.z,
            );
            ownerApproachCheckCount += 1;
            const reductionBucket = ownerApproachReductionBucket(
              ownerDistanceBeforeRequest,
              remainingDistance,
            );
            if (reductionBucket === "minimum_met")
              bestApproachBucket = "minimum_met";
            else if (
              reductionBucket === "under_minimum" &&
              bestApproachBucket === "none"
            ) {
              bestApproachBucket = "under_minimum";
            }
            const approachThresholdMet = reductionBucket === "minimum_met";
            if (player.activeOperation?.operationId.trim())
              ownerApproachOperationId = player.activeOperation.operationId;
            updateParallelDiagnostic(state, {
              parallelOwnerApproachCheckCount: ownerApproachCheckCount,
              parallelOwnerApproachReductionBucket: bestApproachBucket,
              parallelOwnerApproachWorldObserved: approachThresholdMet,
              parallelActionChangedAfterOwnerPreference: actionChanged,
            });
            lastOwnerApproachCheckAt = Date.now();
            return approachThresholdMet;
          },
        );
        const activeBeforeStop = playerOf(await collect(context.runtime.app));
        const capturedOperation = activeBeforeStop.activeOperation;
        const stopGenerationBefore = activeBeforeStop.stopGeneration;
        const stopGenerationUnchangedBeforeRequest =
          stopGenerationBefore === liveBeforeOwnerChat.stopGeneration;
        const stopActiveBodyOperationObserved =
          typeof capturedOperation?.bodyStartedAt === "string" &&
          Number.isFinite(Date.parse(capturedOperation.bodyStartedAt));
        const capturedOperationId =
          capturedOperation?.operationId.trim().length === 0
            ? undefined
            : capturedOperation?.operationId;
        const capturedOperationWasActive = capturedOperation !== undefined;
        updateParallelDiagnostic(state, {
          parallelStopActiveBodyOperationObserved:
            stopActiveBodyOperationObserved,
        });
        const ownerApproachOperationMatchesStop =
          ownerApproach !== undefined &&
          ownerApproachOperationId !== undefined &&
          capturedOperation?.operationId === ownerApproachOperationId;
        const ownerApproachWorldObserved = ownerApproach !== undefined;
        updateParallelDiagnostic(state, {
          parallelOwnerApproachWorldObserved: ownerApproachWorldObserved,
          parallelOwnerApproachOperationMatchesStop:
            ownerApproachOperationMatchesStop,
        });
        let capturedOperationReceiptStatus:
          PlayerOutcomeStatus | "missing" | "other" = "missing";
        let capturedOperationCancellationConfirmed = false;
        sendChat(context.owner, "今の行動を停止してください。");
        updateParallelDiagnostic(state, { parallelStopRequested: true });
        const stopped = await waitForPlayer(context, 45_000, (player) => {
          const capturedOutcome =
            capturedOperationId === undefined
              ? undefined
              : player.recentOutcomes.find(
                  (outcome) => outcome.operationId === capturedOperationId,
                );
          const safeCapturedStatus = safeOutcomeStatus(capturedOutcome?.status);
          capturedOperationReceiptStatus =
            safeCapturedStatus ??
            (capturedOutcome === undefined ? "missing" : "other");
          const cancellationConfirmed =
            capturedOperationId !== undefined &&
            hasCancellationOutcomeForOperation(
              capturedOperationId,
              player.recentOutcomes,
            );
          capturedOperationCancellationConfirmed = cancellationConfirmed;
          if (
            capturedOperationReceiptStatus !== "missing" &&
            capturedOperationReceiptStatus !== "other" &&
            !cancellationConfirmed
          ) {
            fail("PARALLEL_STOP_CAPTURED_OPERATION_NOT_INTERRUPTED");
          }
          const activeCleared = !isOperationActive(player);
          const generationAdvanced =
            player.stopGeneration > stopGenerationBefore;
          updateParallelDiagnostic(state, {
            parallelStopLatchConfirmed: player.stopped,
            parallelStopOperationGone: activeCleared,
            parallelStopGenerationAdvanced: generationAdvanced,
            parallelStopOperationReceiptConfirmed: cancellationConfirmed,
            parallelStopOperationReceiptStatus: capturedOperationReceiptStatus,
          });
          return (
            player.stopped &&
            activeCleared &&
            generationAdvanced &&
            (!capturedOperationWasActive || cancellationConfirmed)
          );
        });
        const stopGeneration = stopped.stopGeneration;
        updateParallelDiagnostic(state, { parallelStopLatchConfirmed: true });
        const revisionAtStop = stopped.actionRevision;
        const rconPositionAtStop = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const quietStartedAt = Date.now();
        const quietUntil = Math.min(
          quietStartedAt + 8_000,
          context.caseDeadlineAt,
          context.runDeadlineAt,
        );
        if (quietUntil - quietStartedAt < 8_000)
          incomplete("PARALLEL_STOP_QUIET_WINDOW_UNAVAILABLE");
        while (Date.now() < quietUntil) {
          await waitMs(Math.min(1_000, quietUntil - Date.now()));
          const sample = playerOf(await collect(context.runtime.app));
          if (
            !sample.stopped ||
            sample.stopGeneration !== stopGeneration ||
            sample.actionRevision !== revisionAtStop ||
            isOperationActive(sample)
          ) {
            fail("STOPPED_RUNTIME_RESUMED_WITHOUT_OWNER_REQUEST");
          }
          const currentPosition = parsePosition(
            await rcon.command(`data get entity ${state.botName} Pos`),
          );
          if (
            Math.hypot(
              currentPosition.x - rconPositionAtStop.x,
              currentPosition.y - rconPositionAtStop.y,
              currentPosition.z - rconPositionAtStop.z,
            ) > 0.75
          ) {
            fail("PARALLEL_STOP_RCON_MOVED_AFTER_LATCH");
          }
        }
        const quietWindowMs = Date.now() - quietStartedAt;
        if (quietWindowMs < 8_000)
          incomplete("PARALLEL_STOP_QUIET_WINDOW_INCOMPLETE");
        updateParallelDiagnostic(state, {
          parallelStopRuntimeQuietConfirmed: true,
          parallelStopRconQuietConfirmed: true,
        });
        if (!stopGenerationUnchangedBeforeRequest)
          incomplete("PARALLEL_STOP_GENERATION_CHANGED_BEFORE_REQUEST");
        if (!ownerGoalLinkedToRequest)
          incomplete("PARALLEL_OWNER_GOAL_NOT_LINKED_TO_REQUEST");
        if (!ownerApproachWorldObserved)
          incomplete("PARALLEL_OWNER_APPROACH_NOT_CONFIRMED");
        return {
          actionWasInFlight: true,
          ownerChatReceivedDuringLiveOperation:
            ownerOperation.activeOperation?.bodyStartedAt !== undefined &&
            ownerOperation.activeOperation.startedAt !== undefined &&
            Date.parse(ownerOperation.activeOperation.startedAt) >=
              promptSentAt,
          unauthorizedChatDidNotMutateState: true,
          ownerOpinionProcessedDuringAction: true,
          ownerRequestChangedOrResolvedGoal: ownerRequestChangedGoal,
          ownerGoalLinkedToRequest,
          ownerRequestWorldProgressObserved: ownerApproachWorldObserved,
          ownerApproachOperationMatchesStop,
          stopActiveBodyOperationObserved,
          stopOperationReceiptConfirmed: capturedOperationCancellationConfirmed,
          stopOperationReceiptStatus: capturedOperationReceiptStatus,
          stopGenerationAdvanced: stopGeneration > stopGenerationBefore,
          stopOperationGone: !isOperationActive(stopped),
          immediateStopObserved: true,
          noRestartAfterStop: true,
          runtimeAndRconQuietAfterStop: true,
          quietWindowMs,
          ownerReplyObserved: context.responseQueue.length > beforeResponses,
          llmCallsDuringCase: stopped.counters.llmCalls - beforeLlm,
        };
      },
    );

    if (isOwnerStopLatchTargeted(state.targetCase)) {
      await recordCase(
        state,
        "owner_stop_latch",
        CASE_DEADLINES.owner_stop_latch,
        requireLiveContext(),
        async (context) => {
          updateOwnerStopLatchDiagnostic(state, {
            ownerStopActiveBodyOperationObserved: false,
            ownerStopRequested: false,
            ownerStopLatchConfirmed: false,
            ownerStopOperationGone: false,
            ownerStopGenerationAdvanced: false,
            ownerStopOperationReceiptConfirmed: false,
            ownerStopOperationReceiptStatus: "missing",
            ownerStopQuietWindowConfirmed: false,
            ownerStopRconQuietConfirmed: false,
          });
          const before = playerOf(await collect(context.runtime.app));
          const capturedOperation = before.activeOperation;
          const capturedOperationWasActive = capturedOperation !== undefined;
          const capturedOperationId =
            capturedOperation !== undefined &&
            capturedOperation.operationId.trim().length > 0
              ? capturedOperation.operationId
              : undefined;
          const activeBodyOperationObserved =
            typeof capturedOperation?.bodyStartedAt === "string" &&
            Number.isFinite(Date.parse(capturedOperation.bodyStartedAt));
          const stopGenerationBefore = before.stopGeneration;
          updateOwnerStopLatchDiagnostic(state, {
            ownerStopActiveBodyOperationObserved: activeBodyOperationObserved,
          });
          let capturedOperationReceiptStatus:
            PlayerOutcomeStatus | "missing" | "other" = "missing";
          let capturedOperationCancellationConfirmed = false;

          sendChat(context.owner, "今の行動を停止してください。");
          updateOwnerStopLatchDiagnostic(state, {
            ownerStopRequested: true,
          });
          const stopped = await waitForPlayer(context, 45_000, (player) => {
            if (
              !player.stopped ||
              isOperationActive(player) ||
              player.stopGeneration <= stopGenerationBefore
            ) {
              return false;
            }
            const capturedOutcome =
              capturedOperationId === undefined
                ? undefined
                : player.recentOutcomes.find(
                    (outcome) => outcome.operationId === capturedOperationId,
                  );
            const outcomeStatus = capturedOutcome?.status;
            capturedOperationReceiptStatus =
              outcomeStatus === "successful" ||
              outcomeStatus === "failed" ||
              outcomeStatus === "interrupted" ||
              outcomeStatus === "cancelled" ||
              outcomeStatus === "unverified"
                ? outcomeStatus
                : outcomeStatus === undefined
                  ? "missing"
                  : "other";
            const cancellationConfirmed =
              capturedOperationId !== undefined &&
              hasCancellationOutcomeForOperation(
                capturedOperationId,
                player.recentOutcomes,
              );
            capturedOperationCancellationConfirmed = cancellationConfirmed;
            updateOwnerStopLatchDiagnostic(state, {
              ownerStopLatchConfirmed: player.stopped,
              ownerStopOperationGone: !isOperationActive(player),
              ownerStopGenerationAdvanced:
                player.stopGeneration > stopGenerationBefore,
              ownerStopOperationReceiptConfirmed: cancellationConfirmed,
              ownerStopOperationReceiptStatus: capturedOperationReceiptStatus,
            });
            if (
              capturedOperationReceiptStatus !== "missing" &&
              capturedOperationReceiptStatus !== "other" &&
              !cancellationConfirmed
            ) {
              fail("OWNER_STOP_CAPTURED_OPERATION_NOT_INTERRUPTED");
            }
            return !capturedOperationWasActive || cancellationConfirmed;
          });
          const stopGeneration = stopped.stopGeneration;
          const actionRevisionAtStop = stopped.actionRevision;
          updateOwnerStopLatchDiagnostic(state, {
            ownerStopLatchConfirmed: stopped.stopped,
            ownerStopOperationGone: !isOperationActive(stopped),
            ownerStopGenerationAdvanced: stopGeneration > stopGenerationBefore,
            ownerStopOperationReceiptConfirmed:
              capturedOperationCancellationConfirmed,
            ownerStopOperationReceiptStatus: capturedOperationReceiptStatus,
          });

          const rconPositionAtStop = parsePosition(
            await rcon.command(`data get entity ${state.botName} Pos`),
          );
          const quietStartedAt = Date.now();
          const quietUntil = Math.min(
            quietStartedAt + 8_000,
            context.caseDeadlineAt,
            context.runDeadlineAt,
          );
          if (quietUntil - quietStartedAt < 8_000)
            incomplete("OWNER_STOP_QUIET_WINDOW_UNAVAILABLE");
          while (Date.now() < quietUntil) {
            await waitMs(Math.min(1_000, quietUntil - Date.now()));
            const sample = playerOf(await collect(context.runtime.app));
            if (
              !sample.stopped ||
              sample.stopGeneration !== stopGeneration ||
              sample.actionRevision !== actionRevisionAtStop ||
              isOperationActive(sample)
            ) {
              fail("OWNER_STOP_RUNTIME_RESUMED_WITHOUT_OWNER_REQUEST");
            }
            const currentPosition = parsePosition(
              await rcon.command(`data get entity ${state.botName} Pos`),
            );
            if (
              Math.hypot(
                currentPosition.x - rconPositionAtStop.x,
                currentPosition.y - rconPositionAtStop.y,
                currentPosition.z - rconPositionAtStop.z,
              ) > 0.75
            ) {
              fail("OWNER_STOP_RCON_MOVEMENT_AFTER_LATCH");
            }
          }
          const quietWindowMs = Date.now() - quietStartedAt;
          if (quietWindowMs < 8_000)
            incomplete("OWNER_STOP_QUIET_WINDOW_INCOMPLETE");
          updateOwnerStopLatchDiagnostic(state, {
            ownerStopQuietWindowConfirmed: true,
            ownerStopRconQuietConfirmed: true,
          });
          return {
            ownerStopRequested: true,
            ownerStopActiveBodyOperationObserved: activeBodyOperationObserved,
            ownerStopLatchConfirmed: stopped.stopped,
            ownerStopOperationGone: !isOperationActive(stopped),
            ownerStopGenerationAdvanced: stopGeneration > stopGenerationBefore,
            ownerStopOperationReceiptConfirmed:
              capturedOperationCancellationConfirmed,
            ownerStopOperationReceiptStatus: capturedOperationReceiptStatus,
            ownerStopQuietWindowConfirmed: true,
            ownerStopRconQuietConfirmed: true,
            quietWindowMs,
          };
        },
      );
    }

    await recordCase(
      state,
      "integrated_result",
      CASE_DEADLINES.integrated_result,
      requireLiveContext(),
      async (context) => {
        const required = [
          contractResult,
          autonomousResult,
          unknownResult,
          observationResult,
          memoryResult,
          learningResult,
          gatherResult,
          skillQualityResult,
          exchangeResult,
          discretionResult,
          foodResult,
          ownerReturnResult,
          damageResult,
          parallelResult,
          operationSmokeResult,
        ];
        if (required.some((item) => item.status !== "pass")) {
          incomplete("INTEGRATED_ACCEPTANCE_HAS_UNVERIFIED_CASES");
        }
        const finalEvidence = await collect(context.runtime.app);
        const finalPlayer = playerOf(finalEvidence);
        if (finalPlayer.counters.llmCalls < 1 || !finalPlayer.stopped) {
          fail("INTEGRATED_RUNTIME_FINAL_STATE_INVALID");
        }
        return {
          freshServer: true,
          defaultRuntimeUsed: true,
          realOpenAiCountersObserved: finalPlayer.counters.llmCalls > 0,
          independentServerOracleUsed: true,
          allAcceptanceCasesPassed: true,
        };
      },
    );

    const finalContext = requireLiveContext();
    if (shouldCollectAfterRun(state)) {
      const finalEvidence = await collect(finalContext.runtime.app);
      state.countersFinal = countersOf(finalEvidence);
    }
    const runUsage = subtractCounters(
      finalRunCounters(state),
      state.countersInitial ?? zeroCounters(),
    );
    if (runUsage.usageUnknownCalls > 0) state.usageUncertain = true;
    state.status = results.some((result) => result.status === "fail")
      ? "fail"
      : results.some((result) => result.status === "incomplete") ||
          state.usageUncertain === true
        ? "incomplete"
        : "pass";
    if (
      runUsage.llmCalls > state.runBudget.llmCalls ||
      totalTokens(runUsage) > state.runBudget.totalTokens
    ) {
      state.status = "incomplete";
      state.failureCode ??= "RUN_LLM_BUDGET_EXCEEDED";
    } else if (Date.now() > state.runDeadlineAt) {
      state.status = "incomplete";
      state.failureCode ??= "RUN_DEADLINE_EXCEEDED";
    }
  } catch (error) {
    const status = error instanceof HarnessError ? error.status : "incomplete";
    const code =
      error instanceof HarnessError ? error.code : "HARNESS_SETUP_FAILED";
    state.status = status;
    state.failureCode ??= code;
    if (state.countersInitial !== undefined && status === "incomplete") {
      if (
        !isNoFoodContinuityProbeOnly() &&
        !ownerReturnRequestGateEnabled(state.targetCase)
      ) {
        state.usageUncertain = true;
      }
    }
  } finally {
    if (
      ownerReturnRequestGateEnabled(state.targetCase) &&
      state.ownerReturnRequestGate !== undefined
    ) {
      await settleOwnerReturnRequests(
        state,
        ownerReturnSettlementContext(state),
      );
    }
    if (liveContext !== undefined && shouldCollectAfterRun(state)) {
      try {
        state.countersFinal = countersOf(
          await collect(liveContext.runtime.app),
        );
      } catch {
        state.usageUncertain = true;
      }
    }
    await retainObservationBoundaryReplies(state);
    await cleanup(state);
    restoreNoFoodContinuityObservationProbe?.();
    restoreNoFoodContinuityObservationProbe = undefined;
    activeGameActionPlacementObservationProbe = undefined;
    restoreGameActionPlacementObservationProbe?.();
    restoreGameActionPlacementObservationProbe = undefined;
    await writeArtifact(state);
    process.stdout.write(
      `${(state.status ?? "incomplete").toUpperCase()} ${state.artifactPath}\n`,
    );
    if (state.privateDiagnosticLogPath !== undefined) {
      process.stdout.write(
        `PRIVATE_DIAGNOSTIC_LOG ${state.privateDiagnosticLogPath}\n`,
      );
    }
    if (state.observationBoundarySidecarRetained === true) {
      process.stdout.write(
        `PRIVATE_OBSERVATION_REPLIES ${observationBoundarySidecarPath(state)}\n`,
      );
    }
    if (state.gatherProgressReplySidecarRetained === true) {
      process.stdout.write(
        `PRIVATE_GATHER_PROGRESS_REPLY ${gatherProgressReplySidecarPath(state)}\n`,
      );
    }
    process.exitCode = state.status === "pass" ? 0 : 1;
  }
}

async function prepareRun(): Promise<RunState> {
  if (process.env.AI_PLAYER_E2E_CONFIRMED !== "YES")
    incomplete("E2E_CONFIRMATION_REQUIRED");
  const selectedDiagnosticProbeCount = [
    "AI_PLAYER_E2E_NAVIGATION_PROBE_ONLY",
    "AI_PLAYER_E2E_RETURN_PATH_PROBE_ONLY",
    "AI_PLAYER_E2E_PROGRESSIVE_NAVIGATION_PROBE_ONLY",
    "AI_PLAYER_E2E_NO_FOOD_FIXTURE_PROBE_ONLY",
    "AI_PLAYER_E2E_NO_FOOD_CONTINUITY_PROBE_ONLY",
    "AI_PLAYER_E2E_GATHER_MULTI_TARGET_ORACLE_PROBE_ONLY",
    "AI_PLAYER_E2E_DEATH_RECOVERY_FIXTURE_PROBE_ONLY",
  ].filter((name) => process.env[name] === "YES").length;
  if (
    selectedDiagnosticProbeCount > 1 ||
    (isDeathRecoveryFixtureProbeOnly() &&
      process.env.AI_PLAYER_E2E_OBSTACLE_RESTORE_PROBE_ONLY === "YES")
  ) {
    incomplete("E2E_PROBE_FLAGS_MUTUALLY_EXCLUSIVE");
  }
  const noGptProbeOnly = isNoGptDiagnosticProbeOnly();
  if (noGptProbeOnly) delete process.env.OPENAI_API_KEY;
  const requestedTargetCase = process.env.AI_PLAYER_E2E_TARGET_CASE?.trim();
  if (
    process.env.AI_PLAYER_E2E_GATHER_MULTI_TARGET_ORACLE_PROBE_ONLY === "YES" &&
    requestedTargetCase !== "gather_multi_target_continuity"
  ) {
    incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_TARGET_REQUIRED");
  }
  if (
    requestedTargetCase !== undefined &&
    requestedTargetCase.length > 0 &&
    !TARGETABLE_CASES.includes(requestedTargetCase as TargetableCase)
  )
    incomplete("E2E_TARGET_CASE_INVALID");
  const targetCase =
    requestedTargetCase === undefined || requestedTargetCase.length === 0
      ? undefined
      : (requestedTargetCase as TargetableCase);
  const serverJarValue = process.env.AI_PLAYER_E2E_SERVER_JAR;
  if (serverJarValue === undefined || serverJarValue.trim() === "")
    incomplete("SERVER_JAR_REQUIRED");
  const serverJar = resolve(serverJarValue);
  const eulaFile = process.env.AI_PLAYER_E2E_EULA_FILE;
  if (eulaFile === undefined || eulaFile.trim() === "")
    incomplete("EULA_FILE_REQUIRED");
  const openAiApiKey = process.env.OPENAI_API_KEY;
  if (
    !noGptProbeOnly &&
    (openAiApiKey === undefined || openAiApiKey.trim() === "")
  ) {
    incomplete("OPENAI_API_KEY_NOT_CONFIGURED");
  }
  try {
    if (!(await stat(serverJar)).isFile())
      incomplete("ISOLATED_SERVER_JAR_NOT_FOUND");
  } catch {
    incomplete("ISOLATED_SERVER_JAR_NOT_FOUND");
  }
  const eulaContents = await readFile(resolve(eulaFile), "utf8");
  if (!/^eula=true\s*$/mu.test(eulaContents))
    incomplete("EULA_FILE_NOT_ACCEPTED");
  const javaHome = resolve(process.env.JAVA_HOME ?? DEFAULT_JAVA_HOME);
  const javaPath = join(javaHome, "bin/java");
  try {
    await stat(javaPath);
  } catch {
    incomplete("JAVA_21_NOT_FOUND");
  }
  const runBudget = runBudgetFromEnvironment();
  const targetCaseBudget =
    targetCase === undefined ? undefined : CASE_BUDGETS[targetCase];
  if (
    targetCaseBudget !== undefined &&
    !runBudgetCoversCase(runBudget, targetCaseBudget)
  ) {
    incomplete("RUN_BUDGET_BELOW_TARGET_CASE_BUDGET");
  }
  const cacheDirectoryValue =
    process.env.AI_PLAYER_E2E_SERVER_CACHE_DIR?.trim();
  const serverCacheDirectory =
    cacheDirectoryValue === undefined || cacheDirectoryValue.length === 0
      ? undefined
      : resolve(cacheDirectoryValue);
  if (serverCacheDirectory !== undefined) {
    try {
      const cacheInfo = await lstat(serverCacheDirectory);
      if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) {
        incomplete("SERVER_CACHE_DIRECTORY_INVALID");
      }
    } catch {
      incomplete("SERVER_CACHE_DIRECTORY_INVALID");
    }
  }
  const serverPort = await unusedLoopbackPort();
  let rconPort = await unusedLoopbackPort();
  while (rconPort === serverPort) rconPort = await unusedLoopbackPort();
  const artifactDirectory = join(tmpdir(), "ai-player-e2e-results");
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const isolatedDirectory = await mkdtemp(join(tmpdir(), "ai-player-e2e-"));
  const serverDirectory = join(isolatedDirectory, "server");
  const databasePath = join(isolatedDirectory, "data", "companion.sqlite");
  const exchangeDirectory = join(dirname(databasePath), "mc-skills");
  const runId = randomUUID();
  try {
    await mkdir(serverDirectory, { recursive: true, mode: 0o700 });
  } catch (error) {
    await rm(isolatedDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
  const suffix = randomBytes(2).toString("hex").toUpperCase();
  const runSeed = WORLD_SEED;
  const worldFixture = "flat-platform-dry-wall-container-oak-v1";
  const startedClock = Date.now();
  const state: RunState = {
    id: runId,
    ...(targetCase === undefined ? {} : { targetCase }),
    ...(ownerReturnRequestGateEnabled(targetCase)
      ? { ownerReturnRequestGate: new AcceptedProviderRequestGate() }
      : {}),
    startedAt: new Date().toISOString(),
    seed: runSeed,
    runBudget,
    cases: [],
    startedClock,
    runDeadlineAt: startedClock + runBudget.durationMs,
    artifactPath: join(artifactDirectory, `${runId}.json`),
    isolatedDirectory,
    serverDirectory,
    privateServerLogPath: join(isolatedDirectory, "paper-server-private.log"),
    serverPort,
    rconPort,
    botName: `BotE2E${suffix}`,
    ownerName: `OwnerE2E${suffix}`,
    guestName: `GuestE2E${suffix}`,
    rconPassword: randomBytes(24).toString("hex"),
    serverJar,
    ...(serverCacheDirectory === undefined ? {} : { serverCacheDirectory }),
    javaPath,
    eulaContents,
    databasePath,
    exchangeDirectory,
    worldFixture,
    copiedServerCacheAreas: [],
    privateServerLogStream: undefined,
    responses: [],
  };
  const admission = createLlmCallAdmission(runBudget.llmCalls, (code) => {
    state.failureCode ??= code;
  });
  state.llmAdmission = {
    ...admission,
    beforeCall: () => {
      if (isNoFoodContinuityProbeOnly()) {
        state.noFoodContinuityProviderRequestBlocked = true;
        state.noFoodContinuityProviderRequestBlockedAfterReadback =
          state.noFoodContinuityDiagnostic?.startupBodyObservationAvailable ===
          true;
        throw new HarnessError(
          "incomplete",
          "NO_FOOD_CONTINUITY_PROVIDER_REQUEST_BLOCKED",
        );
      }
      if (state.gatherMultiTargetRequestGate !== undefined) {
        state.gatherMultiTargetRequestGate.beforeCall(
          () => {
            try {
              admission.beforeCall();
            } catch (error) {
              if (error instanceof LlmCallAdmissionError)
                throw new HarnessError("incomplete", error.code);
              throw error;
            }
          },
          () =>
            new HarnessError(
              "incomplete",
              "GATHER_MULTI_TARGET_PROVIDER_REQUEST_LATCHED",
            ),
        );
        return;
      }
      if (state.targetCase === "no_food_replan") {
        const caseStart = state.noFoodReplanCaseUsageStart;
        const requestGate = state.noFoodReplanRequestGate;
        if (caseStart !== undefined && requestGate === undefined) {
          state.failureCode ??= "NO_FOOD_REPLAN_REQUEST_GATE_NOT_READY";
          throw new HarnessError(
            "incomplete",
            "NO_FOOD_REPLAN_REQUEST_GATE_NOT_READY",
          );
        }
        const admitNoFoodRequest = () => {
          if (caseStart !== undefined) {
            const current = state.noFoodReplanLatestCounters ?? caseStart;
            const delta = subtractCounters(current, caseStart);
            const blockReason = noFoodReplanBeforeCallBlockReason(
              requestGate?.requestsStarted ?? 0,
              delta.usageUnknownCalls,
              totalTokens(delta),
            );
            if (blockReason !== undefined) {
              state.failureCode ??= blockReason;
              throw new HarnessError("incomplete", blockReason);
            }
          }
          if (
            state.noFoodContinuityDiagnostic?.startupStateConfirmed !== true
          ) {
            state.failureCode ??=
              "NO_FOOD_REPLAN_STARTUP_ORACLES_NOT_CONFIRMED";
            throw new HarnessError(
              "incomplete",
              "NO_FOOD_REPLAN_STARTUP_ORACLES_NOT_CONFIRMED",
            );
          }
          try {
            admission.beforeCall();
          } catch (error) {
            if (error instanceof LlmCallAdmissionError)
              throw new HarnessError("incomplete", error.code);
            throw error;
          }
        };
        if (caseStart !== undefined && requestGate !== undefined) {
          requestGate.beforeCall(admitNoFoodRequest);
          return;
        }
        admitNoFoodRequest();
        return;
      }
      if (ownerReturnRequestGateEnabled(state.targetCase)) {
        admitOwnerReturnProviderRequest(
          state.ownerReturnRequestGate,
          OWNER_RETURN_THROUGH_DOOR_CASE_BUDGET.llmCalls,
          () => {
            try {
              admission.beforeCall();
            } catch (error) {
              if (error instanceof LlmCallAdmissionError)
                throw new HarnessError("incomplete", error.code);
              throw error;
            }
          },
          (code) => {
            state.failureCode ??= code;
            return new HarnessError("incomplete", code);
          },
        );
        return;
      }
      try {
        admission.beforeCall();
      } catch (error) {
        if (error instanceof LlmCallAdmissionError)
          throw new HarnessError("incomplete", error.code);
        throw error;
      }
    },
  };
  return state;
}

async function startServer(state: RunState): Promise<void> {
  await copyServerCacheAreas(state);
  await writeFile(state.privateServerLogPath, "", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await copyFile(state.serverJar, join(state.serverDirectory, "server.jar"));
  await writeFile(join(state.serverDirectory, "eula.txt"), state.eulaContents, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(join(state.serverDirectory, "ops.json"), "[]\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  const properties = [
    "server-ip=127.0.0.1",
    `server-port=${state.serverPort}`,
    "online-mode=false",
    "white-list=false",
    "spawn-protection=0",
    "enable-command-block=false",
    "allow-flight=false",
    "difficulty=normal",
    "gamemode=survival",
    "max-players=8",
    "view-distance=8",
    "simulation-distance=6",
    "sync-chunk-writes=true",
    "level-name=fixture-world",
    `level-seed=${state.seed}`,
    "level-type=minecraft:flat",
    "enable-rcon=true",
    `rcon.port=${state.rconPort}`,
    `rcon.password=${state.rconPassword}`,
    "rcon.ip=127.0.0.1",
    "motd=isolated ai-player acceptance harness",
  ].join("\n");
  await writeFile(
    join(state.serverDirectory, "server.properties"),
    `${properties}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  const server = spawn(
    state.javaPath,
    ["-Xms512M", "-Xmx2G", "-jar", "server.jar", "--nogui"],
    {
      cwd: state.serverDirectory,
      env: {
        JAVA_HOME: dirname(dirname(state.javaPath)),
        PATH: process.env.PATH ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  state.serverProcess = server;
  serverForCleanup = server;
  const privateLogStream = createWriteStream(state.privateServerLogPath, {
    flags: "a",
    mode: 0o600,
  });
  state.privateServerLogStream = privateLogStream;
  privateLogStream.on("error", () => {
    state.privateServerLogWriteFailed = true;
    state.failureCode ??= "PRIVATE_SERVER_LOG_WRITE_FAILED";
    if (state.status !== "fail") state.status = "incomplete";
  });
  server.stdout.on("data", (chunk: Buffer) => privateLogStream.write(chunk));
  server.stderr.on("data", (chunk: Buffer) => privateLogStream.write(chunk));
  const started = waitForServerReady(server, 150_000);
  await started;
}

async function copyServerCacheAreas(state: RunState): Promise<void> {
  if (state.serverCacheDirectory === undefined) return;
  for (const area of ["libraries", "versions", "cache"] as const) {
    const source = join(state.serverCacheDirectory, area);
    try {
      const areaInfo = await lstat(source);
      if (areaInfo.isSymbolicLink() || !areaInfo.isDirectory()) {
        incomplete("SERVER_CACHE_AREA_INVALID");
      }
      await cp(source, join(state.serverDirectory, area), {
        recursive: true,
        force: true,
        filter: async (entryPath) => {
          try {
            return !(await lstat(entryPath)).isSymbolicLink();
          } catch {
            return false;
          }
        },
      });
      state.copiedServerCacheAreas?.push(area);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      if (isRecord(error) && error.code === "ENOENT") continue;
      incomplete("SERVER_CACHE_COPY_FAILED");
    }
  }
}

async function waitForServerReady(
  server: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  let tail = "";
  await new Promise<void>((resolveReady, reject) => {
    let settled = false;
    let onStdout: (chunk: Buffer) => void = () => undefined;
    let finish: (error?: HarnessError) => void = () => undefined;
    const onStderr = (chunk: Buffer): void => {
      tail = `${tail}${chunk.toString("utf8")}`.slice(-2_048);
    };
    const appendTail = (chunk: Buffer): void => {
      tail = `${tail}${chunk.toString("utf8")}`.slice(-2_048);
    };
    onStdout = (chunk: Buffer): void => {
      appendTail(chunk);
      if (/Done \([^\n]+\)! For help/iu.test(tail)) finish();
    };
    const removeOutputListeners = (): void => {
      server.stdout.removeListener("data", onStdout);
      server.stderr.removeListener("data", onStderr);
    };
    finish = (error?: HarnessError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeOutputListeners();
      if (error === undefined) resolveReady();
      else reject(error);
    };
    const timer = setTimeout(
      () =>
        finish(
          new HarnessError(
            "incomplete",
            classifyServerStartupFailure(tail, "SERVER_STARTUP_TIMEOUT"),
          ),
        ),
      timeoutMs,
    );
    server.stdout.on("data", onStdout);
    server.stderr.on("data", onStderr);
    server.once("error", (error) => {
      const code = isRecord(error) ? error.code : undefined;
      const failure =
        code === "ENOENT"
          ? "JAVA_EXECUTABLE_NOT_FOUND"
          : code === "EACCES"
            ? "JAVA_EXECUTABLE_NOT_PERMITTED"
            : "SERVER_PROCESS_LAUNCH_FAILURE";
      finish(new HarnessError("incomplete", failure));
    });
    server.once("exit", () => {
      finish(
        new HarnessError(
          "incomplete",
          classifyServerStartupFailure(tail, "SERVER_EXITED_DURING_STARTUP"),
        ),
      );
    });
  });
}

function classifyServerStartupFailure(tail: string, fallback: string): string {
  if (
    /failed to bind|address already in use|cannot assign requested address/iu.test(
      tail,
    )
  ) {
    return "SERVER_BIND_FAILURE";
  }
  if (/eula|agree to the EULA/iu.test(tail)) return "PAPER_EULA_FAILURE";
  if (
    /unsupportedclassversionerror|class file version .* newer|requires java .* but/iu.test(
      tail,
    )
  ) {
    return "JAVA_VERSION_FAILURE";
  }
  if (
    /unknownhost|connection timed out|failed to download|http status \d{3}/iu.test(
      tail,
    )
  ) {
    return "PAPER_BOOTSTRAP_DOWNLOAD_FAILURE";
  }
  if (
    /noclassdeffounderror|classnotfoundexception|could not load.*library/iu.test(
      tail,
    )
  ) {
    return "PAPER_DEPENDENCY_FAILURE";
  }
  return fallback;
}

async function prepareWorld(state: RunState, rcon: LocalRcon): Promise<void> {
  await setAndVerifyGamerule(rcon, "advanceTime", false);
  await setAndVerifyGamerule(rcon, "spawnMobs", false);
  await setAndVerifyGamerule(rcon, "keepInventory", true);
  await setAndVerifyGamerule(rcon, "respawnRadius", 0);
  await rcon.command("scoreboard objectives add ai_e2e dummy");
  await rcon.command("scoreboard players set #diff ai_e2e 0");
  await forceLoadRegion(rcon, REGION, incomplete);
  await forceLoadRegion(
    rcon,
    destinationRegion(REGION, REGION_BASELINE),
    incomplete,
  );
  await rcon.command("time set 1000");
  await rcon.command("weather clear");
  await rcon.command("setworldspawn 0 64 0");
  await rcon.command(
    `fill ${REGION.minX} ${REGION.minY} ${REGION.minZ} ${REGION.maxX} ${REGION.minY} ${REGION.maxZ} stone`,
  );
  await rcon.command(
    `fill ${REGION.minX} ${REGION.minY + 1} ${REGION.minZ} ${REGION.maxX} ${REGION.maxY} ${REGION.maxZ} air`,
  );
  await configureHiddenContainer(rcon);
  await configureAutonomousBuildFixture(rcon);
  await configureAutonomousResourceFixture(rcon);
  await establishBaseline(rcon, REGION, REGION_BASELINE, incomplete);
  await mkdir(dirname(state.databasePath), { recursive: true, mode: 0o700 });
}

async function setAndVerifyGamerule(
  rcon: LocalRcon,
  rule: keyof typeof E2E_GAMERULES,
  value: boolean | number,
): Promise<void> {
  const { id, readbackFailure } = E2E_GAMERULES[rule];
  await rcon.command(`gamerule ${id} ${value}`);
  const readback = (await rcon.command(`gamerule ${id}`))
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
  const ruleTokens = readback.split(/[^a-z0-9_:]+/u);
  const leafId = id.slice(id.indexOf(":") + 1);
  const ruleIdDisplayed =
    ruleTokens.includes(id) || ruleTokens.includes(leafId);
  const reportedValue = /(?:^|\s)(true|false|\d+)$/u.exec(readback)?.[1];
  if (!ruleIdDisplayed || reportedValue !== String(value))
    incomplete(readbackFailure);
}

async function assertNoOperators(state: RunState): Promise<void> {
  const ops = JSON.parse(
    await readFile(join(state.serverDirectory, "ops.json"), "utf8"),
  ) as unknown;
  if (!Array.isArray(ops) || ops.length !== 0)
    fail("ISOLATED_SERVER_HAS_OPERATOR");
}

async function prepareNoFoodFixtureProbe(
  state: RunState,
  rcon: LocalRcon,
): Promise<Readonly<Record<string, string | number | boolean>>> {
  const [{ MineflayerClient }, { createLogger }] = await Promise.all([
    import("../../src/minecraft/mineflayer-client.js"),
    import("../../src/observability/logger.js"),
  ]);
  const client = new MineflayerClient(
    {
      bot: {
        host: "127.0.0.1",
        port: state.serverPort,
        username: state.botName,
        auth: "offline",
        version: SERVER_VERSION,
      },
      ownerUsername: state.ownerName,
      pathfinderThinkTimeoutMs: 15_000,
      pathfinderTickTimeoutMs: 15_000,
      collectTimeoutMs: 30_000,
    },
    createLogger({ logLevel: "silent" }),
  );
  const abort = new AbortController();
  const abortTimer = setTimeout(
    () => abort.abort(new Error("no-food fixture probe deadline")),
    110_000,
  );
  let body: ReturnType<typeof client.createPlayerBody> | undefined;
  try {
    await client.connect(abort.signal);
    body = client.createPlayerBody();
    await rcon.command(`tp ${state.botName} 0.5 64 0.5 0 0`);
    const baselineBody = await body.observe();
    const baselineRconHealth = await rconEntityHealth(rcon, state.botName);
    const baselineRconFood = await rconFoodLevel(rcon, state.botName);
    if (
      baselineBody.self.health !== 20 ||
      baselineBody.self.food !== 20 ||
      baselineRconHealth !== 20 ||
      baselineRconFood !== 20
    )
      incomplete("NO_FOOD_FIXTURE_FULL_BASELINE_NOT_CONFIRMED");

    const effectsBaseline = await rconActiveEffectsState(rcon, state.botName);
    if (effectsBaseline === "unknown")
      incomplete("NO_FOOD_FIXTURE_BASELINE_EFFECTS_UNAVAILABLE");
    if (effectsBaseline === "active") {
      await rcon.command(`effect clear ${state.botName}`);
      if ((await rconActiveEffectsState(rcon, state.botName)) !== "empty")
        incomplete("NO_FOOD_FIXTURE_BASELINE_EFFECTS_NOT_CLEARED");
    }

    await rcon.command(`clear ${state.botName}`);
    await rcon.command(
      `effect give ${state.botName} minecraft:hunger 120 8 true`,
    );
    if (!(await rconHasActiveEffect(rcon, state.botName, "hunger")))
      incomplete("NO_FOOD_FIXTURE_HUNGER_EFFECT_NOT_CONFIRMED");
    const foodDeadline = Date.now() + 60_000;
    let preparedFood = await rconFoodLevel(rcon, state.botName);
    while (preparedFood > 15 && Date.now() < foodDeadline) {
      await waitMs(250);
      preparedFood = await rconFoodLevel(rcon, state.botName);
    }
    if (preparedFood < 12 || preparedFood > 15)
      incomplete("NO_FOOD_FIXTURE_SAFE_FOOD_NOT_CONFIRMED");
    await rcon.command(`effect clear ${state.botName} minecraft:hunger`);
    if ((await rconActiveEffectsState(rcon, state.botName)) !== "empty")
      incomplete("NO_FOOD_FIXTURE_HUNGER_EFFECT_CLEANUP_NOT_CONFIRMED");

    await setAndVerifyGamerule(rcon, "naturalRegeneration", false);
    await rcon.command(`damage ${state.botName} 14 minecraft:generic`);
    const healthDeadline = Date.now() + 3_000;
    let finalBody = await body.observe();
    let bodyHealth = finalBody.self.health;
    let rconHealth: number | null = null;
    while (Date.now() < healthDeadline) {
      try {
        rconHealth = await rconEntityHealth(
          rcon,
          state.botName,
          Math.max(1, Math.min(500, healthDeadline - Date.now())),
        );
      } catch {
        rconHealth = null;
      }
      try {
        finalBody = await body.observe();
        bodyHealth = finalBody.self.health;
      } catch {
        bodyHealth = null;
      }
      if (
        typeof bodyHealth === "number" &&
        bodyHealth > 0 &&
        bodyHealth <= 6 &&
        rconHealth !== null &&
        rconHealth > 0 &&
        rconHealth <= 6
      )
        break;
      await waitMs(100);
    }
    const bodyFood = finalBody.self.food;
    const rconFood = await rconFoodLevel(rcon, state.botName);
    const bodyInventoryItemCount = finalBody.self.inventory.reduce(
      (total, item) => total + item.count,
      0,
    );
    const bodyEquipmentEmpty = Object.values(finalBody.self.equipment).every(
      (item) => item === null,
    );
    const rconInventoryEmpty = await rconInventoryIsEmpty(rcon, state.botName);
    if (
      typeof bodyHealth !== "number" ||
      bodyHealth <= 0 ||
      bodyHealth > 6 ||
      rconHealth === null ||
      rconHealth <= 0 ||
      rconHealth > 6
    )
      incomplete("NO_FOOD_FIXTURE_LOW_HEALTH_NOT_CONFIRMED_BY_BOTH_ORACLES");
    if (
      typeof bodyFood !== "number" ||
      bodyFood < 12 ||
      bodyFood > 15 ||
      rconFood < 12 ||
      rconFood > 15 ||
      bodyFood !== rconFood
    )
      incomplete("NO_FOOD_FIXTURE_SAFE_FOOD_NOT_CONFIRMED_BY_BOTH_ORACLES");
    if (
      bodyInventoryItemCount !== 0 ||
      !bodyEquipmentEmpty ||
      !rconInventoryEmpty
    )
      incomplete(
        "NO_FOOD_FIXTURE_EMPTY_INVENTORY_NOT_CONFIRMED_BY_BOTH_ORACLES",
      );

    return {
      applicationStarted: false,
      purposeDecisionStarted: false,
      llmCalls: 0,
      baselineBodyHealth: baselineBody.self.health,
      baselineRconHealth,
      baselineBodyFood: baselineBody.self.food,
      baselineRconFood,
      bodyHealth,
      rconHealth,
      bodyFood,
      rconFood,
      bodyInventoryItemCount,
      bodyEquipmentEmpty,
      rconInventoryEmpty,
      hungerEffectCleanupConfirmed: true,
      naturalRegenerationDisabled: true,
    };
  } finally {
    clearTimeout(abortTimer);
    await body?.stop().catch(() => undefined);
    await client.disconnect("no_food_fixture_probe").catch(() => undefined);
  }
}

async function runOperationSmoke(
  state: RunState,
  rcon: LocalRcon,
): Promise<SafeCaseResult> {
  const returnPathProbeOnly =
    process.env.AI_PLAYER_E2E_RETURN_PATH_PROBE_ONLY === "YES";
  const progressiveNavigationProbeOnly =
    process.env.AI_PLAYER_E2E_PROGRESSIVE_NAVIGATION_PROBE_ONLY === "YES";
  const smokeDeadlineMs = progressiveNavigationProbeOnly
    ? 135_000
    : returnPathProbeOnly
      ? 150_000
      : state.targetCase === "gather_multi_target_continuity"
        ? 210_000
        : 90_000;
  const result = await runCase(
    state,
    "body_operation_smoke",
    smokeDeadlineMs,
    0,
    0,
    async () => {
      const [{ MineflayerClient }, { createLogger }, { playerOperationNames }] =
        await Promise.all([
          import("../../src/minecraft/mineflayer-client.js"),
          import("../../src/observability/logger.js"),
          import("../../src/minecraft/player-body-schema.js"),
        ]);
      const client = new MineflayerClient(
        {
          bot: {
            host: "127.0.0.1",
            port: state.serverPort,
            username: state.botName,
            auth: "offline",
            version: SERVER_VERSION,
          },
          ownerUsername: state.ownerName,
          pathfinderThinkTimeoutMs: 15_000,
          pathfinderTickTimeoutMs: 15_000,
          collectTimeoutMs: 30_000,
        },
        createLogger({ logLevel: "silent" }),
      );
      const abort = new AbortController();
      const abortTimer = setTimeout(
        () => abort.abort(new Error("body smoke deadline")),
        smokeDeadlineMs - 10_000,
      );
      let body: Awaited<ReturnType<typeof client.createPlayerBody>> | undefined;
      let target: Position | undefined;
      try {
        await client.connect(abort.signal);
        body = client.createPlayerBody();
        if (isDeathRecoveryFixtureProbeOnly())
          return await runDeathRecoveryFixtureProbe(
            state,
            rcon,
            client,
            body,
            abort.signal,
          );
        const names = new Set(playerOperationNames);
        if (
          names.size !== 31 ||
          !names.has("move_relative") ||
          !names.has("look_sweep") ||
          !names.has("dig") ||
          !names.has("open_window") ||
          !names.has("window_transfer") ||
          !names.has("window_close")
        ) {
          fail("PLAYER_OPERATION_CAPABILITY_LIST_INCOMPLETE");
        }
        const smokeSpawn = { x: 0.5, y: 64, z: 0.5 };
        await rcon.command(
          `tp ${state.botName} ${smokeSpawn.x} ${smokeSpawn.y} ${smokeSpawn.z} 0 0`,
        );
        const serverSmokePosition = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const positionMatchesSmokeSpawn = (position: Position): boolean =>
          Math.hypot(
            position.x - smokeSpawn.x,
            position.y - smokeSpawn.y,
            position.z - smokeSpawn.z,
          ) <= 0.5;
        if (!positionMatchesSmokeSpawn(serverSmokePosition))
          incomplete("BODY_SMOKE_SERVER_POSITION_NOT_CONFIRMED");
        let visibleBefore = await body.observe();
        const smokePositionDeadline = Date.now() + 5_000;
        while (
          !positionMatchesSmokeSpawn(visibleBefore.self.position) &&
          Date.now() < smokePositionDeadline
        ) {
          await waitMs(100);
          visibleBefore = await body.observe();
        }
        if (!positionMatchesSmokeSpawn(visibleBefore.self.position))
          incomplete("BODY_SMOKE_CLIENT_POSITION_NOT_CONFIRMED");
        if (
          shouldRunGatherMultiTargetOracleProbe(
            state.targetCase,
            process.env.AI_PLAYER_E2E_GATHER_MULTI_TARGET_ORACLE_PROBE_ONLY,
          )
        ) {
          await runGatherStackOracleProbe(state, rcon, state.botName, body);
        }
        const hiddenItemOmitted = !JSON.stringify(visibleBefore)
          .toLowerCase()
          .includes("emerald");
        if (!hiddenItemOmitted) fail("BODY_OBSERVATION_LEAKED_OCCLUDED_ITEM");
        const knowledge: unknown = body.knowledge("oak log");
        const registryKnowledgeAvailable =
          isRecord(knowledge) &&
          knowledge.source === "minecraft_registry" &&
          Array.isArray(knowledge.facts) &&
          knowledge.facts.some(
            (fact: unknown) =>
              isRecord(fact) && fact.kind === "item" && fact.name === "oak_log",
          );
        if (!registryKnowledgeAvailable)
          incomplete("GAME_REGISTRY_KNOWLEDGE_FIXTURE_MISSING");
        const playerSnapshot = await readWorldSnapshot(rcon, state.botName);
        const smokeTarget = {
          x: Math.floor(playerSnapshot.position.x) + 1,
          y: Math.floor(playerSnapshot.position.y),
          z: Math.floor(playerSnapshot.position.z) + 2,
        };
        if (
          AUTONOMOUS_RESOURCE_FIXTURE.some(
            (block) =>
              block.x === smokeTarget.x &&
              block.y === smokeTarget.y &&
              block.z === smokeTarget.z,
          )
        ) {
          incomplete("BODY_SMOKE_TARGET_OVERLAPS_RESOURCE_FIXTURE");
        }
        target = smokeTarget;
        if (!(await isBlock(rcon, target, "air")))
          incomplete("BODY_SMOKE_TARGET_NOT_AIR");
        await rcon.command(
          `setblock ${target.x} ${target.y} ${target.z} stone`,
        );
        if (!(await isBlock(rcon, target, "stone")))
          incomplete("BODY_SMOKE_TARGET_STONE_NOT_CONFIRMED");
        const fixtureLookResult = await body.execute(
          {
            kind: "look",
            target: {
              x: target.x + 0.5,
              y: target.y + 0.5,
              z: target.z + 0.5,
            },
          },
          abort.signal,
        );
        let fixtureObservation: PlayerBodyObservation | null = null;
        const visibilityDeadline = Date.now() + 5_000;
        while (!abort.signal.aborted && Date.now() < visibilityDeadline) {
          fixtureObservation = await body.observe();
          if (observedBlockName(fixtureObservation, target) !== undefined)
            break;
          await waitMs(100);
        }
        const fixtureTargetBlockName =
          observedBlockName(fixtureObservation, target) ?? "not_observed";
        const fixtureTargetVisibleAfterLook =
          fixtureTargetBlockName !== "not_observed";
        const fixtureLookDiagnostic: BodySmokeDiagnostic = {
          fixtureLookStatus: fixtureLookResult.status,
          fixtureLookDetailClass: classifyBodyOperationDetail(
            fixtureLookResult.detail,
          ),
          fixtureTargetVisibleAfterLook,
          fixtureTargetBlockName,
        };
        state.bodySmokeDiagnostic = fixtureLookDiagnostic;
        if (fixtureLookResult.status !== "successful")
          incomplete("BODY_SMOKE_LOOK_NOT_CONFIRMED");
        if (!fixtureTargetVisibleAfterLook)
          incomplete("BODY_SMOKE_TARGET_NOT_VISIBLE_BEFORE_DIG");
        if (fixtureTargetBlockName !== "stone")
          incomplete("BODY_SMOKE_FIXTURE_BLOCK_MISMATCH");
        const digResult = await body.execute(
          { kind: "dig", position: target },
          abort.signal,
        );
        const digBeforeBlockName = observedBlockName(digResult.before, target);
        const blockIsAir = await isBlock(rcon, target, "air");
        const digDiagnostic: BodySmokeDiagnostic = {
          ...fixtureLookDiagnostic,
          targetVisibleInDigBeforeSnapshot: digBeforeBlockName !== undefined,
          targetBlockNameInDigBeforeSnapshot:
            digBeforeBlockName ?? "not_observed",
          digStatus: digResult.status,
          digRecoveryRequired: digResult.recoveryRequired,
          digDetailClass: classifyBodyOperationDetail(digResult.detail),
          serverBlockAirAfterDig: blockIsAir,
        };
        state.bodySmokeDiagnostic = digDiagnostic;
        if (digResult.status !== "successful")
          fail("NON_OP_BODY_DIG_NOT_CONFIRMED_BY_BODY");
        if (!blockIsAir) fail("NON_OP_BODY_DIG_NOT_CONFIRMED_BY_SERVER");

        let furnaceFixtureRconConfirmed = false;
        try {
          await rcon.command(
            `setblock ${target.x} ${target.y} ${target.z} furnace`,
          );
          await rcon.command(
            `item replace entity ${state.botName} hotbar.0 with minecraft:raw_iron 1`,
          );
        } catch {
          state.bodySmokeDiagnostic = {
            ...digDiagnostic,
            furnaceFixtureRconConfirmed: false,
          };
          incomplete("FURNACE_FIXTURE_SETUP_FAILED");
        }
        try {
          furnaceFixtureRconConfirmed = await isBlock(rcon, target, "furnace");
        } catch {
          state.bodySmokeDiagnostic = {
            ...digDiagnostic,
            furnaceFixtureRconConfirmed: false,
          };
          incomplete("FURNACE_FIXTURE_RCON_READBACK_FAILED");
        }
        let furnaceDiagnostic: BodySmokeDiagnostic = {
          ...digDiagnostic,
          furnaceFixtureRconConfirmed,
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        if (!furnaceFixtureRconConfirmed)
          incomplete("FURNACE_FIXTURE_RCON_READBACK_FAILED");

        const furnaceLookResult = await body.execute(
          {
            kind: "look",
            target: { x: target.x + 0.5, y: target.y + 0.5, z: target.z + 0.5 },
          },
          abort.signal,
        );
        furnaceDiagnostic = {
          ...furnaceDiagnostic,
          furnaceLookStatus: furnaceLookResult.status,
          furnaceLookDetailClass: classifyBodyOperationDetail(
            furnaceLookResult.detail,
          ),
          furnaceTargetClassBeforeOpen: "not_observed",
          furnaceTargetVisibleBeforeOpen: false,
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        if (furnaceLookResult.status !== "successful")
          incomplete("FURNACE_LOOK_NOT_CONFIRMED");

        const furnaceVisibilityDeadline = Date.now() + 5_000;
        do {
          const observation = await body.observe();
          const targetBlockName = observedBlockName(observation, target);
          const targetClass = classifyFurnaceTarget(targetBlockName);
          furnaceDiagnostic = {
            ...furnaceDiagnostic,
            furnaceTargetClassBeforeOpen: targetClass,
            furnaceTargetVisibleBeforeOpen: targetBlockName !== undefined,
          };
          state.bodySmokeDiagnostic = furnaceDiagnostic;
          if (
            targetClass === "furnace" ||
            Date.now() >= furnaceVisibilityDeadline
          )
            break;
          await waitMs(
            Math.max(1, Math.min(100, furnaceVisibilityDeadline - Date.now())),
          );
        } while (!abort.signal.aborted);

        if (furnaceDiagnostic.furnaceTargetClassBeforeOpen !== "furnace")
          incomplete("FURNACE_TARGET_NOT_CONFIRMED_BEFORE_OPEN");

        const openResult = await body.execute(
          {
            kind: "open_window",
            target: { kind: "block", position: target },
          },
          abort.signal,
        );
        furnaceDiagnostic = {
          ...furnaceDiagnostic,
          furnaceOpenStatus: openResult.status,
          furnaceOpenDetailClass: classifyBodyOperationDetail(
            openResult.detail,
          ),
          furnaceWindowTypeClass: "none",
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        const opened = await body.observe();
        const furnaceWindowTypeClass = classifyWindowType(opened.window?.type);
        furnaceDiagnostic = {
          ...furnaceDiagnostic,
          furnaceWindowTypeClass,
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        if (
          openResult.status !== "successful" ||
          furnaceWindowTypeClass !== "furnace"
        ) {
          incomplete("FURNACE_WINDOW_OPEN_NOT_CONFIRMED");
        }
        let furnaceInputInventory: PlayerBodyObservation;
        const furnaceInventoryDeadline = Date.now() + 5_000;
        let rconInventoryInputConfirmed = false;
        try {
          rconInventoryInputConfirmed = (
            await rcon.command(`data get entity ${state.botName} Inventory`)
          ).includes("minecraft:raw_iron");
        } catch {
          rconInventoryInputConfirmed = false;
        }
        do {
          furnaceInputInventory = await body.observe();
          const itemCounts = furnaceItemCounts(furnaceInputInventory);
          furnaceDiagnostic = {
            ...furnaceDiagnostic,
            furnaceInventoryRawIronBeforeTransferIn: itemCounts.inventory,
            furnaceWindowInventoryRawIronBeforeTransferIn:
              itemCounts.windowInventory,
            furnaceWindowInputRawIronBeforeTransferIn: itemCounts.windowInput,
            furnaceCursorRawIronBeforeTransferIn: itemCounts.cursor,
            furnaceRconInventoryInputConfirmed: rconInventoryInputConfirmed,
          };
          state.bodySmokeDiagnostic = furnaceDiagnostic;
          if (
            itemCounts.windowInventory === 1 ||
            Date.now() >= furnaceInventoryDeadline
          ) {
            break;
          }
          await waitMs(
            Math.max(1, Math.min(100, furnaceInventoryDeadline - Date.now())),
          );
        } while (!abort.signal.aborted);
        const furnaceInputInventoryCounts = furnaceItemCounts(
          furnaceInputInventory,
        );
        if (
          furnaceInputInventoryCounts.windowInventory !== 1 ||
          !rconInventoryInputConfirmed
        ) {
          incomplete("FURNACE_FIXTURE_INVENTORY_NOT_CONFIRMED");
        }
        const transferInResult = await body.execute(
          {
            kind: "window_transfer",
            item: "raw_iron",
            count: 1,
            direction: "inventory_to_window",
          },
          abort.signal,
        );
        furnaceDiagnostic = {
          ...furnaceDiagnostic,
          furnaceTransferInStatus: transferInResult.status,
          furnaceTransferInRecoveryRequired: transferInResult.recoveryRequired,
          furnaceTransferInDetailClass: classifyBodyOperationDetail(
            transferInResult.detail,
          ),
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        const transferInWaitStartedAt = Date.now();
        const transferInDeadline = transferInWaitStartedAt + 5_000;
        let furnaceInputVisible = false;
        let furnaceInputConfirmed = false;
        let furnaceInputCounts = {
          inventory: 0,
          windowInventory: 0,
          windowInput: 0,
          cursor: 0,
        };
        let firstInputReply = classifyFurnaceRconReply(null);
        let firstInputCounts = furnaceInputCounts;
        let firstInputSample = true;
        let inputReply = classifyFurnaceRconReply(null);
        let inputWaitElapsedMs = 0;
        do {
          let reply: string | null = null;
          try {
            reply = await rcon.command(
              `data get block ${target.x} ${target.y} ${target.z} Items`,
              Math.max(1, Math.min(1_000, transferInDeadline - Date.now())),
            );
          } catch {
            reply = null;
          }
          const furnaceInput = await body.observe();
          furnaceInputCounts = furnaceItemCounts(furnaceInput);
          furnaceInputVisible =
            furnaceInput.window?.slots
              .slice(0, furnaceInput.window.inventoryStart)
              .some((item) => item?.name === "raw_iron" && item.count === 1) ===
            true;
          inputReply = classifyFurnaceRconReply(reply);
          furnaceInputConfirmed = inputReply.hasCanonicalRawIron;
          inputWaitElapsedMs = Date.now() - transferInWaitStartedAt;
          if (firstInputSample) {
            firstInputReply = inputReply;
            firstInputCounts = furnaceInputCounts;
            firstInputSample = false;
          }
          furnaceDiagnostic = {
            ...furnaceDiagnostic,
            furnaceInventoryRawIronAtTransferInInitial:
              firstInputCounts.inventory,
            furnaceWindowInventoryRawIronAtTransferInInitial:
              firstInputCounts.windowInventory,
            furnaceWindowInputRawIronAtTransferInInitial:
              firstInputCounts.windowInput,
            furnaceCursorRawIronAtTransferInInitial: firstInputCounts.cursor,
            furnaceRconInputInitialClass: firstInputReply.replyClass,
            furnaceRconInputInitialConfirmed:
              firstInputReply.hasCanonicalRawIron,
            furnaceInventoryRawIronAfterTransferIn:
              furnaceInputCounts.inventory,
            furnaceWindowInventoryRawIronAfterTransferIn:
              furnaceInputCounts.windowInventory,
            furnaceWindowInputRawIronAfterTransferIn:
              furnaceInputCounts.windowInput,
            furnaceCursorRawIronAfterTransferIn: furnaceInputCounts.cursor,
            furnaceRconInputFinalClass: inputReply.replyClass,
            furnaceRconInputFinalConfirmed: furnaceInputConfirmed,
            furnaceRconInputConfirmedAfterTransferIn: furnaceInputConfirmed,
            furnaceTransferInWaitElapsedMs: inputWaitElapsedMs,
          };
          state.bodySmokeDiagnostic = furnaceDiagnostic;
          if (furnaceInputVisible && furnaceInputConfirmed) {
            break;
          }
          if (Date.now() >= transferInDeadline) break;
          await waitMs(Math.min(100, transferInDeadline - Date.now()));
        } while (!abort.signal.aborted);
        if (!furnaceInputVisible || !furnaceInputConfirmed) {
          incomplete("FURNACE_INPUT_NOT_CONFIRMED_BY_BODY_AND_SERVER");
        }
        furnaceDiagnostic = {
          ...furnaceDiagnostic,
          furnaceInventoryRawIronBeforeTransferOut:
            furnaceInputCounts.inventory,
          furnaceWindowInventoryRawIronBeforeTransferOut:
            furnaceInputCounts.windowInventory,
          furnaceWindowInputRawIronBeforeTransferOut:
            furnaceInputCounts.windowInput,
          furnaceCursorRawIronBeforeTransferOut: furnaceInputCounts.cursor,
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        const transferOutResult = await body.execute(
          {
            kind: "window_transfer",
            item: "raw_iron",
            count: 1,
            direction: "window_to_inventory",
          },
          abort.signal,
        );
        furnaceDiagnostic = {
          ...furnaceDiagnostic,
          furnaceTransferOutStatus: transferOutResult.status,
          furnaceTransferOutRecoveryRequired:
            transferOutResult.recoveryRequired,
          furnaceTransferOutDetailClass: classifyBodyOperationDetail(
            transferOutResult.detail,
          ),
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        const transferOutWaitStartedAt = Date.now();
        const transferOutDeadline = transferOutWaitStartedAt + 5_000;
        let returnedCounts = {
          inventory: 0,
          windowInventory: 0,
          windowInput: 0,
          cursor: 0,
        };
        let itemReturnedToInventory = false;
        let furnaceEmpty = false;
        let firstReturnReply = classifyFurnaceRconReply(null);
        let firstReturnCounts = returnedCounts;
        let firstReturnSample = true;
        let returnReply = classifyFurnaceRconReply(null);
        let returnWaitElapsedMs = 0;
        do {
          let reply: string | null = null;
          try {
            reply = await rcon.command(
              `data get block ${target.x} ${target.y} ${target.z} Items`,
              Math.max(1, Math.min(1_000, transferOutDeadline - Date.now())),
            );
          } catch {
            reply = null;
          }
          const returned = await body.observe();
          returnedCounts = furnaceItemCounts(returned);
          itemReturnedToInventory =
            returnedCounts.windowInventory === 1 &&
            returnedCounts.windowInput === 0 &&
            returnedCounts.cursor === 0;
          returnReply = classifyFurnaceRconReply(reply);
          furnaceEmpty = returnReply.replyClass === "empty_list";
          returnWaitElapsedMs = Date.now() - transferOutWaitStartedAt;
          if (firstReturnSample) {
            firstReturnReply = returnReply;
            firstReturnCounts = returnedCounts;
            firstReturnSample = false;
          }
          furnaceDiagnostic = {
            ...furnaceDiagnostic,
            furnaceInventoryRawIronAtTransferOutInitial:
              firstReturnCounts.inventory,
            furnaceWindowInventoryRawIronAtTransferOutInitial:
              firstReturnCounts.windowInventory,
            furnaceWindowInputRawIronAtTransferOutInitial:
              firstReturnCounts.windowInput,
            furnaceCursorRawIronAtTransferOutInitial: firstReturnCounts.cursor,
            furnaceRconReturnInitialClass: firstReturnReply.replyClass,
            furnaceRconReturnInitialEmptyConfirmed:
              firstReturnReply.replyClass === "empty_list",
            furnaceInventoryRawIronAfterTransferOut: returnedCounts.inventory,
            furnaceWindowInventoryRawIronAfterTransferOut:
              returnedCounts.windowInventory,
            furnaceWindowInputRawIronAfterTransferOut:
              returnedCounts.windowInput,
            furnaceCursorRawIronAfterTransferOut: returnedCounts.cursor,
            furnaceRconReturnFinalClass: returnReply.replyClass,
            furnaceRconReturnFinalEmptyConfirmed: furnaceEmpty,
            furnaceRconEmptyConfirmedAfterTransferOut: furnaceEmpty,
            furnaceTransferOutWaitElapsedMs: returnWaitElapsedMs,
          };
          state.bodySmokeDiagnostic = furnaceDiagnostic;
          if (itemReturnedToInventory && furnaceEmpty) break;
          if (Date.now() >= transferOutDeadline) break;
          await waitMs(Math.min(100, transferOutDeadline - Date.now()));
        } while (!abort.signal.aborted);
        furnaceDiagnostic = {
          ...furnaceDiagnostic,
          furnaceInventoryRawIronBeforeClose: returnedCounts.inventory,
          furnaceWindowInventoryRawIronBeforeClose:
            returnedCounts.windowInventory,
          furnaceWindowInputRawIronBeforeClose: returnedCounts.windowInput,
          furnaceCursorRawIronBeforeClose: returnedCounts.cursor,
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        const closeResult = await body.execute(
          { kind: "window_close" },
          abort.signal,
        );
        const closed = await body.observe();
        const closedCounts = furnaceItemCounts(closed);
        const windowClosed = closed.window === null;
        furnaceDiagnostic = {
          ...furnaceDiagnostic,
          furnaceWindowCloseStatus: closeResult.status,
          furnaceWindowCloseRecoveryRequired: closeResult.recoveryRequired,
          furnaceWindowCloseDetailClass: classifyBodyOperationDetail(
            closeResult.detail,
          ),
          furnaceInventoryRawIronAfterClose: closedCounts.inventory,
          furnaceWindowInventoryRawIronAfterClose: closedCounts.windowInventory,
          furnaceWindowInputRawIronAfterClose: closedCounts.windowInput,
          furnaceCursorRawIronAfterClose: closedCounts.cursor,
          furnaceWindowClosed: windowClosed,
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        if (!itemReturnedToInventory || !furnaceEmpty) {
          incomplete("FURNACE_INPUT_NOT_RETURNED_TO_INVENTORY");
        }
        if (!windowClosed) incomplete("FURNACE_WINDOW_NOT_CLOSED");
        const apiOperationsReportedSuccess = [
          digResult,
          furnaceLookResult,
          openResult,
          transferInResult,
          transferOutResult,
          closeResult,
        ].every((item) => item.status === "successful");
        if (!apiOperationsReportedSuccess)
          incomplete("BODY_OPERATION_EFFECT_NOT_CONFIRMED");
        await rcon.command(`setblock ${target.x} ${target.y} ${target.z} air`);
        await rcon.command(`clear ${state.botName} minecraft:raw_iron`);
        if (!(await isBlock(rcon, target, "air")))
          incomplete("BODY_SMOKE_RESOURCE_TARGET_NOT_CLEAR");
        await rcon.command(
          `setblock ${target.x} ${target.y} ${target.z} oak_log`,
        );
        const resourceTargetRconConfirmed = await isBlock(
          rcon,
          target,
          "oak_log",
        );
        furnaceDiagnostic = {
          ...furnaceDiagnostic,
          resourceTargetRconConfirmed,
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        if (!resourceTargetRconConfirmed)
          incomplete("BODY_SMOKE_RESOURCE_FIXTURE_NOT_CONFIRMED");
        const resourceLookResult = await body.execute(
          {
            kind: "look",
            target: {
              x: target.x + 0.5,
              y: target.y + 0.5,
              z: target.z + 0.5,
            },
          },
          abort.signal,
        );
        furnaceDiagnostic = {
          ...furnaceDiagnostic,
          resourceLookStatus: resourceLookResult.status,
          resourceLookDetailClass: classifyBodyOperationDetail(
            resourceLookResult.detail,
          ),
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        if (resourceLookResult.status !== "successful")
          incomplete("BODY_SMOKE_RESOURCE_LOOK_NOT_CONFIRMED");
        let resourceVisibleAfterSmoke = false;
        const resourceVisibilityDeadline = Date.now() + 5_000;
        while (
          !abort.signal.aborted &&
          Date.now() < resourceVisibilityDeadline
        ) {
          let observation: PlayerBodyObservation;
          try {
            observation = await body.observe();
          } catch {
            incomplete("BODY_SMOKE_RESOURCE_OBSERVATION_UNAVAILABLE");
          }
          resourceVisibleAfterSmoke =
            observedBlockName(observation, target) === "oak_log";
          if (resourceVisibleAfterSmoke) break;
          await waitMs(
            Math.max(1, Math.min(100, resourceVisibilityDeadline - Date.now())),
          );
        }
        furnaceDiagnostic = {
          ...furnaceDiagnostic,
          resourceVisibleAfterSmoke,
        };
        state.bodySmokeDiagnostic = furnaceDiagnostic;
        if (!resourceVisibleAfterSmoke)
          incomplete("BODY_SMOKE_RESOURCE_NOT_VISIBLE");
        await rcon.command(`setblock ${target.x} ${target.y} ${target.z} air`);
        if (!(await isBlock(rcon, target, "air")))
          incomplete("BODY_SMOKE_RESOURCE_FIXTURE_CLEANUP_UNVERIFIED");
        const beforeRelativeMove = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const relativeDestination = {
          x: Math.floor(beforeRelativeMove.x),
          y: Math.floor(beforeRelativeMove.y),
          z: Math.floor(beforeRelativeMove.z) + 3,
        };
        if (
          !(await isBlock(rcon, relativeDestination, "air")) ||
          !(await isBlock(
            rcon,
            { ...relativeDestination, y: relativeDestination.y + 1 },
            "air",
          )) ||
          !(await isBlock(
            rcon,
            { ...relativeDestination, y: relativeDestination.y - 1 },
            "stone",
          ))
        )
          incomplete("BODY_RELATIVE_MOVE_FIXTURE_NOT_CLEAR");
        const relativeMove = await body.execute(
          {
            kind: "move_relative",
            offset: { x: 0, y: 0, z: 3 },
            range: 1,
          },
          abort.signal,
        );
        const afterRelativeMove = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const relativeMoveServerDisplacementObserved =
          afterRelativeMove.z - beforeRelativeMove.z >= 1.5 &&
          Math.abs(afterRelativeMove.x - beforeRelativeMove.x) <= 1.5;
        state.bodySmokeDiagnostic = {
          ...furnaceDiagnostic,
          relativeMoveStatus: relativeMove.status,
          relativeMoveServerDisplacementObserved,
        };
        if (
          relativeMove.status !== "successful" ||
          !relativeMoveServerDisplacementObserved
        )
          incomplete("BODY_RELATIVE_MOVE_NOT_CONFIRMED");
        await rcon.command(
          `tp ${state.botName} ${smokeSpawn.x} ${smokeSpawn.y} ${smokeSpawn.z} 0 0`,
        );
        const smokeEndPosition = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        if (!positionMatchesSmokeSpawn(smokeEndPosition))
          incomplete("BODY_SMOKE_SPAWN_RESET_NOT_CONFIRMED");
        if (progressiveNavigationProbeOnly) {
          await runProgressiveNavigationProbe(
            state,
            rcon,
            body,
            smokeSpawn,
            abort.signal,
          );
        }
        let obstacleRouteVerifiedByServer = false;
        if (process.env.AI_PLAYER_E2E_NAVIGATION_PROBE_ONLY === "YES") {
          await removeHiddenContainerFixture(rcon, smokeSpawn, {
            chest: fixturePoint(smokeSpawn, 6, 0),
          });
          await configureUnknownFixture(rcon, smokeSpawn, state.botName);
          const fixtureTarget = unknownFixtureTarget(smokeSpawn);
          if (!(await isBlock(rcon, fixtureTarget, "blue_wool")))
            incomplete("BODY_NAVIGATION_PROBE_FIXTURE_NOT_CONFIRMED");
          const navigationClientReadyBy = Date.now() + 5_000;
          let navigationClientSpawnConfirmed = false;
          while (Date.now() < navigationClientReadyBy) {
            navigationClientSpawnConfirmed = positionMatchesSmokeSpawn(
              (await body.observe()).self.position,
            );
            if (navigationClientSpawnConfirmed) break;
            await waitMs(100);
          }
          state.bodySmokeDiagnostic = {
            ...furnaceDiagnostic,
            ...state.bodySmokeDiagnostic,
            obstacleRouteClientSpawnConfirmed: navigationClientSpawnConfirmed,
          };
          if (!navigationClientSpawnConfirmed)
            incomplete("BODY_NAVIGATION_PROBE_CLIENT_SPAWN_NOT_CONFIRMED");
          const navigationStart = parsePosition(
            await rcon.command(`data get entity ${state.botName} Pos`),
          );
          let pathUpdateCount = 0;
          let lastPathStatus: BodyPathStatus = "none";
          let maxPathLength = 0;
          const unsubscribePathUpdates = body.onEvent((event) => {
            if (event.type !== "operation_path_updated") return;
            pathUpdateCount += 1;
            lastPathStatus = event.status;
            maxPathLength = Math.max(maxPathLength, event.pathLength);
          });
          const navigationAbort = new AbortController();
          const navigationTimer = setTimeout(
            () => navigationAbort.abort(new Error("navigation probe deadline")),
            20_000,
          );
          let navigationResult: Awaited<ReturnType<typeof body.execute>>;
          try {
            navigationResult = await body.execute(
              {
                kind: "move_relative",
                offset: {
                  x: fixtureTarget.x + 0.5 - smokeSpawn.x,
                  y: 0,
                  z: 0,
                },
                range: 1,
              },
              navigationAbort.signal,
            );
          } finally {
            clearTimeout(navigationTimer);
            unsubscribePathUpdates();
          }
          const navigationPosition = parsePosition(
            await rcon.command(`data get entity ${state.botName} Pos`),
          );
          const distanceToTarget = Math.hypot(
            navigationPosition.x - fixtureTarget.x,
            navigationPosition.y - fixtureTarget.y,
            navigationPosition.z - fixtureTarget.z,
          );
          obstacleRouteVerifiedByServer =
            navigationResult.status === "successful" &&
            distanceToTarget <= 1.75;
          state.bodySmokeDiagnostic = {
            ...furnaceDiagnostic,
            ...state.bodySmokeDiagnostic,
            obstacleRouteStatus: navigationResult.status,
            obstacleRouteDistanceBand:
              distanceToTarget <= 1.75
                ? "near"
                : distanceToTarget < 5
                  ? "middle"
                  : "far",
            obstacleRouteVerifiedByServer,
            obstacleRouteEastProgress:
              navigationPosition.x - navigationStart.x >= 1.5,
            obstacleRouteLateralProgress:
              Math.abs(navigationPosition.z - navigationStart.z) >= 1.5,
            obstacleRoutePathStatus: lastPathStatus,
            obstacleRoutePathUpdateCount: pathUpdateCount,
            obstacleRouteMaxPathBand:
              maxPathLength === 0
                ? "none"
                : maxPathLength < 5
                  ? "short"
                  : "long",
          };
          if (!obstacleRouteVerifiedByServer)
            incomplete("BODY_NAVIGATION_PROBE_ROUTE_NOT_CONFIRMED");
          const lookSweepResult = await body
            .execute({ kind: "look_sweep" }, abort.signal)
            .catch(() => undefined);
          const lookSweep = lookSweepResult?.lookSweep;
          const lookSweepViews =
            lookSweep === undefined
              ? []
              : [lookSweep.current, ...lookSweep.directions];
          const lookSweepAnyViewTargetName = lookSweepViews.some(
            ({ visibleBlocks }) =>
              visibleBlocks.some(({ name }) => name === "blue_wool"),
          );
          const lookSweepAnyTruncation =
            lookSweep?.candidateSearchMayBeTruncated === true ||
            lookSweepViews.some(
              (view) =>
                view.candidateSearchMayBeTruncated ||
                view.omittedBlockCandidates > 0 ||
                view.omittedEntityCandidates > 0,
            );
          const lookSweepDistinctYawCount = new Set(
            (lookSweep?.directions ?? []).map(({ yawDegrees }) => yawDegrees),
          ).size;
          const targetObservedInLookSweep =
            lookSweepResult?.status === "successful" &&
            lookSweep?.complete === true &&
            lookSweep.directions.some(({ visibleBlocks }) =>
              visibleBlocks.some(
                ({ name, position }) =>
                  name === "blue_wool" &&
                  position.x === fixtureTarget.x &&
                  position.y === fixtureTarget.y &&
                  position.z === fixtureTarget.z,
              ),
            );
          state.bodySmokeDiagnostic = {
            ...state.bodySmokeDiagnostic,
            obstacleRouteTargetObservedInSweep: targetObservedInLookSweep,
            obstacleRouteLookSweepStatus:
              lookSweepResult?.status ?? "unavailable",
            obstacleRouteLookSweepComplete: lookSweep?.complete === true,
            obstacleRouteLookSweepAnyViewTargetName: lookSweepAnyViewTargetName,
            obstacleRouteLookSweepAnyTruncation: lookSweepAnyTruncation,
            obstacleRouteLookSweepDistinctYawCount: lookSweepDistinctYawCount,
          };
          const targetLook = await body.execute(
            {
              kind: "look",
              target: {
                x: fixtureTarget.x + 0.5,
                y: fixtureTarget.y + 0.5,
                z: fixtureTarget.z + 0.5,
              },
            },
            abort.signal,
          );
          let targetVisibleAfterLook = false;
          const targetVisibilityDeadline = Date.now() + 5_000;
          while (Date.now() < targetVisibilityDeadline) {
            targetVisibleAfterLook =
              observedBlockName(await body.observe(), fixtureTarget) ===
              "blue_wool";
            if (targetVisibleAfterLook) break;
            await waitMs(100);
          }
          state.bodySmokeDiagnostic = {
            ...state.bodySmokeDiagnostic,
            obstacleRouteLookStatus: targetLook.status,
            obstacleRouteTargetVisibleAfterLook: targetVisibleAfterLook,
          };
          if (process.env.AI_PLAYER_E2E_OBSTACLE_RESTORE_PROBE_ONLY === "YES") {
            await rcon.command(
              `tp ${state.botName} ${smokeSpawn.x} ${smokeSpawn.y} ${smokeSpawn.z} 0 0`,
            );
            if (
              !positionMatchesSmokeSpawn(
                parsePosition(
                  await rcon.command(`data get entity ${state.botName} Pos`),
                ),
              )
            )
              incomplete("BODY_OBSTACLE_RESTORE_PROBE_CLEARANCE_NOT_CONFIRMED");
            const probeCenter = {
              x: fixtureTarget.x + 0.5,
              y: fixtureTarget.y,
              z: fixtureTarget.z + 0.5,
            };
            const probePlan = recoveryCagePlan(probeCenter, {
              x: 2_000,
              y: 64,
              z: 2_000,
            });
            const probeRcon = boundedOracleRcon(rcon);
            const probeDiagnostic = state.bodySmokeDiagnostic;
            const restoreResult = await withRestorableObstacle(
              probeRcon,
              probePlan,
              {
                eligible: () =>
                  nearbyEntitiesClear(probeRcon, probeCenter, state.botName),
                observeWhileApplied: async () => true,
                restoreInStableWorld: (restore) =>
                  withFrozenTicks(probeRcon, restore, incomplete),
                onRestoreFailure: (stage) => {
                  state.bodySmokeDiagnostic = {
                    ...probeDiagnostic,
                    obstacleRestoreProbeFailureStage: stage,
                  };
                },
              },
              incomplete,
            );
            const verified = restoreResult.status === "applied";
            state.bodySmokeDiagnostic = {
              ...probeDiagnostic,
              obstacleRestoreProbeVerified: verified,
            };
            if (!verified)
              incomplete("BODY_OBSTACLE_RESTORE_PROBE_NOT_APPLIED");
          }
          if (!targetObservedInLookSweep)
            incomplete("BODY_NAVIGATION_PROBE_LOOK_SWEEP_TARGET_NOT_OBSERVED");
        }
        if (returnPathProbeOnly) {
          await runUnknownReturnPathProbe(
            state,
            rcon,
            body,
            state.botName,
            smokeSpawn,
            abort.signal,
          );
        }
        state.autonomousRegion = await captureBlockBaseline(
          rcon,
          smokeEndPosition,
        );
        state.autonomousSmokeBaseline = await readWorldSnapshot(
          rcon,
          state.botName,
          state.autonomousRegion,
        );
        return {
          declaredOperationCount: names.size,
          nonOpDigAcceptedByServer: blockIsAir,
          representativeFurnaceWindowFlow: true,
          bodyObservedFurnaceInput: furnaceInputVisible,
          rconConfirmedFurnaceInput: furnaceInputConfirmed,
          transferReturnedInput: itemReturnedToInventory,
          windowClosed: true,
          bodyObservationAvailable: isRecord(visibleBefore),
          occludedFixtureItemOmitted: hiddenItemOmitted,
          gameKnowledgeAvailable: registryKnowledgeAvailable,
          resourceVisibleAfterSmoke,
          relativeMoveVerifiedByServer: relativeMoveServerDisplacementObserved,
          ...(process.env.AI_PLAYER_E2E_NAVIGATION_PROBE_ONLY === "YES"
            ? { obstacleRouteVerifiedByServer }
            : {}),
          ...(progressiveNavigationProbeOnly
            ? { progressiveNavigationDiagnosticOnly: true }
            : {}),
          ...(state.bodySmokeDiagnostic.obstacleRestoreProbeVerified === true
            ? { obstacleRestoreProbeVerified: true }
            : {}),
          gptCalls: 0,
          ...(returnPathProbeOnly ? { diagnosticOnly: true } : {}),
          apiOperationsReportedSuccess,
        };
      } finally {
        clearTimeout(abortTimer);
        if (target !== undefined) {
          await rcon
            .command(`setblock ${target.x} ${target.y} ${target.z} air`)
            .catch(() => undefined);
          await rcon
            .command(`clear ${state.botName} minecraft:raw_iron`)
            .catch(() => undefined);
        }
        await body?.stop().catch(() => undefined);
        await client.disconnect("ai_player_e2e_operation_smoke");
      }
    },
  );
  return result;
}

async function runDeathRecoveryFixtureProbe(
  state: RunState,
  rcon: LocalRcon,
  client: MineflayerClient,
  body: PlayerBody,
  signal: AbortSignal,
): Promise<Readonly<Record<string, boolean | number | string>>> {
  const fixtureSpawn = { x: 0.5, y: 64, z: 0.5 };
  let deathObservedAt: string | undefined;
  let removeDeathListener: (() => void) | undefined;
  let operationError: unknown;
  let cleanupConfirmed: boolean;
  let cleanupKeepInventoryRestored: boolean;
  let cleanupDropsAbsentConfirmed: boolean;
  let cleanupTestItemAbsentConfirmed = false;
  let cleanupBotAliveConfirmed: boolean;
  let cleanupBotPositionRestoredConfirmed = false;
  const diagnostic = (values: SafeEvidence): void => {
    state.deathRecoveryFixtureDiagnostic = {
      ...(state.deathRecoveryFixtureDiagnostic ?? {}),
      ...values,
    };
  };
  let evidence: Readonly<Record<string, boolean | number | string>> = {
    deathRecoveryFixtureProbeSelected: true,
    gptCalls: 0,
  };

  try {
    await rcon.command(`clear ${state.botName}`);
    await rcon.command(
      `tp ${state.botName} ${fixtureSpawn.x} ${fixtureSpawn.y} ${fixtureSpawn.z} 0 0`,
    );
    await rcon.command(`give ${state.botName} minecraft:blue_wool 1`);

    const setupDeadline = Date.now() + 5_000;
    let beforeDeath: PlayerBodyObservation | undefined;
    while (!signal.aborted && Date.now() < setupDeadline) {
      try {
        const observed = await body.observe();
        if (
          observed.self.inventory.some(
            (item) => item.name === "blue_wool" && item.count === 1,
          ) &&
          Math.hypot(
            observed.self.position.x - fixtureSpawn.x,
            observed.self.position.y - fixtureSpawn.y,
            observed.self.position.z - fixtureSpawn.z,
          ) <= 0.5
        ) {
          beforeDeath = observed;
          break;
        }
      } catch {
        // The fixed failure below represents missing setup readback.
      }
      await waitMs(100);
    }
    if (beforeDeath === undefined)
      incomplete("DEATH_RECOVERY_FIXTURE_BASELINE_NOT_CONFIRMED");
    if (
      beforeDeath.self.health === null ||
      beforeDeath.self.health <= 0 ||
      beforeDeath.self.inLava ||
      beforeDeath.self.onFire ||
      beforeDeath.self.suffocating
    ) {
      incomplete("DEATH_RECOVERY_FIXTURE_BASELINE_UNSAFE");
    }
    const serverBeforeDeath = parsePosition(
      await rcon.command(`data get entity ${state.botName} Pos`),
    );
    if (
      Math.hypot(
        serverBeforeDeath.x - beforeDeath.self.position.x,
        serverBeforeDeath.y - beforeDeath.self.position.y,
        serverBeforeDeath.z - beforeDeath.self.position.z,
      ) > 0.5
    ) {
      incomplete("DEATH_RECOVERY_FIXTURE_BODY_RCON_POSITION_MISMATCH");
    }
    const deathSite = beforeDeath.self.position;
    if ((await rconBlueWoolDropCountNear(rcon, deathSite, 4)) !== 0)
      incomplete("DEATH_RECOVERY_FIXTURE_DROP_BASELINE_NOT_EMPTY");
    if (!(await rconInventoryHasBlueWool(rcon, state.botName)))
      incomplete("DEATH_RECOVERY_FIXTURE_ITEM_NOT_CONFIRMED_BEFORE_DEATH");
    diagnostic({
      testItemConfirmedBeforeDeath: true,
      bodyRconPositionAgreementConfirmed: true,
      emptyDropBaselineConfirmed: true,
    });

    await setAndVerifyGamerule(rcon, "keepInventory", false);
    diagnostic({ keepInventoryFalseReadbackConfirmed: true });
    removeDeathListener = client.onDeath((at) => {
      deathObservedAt ??= at;
    });
    await rcon.command(`kill ${state.botName}`);
    const deathDeadline = Date.now() + 5_000;
    while (deathObservedAt === undefined && Date.now() < deathDeadline) {
      if (signal.aborted) incomplete("DEATH_RECOVERY_FIXTURE_CANCELLED");
      await waitMs(50);
    }
    if (
      deathObservedAt === undefined ||
      !Number.isFinite(Date.parse(deathObservedAt))
    )
      incomplete("DEATH_RECOVERY_FIXTURE_DEATH_EVENT_NOT_OBSERVED");
    diagnostic({ deathEventObserved: true });

    const respawnDeadline = Date.now() + 10_000;
    let afterDeath: PlayerBodyObservation | undefined;
    while (!signal.aborted && Date.now() < respawnDeadline) {
      try {
        const observed = await body.observe();
        const health = await rconEntityHealth(rcon, state.botName, 500);
        if (
          Date.parse(observed.observedAt) > Date.parse(deathObservedAt) &&
          observed.dimension === beforeDeath.dimension &&
          observed.self.health !== null &&
          observed.self.health > 0 &&
          health > 0
        ) {
          afterDeath = observed;
          break;
        }
      } catch {
        // A missing player entity or Body snapshot is not respawn evidence.
      }
      await waitMs(100);
    }
    if (afterDeath === undefined)
      incomplete("DEATH_RECOVERY_FIXTURE_RESPAWN_NOT_CONFIRMED");
    const testItemStillInInventory =
      afterDeath.self.inventory.some((item) => item.name === "blue_wool") ||
      (await rconInventoryHasBlueWool(rcon, state.botName));
    if (testItemStillInInventory) {
      incomplete("DEATH_RECOVERY_FIXTURE_DROP_NOT_REMOVED_FROM_INVENTORY");
    }
    diagnostic({
      respawnConfirmedByFreshBodyAndRcon: true,
      postDeathBodyObservationFresh: true,
      postDeathDimensionMatched: true,
      testItemAbsentFromBodyAndRconInventory: true,
    });

    const dropDeadline = Date.now() + 5_000;
    let dropCount = 0;
    while (!signal.aborted && Date.now() < dropDeadline) {
      dropCount = await rconBlueWoolDropCountNear(rcon, deathSite, 4);
      if (dropCount > 0) break;
      await waitMs(100);
    }
    if (dropCount !== 1)
      incomplete(
        dropCount === 0
          ? "DEATH_RECOVERY_FIXTURE_DROP_NOT_CONFIRMED_BY_RCON"
          : "DEATH_RECOVERY_FIXTURE_DROP_NOT_UNIQUE_BY_RCON",
      );
    const visibilityDeadline = Date.now() + 2_500;
    let visibilityObservationCount = 0;
    let observationAvailable = false;
    let visibleCount: number | undefined;
    let freshAfterDeath = false;
    let dimensionMatched = false;
    let perceptionTruncated = false;
    let dropVisibilityConfirmed = false;
    while (
      !signal.aborted &&
      visibilityObservationCount < 8 &&
      Date.now() < visibilityDeadline
    ) {
      visibilityObservationCount += 1;
      try {
        const observed = await body.observe();
        observationAvailable = true;
        visibleCount = observed.perception.entities.filter(
          (entity) =>
            !entity.isPlayer &&
            entity.name === "item" &&
            Math.hypot(
              entity.position.x - deathSite.x,
              entity.position.y - deathSite.y,
              entity.position.z - deathSite.z,
            ) <= 4,
        ).length;
        freshAfterDeath =
          Date.parse(observed.observedAt) > Date.parse(deathObservedAt);
        dimensionMatched = observed.dimension === beforeDeath.dimension;
        perceptionTruncated =
          observed.perception.candidateSearchMayBeTruncated ||
          observed.perception.omittedEntityCandidates > 0;
        dropVisibilityConfirmed = deathRecoveryDropConfirmed({
          deathEventObserved: Number.isFinite(Date.parse(deathObservedAt)),
          freshBodyAfterDeath: freshAfterDeath,
          dimensionMatched,
          testItemAbsentFromInventory: !testItemStillInInventory,
          rconDropCount: dropCount,
          bodyVisibleDropCount: visibleCount,
          bodyVisibilityComplete: !perceptionTruncated,
        });
      } catch {
        observationAvailable = false;
        visibleCount = undefined;
        freshAfterDeath = false;
        dimensionMatched = false;
        perceptionTruncated = false;
        dropVisibilityConfirmed = false;
      }
      diagnostic({
        dropVisibilityObservationCount: visibilityObservationCount,
        dropVisibilityReobserved: visibilityObservationCount > 1,
        dropVisibilityBodyObservationAvailable: observationAvailable,
        dropVisibilityCandidateCountBucket:
          visibleCount === undefined
            ? "unknown"
            : safeEntityCountBucket(visibleCount),
        dropVisibilityFreshAfterDeath: freshAfterDeath,
        dropVisibilityDimensionMatched: dimensionMatched,
        dropVisibilityPerceptionTruncated: perceptionTruncated,
        freshBodyDropVisibilityConfirmed: dropVisibilityConfirmed,
      });
      if (dropVisibilityConfirmed) break;
      if (Date.now() < visibilityDeadline && visibilityObservationCount < 8)
        await waitMs(200);
    }
    if (signal.aborted) incomplete("DEATH_RECOVERY_FIXTURE_CANCELLED");
    if (!dropVisibilityConfirmed) {
      incomplete("DEATH_RECOVERY_FIXTURE_DROP_NOT_VISIBLE_TO_FRESH_BODY");
    }
    diagnostic({
      deathDropConfirmedByRcon: true,
      freshBodyDropVisibilityConfirmed: true,
    });
    evidence = {
      deathRecoveryFixtureProbeSelected: true,
      testItemConfirmedBeforeDeath: true,
      keepInventoryFalseReadbackConfirmed: true,
      deathEventObserved: true,
      respawnConfirmedByFreshBodyAndRcon: true,
      testItemAbsentFromBodyAndRconInventory: true,
      deathDropConfirmedByRcon: true,
      freshBodyDropVisibilityConfirmed: true,
      gptCalls: 0,
    };
  } catch (error) {
    operationError = error;
  } finally {
    removeDeathListener?.();
    try {
      await setAndVerifyGamerule(rcon, "keepInventory", true);
      cleanupKeepInventoryRestored = true;
    } catch {
      cleanupKeepInventoryRestored = false;
    }
    try {
      await rcon.command(
        `execute positioned ${fixtureSpawn.x} ${fixtureSpawn.y} ${fixtureSpawn.z} run kill @e[type=minecraft:item,distance=..8,nbt={Item:{id:"minecraft:blue_wool"}}]`,
      );
      cleanupDropsAbsentConfirmed =
        (await rconBlueWoolDropCountNear(rcon, fixtureSpawn, 8)) === 0;
    } catch {
      cleanupDropsAbsentConfirmed = false;
    }
    const aliveDeadline = Date.now() + 5_000;
    let alive = false;
    while (!alive && Date.now() < aliveDeadline) {
      try {
        alive = (await rconEntityHealth(rcon, state.botName, 500)) > 0;
      } catch {
        // Wait for the isolated client to finish respawning before cleanup.
      }
      if (!alive) await waitMs(100);
    }
    cleanupBotAliveConfirmed = alive;
    if (alive) {
      try {
        await rcon.command(`clear ${state.botName} minecraft:blue_wool`);
        cleanupTestItemAbsentConfirmed = !(await rconInventoryHasBlueWool(
          rcon,
          state.botName,
        ));
      } catch {
        cleanupTestItemAbsentConfirmed = false;
      }
      try {
        await rcon.command(
          `tp ${state.botName} ${fixtureSpawn.x} ${fixtureSpawn.y} ${fixtureSpawn.z} 0 0`,
        );
        const restoredPosition = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        cleanupBotPositionRestoredConfirmed =
          Math.hypot(
            restoredPosition.x - fixtureSpawn.x,
            restoredPosition.y - fixtureSpawn.y,
            restoredPosition.z - fixtureSpawn.z,
          ) <= 0.5;
      } catch {
        cleanupBotPositionRestoredConfirmed = false;
      }
    }
    cleanupConfirmed =
      cleanupKeepInventoryRestored &&
      cleanupDropsAbsentConfirmed &&
      cleanupTestItemAbsentConfirmed &&
      cleanupBotAliveConfirmed &&
      cleanupBotPositionRestoredConfirmed;
    diagnostic({
      cleanupConfirmed,
      cleanupKeepInventoryRestored,
      cleanupDropsAbsentConfirmed,
      cleanupTestItemAbsentConfirmed,
      cleanupBotAliveConfirmed,
      cleanupBotPositionRestoredConfirmed,
    });
    if (!cleanupConfirmed)
      state.failureCode ??= "DEATH_RECOVERY_FIXTURE_CLEANUP_NOT_CONFIRMED";
  }
  if (operationError instanceof Error) throw operationError;
  if (operationError !== undefined)
    incomplete("DEATH_RECOVERY_FIXTURE_OPERATION_FAILED");
  if (!cleanupConfirmed)
    incomplete("DEATH_RECOVERY_FIXTURE_CLEANUP_NOT_CONFIRMED");
  return { ...evidence, deathRecoveryFixtureCleanupConfirmed: true };
}

async function rconBlueWoolDropCountNear(
  rcon: LocalRcon,
  center: Position,
  radius: 4 | 8,
): Promise<number> {
  const holder = "#death_fixture_drop";
  const reset = await rcon.command(`scoreboard players set ${holder} ai_e2e 0`);
  if (classifyRconReply(reset) !== "success")
    incomplete("DEATH_RECOVERY_FIXTURE_DROP_RCON_READBACK_UNAVAILABLE");
  const countReply = await rcon.command(
    `execute positioned ${center.x} ${center.y} ${center.z} as @e[type=minecraft:item,distance=..${radius},nbt={Item:{id:"minecraft:blue_wool"}}] run scoreboard players add ${holder} ai_e2e 1`,
  );
  if (
    !isNoEntitySelectionReply(countReply) &&
    classifyRconReply(countReply) !== "success"
  )
    incomplete("DEATH_RECOVERY_FIXTURE_DROP_RCON_READBACK_UNAVAILABLE");
  const scoreReply = await rcon.command(
    `scoreboard players get ${holder} ai_e2e`,
  );
  const count = parseScore(scoreReply, holder);
  if (count === undefined || !Number.isInteger(count) || count < 0)
    incomplete("DEATH_RECOVERY_FIXTURE_DROP_RCON_READBACK_UNAVAILABLE");
  return count;
}

function updateOwnerReturnDiagnostic(
  state: RunState,
  update: Partial<OwnerReturnDiagnostic>,
): void {
  state.ownerReturnDiagnostic = {
    stage: "not_started",
    ...state.ownerReturnDiagnostic,
    ...update,
  };
}

function ownerReturnDistanceBucket(
  distance: number,
): OwnerReturnDistanceBucket {
  return distance <= 1.75 ? "within_1_75" : "over_1_75";
}

export function ownerReturnProposalDisposition(
  proposal: Pick<PlayerEvidence["proposals"][number], "status"> | undefined,
): OwnerReturnProposalDisposition {
  const status = proposal?.status;
  return status === "pending" ||
    status === "adopted" ||
    status === "compromised" ||
    status === "declined"
    ? status
    : "unknown";
}

export function isOwnerProposalProgressable(
  disposition: OwnerReturnProposalDisposition,
  ownerGoalLinked: boolean,
): boolean {
  return (
    ownerGoalLinked &&
    (disposition === "adopted" || disposition === "compromised")
  );
}

export function ownerReturnArrivalConfirmed(
  sample: Pick<
    OwnerReturnWorldSample,
    | "bodySide"
    | "rconSide"
    | "bodyDistance"
    | "rconDistance"
    | "bodyRconAligned"
    | "doorState"
  >,
): boolean {
  return (
    sample.bodySide === "owner_side" &&
    sample.rconSide === "owner_side" &&
    sample.bodyDistance === "within_1_75" &&
    sample.rconDistance === "within_1_75" &&
    sample.bodyRconAligned &&
    sample.doorState === "open"
  );
}

export function ownerReturnAcceptanceEvidenceConfirmed(
  disposition: OwnerReturnProposalDisposition,
  ownerGoalLinked: boolean,
  ownerMoveJudgmentObserved: boolean,
  sample: OwnerReturnWorldSample,
): boolean {
  return (
    isOwnerProposalProgressable(disposition, ownerGoalLinked) &&
    ownerMoveJudgmentObserved &&
    ownerReturnArrivalConfirmed(sample)
  );
}

interface GatherMultiTargetFixture {
  readonly oakLog: BlockPosition;
  readonly birchLog: BlockPosition;
}

const GATHER_FIXTURE_JAVA_YAW = 180;

async function findGatherMultiTargetFixture(
  rcon: LocalRcon,
  origin: Position,
): Promise<GatherMultiTargetFixture> {
  for (const radius of [3, 4, 5, 6]) {
    const fixture = {
      oakLog: fixturePoint(origin, -1, -radius, Math.floor(origin.y)),
      birchLog: fixturePoint(origin, 1, -radius, Math.floor(origin.y)),
    };
    let sitesAvailable = true;
    for (const target of [fixture.oakLog, fixture.birchLog]) {
      if (
        !(await isBlock(rcon, target, "air")) ||
        !(await isBlock(rcon, { ...target, y: target.y + 1 }, "air")) ||
        !(await isBlock(rcon, { ...target, y: target.y - 1 }, "stone"))
      ) {
        sitesAvailable = false;
        break;
      }
    }
    if (!sitesAvailable) continue;
    try {
      for (const target of [fixture.oakLog, fixture.birchLog]) {
        await verifyUnknownFixtureSightline(
          rcon,
          { x: origin.x, y: origin.y + 1.62, z: origin.z },
          target,
          GATHER_FIXTURE_JAVA_YAW,
          "GATHER_MULTI_TARGET_FIXTURE_OUT_OF_VIEW",
          "GATHER_MULTI_TARGET_FIXTURE_OCCLUDED",
        );
      }
      return fixture;
    } catch (error) {
      if (
        error instanceof HarnessError &&
        (error.code === "GATHER_MULTI_TARGET_FIXTURE_OUT_OF_VIEW" ||
          error.code === "GATHER_MULTI_TARGET_FIXTURE_OCCLUDED")
      ) {
        continue;
      }
      throw error;
    }
  }
  incomplete("GATHER_MULTI_TARGET_FIXTURE_SITE_UNAVAILABLE");
}

async function readGatherMultiTargetInventoryCounts(
  state: RunState,
  rcon: LocalRcon,
  botName: string,
): Promise<Readonly<Record<GatherMultiTargetItem, number>>> {
  const result = await readGatherMultiTargetInventory(() =>
    rcon.command(`data get entity ${botName} Inventory`),
  );
  if (result.reason !== "parsed") {
    updateGatherMultiTargetDiagnostic(state, {
      gatherInventoryReadAvailable: false,
      gatherInventoryReadReason: result.reason,
    });
    incomplete("GATHER_MULTI_TARGET_INVENTORY_ORACLE_UNAVAILABLE");
  }
  return result.counts;
}

async function rconGatherLogDropCountNear(
  rcon: LocalRcon,
  center: Position,
  item: GatherMultiTargetItem,
): Promise<number> {
  const holder = "#gather_multi_target_drop";
  const reset = await rcon.command(`scoreboard players set ${holder} ai_e2e 0`);
  if (classifyRconReply(reset) !== "success")
    incomplete("GATHER_MULTI_TARGET_DROP_ORACLE_UNAVAILABLE");
  const countReply = await rcon.command(
    `execute positioned ${center.x} ${center.y} ${center.z} as @e[type=minecraft:item,distance=..4,nbt={Item:{id:"minecraft:${item}"}}] run scoreboard players add ${holder} ai_e2e 1`,
  );
  if (
    !isNoEntitySelectionReply(countReply) &&
    classifyRconReply(countReply) !== "success"
  )
    incomplete("GATHER_MULTI_TARGET_DROP_ORACLE_UNAVAILABLE");
  const scoreReply = await rcon.command(
    `scoreboard players get ${holder} ai_e2e`,
  );
  const count = parseScore(scoreReply, holder);
  if (count === undefined || !Number.isSafeInteger(count) || count < 0)
    incomplete("GATHER_MULTI_TARGET_DROP_ORACLE_UNAVAILABLE");
  return count;
}

async function rconGatherLogDropPositionNear(
  rcon: LocalRcon,
  center: Position,
  item: GatherMultiTargetItem,
): Promise<Position | undefined> {
  const selector = `@e[type=minecraft:item,distance=..4,sort=nearest,limit=1,nbt={Item:{id:"minecraft:${item}"}}]`;
  const reply = await rcon.command(
    `execute positioned ${center.x} ${center.y} ${center.z} if entity @e[type=minecraft:item,distance=..4,nbt={Item:{id:"minecraft:${item}"}}] run data get entity ${selector} Pos`,
  );
  const classification = classifyGatherDropReadbackReply(reply);
  if (classification === "position") return parsePosition(reply);
  if (classification === "known_negative") return undefined;
  incomplete("GATHER_MULTI_TARGET_DROP_ORACLE_UNAVAILABLE");
}

async function runGatherStackOracleProbe(
  state: RunState,
  rcon: LocalRcon,
  botName: string,
  body: PlayerBody,
): Promise<void> {
  if (appForCleanup !== undefined)
    incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_NOT_PRESTART");
  updateGatherMultiTargetDiagnostic(state, {
    gatherOracleProbeStarted: true,
    gatherOracleProbeGptFreeConfirmed: false,
    gatherOracleProbeRuntimeStarted: false,
    gatherOracleProbeProviderRequestsStarted: 0,
    gatherOracleProbeProviderRequestsRecorded: 0,
    gatherOracleProbeBlockedProviderRequests: "not_applicable_prestart",
    gatherOracleProbeCleanupConfirmed: false,
    ...gatherMultiTargetInventorySafeEvidence("Baseline", undefined),
    ...gatherMultiTargetInventorySafeEvidence("Final", undefined),
    gatherOracleProbeBaselineDropCount: null,
    gatherOracleProbeDropCountBeforeCollection: null,
    gatherOracleProbeDropCountAfterCollection: null,
  });
  const origin = parsePosition(
    await rcon.command(`data get entity ${botName} Pos`),
  );
  const fixture = await findGatherMultiTargetFixture(rcon, origin);
  const target = fixture.oakLog;
  const targetCenter = {
    x: target.x + 0.5,
    y: target.y + 0.5,
    z: target.z + 0.5,
  };
  let cleanupConfirmed: boolean;
  try {
    await rcon.command(`clear ${botName}`);
    if (
      !(await rconInventoryIsEmpty(
        rcon,
        botName,
        "GATHER_MULTI_TARGET_ORACLE_PROBE_INVENTORY_NOT_EMPTY",
      ))
    ) {
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_INVENTORY_NOT_EMPTY");
    }
    await rcon.command(
      `tp ${botName} ${origin.x} ${origin.y} ${origin.z} ${GATHER_FIXTURE_JAVA_YAW} ${LEARNING_FIXTURE_PITCH}`,
    );
    await rcon.command(
      `item replace entity ${botName} hotbar.0 with minecraft:oak_log 64`,
    );
    const baseline = await readGatherMultiTargetInventory(() =>
      rcon.command(`data get entity ${botName} Inventory`),
    );
    updateGatherMultiTargetDiagnostic(state, {
      ...gatherMultiTargetInventorySafeEvidence("Baseline", baseline),
    });
    const baselineFailureFields =
      gatherMultiTargetOracleProbeBaselineFailureFields(baseline);
    if (baselineFailureFields.length > 0) {
      updateGatherMultiTargetDiagnostic(state, {
        gatherOracleProbeBaselineMismatchFields:
          baselineFailureFields.join(","),
      });
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_STACK_BASELINE_UNCONFIRMED");
    }
    const dropBaseline = await rconGatherLogDropCountNear(
      rcon,
      targetCenter,
      "oak_log",
    );
    updateGatherMultiTargetDiagnostic(state, {
      gatherOracleProbeBaselineDropCount: dropBaseline,
    });
    if (dropBaseline !== 0) {
      updateGatherMultiTargetDiagnostic(state, {
        gatherOracleProbeBaselineMismatchFields: "drop_baseline",
      });
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_DROP_BASELINE_NOT_EMPTY");
    }
    await rcon.command(`setblock ${target.x} ${target.y} ${target.z} oak_log`);
    const blockPlaced = await isBlock(rcon, target, "oak_log");
    updateGatherMultiTargetDiagnostic(state, {
      gatherOracleProbeBlockPlacedByServer: blockPlaced,
    });
    if (!blockPlaced)
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_BLOCK_NOT_CONFIRMED");
    const initialBody = await body.observe();
    if (
      initialBody.self.inventory.reduce(
        (total, item) => total + (item.name === "oak_log" ? item.count : 0),
        0,
      ) !== 64
    ) {
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_BODY_BASELINE_UNCONFIRMED");
    }
    if (
      Math.hypot(
        initialBody.self.position.x - origin.x,
        initialBody.self.position.y - origin.y,
        initialBody.self.position.z - origin.z,
      ) > 0.75
    ) {
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_BODY_POSITION_UNCONFIRMED");
    }
    const look = await body.execute(
      { kind: "look", target: targetCenter },
      AbortSignal.timeout(15_000),
    );
    if (
      look.status !== "successful" ||
      observedBlockName(look.after, target) !== "oak_log"
    ) {
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_LOOK_UNCONFIRMED");
    }
    const dig = await body.execute(
      { kind: "dig", position: target },
      AbortSignal.timeout(30_000),
    );
    const blockRemoved = !(await isBlock(rcon, target, "oak_log"));
    const digConfirmed = dig.status === "successful" && blockRemoved;
    updateGatherMultiTargetDiagnostic(state, {
      gatherOracleProbeBodyDigConfirmed: digConfirmed,
      gatherOracleProbeBlockRemovedByServer: blockRemoved,
    });
    if (!digConfirmed)
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_DIG_UNCONFIRMED");
    updateGatherMultiTargetDiagnostic(state, {
      gatherOracleProbeDropCountBeforeCollection: null,
    });
    let dropCount = await rconGatherLogDropCountNear(
      rcon,
      targetCenter,
      "oak_log",
    );
    updateGatherMultiTargetDiagnostic(state, {
      gatherOracleProbeDropCountBeforeCollection: dropCount,
    });
    const dropDeadline = Date.now() + 2_000;
    while (dropCount === 0 && Date.now() < dropDeadline) {
      await waitMs(100);
      dropCount = await rconGatherLogDropCountNear(
        rcon,
        targetCenter,
        "oak_log",
      );
      updateGatherMultiTargetDiagnostic(state, {
        gatherOracleProbeDropCountBeforeCollection: dropCount,
      });
    }
    if (dropCount !== 1) {
      updateGatherMultiTargetDiagnostic(state, {
        gatherOracleProbeDropMismatch: true,
      });
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_DROP_NOT_UNIQUE");
    }
    const dropPosition = await rconGatherLogDropPositionNear(
      rcon,
      targetCenter,
      "oak_log",
    );
    if (dropPosition === undefined)
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_DROP_POSITION_UNAVAILABLE");
    const dropLook = await body.execute(
      { kind: "look", target: dropPosition },
      AbortSignal.timeout(15_000),
    );
    if (dropLook.status !== "successful")
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_DROP_LOOK_FAILED");
    let visibleDrop:
      PlayerBodyObservation["perception"]["entities"][number] | undefined;
    const visibilityDeadline = Date.now() + 5_000;
    while (Date.now() < visibilityDeadline) {
      const observation = await body.observe();
      const candidates = observation.perception.entities.filter(
        (entity) =>
          !entity.isPlayer &&
          entity.name === "item" &&
          Math.hypot(
            entity.position.x - dropPosition.x,
            entity.position.y - dropPosition.y,
            entity.position.z - dropPosition.z,
          ) <= 1,
      );
      if (candidates.length > 1)
        incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_DROP_AMBIGUOUS");
      visibleDrop = candidates[0];
      if (visibleDrop !== undefined) break;
      await waitMs(100);
    }
    if (visibleDrop === undefined)
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_DROP_NOT_VISIBLE_TO_BODY");
    const collection = await body.execute(
      { kind: "collect_item", entityId: visibleDrop.id },
      AbortSignal.timeout(30_000),
    );
    const collectionConfirmed =
      collection.status === "successful" &&
      collection.observedEffect?.type === "item_collected" &&
      collection.observedEffect.entityId === visibleDrop.id;
    updateGatherMultiTargetDiagnostic(state, {
      gatherOracleProbeBodyCollectionConfirmed: collectionConfirmed,
    });
    if (!collectionConfirmed)
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_COLLECTION_UNCONFIRMED");
    const inventoryAfter = await readGatherMultiTargetInventory(() =>
      rcon.command(`data get entity ${botName} Inventory`),
    );
    updateGatherMultiTargetDiagnostic(state, {
      ...gatherMultiTargetInventorySafeEvidence("Final", inventoryAfter),
      gatherOracleProbeDropCountAfterCollection: null,
    });
    const dropCountAfter = await rconGatherLogDropCountNear(
      rcon,
      targetCenter,
      "oak_log",
    );
    updateGatherMultiTargetDiagnostic(state, {
      gatherOracleProbeDropCountAfterCollection: dropCountAfter,
    });
    const resultFailureFields = gatherMultiTargetOracleProbeResultFailureFields(
      inventoryAfter,
      dropCountAfter,
    );
    if (resultFailureFields.length > 0) {
      updateGatherMultiTargetDiagnostic(state, {
        gatherOracleProbeResultMismatchFields: resultFailureFields.join(","),
      });
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_RESULT_UNCONFIRMED");
    }
    updateGatherMultiTargetDiagnostic(state, {
      gatherOracleProbeGptFreeConfirmed: true,
    });
  } finally {
    let targetBlockRemoved = false;
    let dropsRemoved = false;
    let inventoryRestored = false;
    try {
      await rcon.command(
        `fill ${target.x} ${target.y} ${target.z} ${target.x} ${target.y} ${target.z} air replace oak_log`,
      );
      await rcon.command(
        `execute positioned ${targetCenter.x} ${targetCenter.y} ${targetCenter.z} run kill @e[type=minecraft:item,distance=..4,nbt={Item:{id:"minecraft:oak_log"}}]`,
      );
      await rcon.command(`clear ${botName}`);
      targetBlockRemoved = await isBlock(rcon, target, "air");
      dropsRemoved =
        (await rconGatherLogDropCountNear(rcon, targetCenter, "oak_log")) === 0;
      inventoryRestored = await rconInventoryIsEmpty(
        rcon,
        botName,
        "GATHER_MULTI_TARGET_ORACLE_PROBE_CLEANUP_NOT_CONFIRMED",
      );
    } catch {
      // Still restore the known origin even when fixture cleanup failed.
    }
    let originRestored = false;
    const restoreDeadline = Date.now() + 5_000;
    try {
      await rcon.command(
        `tp ${botName} ${origin.x} ${origin.y} ${origin.z} 0 0`,
        Math.max(1, restoreDeadline - Date.now()),
      );
      while (Date.now() < restoreDeadline) {
        const remainingMs = Math.max(1, restoreDeadline - Date.now());
        const serverPosition = parsePosition(
          await rcon.command(`data get entity ${botName} Pos`, remainingMs),
        );
        const observationRemainingMs = Math.max(
          1,
          restoreDeadline - Date.now(),
        );
        let observationTimer: ReturnType<typeof setTimeout> | undefined;
        let observation: PlayerBodyObservation | undefined;
        try {
          observation = await Promise.race([
            body.observe(),
            new Promise<undefined>((resolve) => {
              observationTimer = setTimeout(
                () => resolve(undefined),
                observationRemainingMs,
              );
            }),
          ]);
        } finally {
          if (observationTimer !== undefined) clearTimeout(observationTimer);
        }
        if (observation === undefined) break;
        const bodyPosition = observation.self.position;
        const positionMatches = (left: Position, right: Position): boolean =>
          Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) <=
          0.5;
        originRestored =
          positionMatches(serverPosition, origin) &&
          positionMatches(bodyPosition, origin) &&
          positionMatches(serverPosition, bodyPosition);
        if (originRestored) break;
        const waitMsRemaining = restoreDeadline - Date.now();
        if (waitMsRemaining > 0) await waitMs(Math.min(100, waitMsRemaining));
      }
    } catch {
      originRestored = false;
    }
    cleanupConfirmed =
      targetBlockRemoved && dropsRemoved && inventoryRestored && originRestored;
    updateGatherMultiTargetDiagnostic(state, {
      gatherOracleProbeInventoryRestoredEmpty: inventoryRestored,
      gatherOracleProbeCleanupConfirmed: cleanupConfirmed,
    });
    if (!cleanupConfirmed)
      incomplete("GATHER_MULTI_TARGET_ORACLE_PROBE_CLEANUP_NOT_CONFIRMED");
  }
}

async function cleanupGatherMultiTargetFixture(
  state: RunState,
  rcon: LocalRcon,
  botName: string,
  fixture: GatherMultiTargetFixture,
): Promise<void> {
  updateGatherMultiTargetDiagnostic(state, {
    gatherFixtureCleanupConfirmed: false,
  });
  const dropReadbacks: GatherDropReadbackClass[] = [];
  let sourceBlocksAbsent = true;
  for (const [item, target] of [
    ["oak_log", fixture.oakLog],
    ["birch_log", fixture.birchLog],
  ] as const) {
    await rcon.command(
      `fill ${target.x} ${target.y} ${target.z} ${target.x} ${target.y} ${target.z} air replace ${item}`,
    );
    await rcon.command(
      `execute positioned ${target.x + 0.5} ${target.y + 0.5} ${target.z + 0.5} run kill @e[type=minecraft:item,distance=..3,nbt={Item:{id:"minecraft:${item}"}}]`,
    );
    const nearbyDrops = `@e[type=minecraft:item,distance=..3,nbt={Item:{id:"minecraft:${item}"}}]`;
    const singleNearbyDrop = `@e[type=minecraft:item,distance=..3,limit=1,nbt={Item:{id:"minecraft:${item}"}}]`;
    let dropReadback: GatherDropReadbackClass;
    try {
      const reply = await rcon.command(
        `execute positioned ${target.x + 0.5} ${target.y + 0.5} ${target.z + 0.5} if entity ${nearbyDrops} run data get entity ${singleNearbyDrop} Pos`,
      );
      dropReadback = classifyGatherDropReadbackReply(reply);
    } catch (error) {
      dropReadback = classifyGatherDropReadbackFailure(
        error instanceof HarnessError ? error.code : undefined,
      );
    }
    dropReadbacks.push(dropReadback);
    updateGatherMultiTargetDiagnostic(
      state,
      item === "oak_log"
        ? { gatherOakFixtureDropReadback: dropReadback }
        : { gatherBirchFixtureDropReadback: dropReadback },
    );
    sourceBlocksAbsent =
      sourceBlocksAbsent && !(await isBlock(rcon, target, item));
  }
  for (const item of GATHER_MULTI_TARGET_ITEMS) {
    await rcon.command(`clear ${botName} minecraft:${item}`);
  }
  const inventory = await readGatherMultiTargetInventory(() =>
    rcon.command(`data get entity ${botName} Inventory`),
  );
  const fixtureInventoryEmpty =
    inventory.reason === "parsed" &&
    GATHER_MULTI_TARGET_ITEMS.every((item) => inventory.counts[item] === 0);
  if (
    !gatherFixtureCleanupProofConfirmed(
      dropReadbacks,
      sourceBlocksAbsent,
      fixtureInventoryEmpty,
    )
  ) {
    incomplete("GATHER_MULTI_TARGET_FIXTURE_CLEANUP_UNVERIFIED");
  }
  updateGatherMultiTargetDiagnostic(state, {
    gatherFixtureCleanupConfirmed: true,
  });
}

async function runGatherMultiTargetContinuityCase(
  state: RunState,
  context: CaseContext,
): Promise<Readonly<Record<string, boolean | number | string>>> {
  let fixture: GatherMultiTargetFixture | undefined;
  let caseResult:
    Readonly<Record<string, boolean | number | string>> | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  let primaryFailed = false;
  let cleanupFailed = false;
  try {
    const quiet = await observeForPlayer(
      context,
      30_000,
      (player) => !player.stopped && !isOperationActive(player),
    );
    if (quiet === undefined)
      incomplete("GATHER_MULTI_TARGET_PRECONDITION_NOT_QUIET");

    await removeAutonomousResourceFixture(context.rcon);
    const origin = parsePosition(
      await context.rcon.command(`data get entity ${context.botName} Pos`),
    );
    const activeFixture = await findGatherMultiTargetFixture(
      context.rcon,
      origin,
    );
    fixture = activeFixture;
    for (const item of GATHER_MULTI_TARGET_ITEMS) {
      await context.rcon.command(`clear ${context.botName} minecraft:${item}`);
    }
    const baseline = await readGatherMultiTargetInventoryCounts(
      state,
      context.rcon,
      context.botName,
    );
    if (GATHER_MULTI_TARGET_ITEMS.some((item) => baseline[item] !== 0))
      incomplete("GATHER_MULTI_TARGET_INVENTORY_NOT_EMPTY");

    await context.rcon.command(
      `setblock ${activeFixture.oakLog.x} ${activeFixture.oakLog.y} ${activeFixture.oakLog.z} oak_log`,
    );
    await context.rcon.command(
      `setblock ${activeFixture.birchLog.x} ${activeFixture.birchLog.y} ${activeFixture.birchLog.z} birch_log`,
    );
    if (
      !(await isBlock(context.rcon, activeFixture.oakLog, "oak_log")) ||
      !(await isBlock(context.rcon, activeFixture.birchLog, "birch_log"))
    ) {
      incomplete("GATHER_MULTI_TARGET_FIXTURE_NOT_CONFIRMED");
    }
    await context.rcon.command(
      `tp ${context.botName} ${origin.x} ${origin.y} ${origin.z} ${GATHER_FIXTURE_JAVA_YAW} ${LEARNING_FIXTURE_PITCH}`,
    );
    const rotation = await readLearningFixtureRotation(
      context.rcon,
      context.botName,
    );
    if (
      rotation === undefined ||
      angularDistance(rotation.yaw, GATHER_FIXTURE_JAVA_YAW) > 2 ||
      Math.abs(rotation.pitch - LEARNING_FIXTURE_PITCH) > 2
    ) {
      incomplete("GATHER_MULTI_TARGET_ORIENTATION_NOT_CONFIRMED");
    }
    const fixtureConfiguredAt = Date.now();
    const visible = await observeForPlayer(context, 20_000, (player) => {
      const observedAt = Date.parse(player.lastObservation?.observedAt ?? "");
      const names = player.lastObservation?.visibleBlockNames ?? [];
      return (
        Number.isFinite(observedAt) &&
        observedAt >= fixtureConfiguredAt &&
        names.includes("oak_log") &&
        names.includes("birch_log")
      );
    });
    if (visible === undefined)
      incomplete("GATHER_MULTI_TARGET_BODY_FIXTURE_NOT_VISIBLE");
    updateGatherMultiTargetDiagnostic(state, {
      gatherFixtureConfigured: true,
      gatherFreshBodyObservationConfirmed: true,
      gatherRequestedOakLogCount: "unknown",
      gatherRequestedBirchLogCount: "unknown",
      gatherRemainingQuantity: "unknown",
      gatherInventoryBaselineOakLogCount: baseline.oak_log,
      gatherInventoryBaselineBirchLogCount: baseline.birch_log,
    });

    const beforeTask = playerOf(await collect(context.runtime.app));
    const priorProposalIds = new Set(beforeTask.proposals.map(({ id }) => id));
    const priorOutcomeIds = new Set(
      beforeTask.recentOutcomes.map(({ operationId }) => operationId),
    );
    const observedOutcomes = new Map<
      string,
      PlayerEvidence["recentOutcomes"][number]
    >();
    const rememberOutcomes = (player: PlayerEvidence): void => {
      for (const outcome of player.recentOutcomes) {
        if (!priorOutcomeIds.has(outcome.operationId)) {
          observedOutcomes.set(outcome.operationId, outcome);
        }
      }
      const bodyOutcomes = summarizeSuccessfulGatherBodyOutcomes([
        ...observedOutcomes.values(),
      ]);
      updateGatherMultiTargetDiagnostic(state, {
        gatherSuccessfulBodyOutcomeCount: bodyOutcomes.totalCount,
        gatherSuccessfulBodyOutcomeKindCounts: bodyOutcomes.kindCounts,
      });
    };

    sendChat(context.owner, "近くのオークの原木を集めてきて。進め方は任せる。");
    const initialIntent = await observeForPlayer(context, 45_000, (player) => {
      const proposalIds = newGatherTargetProposalIds({
        item: "oak_log",
        proposals: player.proposals,
        goals: player.goals,
        previousProposalIds: priorProposalIds,
      });
      return (
        proposalIds.length === 1 &&
        hasResolvedGatherTargetOwnerGoal({
          proposals: player.proposals,
          judgments: player.recentJudgments,
          goals: player.goals,
          proposalIds: new Set(proposalIds),
        })
      );
    });
    if (initialIntent === undefined)
      incomplete("GATHER_MULTI_TARGET_INITIAL_OAK_GOAL_NOT_ACCEPTED");
    const oakGoalProposalIds = new Set(
      newGatherTargetProposalIds({
        item: "oak_log",
        proposals: initialIntent.proposals,
        goals: initialIntent.goals,
        previousProposalIds: priorProposalIds,
      }),
    );
    const oakGoalCount = gatherTargetAcceptedGoalCount({
      item: "oak_log",
      proposals: initialIntent.proposals,
      judgments: initialIntent.recentJudgments,
      goals: initialIntent.goals,
      proposalIds: oakGoalProposalIds,
    });
    state.gatherMultiTargetRequestedCounts = {
      oak_log: oakGoalCount ?? "unknown",
      birch_log: "unknown",
    };
    updateGatherMultiTargetDiagnostic(state, {
      gatherRequestedOakLogCount: oakGoalCount ?? "unknown",
      gatherRequestedBirchLogCount: "unknown",
    });

    const firstOakProgress = await observeForPlayer(
      context,
      120_000,
      async (player) => {
        rememberOutcomes(player);
        const bodyOutcomes = summarizeSuccessfulGatherBodyOutcomes([
          ...observedOutcomes.values(),
        ]);
        if (bodyOutcomes.totalCount === 0) return false;
        updateGatherMultiTargetDiagnostic(state, {
          gatherInitialOakBodyProgressConfirmed: true,
        });
        return true;
      },
    );
    if (firstOakProgress === undefined)
      incomplete("GATHER_MULTI_TARGET_FIRST_OAK_PROGRESS_NOT_CONFIRMED");

    const beforeFollowup = playerOf(await collect(context.runtime.app));
    rememberOutcomes(beforeFollowup);
    const outcomeIdsBeforeFollowup = new Set(
      beforeFollowup.recentOutcomes.map(({ operationId }) => operationId),
    );
    const proposalIdsBeforeFollowup = new Set(
      beforeFollowup.proposals.map(({ id }) => id),
    );
    const followupSentAt = Date.now();
    sendChat(context.owner, "白樺の原木もお願い。");
    let birchProposalIds: readonly string[] = [];
    let birchAcceptedAt = Number.NaN;
    const birchIntent = await observeForPlayer(context, 45_000, (player) => {
      birchProposalIds = newGatherTargetProposalIds({
        item: "birch_log",
        proposals: player.proposals,
        goals: player.goals,
        previousProposalIds: proposalIdsBeforeFollowup,
      });
      if (
        birchProposalIds.length !== 1 ||
        !hasResolvedGatherTargetOwnerGoal({
          proposals: player.proposals,
          judgments: player.recentJudgments,
          goals: player.goals,
          proposalIds: new Set(birchProposalIds),
        })
      ) {
        return false;
      }
      const acceptedGoal = player.goals.find(
        ({ ownerProposalId, source, status }) =>
          birchProposalIds.includes(ownerProposalId ?? "") &&
          source === "owner" &&
          (status === "active" || status === "completed"),
      );
      birchAcceptedAt = Date.parse(acceptedGoal?.updatedAt ?? "");
      return (
        Number.isFinite(birchAcceptedAt) && birchAcceptedAt >= followupSentAt
      );
    });
    if (birchIntent === undefined)
      incomplete("GATHER_MULTI_TARGET_BIRCH_FOLLOWUP_NOT_ACCEPTED");
    const birchGoalCount = gatherTargetAcceptedGoalCount({
      item: "birch_log",
      proposals: birchIntent.proposals,
      judgments: birchIntent.recentJudgments,
      goals: birchIntent.goals,
      proposalIds: new Set(birchProposalIds),
    });
    state.gatherMultiTargetRequestedCounts = {
      oak_log: state.gatherMultiTargetRequestedCounts.oak_log,
      birch_log: birchGoalCount ?? "unknown",
    };
    updateGatherMultiTargetDiagnostic(state, {
      gatherBirchFollowupOwnerGoalAccepted: true,
      gatherRequestedBirchLogCount: birchGoalCount ?? "unknown",
    });

    const postFollowupOutcomes = new Map<
      string,
      PlayerEvidence["recentOutcomes"][number]
    >();
    let finalInventory:
      Readonly<Record<GatherMultiTargetItem, number>> | undefined;
    let finalOakRemoved: boolean | undefined;
    let finalBirchRemoved: boolean | undefined;
    let lastSampleAt = 0;
    const complete = await observeForPlayer(
      context,
      180_000,
      async (player) => {
        rememberOutcomes(player);
        for (const outcome of observedOutcomes.values()) {
          if (
            !outcomeIdsBeforeFollowup.has(outcome.operationId) &&
            Date.parse(outcome.observedAt ?? "") > birchAcceptedAt &&
            !postFollowupOutcomes.has(outcome.operationId)
          ) {
            postFollowupOutcomes.set(outcome.operationId, outcome);
          }
        }
        const bodyOutcomes = summarizeSuccessfulGatherBodyOutcomes([
          ...observedOutcomes.values(),
        ]);
        const followupBodyOutcomes = summarizeSuccessfulGatherBodyOutcomes(
          [...postFollowupOutcomes.values()],
          birchAcceptedAt,
        );
        updateGatherMultiTargetDiagnostic(state, {
          gatherSuccessfulBodyOutcomeCount: bodyOutcomes.totalCount,
          gatherSuccessfulBodyOutcomeKindCounts: bodyOutcomes.kindCounts,
          gatherPostBirchGoalBodyOutcomeCount: followupBodyOutcomes.totalCount,
          gatherPostBirchGoalBodyOutcomeKindCounts:
            followupBodyOutcomes.kindCounts,
        });
        if (Date.now() - lastSampleAt < 1_200) return false;
        lastSampleAt = Date.now();

        const inventory = await readGatherMultiTargetInventory(() =>
          context.rcon.command(`data get entity ${context.botName} Inventory`),
        );
        const inventoryParsed = inventory.reason === "parsed";
        const oakDelta = inventoryParsed
          ? inventory.counts.oak_log - baseline.oak_log
          : undefined;
        const birchDelta = inventoryParsed
          ? inventory.counts.birch_log - baseline.birch_log
          : undefined;
        updateGatherMultiTargetInventoryReadDiagnostic(
          state,
          inventory,
          baseline,
        );
        if (!inventoryParsed) return false;
        finalInventory = inventory.counts;
        try {
          finalOakRemoved = !(await isBlock(
            context.rcon,
            activeFixture.oakLog,
            "oak_log",
          ));
        } catch {
          finalOakRemoved = undefined;
        }
        try {
          finalBirchRemoved = !(await isBlock(
            context.rcon,
            activeFixture.birchLog,
            "birch_log",
          ));
        } catch {
          finalBirchRemoved = undefined;
        }
        updateGatherMultiTargetDiagnostic(state, {
          gatherOakBlockRemovedByServer: finalOakRemoved ?? null,
          gatherBirchBlockRemovedByServer: finalBirchRemoved ?? null,
        });
        return (
          oakDelta !== undefined &&
          oakDelta >= 1 &&
          birchDelta !== undefined &&
          birchDelta >= 1 &&
          bodyOutcomes.totalCount >= 2 &&
          followupBodyOutcomes.totalCount >= 1
        );
      },
    );
    if (complete === undefined || finalInventory === undefined)
      incomplete("GATHER_MULTI_TARGET_SERVER_AND_BODY_PROGRESS_NOT_CONFIRMED");
    const finalBodyOutcomes = summarizeSuccessfulGatherBodyOutcomes([
      ...observedOutcomes.values(),
    ]);
    const finalPostBirchBodyOutcomes = summarizeSuccessfulGatherBodyOutcomes(
      [...postFollowupOutcomes.values()],
      birchAcceptedAt,
    );
    updateGatherMultiTargetDiagnostic(state, {
      gatherOakLogInventoryDelta: finalInventory.oak_log - baseline.oak_log,
      gatherBirchLogInventoryDelta:
        finalInventory.birch_log - baseline.birch_log,
      gatherOakBlockRemovedByServer: finalOakRemoved ?? null,
      gatherBirchBlockRemovedByServer: finalBirchRemoved ?? null,
      gatherSuccessfulBodyOutcomeCount: finalBodyOutcomes.totalCount,
      gatherSuccessfulBodyOutcomeKindCounts: finalBodyOutcomes.kindCounts,
      gatherPostBirchGoalBodyOutcomeCount:
        finalPostBirchBodyOutcomes.totalCount,
      gatherPostBirchGoalBodyOutcomeKindCounts:
        finalPostBirchBodyOutcomes.kindCounts,
    });
    const oakDelta = finalInventory.oak_log - baseline.oak_log;
    const birchDelta = finalInventory.birch_log - baseline.birch_log;
    const requestedCounts = state.gatherMultiTargetRequestedCounts ?? {
      oak_log: "unknown",
      birch_log: "unknown",
    };
    const oakRemaining =
      typeof requestedCounts.oak_log === "number"
        ? Math.max(0, requestedCounts.oak_log - oakDelta)
        : "unknown";
    const birchRemaining =
      typeof requestedCounts.birch_log === "number"
        ? Math.max(0, requestedCounts.birch_log - birchDelta)
        : "unknown";
    const goalCountsKnown =
      typeof requestedCounts.oak_log === "number" &&
      typeof requestedCounts.birch_log === "number";
    updateGatherMultiTargetDiagnostic(state, {
      gatherRemainingOakLogCount: oakRemaining,
      gatherRemainingBirchLogCount: birchRemaining,
      gatherRemainingQuantity: !goalCountsKnown
        ? "unknown"
        : oakRemaining === 0 && birchRemaining === 0
          ? "none_by_known_goal_counts"
          : "known_remaining",
      gatherGoalCompletionStatus: !goalCountsKnown
        ? "unknown_target_quantity_unspecified"
        : oakRemaining === 0 && birchRemaining === 0
          ? "target_counts_reached"
          : "target_counts_remaining",
    });

    await sampleGatherProgressReply(
      state,
      context,
      activeFixture,
      baseline,
      requestedCounts,
    );
    const progressExplanationStatus =
      state.gatherMultiTargetDiagnostic?.gatherProgressExplanationStatus;
    if (
      progressExplanationStatus ===
      "sampled_world_changed_pending_private_review"
    )
      incomplete(
        "GATHER_MULTI_TARGET_PROGRESS_WORLD_CHANGED_PENDING_PRIVATE_REVIEW",
      );
    if (progressExplanationStatus === "sampled_pending_private_review")
      incomplete("GATHER_MULTI_TARGET_PROGRESS_PRIVATE_REVIEW_PENDING");

    const requestGate = state.gatherMultiTargetRequestGate;
    if (requestGate === undefined)
      incomplete("GATHER_MULTI_TARGET_ACCEPTANCE_GATE_MISSING");
    requestGate.latch();
    updateGatherMultiTargetDiagnostic(state, {
      gatherAcceptanceLatched: true,
    });
    if (!(await settleGatherMultiTargetProviderRequests(context, state)))
      incomplete("GATHER_MULTI_TARGET_ACCEPTED_REQUESTS_NOT_SETTLED");

    await cleanupGatherMultiTargetFixture(
      state,
      context.rcon,
      context.botName,
      activeFixture,
    );
    fixture = undefined;
    caseResult = {
      ...gatherMultiTargetSafeEvidence(state),
      gatherIndependentTargetInventoryIncreasesConfirmed: true,
      gatherMultipleSuccessfulBodyOutcomesConfirmed: true,
      gatherProgressExplanationStatus:
        typeof state.gatherMultiTargetDiagnostic
          ?.gatherProgressExplanationStatus === "string"
          ? state.gatherMultiTargetDiagnostic.gatherProgressExplanationStatus
          : "not_sampled",
      gatherGoalCompletionStatus: !goalCountsKnown
        ? "unknown_target_quantity_unspecified"
        : oakRemaining === 0 && birchRemaining === 0
          ? "target_counts_reached"
          : "target_counts_remaining",
    };
  } catch (error) {
    primaryError = error;
    primaryFailed = true;
  } finally {
    if (fixture !== undefined) {
      try {
        await cleanupGatherMultiTargetFixture(
          state,
          context.rcon,
          context.botName,
          fixture,
        );
      } catch (error) {
        cleanupError = error;
        cleanupFailed = true;
      }
    }
  }
  if (primaryFailed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
  if (caseResult === undefined)
    throw new Error("Gather case returned no result");
  return caseResult;
}

async function sampleGatherProgressReply(
  state: RunState,
  context: CaseContext,
  fixture: GatherMultiTargetFixture,
  baseline: Readonly<Record<GatherMultiTargetItem, number>>,
  requestedCounts: Readonly<Record<GatherMultiTargetItem, number | "unknown">>,
): Promise<void> {
  const requestGate = state.gatherMultiTargetRequestGate;
  if (requestGate === undefined || requestGate.latched)
    incomplete("GATHER_MULTI_TARGET_ACCEPTANCE_GATE_MISSING");
  const priorReplySettled = await observeForPlayer(
    context,
    Math.max(
      1,
      Math.min(
        15_000,
        context.caseDeadlineAt - Date.now(),
        context.runDeadlineAt - Date.now(),
      ),
    ),
    (player) =>
      !player.stopped &&
      !isOperationActive(player) &&
      requestGate.inFlightRequests === 0,
  );
  if (priorReplySettled === undefined)
    incomplete("GATHER_MULTI_TARGET_PRIOR_REPLY_NOT_SETTLED");
  const before = await readGatherMultiTargetInventory(() =>
    context.rcon.command(`data get entity ${context.botName} Inventory`),
  );
  updateGatherMultiTargetInventoryReadDiagnostic(state, before, baseline);
  if (before.reason !== "parsed")
    incomplete("GATHER_MULTI_TARGET_PROGRESS_ORACLE_UNAVAILABLE");
  const readBlockRemoved = async (
    target: Position,
    item: GatherMultiTargetItem,
  ): Promise<boolean | undefined> => {
    try {
      return !(await isBlock(context.rcon, target, item));
    } catch {
      return undefined;
    }
  };
  const oakBlockRemovedBefore = await readBlockRemoved(
    fixture.oakLog,
    "oak_log",
  );
  const birchBlockRemovedBefore = await readBlockRemoved(
    fixture.birchLog,
    "birch_log",
  );
  const responseStart = context.responseQueue.length;
  const questionSentAt = Date.now();
  updateGatherMultiTargetDiagnostic(state, {
    gatherProgressQuestionSent: true,
    gatherProgressReplySampled: false,
    gatherProgressReplyReviewRequired: true,
    gatherProgressExplanationStatus: "not_sampled",
  });
  sendChat(
    context.owner,
    "今、オークと白樺の原木はそれぞれ何個集まり、目標まで何個残っていますか？目標量が分からない場合は残り不明と教えてください。",
  );
  const replyTimeoutMs = Math.max(
    1,
    Math.min(
      45_000,
      context.caseDeadlineAt - Date.now(),
      context.runDeadlineAt - Date.now(),
    ),
  );
  await observeForPlayer(context, replyTimeoutMs, () =>
    context.responseQueue.some(({ at }) => at >= questionSentAt),
  );
  const reply = context.responseQueue
    .slice(responseStart)
    .find(({ at }) => at >= questionSentAt);
  if (reply === undefined) {
    incomplete("GATHER_MULTI_TARGET_PROGRESS_REPLY_NOT_SAMPLED");
  }
  const hash = await retainGatherProgressReply(state, reply.text);
  const after = await readGatherMultiTargetInventory(() =>
    context.rcon.command(`data get entity ${context.botName} Inventory`),
  );
  updateGatherMultiTargetInventoryReadDiagnostic(state, after, baseline);
  if (after.reason !== "parsed")
    incomplete("GATHER_MULTI_TARGET_PROGRESS_ORACLE_UNAVAILABLE");
  const oakBlockRemovedAfter = await readBlockRemoved(
    fixture.oakLog,
    "oak_log",
  );
  const birchBlockRemovedAfter = await readBlockRemoved(
    fixture.birchLog,
    "birch_log",
  );
  const inventoryStable = GATHER_MULTI_TARGET_ITEMS.every(
    (item) => before.counts[item] === after.counts[item],
  );
  const observedOak = after.counts.oak_log - baseline.oak_log;
  const observedBirch = after.counts.birch_log - baseline.birch_log;
  const oakRemaining =
    typeof requestedCounts.oak_log === "number"
      ? Math.max(0, requestedCounts.oak_log - observedOak)
      : "unknown";
  const birchRemaining =
    typeof requestedCounts.birch_log === "number"
      ? Math.max(0, requestedCounts.birch_log - observedBirch)
      : "unknown";
  updateGatherMultiTargetDiagnostic(state, {
    gatherProgressReplySampled: true,
    gatherProgressReplyReceivedAfterQuestion: true,
    gatherProgressReplyHash: hash,
    gatherProgressReplySidecarRetained:
      state.gatherProgressReplySidecarRetained === true,
    gatherProgressReplyReviewRequired: true,
    gatherProgressInventoryStableWhileReplying: inventoryStable,
    gatherOakBlockRemovedBeforeProgressReply: oakBlockRemovedBefore ?? null,
    gatherBirchBlockRemovedBeforeProgressReply: birchBlockRemovedBefore ?? null,
    gatherOakBlockRemovedAfterProgressReply: oakBlockRemovedAfter ?? null,
    gatherBirchBlockRemovedAfterProgressReply: birchBlockRemovedAfter ?? null,
    gatherProgressObservedOakLogCount: observedOak,
    gatherProgressObservedBirchLogCount: observedBirch,
    gatherProgressRequestedOakLogCount: requestedCounts.oak_log,
    gatherProgressRequestedBirchLogCount: requestedCounts.birch_log,
    gatherProgressRemainingOakLogCount: oakRemaining,
    gatherProgressRemainingBirchLogCount: birchRemaining,
    gatherProgressExplanationStatus: inventoryStable
      ? "sampled_pending_private_review"
      : "sampled_world_changed_pending_private_review",
  });
}

async function settleGatherMultiTargetProviderRequests(
  context: CaseContext,
  state: RunState,
): Promise<boolean> {
  const gate = state.gatherMultiTargetRequestGate;
  const usageStart = state.gatherMultiTargetRequestGateUsageStart;
  if (gate === undefined || usageStart === undefined || !gate.latched)
    return false;
  const deadline = Math.min(
    Date.now() + 15_000,
    context.caseDeadlineAt,
    context.runDeadlineAt,
  );
  while (Date.now() < deadline) {
    const player = playerOf(await collect(context.runtime.app));
    gate.observeRecordedCalls(
      subtractCounters(player.counters, usageStart).llmCalls,
    );
    if (gate.requestsRecorded > gate.requestsStarted) return false;
    updateGatherMultiTargetDiagnostic(state, {
      gatherAcceptedRequestsStarted: gate.requestsStarted,
      gatherAcceptedRequestsRecorded: gate.requestsRecorded,
      gatherAcceptedRequestsInFlight: gate.inFlightRequests,
      gatherProviderRequestsBlockedAfterLatch:
        gate.providerRequestsBlockedAfterLatch,
    });
    if (gate.inFlightRequests === 0) return true;
    await waitMs(150);
  }
  return false;
}

export function ownerReturnRequestGateEnabled(
  targetCase: TargetableCase | undefined,
): boolean {
  return targetCase === "owner_return_through_door";
}

export function ownerReturnCaseCallLimit(
  targetCase: TargetableCase | undefined,
  configuredCalls: number,
  gate: Pick<AcceptedProviderRequestGate, "requestsStarted"> | undefined,
): number | undefined {
  if (!ownerReturnRequestGateEnabled(targetCase)) return configuredCalls;
  if (
    gate === undefined ||
    !Number.isSafeInteger(configuredCalls) ||
    configuredCalls < 0 ||
    !Number.isSafeInteger(gate.requestsStarted) ||
    gate.requestsStarted < 0
  ) {
    return undefined;
  }
  return Math.max(0, configuredCalls - gate.requestsStarted);
}

export type OwnerReturnRequestAdmissionErrorCode =
  | "OWNER_RETURN_REQUEST_GATE_NOT_READY"
  | "CASE_LLM_BUDGET_EXCEEDED"
  | "OWNER_RETURN_REQUEST_ADMISSION_LATCHED";

export function admitOwnerReturnProviderRequest(
  gate: AcceptedProviderRequestGate | undefined,
  caseCallLimit: number,
  admit: () => void,
  createError: (code: OwnerReturnRequestAdmissionErrorCode) => Error,
): void {
  if (
    gate === undefined ||
    !Number.isSafeInteger(caseCallLimit) ||
    caseCallLimit < 1
  ) {
    throw createError("OWNER_RETURN_REQUEST_GATE_NOT_READY");
  }
  gate.beforeCall(
    () => {
      if (gate.requestsStarted >= caseCallLimit)
        throw createError("CASE_LLM_BUDGET_EXCEEDED");
      admit();
    },
    () => createError("OWNER_RETURN_REQUEST_ADMISSION_LATCHED"),
  );
}

export function createOwnerReturnRequestTracking(
  targetCase: TargetableCase | undefined,
  preStartCounters: Counters,
  existingGate?: AcceptedProviderRequestGate,
):
  | Readonly<{
      usageStart: Counters;
      gate: AcceptedProviderRequestGate;
    }>
  | undefined {
  if (!ownerReturnRequestGateEnabled(targetCase)) return undefined;
  return {
    usageStart: preStartCounters,
    gate: existingGate ?? new AcceptedProviderRequestGate(),
  };
}

function ownerReturnRequestDiagnosticPatch(
  state: RunState,
  status: AcceptedProviderRequestSettleStatus,
  settled: boolean,
): Partial<OwnerReturnDiagnostic> {
  const gate = state.ownerReturnRequestGate;
  return {
    acceptedProviderRequestsLatched: gate?.latched === true,
    acceptedProviderRequestsStarted: gate?.requestsStarted ?? 0,
    acceptedProviderRequestsRecorded: gate?.requestsRecorded ?? 0,
    acceptedProviderRequestsInFlight: gate?.inFlightRequests ?? 0,
    acceptedProviderRequestsBlockedAfterLatch:
      gate?.providerRequestsBlockedAfterLatch ?? 0,
    acceptedProviderRequestsSettled: settled,
    acceptedProviderRequestSettleStatus: status,
  };
}

function ownerReturnGoalStatus(
  value: string | undefined,
): NonNullable<OwnerReturnDiagnostic["ownerGoalStatusAtStop"]> {
  return value === "active" ||
    value === "paused" ||
    value === "completed" ||
    value === "abandoned"
    ? value
    : "unknown";
}

export function ownerReturnToolNamesSince(
  activities: readonly Pick<
    PlayerAgentRoundActivity,
    "runSequence" | "round" | "role" | "toolCalls"
  >[],
  previousActivities: readonly Pick<
    PlayerAgentRoundActivity,
    "runSequence" | "round" | "role" | "toolCalls"
  >[],
): Readonly<{
  conversation: readonly PlayerAgentToolName[];
  purpose: readonly PlayerAgentToolName[];
}> {
  const activityKey = (
    activity: Pick<PlayerAgentRoundActivity, "runSequence" | "round" | "role">,
  ): string => `${activity.runSequence}:${activity.role}:${activity.round}`;
  const previousRounds = new Set(previousActivities.map(activityKey));
  const namesByRole = {
    conversation: new Set<PlayerAgentToolName>(),
    purpose: new Set<PlayerAgentToolName>(),
  };
  for (const activity of activities) {
    if (previousRounds.has(activityKey(activity))) continue;
    const names = namesByRole[activity.role];
    for (const toolCall of activity.toolCalls) names.add(toolCall.name);
  }
  return {
    conversation: [...namesByRole.conversation].sort(),
    purpose: [...namesByRole.purpose].sort(),
  };
}

async function runOwnerReturnThroughDoorCase(
  state: RunState,
  context: CaseContext,
): Promise<Readonly<Record<string, boolean | number | string>>> {
  const body = activeApplicationPlayerBody;
  if (body === undefined)
    incomplete("OWNER_RETURN_APPLICATION_BODY_UNAVAILABLE");
  const rcon = context.rcon;
  const origin = { x: 0.5, y: 64, z: 0.5 };
  const door = fixturePoint(origin, 2, 0);
  const start = { x: door.x + 6.5, y: 68, z: door.z + 0.5 };
  const ownerTarget = { x: origin.x, y: origin.y, z: origin.z };
  const stairBlocks = [
    { x: door.x + 1, y: 64, z: door.z },
    { x: door.x + 2, y: 65, z: door.z },
    { x: door.x + 3, y: 66, z: door.z },
    { x: door.x + 4, y: 67, z: door.z },
  ] as const;
  const supports = [
    { x: door.x + 2, y: 64, z: door.z },
    { x: door.x + 3, y: 64, z: door.z },
    { x: door.x + 3, y: 65, z: door.z },
    { x: door.x + 4, y: 64, z: door.z },
    { x: door.x + 4, y: 65, z: door.z },
    { x: door.x + 4, y: 66, z: door.z },
  ] as const;
  const platform = [
    { x: door.x + 5, y: 67, z: door.z },
    { x: door.x + 6, y: 67, z: door.z },
  ] as const;
  const hiddenFixture = { chest: fixturePoint(origin, 6, 0) };
  let fixtureMutationStarted = false;
  let arrived = false;
  const commandText = (...parts: (string | number)[]): string => parts.join("");
  const update = (patch: Partial<OwnerReturnDiagnostic>): void =>
    updateOwnerReturnDiagnostic(state, patch);
  const sampleWorld = async (): Promise<OwnerReturnWorldSample> => {
    const [bodyObservation, botPositionText, ownerPositionText] =
      await Promise.all([
        body.observe(),
        rcon.command("data get entity " + context.botName + " Pos"),
        rcon.command("data get entity " + context.ownerName + " Pos"),
      ]);
    const [botPosition, ownerPosition] = [
      parsePosition(botPositionText),
      parsePosition(ownerPositionText),
    ];
    const bodyPosition = bodyObservation.self.position;
    const bodyDistance = Math.hypot(
      bodyPosition.x - ownerPosition.x,
      bodyPosition.y - ownerPosition.y,
      bodyPosition.z - ownerPosition.z,
    );
    const rconDistance = Math.hypot(
      botPosition.x - ownerPosition.x,
      botPosition.y - ownerPosition.y,
      botPosition.z - ownerPosition.z,
    );
    return {
      bodySide: progressiveNavigationSide(bodyPosition, door.x),
      rconSide: progressiveNavigationSide(botPosition, door.x),
      bodyDistance: ownerReturnDistanceBucket(bodyDistance),
      rconDistance: ownerReturnDistanceBucket(rconDistance),
      bodyRconAligned:
        Math.hypot(
          bodyPosition.x - botPosition.x,
          bodyPosition.y - botPosition.y,
          bodyPosition.z - botPosition.z,
        ) <= 1.5,
      doorState: await readProgressiveNavigationDoorState(
        rcon,
        door,
        context.botName,
      ),
    };
  };
  const updateWorldDiagnostic = (
    sample: OwnerReturnWorldSample,
    before: boolean,
  ): void => {
    update(
      before
        ? {
            bodySideBefore: sample.bodySide,
            rconSideBefore: sample.rconSide,
            bodyDistanceBefore: sample.bodyDistance,
            rconDistanceBefore: sample.rconDistance,
            bodyRconSampleAlignedBefore: sample.bodyRconAligned,
            doorStateBefore: sample.doorState,
          }
        : {
            bodySideAfter: sample.bodySide,
            rconSideAfter: sample.rconSide,
            bodyDistanceAfter: sample.bodyDistance,
            rconDistanceAfter: sample.rconDistance,
            bodyRconSampleAlignedAfter: sample.bodyRconAligned,
            doorStateAfter: sample.doorState,
          },
    );
  };
  let stopWorldSampleAttempted = false;
  let projectOwnerReturnStopPlayer:
    ((player: PlayerEvidence) => void) | undefined;
  let ownerRequestSent = false;
  const sampleStopWorldOnce = async (): Promise<void> => {
    if (stopWorldSampleAttempted) return;
    stopWorldSampleAttempted = true;
    try {
      const sample = await sampleWorld();
      updateWorldDiagnostic(sample, false);
      update({
        bodyReachedOwnerSide: sample.bodySide === "owner_side",
        rconReachedOwnerSide: sample.rconSide === "owner_side",
        bodyAndRconArrivalObserved: ownerReturnArrivalConfirmed(sample),
      });
    } catch {
      update({
        bodySideAfter: "unknown",
        rconSideAfter: "unknown",
        bodyDistanceAfter: "unknown",
        rconDistanceAfter: "unknown",
        bodyRconSampleAlignedAfter: "unknown",
        doorStateAfter: "unknown",
        bodyReachedOwnerSide: "unknown",
        rconReachedOwnerSide: "unknown",
        bodyAndRconArrivalObserved: "unknown",
      });
    }
  };
  const finalizeBudgetStop = async (
    player: PlayerEvidence | undefined,
    _reason: string,
  ): Promise<void> => {
    state.ownerReturnRequestGate?.latch();
    update({ stopReason: "budget_stop", ownerRequestSent });
    if (player !== undefined && projectOwnerReturnStopPlayer !== undefined) {
      projectOwnerReturnStopPlayer(player);
    } else {
      update({
        stopPlayerEvidenceAvailable: player !== undefined,
        newOwnerProposalObserved: "unknown",
        ownerProposalDisposition: "unknown",
        ownerProposalAdoptedForRequest: "unknown",
        ownerProposalProgressableForRequest: "unknown",
        ownerGoalLinked: "unknown",
        ownerGoalStatusAtStop: "unknown",
        ownerMoveJudgmentObserved: "unknown",
        moveOutcomeStatus: "unknown",
        activeOperationPresentAtStop:
          player === undefined ? "unknown" : isOperationActive(player),
        toolNamesByRole: "unknown",
      });
    }
    await settleOwnerReturnRequests(state, context);
    await sampleStopWorldOnce();
  };

  update({ stage: "fixture_setup" });
  try {
    const idle = await observeForPlayer(
      context,
      15_000,
      (player) => !isOperationActive(player),
      ownerReturnRequestGateEnabled(state.targetCase)
        ? finalizeBudgetStop
        : undefined,
    );
    if (idle === undefined) incomplete("OWNER_RETURN_BODY_NOT_IDLE");
    fixtureMutationStarted = true;
    await removeHiddenContainerFixture(rcon, origin, hiddenFixture);
    await rcon.command(
      commandText(
        "kill @e[type=minecraft:item,x=",
        hiddenFixture.chest.x,
        ",y=",
        hiddenFixture.chest.y,
        ",z=",
        hiddenFixture.chest.z,
        ",distance=..3]",
      ),
    );
    await rcon.command(
      commandText(
        "fill ",
        door.x,
        " 64 ",
        door.z - 1,
        " ",
        Math.floor(start.x),
        " 69 ",
        door.z - 1,
        " stone",
      ),
    );
    await rcon.command(
      commandText(
        "fill ",
        door.x,
        " 64 ",
        door.z + 1,
        " ",
        Math.floor(start.x),
        " 69 ",
        door.z + 1,
        " stone",
      ),
    );
    for (const support of supports) {
      await rcon.command(
        commandText(
          "setblock ",
          support.x,
          " ",
          support.y,
          " ",
          support.z,
          " stone",
        ),
      );
    }
    for (const block of platform) {
      await rcon.command(
        commandText("setblock ", block.x, " ", block.y, " ", block.z, " stone"),
      );
    }
    await rcon.command(
      commandText(
        "setblock ",
        door.x,
        " ",
        door.y,
        " ",
        door.z,
        " oak_door[facing=west,half=lower,hinge=left,open=false,powered=false]",
      ),
    );
    await rcon.command(
      commandText(
        "setblock ",
        door.x,
        " ",
        door.y + 1,
        " ",
        door.z,
        " oak_door[facing=west,half=upper,hinge=left,open=false,powered=false]",
      ),
    );
    for (const stair of stairBlocks) {
      await rcon.command(
        commandText(
          "setblock ",
          stair.x,
          " ",
          stair.y,
          " ",
          stair.z,
          " oak_stairs[facing=west,half=bottom,shape=straight,waterlogged=false]",
        ),
      );
    }
    const stairsConfirmed = (
      await Promise.all(
        stairBlocks.map((stair) => isBlock(rcon, stair, "oak_stairs")),
      )
    ).every(Boolean);
    const supportBlocks = [...supports, ...platform];
    const supportsConfirmed = (
      await Promise.all(
        supportBlocks.map((support) => isBlock(rcon, support, "stone")),
      )
    ).every(Boolean);
    const doorHalvesConfirmed =
      (await isBlock(rcon, door, "oak_door")) &&
      (await isBlock(rcon, { ...door, y: door.y + 1 }, "oak_door"));
    const fixtureConfigured =
      stairsConfirmed &&
      supportsConfirmed &&
      doorHalvesConfirmed &&
      (await readProgressiveNavigationDoorState(
        rcon,
        door,
        context.botName,
      )) === "closed";
    update({ fixtureConfigured, stage: "preflight" });
    if (!fixtureConfigured) incomplete("OWNER_RETURN_FIXTURE_UNCONFIRMED");

    await rcon.command(
      commandText(
        "tp ",
        context.ownerName,
        " ",
        ownerTarget.x,
        " ",
        ownerTarget.y,
        " ",
        ownerTarget.z,
      ),
    );
    await rcon.command(
      commandText(
        "tp ",
        context.botName,
        " ",
        start.x,
        " ",
        start.y,
        " ",
        start.z,
        " 90 0",
      ),
    );
    let before = await sampleWorld();
    const bodyReadyBy = Date.now() + 5_000;
    while (
      Date.now() < bodyReadyBy &&
      (before.bodySide !== "return_side" ||
        before.rconSide !== "return_side" ||
        !before.bodyRconAligned)
    ) {
      await waitMs(250);
      before = await sampleWorld();
    }
    updateWorldDiagnostic(before, true);
    if (
      before.bodySide !== "return_side" ||
      before.rconSide !== "return_side" ||
      before.doorState !== "closed" ||
      !before.bodyRconAligned
    )
      incomplete("OWNER_RETURN_START_NOT_CONFIRMED");
    const baseline = playerOf(await collect(context.runtime.app));
    if (isOperationActive(baseline))
      incomplete("OWNER_RETURN_BODY_BECAME_ACTIVE_BEFORE_REQUEST");
    const baselineActivities = baseline.recentAgentActivity ?? [];
    const updateObservedToolNames = (player: PlayerEvidence): void =>
      updateOwnerReturnDiagnostic(state, {
        toolNamesByRole: ownerReturnToolNamesSince(
          player.recentAgentActivity ?? [],
          baselineActivities,
        ),
      });
    const baselineProposalIds = new Set(
      baseline.proposals.map((proposal) => proposal.id),
    );
    const baselineOutcomeIds = new Set(
      baseline.recentOutcomes.map((outcome) => outcome.operationId),
    );
    let requestProposalId: string | undefined;
    let requestProposalObserved = false;
    const requestAt = Date.now();
    update({ stage: "owner_request" });
    sendChat(context.owner, "ドアを通って、こっちまで戻ってきてください。");
    ownerRequestSent = true;
    update({ ownerRequestSent: true });
    let lastWorldSampleAt = 0;
    let latestWorldSample = before;
    const updateNavigationEvidence = (player: PlayerEvidence) => {
      updateObservedToolNames(player);
      const newProposals = player.proposals.filter(
        (proposal) => !baselineProposalIds.has(proposal.id),
      );
      requestProposalObserved ||= newProposals.length > 0;
      const proposal = newProposals.length === 1 ? newProposals[0] : undefined;
      if (proposal !== undefined) requestProposalId = proposal.id;
      else if (newProposals.length > 1) requestProposalId = undefined;
      const disposition = ownerReturnProposalDisposition(proposal);
      const ownerGoalLinked =
        proposal !== undefined &&
        player.goals.some(
          (goal) =>
            goal.ownerProposalId === proposal.id && goal.source === "owner",
        );
      const ownerProposalAdoptedForRequest =
        proposal !== undefined && disposition === "adopted" && ownerGoalLinked;
      const ownerProposalProgressableForRequest =
        proposal !== undefined &&
        isOwnerProposalProgressable(disposition, ownerGoalLinked);
      if (ownerProposalProgressableForRequest)
        state.ownerReturnProposalIdForRun = proposal.id;
      const ownerMoveJudgmentObserved = player.recentJudgments.some(
        (judgment) =>
          judgment.kind === "act" &&
          judgment.operationKind === "move_to" &&
          judgment.decidedAt !== undefined &&
          Date.parse(judgment.decidedAt) >= requestAt,
      );
      const moveOutcome = player.recentOutcomes.findLast(
        (outcome) =>
          !baselineOutcomeIds.has(outcome.operationId) &&
          outcome.kind === "move_to" &&
          outcome.observedAt !== undefined &&
          Date.parse(outcome.observedAt) >= requestAt,
      );
      const safeMoveOutcomeStatus =
        moveOutcome === undefined
          ? "unknown"
          : (safeOutcomeStatus(moveOutcome.status) ?? "unknown");
      update({
        stage: "navigation",
        stopPlayerEvidenceAvailable: true,
        newOwnerProposalObserved: requestProposalObserved,
        ownerProposalDisposition: disposition,
        ownerProposalAdoptedForRequest,
        ownerProposalProgressableForRequest,
        ownerGoalLinked,
        ownerGoalStatusAtStop: ownerReturnGoalStatus(
          player.goals.find(
            (goal) =>
              proposal !== undefined &&
              goal.ownerProposalId === proposal.id &&
              goal.source === "owner",
          )?.status,
        ),
        ownerMoveJudgmentObserved,
        moveOutcomeStatus:
          safeMoveOutcomeStatus === "cancelled"
            ? "interrupted"
            : safeMoveOutcomeStatus,
        activeOperationPresentAtStop: isOperationActive(player),
      });
      return {
        disposition,
        ownerGoalLinked,
        ownerMoveJudgmentObserved,
      } as const;
    };
    projectOwnerReturnStopPlayer = (player) => {
      updateNavigationEvidence(player);
    };
    const observationWindowMs = Math.max(
      1,
      Math.min(150_000, context.caseDeadlineAt - Date.now() - 20_000),
    );
    const reachedPlayer = await observeForPlayer(
      context,
      observationWindowMs,
      async (player) => {
        const navigationEvidence = updateNavigationEvidence(player);
        if (Date.now() - lastWorldSampleAt >= 10_000) {
          latestWorldSample = await sampleWorld();
          lastWorldSampleAt = Date.now();
          updateWorldDiagnostic(latestWorldSample, false);
          update({
            bodyReachedOwnerSide: latestWorldSample.bodySide === "owner_side",
            rconReachedOwnerSide: latestWorldSample.rconSide === "owner_side",
            bodyAndRconArrivalObserved:
              ownerReturnArrivalConfirmed(latestWorldSample),
          });
        }
        arrived = ownerReturnAcceptanceEvidenceConfirmed(
          navigationEvidence.disposition,
          navigationEvidence.ownerGoalLinked,
          navigationEvidence.ownerMoveJudgmentObserved,
          latestWorldSample,
        );
        if (arrived && ownerReturnRequestGateEnabled(state.targetCase))
          state.ownerReturnRequestGate?.latch();
        return arrived;
      },
      ownerReturnRequestGateEnabled(state.targetCase)
        ? finalizeBudgetStop
        : undefined,
    );
    if (reachedPlayer === undefined) {
      latestWorldSample = await sampleWorld();
      updateWorldDiagnostic(latestWorldSample, false);
      const stopPlayer = playerOf(await collect(context.runtime.app));
      updateObservedToolNames(stopPlayer);
      const stopReason: OwnerReturnStopReason =
        state.ownerReturnDiagnostic?.ownerProposalDisposition === "declined"
          ? "proposal_declined"
          : state.ownerReturnDiagnostic?.moveOutcomeStatus !== undefined &&
              state.ownerReturnDiagnostic.moveOutcomeStatus !== "successful"
            ? "navigation_terminal"
            : "observation_window_elapsed";
      update({
        stopReason,
        activeOperationPresentAtStop: isOperationActive(stopPlayer),
      });
    } else {
      update({ stopReason: "owner_arrival" });
      if (ownerReturnRequestGateEnabled(state.targetCase)) {
        requireOwnerReturnRequestsSettled(
          await settleOwnerReturnRequests(state, context),
        );
      }
      arrived = true;
      updateObservedToolNames(reachedPlayer);
      update({
        stopReason: "owner_arrival",
        bodyReachedOwnerSide: true,
        rconReachedOwnerSide: true,
        bodyAndRconArrivalObserved: true,
        activeOperationPresentAtStop: isOperationActive(reachedPlayer),
      });
    }
    const terminalPlayer = playerOf(await collect(context.runtime.app));
    updateObservedToolNames(terminalPlayer);
    const linkedProposal = terminalPlayer.proposals.find(
      (proposal) => proposal.id === requestProposalId,
    );
    const linkedGoal = terminalPlayer.goals.find(
      (goal) =>
        requestProposalId !== undefined &&
        goal.ownerProposalId === requestProposalId &&
        goal.source === "owner",
    );
    const terminalDisposition = ownerReturnProposalDisposition(linkedProposal);
    const terminalOwnerGoalLinked = linkedGoal !== undefined;
    const terminalProposalAdoptedForRequest =
      linkedProposal !== undefined &&
      terminalDisposition === "adopted" &&
      terminalOwnerGoalLinked;
    const terminalProposalProgressableForRequest =
      linkedProposal !== undefined &&
      isOwnerProposalProgressable(terminalDisposition, terminalOwnerGoalLinked);
    update({
      newOwnerProposalObserved: requestProposalObserved,
      ownerProposalDisposition: terminalDisposition,
      ownerProposalAdoptedForRequest: terminalProposalAdoptedForRequest,
      ownerProposalProgressableForRequest:
        terminalProposalProgressableForRequest,
      ownerGoalLinked: terminalOwnerGoalLinked,
      ownerGoalStatusAtStop: ownerReturnGoalStatus(linkedGoal?.status),
      activeOperationPresentAtStop: isOperationActive(terminalPlayer),
    });
    if (!arrived) incomplete("OWNER_RETURN_DOOR_CROSSING_NOT_CONFIRMED");
  } finally {
    if (fixtureMutationStarted) {
      update({ stage: "cleanup" });
      const fixtureCleanupConfirmed = await (async () => {
        try {
          await rcon.command(
            commandText(
              "fill ",
              door.x,
              " 64 ",
              door.z - 1,
              " ",
              Math.floor(start.x),
              " 69 ",
              door.z + 1,
              " air",
            ),
          );
          const cleanupCells = [
            door,
            { ...door, y: door.y + 1 },
            ...stairBlocks,
            ...supports,
            ...platform,
            { x: door.x + 2, y: 64, z: door.z - 1 },
            { x: door.x + 2, y: 69, z: door.z + 1 },
          ];
          return (
            await Promise.all(
              cleanupCells.map((position) => isBlock(rcon, position, "air")),
            )
          ).every(Boolean);
        } catch {
          return false;
        }
      })();
      const originalFixtureRestored = await (async () => {
        try {
          await configureHiddenContainer(rcon, origin);
          return (
            (await isBlock(rcon, { ...door, y: 64 }, "stone")) &&
            (await isBlock(rcon, hiddenFixture.chest, "chest"))
          );
        } catch {
          return false;
        }
      })();
      update({
        fixtureCleanupConfirmed,
        originalFixtureRestored,
        stage:
          fixtureCleanupConfirmed && originalFixtureRestored
            ? "complete"
            : "cleanup",
      });
      if (!fixtureCleanupConfirmed || !originalFixtureRestored)
        incomplete("OWNER_RETURN_FIXTURE_CLEANUP_UNCONFIRMED");
    }
  }
  return {
    ownerRequestSent: true,
    fixtureConfigured: state.ownerReturnDiagnostic?.fixtureConfigured === true,
    ownerProposalAdoptedForRequest:
      state.ownerReturnDiagnostic?.ownerProposalAdoptedForRequest === true,
    ownerProposalProgressableForRequest:
      state.ownerReturnDiagnostic?.ownerProposalProgressableForRequest === true,
    ownerGoalLinked: state.ownerReturnDiagnostic?.ownerGoalLinked === true,
    ownerMoveJudgmentObserved:
      state.ownerReturnDiagnostic?.ownerMoveJudgmentObserved === true,
    bodyAndRconArrivalObserved:
      state.ownerReturnDiagnostic?.bodyAndRconArrivalObserved === true,
    doorOpened: state.ownerReturnDiagnostic?.doorStateAfter === "open",
    fixtureCleanupConfirmed:
      state.ownerReturnDiagnostic?.fixtureCleanupConfirmed === true,
    originalFixtureRestored:
      state.ownerReturnDiagnostic?.originalFixtureRestored === true,
  };
}

async function runProgressiveNavigationProbe(
  state: RunState,
  rcon: LocalRcon,
  body: PlayerBody,
  spawn: Position,
  signal: AbortSignal,
): Promise<void> {
  const door = fixturePoint(spawn, 2, 0);
  const start = { x: door.x + 6.5, y: 68, z: door.z + 0.5 };
  const stairBlocks = [
    { x: door.x + 1, y: 64, z: door.z },
    { x: door.x + 2, y: 65, z: door.z },
    { x: door.x + 3, y: 66, z: door.z },
    { x: door.x + 4, y: 67, z: door.z },
  ] as const;
  const supports = [
    { x: door.x + 2, y: 64, z: door.z },
    { x: door.x + 3, y: 64, z: door.z },
    { x: door.x + 3, y: 65, z: door.z },
    { x: door.x + 4, y: 64, z: door.z },
    { x: door.x + 4, y: 65, z: door.z },
    { x: door.x + 4, y: 66, z: door.z },
  ] as const;
  const platform = [
    { x: door.x + 5, y: 67, z: door.z },
    { x: door.x + 6, y: 67, z: door.z },
  ] as const;
  const hiddenFixture = { chest: fixturePoint(spawn, 6, 0) };
  const update = (patch: Partial<BodySmokeDiagnostic>): void => {
    const current = state.bodySmokeDiagnostic;
    if (current === undefined) incomplete("BODY_SMOKE_DIAGNOSTIC_MISSING");
    state.bodySmokeDiagnostic = { ...current, ...patch };
  };
  let fixtureMutationStarted = false;
  update({ progressiveNavigationStage: "fixture_setup" });
  try {
    fixtureMutationStarted = true;
    await removeHiddenContainerFixture(rcon, spawn, hiddenFixture);
    await rcon.command(
      `kill @e[type=minecraft:item,x=${hiddenFixture.chest.x},y=${hiddenFixture.chest.y},z=${hiddenFixture.chest.z},distance=..3]`,
    );
    await rcon.command(
      `fill ${door.x} 64 ${door.z - 1} ${Math.floor(start.x)} 69 ${door.z - 1} stone`,
    );
    await rcon.command(
      `fill ${door.x} 64 ${door.z + 1} ${Math.floor(start.x)} 69 ${door.z + 1} stone`,
    );
    for (const support of supports) {
      await rcon.command(
        `setblock ${support.x} ${support.y} ${support.z} stone`,
      );
    }
    for (const block of platform) {
      await rcon.command(`setblock ${block.x} ${block.y} ${block.z} stone`);
    }
    await rcon.command(
      `setblock ${door.x} ${door.y} ${door.z} oak_door[facing=west,half=lower,hinge=left,open=false,powered=false]`,
    );
    await rcon.command(
      `setblock ${door.x} ${door.y + 1} ${door.z} oak_door[facing=west,half=upper,hinge=left,open=false,powered=false]`,
    );
    for (const stair of stairBlocks) {
      await rcon.command(
        `setblock ${stair.x} ${stair.y} ${stair.z} oak_stairs[facing=west,half=bottom,shape=straight,waterlogged=false]`,
      );
    }
    let stairsConfirmed = true;
    for (const stair of stairBlocks) {
      stairsConfirmed =
        (await isBlock(rcon, stair, "oak_stairs")) && stairsConfirmed;
    }
    let supportsConfirmed = true;
    for (const support of [...supports, ...platform]) {
      supportsConfirmed =
        (await isBlock(rcon, support, "stone")) && supportsConfirmed;
    }
    const corridorWallsConfirmed =
      (await isBlock(rcon, { x: door.x + 2, y: 64, z: door.z - 1 }, "stone")) &&
      (await isBlock(rcon, { x: door.x + 2, y: 69, z: door.z + 1 }, "stone"));
    const doorLowerConfirmed = await isBlock(rcon, door, "oak_door");
    const doorUpperConfirmed = await isBlock(
      rcon,
      { ...door, y: door.y + 1, z: door.z },
      "oak_door",
    );
    const doorStateBefore = await readProgressiveNavigationDoorState(
      rcon,
      door,
      state.botName,
    );
    update({
      progressiveNavigationFixtureConfigured:
        stairsConfirmed &&
        supportsConfirmed &&
        corridorWallsConfirmed &&
        doorLowerConfirmed &&
        doorUpperConfirmed,
      progressiveNavigationStairBlocksConfirmed: stairsConfirmed,
      progressiveNavigationStepSupportsConfirmed: supportsConfirmed,
      progressiveNavigationCorridorWallsConfirmed: corridorWallsConfirmed,
      progressiveNavigationDoorHalvesConfirmed:
        doorLowerConfirmed && doorUpperConfirmed,
      progressiveNavigationDoorStateBefore: doorStateBefore,
      progressiveNavigationStage: "preflight",
    });
    if (!stairsConfirmed)
      incomplete("PROGRESSIVE_NAVIGATION_STAIRS_UNCONFIRMED");
    if (!supportsConfirmed || !corridorWallsConfirmed)
      incomplete("PROGRESSIVE_NAVIGATION_ROUTE_FIXTURE_UNCONFIRMED");
    if (!doorLowerConfirmed || !doorUpperConfirmed)
      incomplete("PROGRESSIVE_NAVIGATION_DOOR_UNCONFIRMED");
    if (doorStateBefore !== "closed")
      incomplete("PROGRESSIVE_NAVIGATION_DOOR_NOT_CLOSED_BEFORE_MOVE");

    await rcon.command(
      `tp ${state.botName} ${start.x} ${start.y} ${start.z} 90 0`,
    );
    const rconBefore = parsePosition(
      await rcon.command(`data get entity ${state.botName} Pos`),
    );
    const ownerBefore = parsePosition(
      await rcon.command(`data get entity ${state.ownerName} Pos`),
    );
    const bodyReadyBy = Date.now() + 5_000;
    let bodyBefore = await body.observe();
    while (
      Date.now() < bodyReadyBy &&
      Math.hypot(
        bodyBefore.self.position.x - start.x,
        bodyBefore.self.position.y - start.y,
        bodyBefore.self.position.z - start.z,
      ) > 1.5
    ) {
      await waitMs(100);
      bodyBefore = await body.observe();
    }
    if (
      Math.hypot(
        rconBefore.x - start.x,
        rconBefore.y - start.y,
        rconBefore.z - start.z,
      ) > 1.5
    )
      incomplete("PROGRESSIVE_NAVIGATION_RCON_START_NOT_CONFIRMED");
    if (
      Math.hypot(
        bodyBefore.self.position.x - start.x,
        bodyBefore.self.position.y - start.y,
        bodyBefore.self.position.z - start.z,
      ) > 1.5
    )
      incomplete("PROGRESSIVE_NAVIGATION_BODY_START_NOT_CONFIRMED");
    const bodyDistanceBefore = Math.hypot(
      bodyBefore.self.position.x - ownerBefore.x,
      bodyBefore.self.position.y - ownerBefore.y,
      bodyBefore.self.position.z - ownerBefore.z,
    );
    const rconDistanceBefore = Math.hypot(
      rconBefore.x - ownerBefore.x,
      rconBefore.y - ownerBefore.y,
      rconBefore.z - ownerBefore.z,
    );
    update({
      progressiveNavigationBodySideBefore: progressiveNavigationSide(
        bodyBefore.self.position,
        door.x,
      ),
      progressiveNavigationRconSideBefore: progressiveNavigationSide(
        rconBefore,
        door.x,
      ),
      progressiveNavigationBodyDistanceBefore: positionDistanceBucket(
        bodyBefore.self.position,
        ownerBefore,
      ),
      progressiveNavigationRconDistanceBefore: positionDistanceBucket(
        rconBefore,
        ownerBefore,
      ),
      progressiveNavigationStage: "move",
    });
    const movementSamples: ProgressiveNavigationMovementSample[] = [
      progressiveNavigationMovementSample(
        "start",
        0,
        bodyBefore,
        rconBefore,
        door,
        doorStateBefore,
      ),
    ];
    const moveStartedAt = Date.now();
    let intervalSampleCount = 0;
    const move = await executeBodyMovePathProbe(
      body,
      { kind: "move_to", position: ownerBefore, range: 1 },
      signal,
      40_000,
      {
        captureStallEvents: true,
        sampleIntervalMs: 10_000,
        maxSamples: 3,
        onSample: async (elapsedMs) => {
          intervalSampleCount += 1;
          const point = progressiveNavigationSamplePoint(intervalSampleCount);
          try {
            const [observation, position] = await Promise.all([
              body.observe(),
              rcon
                .command(`data get entity ${state.botName} Pos`)
                .then(parsePosition),
            ]);
            const doorState = await readProgressiveNavigationDoorState(
              rcon,
              door,
              state.botName,
            );
            movementSamples.push(
              progressiveNavigationMovementSample(
                point,
                elapsedMs,
                observation,
                position,
                door,
                doorState,
              ),
            );
          } catch {
            movementSamples.push(
              progressiveNavigationMovementSample(
                point,
                elapsedMs,
                undefined,
                undefined,
                door,
                "unknown",
              ),
            );
          }
        },
      },
    );
    const [bodyAfter, rconAfter] = await Promise.all([
      body.observe(),
      rcon.command(`data get entity ${state.botName} Pos`).then(parsePosition),
    ]);
    const ownerAfter = parsePosition(
      await rcon.command(`data get entity ${state.ownerName} Pos`),
    );
    const doorStateAfter = await readProgressiveNavigationDoorState(
      rcon,
      door,
      state.botName,
    );
    movementSamples.push(
      progressiveNavigationMovementSample(
        "final",
        Date.now() - moveStartedAt,
        bodyAfter,
        rconAfter,
        door,
        doorStateAfter,
      ),
    );
    const bodyDistanceAfter = Math.hypot(
      bodyAfter.self.position.x - ownerAfter.x,
      bodyAfter.self.position.y - ownerAfter.y,
      bodyAfter.self.position.z - ownerAfter.z,
    );
    const rconDistanceAfter = Math.hypot(
      rconAfter.x - ownerAfter.x,
      rconAfter.y - ownerAfter.y,
      rconAfter.z - ownerAfter.z,
    );
    const bodyPassedDoor = bodyAfter.self.position.x < door.x - 0.5;
    const rconPassedDoor = rconAfter.x < door.x - 0.5;
    const routeConfirmed =
      doorStateAfter !== "unknown" &&
      move.status === "successful" &&
      bodyPassedDoor &&
      rconPassedDoor &&
      bodyDistanceAfter <= 1.75 &&
      rconDistanceAfter <= 1.75;
    const doorUseReadinessBeforeLook = progressiveNavigationDoorUseReadiness(
      bodyAfter,
      door,
    );
    const skippedDoorLook = (
      skipReason: ProgressiveNavigationDoorLookSkipReason,
    ): ProgressiveNavigationDoorLookDiagnostic => ({
      attempted: false,
      skipReason,
      doorObservedHalfBefore:
        doorUseReadinessBeforeLook.diagnostic.doorObservedHalf,
      doorObservedHalfAfter: "not_sampled",
      bodyBlockSearchMayBeTruncatedBefore:
        doorUseReadinessBeforeLook.diagnostic.bodyBlockSearchMayBeTruncated,
      bodyBlockSearchMayBeTruncatedAfter: "not_sampled",
      doorStateBefore: doorStateAfter,
      doorStateAfter: "not_sampled",
    });
    let doorUseReadinessResult = doorUseReadinessBeforeLook;
    let doorStateBeforeUse = doorStateAfter;
    let doorLookDiagnostic: ProgressiveNavigationDoorLookDiagnostic;
    let doorLookObservationAvailable = false;
    if (isProgressiveNavigationSignalAborted(signal)) {
      doorLookDiagnostic = skippedDoorLook("run_deadline");
    } else if (routeConfirmed) {
      doorLookDiagnostic = skippedDoorLook("initial_route_confirmed");
    } else if (doorStateAfter !== "closed") {
      doorLookDiagnostic = skippedDoorLook("door_not_closed");
    } else if (move.recoveryRequired) {
      doorLookDiagnostic = skippedDoorLook("operation_unresolved");
    } else {
      const doorLook = await executeProgressiveNavigationDoorLook(
        body,
        {
          x: door.x + 0.5,
          y: door.y + 1.5,
          z: door.z + 0.5,
        },
        signal,
        5_000,
      );
      const [bodyAfterLook, doorStateAfterLook] = await Promise.all([
        body.observe().catch(() => undefined),
        readProgressiveNavigationDoorState(rcon, door, state.botName).catch(
          () => "unknown" as const,
        ),
      ]);
      const readinessAfterLook =
        bodyAfterLook === undefined
          ? undefined
          : progressiveNavigationDoorUseReadiness(bodyAfterLook, door);
      if (readinessAfterLook !== undefined) {
        doorUseReadinessResult = readinessAfterLook;
        doorLookObservationAvailable = true;
      }
      doorStateBeforeUse = doorStateAfterLook;
      doorLookDiagnostic = {
        attempted: true,
        skipReason: "attempted",
        status: doorLook.status,
        errorClass: doorLook.errorClass,
        recoveryRequired: doorLook.recoveryRequired,
        doorObservedHalfBefore:
          doorUseReadinessBeforeLook.diagnostic.doorObservedHalf,
        doorObservedHalfAfter:
          readinessAfterLook?.diagnostic.doorObservedHalf ?? "unknown",
        bodyBlockSearchMayBeTruncatedBefore:
          doorUseReadinessBeforeLook.diagnostic.bodyBlockSearchMayBeTruncated,
        bodyBlockSearchMayBeTruncatedAfter:
          readinessAfterLook?.diagnostic.bodyBlockSearchMayBeTruncated ??
          "unknown",
        doorStateBefore: doorStateAfter,
        doorStateAfter: doorStateAfterLook,
      };
    }
    const doorUseReadiness = doorUseReadinessResult.diagnostic;
    let doorUseDiagnostic: ProgressiveNavigationDoorUseDiagnostic;
    let retryDiagnostic: ProgressiveNavigationRetryDiagnostic;
    if (isProgressiveNavigationSignalAborted(signal)) {
      doorUseDiagnostic = {
        attempted: false,
        skipReason: "run_deadline",
        ...doorUseReadiness,
      };
      retryDiagnostic = { attempted: false, skipReason: "run_deadline" };
    } else if (routeConfirmed) {
      doorUseDiagnostic = {
        attempted: false,
        skipReason: "initial_route_confirmed",
        ...doorUseReadiness,
      };
      retryDiagnostic = {
        attempted: false,
        skipReason: "initial_route_confirmed",
      };
    } else if (doorStateBeforeUse !== "closed") {
      doorUseDiagnostic = {
        attempted: false,
        skipReason: "door_not_closed",
        ...doorUseReadiness,
      };
      retryDiagnostic = { attempted: false, skipReason: "use_not_attempted" };
    } else if (
      move.recoveryRequired ||
      doorLookDiagnostic.recoveryRequired === true
    ) {
      doorUseDiagnostic = {
        attempted: false,
        skipReason: "operation_unresolved",
        ...doorUseReadiness,
      };
      retryDiagnostic = {
        attempted: false,
        skipReason: "operation_unresolved",
      };
    } else if (doorLookDiagnostic.skipReason !== "attempted") {
      doorUseDiagnostic = {
        attempted: false,
        skipReason: "look_not_successful",
        ...doorUseReadiness,
      };
      retryDiagnostic = { attempted: false, skipReason: "use_not_attempted" };
    } else if (doorLookDiagnostic.status !== "successful") {
      doorUseDiagnostic = {
        attempted: false,
        skipReason: "look_not_successful",
        ...doorUseReadiness,
      };
      retryDiagnostic = { attempted: false, skipReason: "use_not_attempted" };
    } else if (!doorLookObservationAvailable) {
      doorUseDiagnostic = {
        attempted: false,
        skipReason: "look_observation_unavailable",
        ...doorUseReadiness,
      };
      retryDiagnostic = { attempted: false, skipReason: "use_not_attempted" };
    } else if (
      doorUseReadiness.doorObservedHalf === "neither" ||
      doorUseReadinessResult.targetPosition === null
    ) {
      doorUseDiagnostic = {
        attempted: false,
        skipReason: "door_not_observed",
        ...doorUseReadiness,
      };
      retryDiagnostic = { attempted: false, skipReason: "use_not_attempted" };
    } else if (!doorUseReadiness.doorWithinReach) {
      doorUseDiagnostic = {
        attempted: false,
        skipReason: "door_out_of_reach",
        ...doorUseReadiness,
      };
      retryDiagnostic = { attempted: false, skipReason: "use_not_attempted" };
    } else {
      const use = await executeProgressiveNavigationDoorUse(
        body,
        doorUseReadinessResult.targetPosition,
        signal,
        15_000,
      );
      let doorStateAfterUse: ProgressiveNavigationDoorState = "unknown";
      try {
        doorStateAfterUse = await readProgressiveNavigationDoorState(
          rcon,
          door,
          state.botName,
        );
      } catch {
        doorStateAfterUse = "unknown";
      }
      doorUseDiagnostic = {
        attempted: true,
        skipReason: "attempted",
        ...doorUseReadiness,
        status: use.status,
        errorClass: use.errorClass,
        recoveryRequired: use.recoveryRequired,
        doorStateAfter: doorStateAfterUse,
      };
      if (isProgressiveNavigationSignalAborted(signal)) {
        retryDiagnostic = { attempted: false, skipReason: "run_deadline" };
      } else if (use.recoveryRequired) {
        retryDiagnostic = {
          attempted: false,
          skipReason: "operation_unresolved",
        };
      } else if (doorStateAfterUse !== "open") {
        retryDiagnostic = { attempted: false, skipReason: "door_not_open" };
      } else {
        const retry = await executeBodyMovePathProbe(
          body,
          { kind: "move_to", position: ownerAfter, range: 1 },
          signal,
          15_000,
          { captureStallEvents: true },
        );
        const [bodyAfterRetry, rconAfterRetry] = await Promise.all([
          body.observe(),
          rcon
            .command(`data get entity ${state.botName} Pos`)
            .then(parsePosition),
        ]);
        let doorStateAfterRetry: ProgressiveNavigationDoorState = "unknown";
        try {
          doorStateAfterRetry = await readProgressiveNavigationDoorState(
            rcon,
            door,
            state.botName,
          );
        } catch {
          doorStateAfterRetry = "unknown";
        }
        const bodyPassedDoorAfterRetry =
          bodyAfterRetry.self.position.x < door.x - 0.5;
        const rconPassedDoorAfterRetry = rconAfterRetry.x < door.x - 0.5;
        const retryRouteConfirmed =
          retry.status === "successful" &&
          bodyPassedDoorAfterRetry &&
          rconPassedDoorAfterRetry &&
          Math.hypot(
            bodyAfterRetry.self.position.x - ownerAfter.x,
            bodyAfterRetry.self.position.y - ownerAfter.y,
            bodyAfterRetry.self.position.z - ownerAfter.z,
          ) <= 1.75 &&
          Math.hypot(
            rconAfterRetry.x - ownerAfter.x,
            rconAfterRetry.y - ownerAfter.y,
            rconAfterRetry.z - ownerAfter.z,
          ) <= 1.75;
        retryDiagnostic = {
          attempted: true,
          skipReason: "attempted",
          status: retry.status,
          errorClass: retry.errorClass,
          pathStatus: retry.pathStatus,
          pathUpdateCount: retry.pathUpdateCount,
          stallEventCountBucket: retry.stallEventCountBucket ?? "0",
          stallElapsedBucket: retry.stallElapsedBucket ?? "none",
          bodySideAfter: progressiveNavigationSide(
            bodyAfterRetry.self.position,
            door.x,
          ),
          rconSideAfter: progressiveNavigationSide(rconAfterRetry, door.x),
          doorStateAfter: doorStateAfterRetry,
          routeConfirmed: retryRouteConfirmed,
        };
      }
    }
    update({
      progressiveNavigationDoorStateAfter: doorStateAfter,
      progressiveNavigationBodySideAfter: progressiveNavigationSide(
        bodyAfter.self.position,
        door.x,
      ),
      progressiveNavigationRconSideAfter: progressiveNavigationSide(
        rconAfter,
        door.x,
      ),
      progressiveNavigationBodyDistanceAfter: positionDistanceBucket(
        bodyAfter.self.position,
        ownerAfter,
      ),
      progressiveNavigationRconDistanceAfter: positionDistanceBucket(
        rconAfter,
        ownerAfter,
      ),
      progressiveNavigationBodyDistanceReduced:
        bodyDistanceBefore - bodyDistanceAfter >= 1.5,
      progressiveNavigationRconDistanceReduced:
        rconDistanceBefore - rconDistanceAfter >= 1.5,
      progressiveNavigationMoveStatus: move.status,
      progressiveNavigationMoveErrorClass: move.errorClass,
      progressiveNavigationPathStatus: move.pathStatus,
      progressiveNavigationPathUpdateCount: move.pathUpdateCount,
      progressiveNavigationProbeDeadlineReached: move.probeDeadlineReached,
      progressiveNavigationBodyPassedDoor: bodyPassedDoor,
      progressiveNavigationRconPassedDoor: rconPassedDoor,
      progressiveNavigationRouteConfirmed: routeConfirmed,
      progressiveNavigationMoveTrace: {
        stallEventCountBucket: move.stallEventCountBucket ?? "0",
        stallElapsedBucket: move.stallElapsedBucket ?? "none",
        samples: movementSamples.slice(0, 5),
      },
      progressiveNavigationDoorLook: doorLookDiagnostic,
      progressiveNavigationDoorUse: doorUseDiagnostic,
      progressiveNavigationRetryMove: retryDiagnostic,
    });
    if (!routeConfirmed)
      incomplete("PROGRESSIVE_NAVIGATION_BODY_ROUTE_NOT_CONFIRMED");
  } finally {
    if (fixtureMutationStarted) {
      update({ progressiveNavigationStage: "cleanup" });
      const fixtureCleanupConfirmed = await (async () => {
        try {
          await rcon.command(
            `fill ${door.x} 64 ${door.z - 1} ${Math.floor(start.x)} 69 ${door.z + 1} air`,
          );
          const cleanupCells = [
            door,
            { ...door, y: door.y + 1 },
            ...stairBlocks,
            ...supports,
            ...platform,
            { x: door.x + 2, y: 64, z: door.z - 1 },
            { x: door.x + 2, y: 69, z: door.z - 1 },
            { x: door.x + 2, y: 64, z: door.z + 1 },
            { x: door.x + 2, y: 69, z: door.z + 1 },
          ];
          let cleared = true;
          for (const position of cleanupCells) {
            cleared = (await isBlock(rcon, position, "air")) && cleared;
          }
          return cleared;
        } catch {
          return false;
        }
      })();
      const originalFixtureRestored = await (async () => {
        try {
          await configureHiddenContainer(rcon, spawn);
          return (
            (await isBlock(rcon, fixturePoint(spawn, 2, 0), "stone")) &&
            (await isBlock(rcon, hiddenFixture.chest, "chest"))
          );
        } catch {
          return false;
        }
      })();
      update({
        progressiveNavigationFixtureCleanupConfirmed: fixtureCleanupConfirmed,
        progressiveNavigationOriginalFixtureRestored: originalFixtureRestored,
        progressiveNavigationStage:
          fixtureCleanupConfirmed && originalFixtureRestored
            ? "complete"
            : "cleanup",
      });
      if (!fixtureCleanupConfirmed || !originalFixtureRestored)
        incomplete("PROGRESSIVE_NAVIGATION_FIXTURE_CLEANUP_UNCONFIRMED");
    }
  }
}

function progressiveNavigationMovementSample(
  point: ProgressiveNavigationSamplePoint,
  elapsedMs: number,
  observation: Awaited<ReturnType<PlayerBody["observe"]>> | undefined,
  rconPosition: Position | undefined,
  door: BlockPosition,
  doorState: ProgressiveNavigationDoorState,
): ProgressiveNavigationMovementSample {
  const doorCenter = {
    x: door.x + 0.5,
    y: door.y + 0.5,
    z: door.z + 0.5,
  };
  return {
    point,
    elapsed: progressiveNavigationSampleElapsedBucket(elapsedMs),
    bodySide:
      observation === undefined
        ? "unknown"
        : progressiveNavigationSide(observation.self.position, door.x),
    rconSide:
      rconPosition === undefined
        ? "unknown"
        : progressiveNavigationSide(rconPosition, door.x),
    bodyDoorDistance:
      observation === undefined
        ? "unknown"
        : positionDistanceBucket(observation.self.position, doorCenter),
    rconDoorDistance:
      rconPosition === undefined
        ? "unknown"
        : positionDistanceBucket(rconPosition, doorCenter),
    doorState,
    bodyBlockSearchMayBeTruncated:
      observation?.perception.candidateSearchMayBeTruncated ?? "unknown",
  };
}

function progressiveNavigationSamplePoint(
  sampleNumber: number,
): ProgressiveNavigationSamplePoint {
  if (sampleNumber === 1) return "sample_1";
  if (sampleNumber === 2) return "sample_2";
  return "sample_3";
}

function isProgressiveNavigationSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function progressiveNavigationDoorUseReadiness(
  observation: Awaited<ReturnType<PlayerBody["observe"]>>,
  door: BlockPosition,
): ProgressiveNavigationDoorUseReadiness {
  const visibleLowerDoor = observation.perception.blocks.find(
    (block) =>
      block.name === "oak_door" &&
      block.position.x === door.x &&
      block.position.y === door.y &&
      block.position.z === door.z &&
      block.properties.half === "lower",
  );
  const visibleUpperDoor = observation.perception.blocks.find(
    (block) =>
      block.name === "oak_door" &&
      block.position.x === door.x &&
      block.position.y === door.y + 1 &&
      block.position.z === door.z &&
      block.properties.half === "upper",
  );
  const visibleDoor = visibleUpperDoor ?? visibleLowerDoor;
  const doorObservedHalf: ProgressiveNavigationObservedDoorHalf =
    visibleUpperDoor !== undefined
      ? "upper"
      : visibleLowerDoor !== undefined
        ? "lower"
        : "neither";
  const targetPosition =
    visibleDoor === undefined
      ? null
      : {
          x: visibleDoor.position.x,
          y: visibleDoor.position.y,
          z: visibleDoor.position.z,
        };
  const target =
    visibleDoor === undefined
      ? undefined
      : {
          x: visibleDoor.position.x + 0.5,
          y: visibleDoor.position.y + 0.5,
          z: visibleDoor.position.z + 0.5,
        };
  const eye = {
    x: observation.self.position.x,
    y: observation.self.position.y + observation.self.eyeHeight,
    z: observation.self.position.z,
  };
  const eyeDistance =
    target === undefined
      ? undefined
      : Math.hypot(eye.x - target.x, eye.y - target.y, eye.z - target.z);
  return {
    diagnostic: {
      doorObserved: visibleDoor !== undefined,
      doorObservedHalf,
      bodyBlockSearchMayBeTruncated:
        observation.perception.candidateSearchMayBeTruncated,
      doorWithinReach:
        eyeDistance === undefined ? "unknown" : eyeDistance <= 4.65,
    },
    targetPosition,
  };
}

async function executeProgressiveNavigationDoorUse(
  body: PlayerBody,
  door: BlockPosition,
  parentSignal: AbortSignal,
  deadlineMs: number,
): Promise<ProgressiveNavigationDoorUseOperationResult> {
  const probeAbort = new AbortController();
  let probeDeadlineReached = false;
  let status: BodyOperationStatus;
  let detail: string | undefined;
  let recoveryRequired = false;
  const timer = setTimeout(() => {
    probeDeadlineReached = true;
    probeAbort.abort(new Error("progressive navigation door use deadline"));
  }, deadlineMs);
  try {
    const result = await body.execute(
      { kind: "use", target: { kind: "block", position: door } },
      AbortSignal.any([parentSignal, probeAbort.signal]),
    );
    status = result.status;
    detail = result.detail;
    recoveryRequired = result.recoveryRequired;
  } catch (error) {
    detail = error instanceof Error ? error.message : undefined;
    status = parentSignal.aborted ? "interrupted" : "failed";
  } finally {
    clearTimeout(timer);
  }
  return {
    status,
    errorClass: classifyProgressiveDoorUseErrorClass(
      detail,
      probeDeadlineReached,
    ),
    recoveryRequired,
    probeDeadlineReached,
  };
}

async function executeProgressiveNavigationDoorLook(
  body: PlayerBody,
  target: Position,
  parentSignal: AbortSignal,
  deadlineMs: number,
): Promise<ProgressiveNavigationDoorUseOperationResult> {
  const probeAbort = new AbortController();
  let probeDeadlineReached = false;
  let status: BodyOperationStatus;
  let detail: string | undefined;
  let recoveryRequired = false;
  const timer = setTimeout(() => {
    probeDeadlineReached = true;
    probeAbort.abort(new Error("progressive navigation door look deadline"));
  }, deadlineMs);
  try {
    const result = await body.execute(
      { kind: "look", target },
      AbortSignal.any([parentSignal, probeAbort.signal]),
    );
    status = result.status;
    detail = result.detail;
    recoveryRequired = result.recoveryRequired;
  } catch (error) {
    detail = error instanceof Error ? error.message : undefined;
    status = parentSignal.aborted ? "interrupted" : "failed";
  } finally {
    clearTimeout(timer);
  }
  return {
    status,
    errorClass: classifyProgressiveDoorUseErrorClass(
      detail,
      probeDeadlineReached,
    ),
    recoveryRequired,
    probeDeadlineReached,
  };
}

function classifyProgressiveDoorUseErrorClass(
  detail: string | undefined,
  probeDeadlineReached: boolean,
): BodyDetailClass | "probe_deadline" {
  if (probeDeadlineReached) return "probe_deadline";
  return classifyBodyOperationDetail(detail);
}

function progressiveNavigationSide(
  position: Position,
  doorX: number,
): "owner_side" | "doorway" | "return_side" {
  if (position.x < doorX - 0.5) return "owner_side";
  if (position.x > doorX + 0.5) return "return_side";
  return "doorway";
}

async function readProgressiveNavigationDoorState(
  rcon: LocalRcon,
  door: BlockPosition,
  botName: string,
): Promise<ProgressiveNavigationDoorState> {
  const closed = await rcon.command(
    `execute if block ${door.x} ${door.y} ${door.z} minecraft:oak_door[open=false] run data get entity ${botName} Pos`,
  );
  const open = await rcon.command(
    `execute if block ${door.x} ${door.y} ${door.z} minecraft:oak_door[open=true] run data get entity ${botName} Pos`,
  );
  const containsPosition = (reply: string): boolean =>
    /\[\s*-?\d+(?:\.\d+)?d?\s*,\s*-?\d+(?:\.\d+)?d?\s*,\s*-?\d+(?:\.\d+)?d?\s*\]/u.test(
      reply,
    );
  const closedConfirmed = containsPosition(closed);
  const openConfirmed = containsPosition(open);
  if (closedConfirmed === openConfirmed) return "unknown";
  return closedConfirmed ? "closed" : "open";
}

async function runUnknownReturnPathProbe(
  state: RunState,
  rcon: LocalRcon,
  body: PlayerBody,
  botName: string,
  spawn: Position,
  signal: AbortSignal,
): Promise<void> {
  // The probe runs before cases; mirror the hidden-fixture cleanup before the live unknown case.
  await removeHiddenContainerFixture(rcon, spawn, {
    chest: fixturePoint(spawn, 6, 0),
  });
  await configureUnknownFixture(rcon, spawn, botName);
  updateReturnPathProbeDiagnostic(state, {
    interpretation: "diagnostic_only_live_item_collection_not_gated",
  });
  const target = unknownFixtureTarget(spawn);
  const wallPoint = {
    x: Math.floor(spawn.x) + 2,
    y: 64,
    z: Math.floor(spawn.z),
  };
  const targetSupport = { x: target.x, y: target.y - 1, z: target.z };
  const fixtureWallConfirmed = await isBlock(rcon, wallPoint, "stone");
  const fixtureDryGroundConfirmed = await isBlock(rcon, targetSupport, "stone");
  const fixtureConfirmed =
    (await isBlock(rcon, target, "blue_wool")) &&
    fixtureWallConfirmed &&
    fixtureDryGroundConfirmed;
  updateReturnPathProbeDiagnostic(state, {
    fixtureConfirmed,
    fixtureWallConfirmed,
    fixtureDryGroundConfirmed,
  });
  if (!fixtureConfirmed) incomplete("RETURN_PATH_PROBE_FIXTURE_NOT_CONFIRMED");

  // Keep the bot outside pickup range until the separate drop-approach move.
  const digStage = {
    x: target.x + 0.5,
    y: target.y,
    z: target.z + 3.5,
  };
  await rcon.command(
    `tp ${botName} ${digStage.x} ${digStage.y} ${digStage.z} 0 0`,
  );
  const digStagePosition = parsePosition(
    await rcon.command(`data get entity ${botName} Pos`),
  );
  const digStageRconConfirmed =
    Math.hypot(
      digStagePosition.x - digStage.x,
      digStagePosition.y - digStage.y,
      digStagePosition.z - digStage.z,
    ) <= 0.75;
  updateReturnPathProbeDiagnostic(state, { digStageRconConfirmed });
  if (
    !digStageRconConfirmed ||
    !(await waitForBodyAtPosition(body, digStage, signal))
  ) {
    incomplete("RETURN_PATH_PROBE_DIG_STAGE_NOT_CONFIRMED");
  }

  const digLookResult = await body.execute(
    {
      kind: "look",
      target: {
        x: target.x + 0.5,
        y: target.y + 0.5,
        z: target.z + 0.5,
      },
    },
    signal,
  );
  let targetVisibleAfterLook = false;
  const targetVisibilityDeadline = Date.now() + 5_000;
  while (!signal.aborted && Date.now() < targetVisibilityDeadline) {
    targetVisibleAfterLook =
      observedBlockName(await body.observe(), target) === "blue_wool";
    if (targetVisibleAfterLook) break;
    await waitMs(100);
  }
  updateReturnPathProbeDiagnostic(state, {
    digLookStatus: digLookResult.status,
    targetVisibleAfterLook,
  });
  if (digLookResult.status !== "successful")
    incomplete("RETURN_PATH_PROBE_DIG_LOOK_NOT_SUCCESSFUL");
  if (!targetVisibleAfterLook)
    incomplete("RETURN_PATH_PROBE_DIG_TARGET_NOT_VISIBLE");

  const digStageObservation = await observeReturnPathDigStage(
    body,
    rcon,
    botName,
    digStage,
  );
  updateReturnPathProbeDiagnostic(state, {
    digStagePlayerDistanceBucket: digStageObservation.playerDistanceBucket,
    digStageBodyDistanceBucket: digStageObservation.bodyDistanceBucket,
    digStageFeetBlockClass: digStageObservation.feetBlockClass,
    digStageSupportBlockClass: digStageObservation.supportBlockClass,
    digStageStable: digStageObservation.stable,
    digStageReady: digStageObservation.ready,
  });
  if (!digStageObservation.ready)
    incomplete("RETURN_PATH_PROBE_DIG_STAGE_NOT_DRY_AND_STABLE");

  const digResult = await body.execute(
    { kind: "dig", position: target },
    signal,
  );
  const positionAfterDig = parsePosition(
    await rcon.command(`data get entity ${botName} Pos`),
  );
  const digPositionDriftBucket = positionDriftBucket(
    Math.hypot(
      positionAfterDig.x - digStage.x,
      positionAfterDig.y - digStage.y,
      positionAfterDig.z - digStage.z,
    ),
  );
  const itemPresentAfterDig = await rconInventoryHasBlueWool(rcon, botName);
  const dropPositionAfterDig = await rconBlueWoolDropPositionNear(rcon, target);
  const dropItemEntityPresentAfterDig =
    dropPositionAfterDig === undefined ? undefined : true;
  const dropGroundSupportConfirmedAfterDig =
    dropPositionAfterDig === undefined
      ? undefined
      : await isBlock(
          rcon,
          {
            x: Math.floor(dropPositionAfterDig.x),
            y: Math.floor(dropPositionAfterDig.y) - 1,
            z: Math.floor(dropPositionAfterDig.z),
          },
          "stone",
        );
  const targetClearedAfterDig = !(await isBlock(rcon, target, "blue_wool"));
  updateReturnPathProbeDiagnostic(state, {
    digStatus: digResult.status,
    digRecoveryRequired: digResult.recoveryRequired,
    digPositionDriftBucket,
    itemPresentAfterDig,
    ...(dropItemEntityPresentAfterDig === undefined
      ? {}
      : { dropItemEntityPresentAfterDig }),
    ...(dropGroundSupportConfirmedAfterDig === undefined
      ? {}
      : { dropGroundSupportConfirmedAfterDig }),
    targetClearedAfterDig,
    ...(digResult.status === "successful"
      ? {}
      : {
          digErrorClass: classifyReturnPathDigError(
            digResult.status,
            digResult.detail,
          ),
        }),
  });
  if (digResult.status !== "successful")
    incomplete("RETURN_PATH_PROBE_DIG_NOT_SUCCESSFUL");
  if (!targetClearedAfterDig)
    incomplete("RETURN_PATH_PROBE_TARGET_NOT_CLEARED");
  if (itemPresentAfterDig)
    incomplete("RETURN_PATH_PROBE_ITEM_PICKED_UP_AFTER_DIG");
  if (dropItemEntityPresentAfterDig !== true)
    incomplete("RETURN_PATH_PROBE_DROP_POSITION_UNAVAILABLE_AFTER_DIG");

  await rcon.command(
    `tp ${botName} ${digStage.x} ${digStage.y} ${digStage.z} 0 0`,
  );

  const dropStagePosition = parsePosition(
    await rcon.command(`data get entity ${botName} Pos`),
  );
  const dropStageRconConfirmed =
    Math.hypot(
      dropStagePosition.x - digStage.x,
      dropStagePosition.y - digStage.y,
      dropStagePosition.z - digStage.z,
    ) <= 0.75;
  const dropStageBodyConfirmed = await waitForBodyAtPosition(
    body,
    digStage,
    signal,
  );
  updateReturnPathProbeDiagnostic(state, {
    dropStageRconConfirmed,
    dropStageBodyConfirmed,
  });
  if (!dropStageRconConfirmed || !dropStageBodyConfirmed) {
    incomplete("RETURN_PATH_PROBE_DROP_STAGE_NOT_CONFIRMED");
  }

  const itemPresentBeforeCollection = await rconInventoryHasBlueWool(
    rcon,
    botName,
  );
  const dropPositionBeforeCollection = await rconBlueWoolDropPositionNear(
    rcon,
    target,
  );
  const dropItemEntityPresentBeforeCollection =
    dropPositionBeforeCollection === undefined ? undefined : true;
  updateReturnPathProbeDiagnostic(state, {
    ...(dropItemEntityPresentBeforeCollection === undefined
      ? {}
      : { dropItemEntityPresentBeforeCollection }),
    itemPresentBeforeCollection,
  });
  if (itemPresentBeforeCollection)
    incomplete("RETURN_PATH_PROBE_ITEM_ALREADY_IN_INVENTORY");
  if (dropPositionBeforeCollection === undefined)
    incomplete("RETURN_PATH_PROBE_DROP_POSITION_UNAVAILABLE_BEFORE_LOOK");

  const dropLookResult = await body.execute(
    { kind: "look", target: dropPositionBeforeCollection },
    signal,
  );
  updateReturnPathProbeDiagnostic(state, {
    dropLookStatus: dropLookResult.status,
    ...(dropLookResult.status === "successful"
      ? {}
      : { dropVisibilityStatus: "look_failed" as const }),
  });
  if (dropLookResult.status !== "successful")
    incomplete("RETURN_PATH_PROBE_DROP_LOOK_FAILED");

  let visibleDropCandidates: PlayerBodyObservation["perception"]["entities"] =
    [];
  let observationUnavailable = false;
  const visibilityDeadline = Date.now() + 5_000;
  while (!signal.aborted && Date.now() < visibilityDeadline) {
    try {
      const observation = await body.observe();
      visibleDropCandidates = observation.perception.entities.filter(
        (entity) =>
          !entity.isPlayer &&
          entity.name === "item" &&
          Math.hypot(
            entity.position.x - dropPositionBeforeCollection.x,
            entity.position.y - dropPositionBeforeCollection.y,
            entity.position.z - dropPositionBeforeCollection.z,
          ) <= 1,
      );
    } catch {
      observationUnavailable = true;
      break;
    }
    if (visibleDropCandidates.length === 1) break;
    await waitMs(100);
  }
  const dropVisibilityStatus =
    visibleDropCandidates.length === 1
      ? "unique"
      : signal.aborted
        ? "cancelled"
        : observationUnavailable
          ? "observation_unavailable"
          : visibleDropCandidates.length === 0
            ? "not_visible"
            : "ambiguous";
  const visibleDropItem =
    visibleDropCandidates.length === 1 ? visibleDropCandidates[0] : undefined;
  updateReturnPathProbeDiagnostic(state, {
    dropVisibilityStatus,
    visibleDropItemCount: visibleDropCandidates.length,
    ...(visibleDropItem === undefined
      ? {}
      : {
          dropEntityKindClass:
            visibleDropItem.kind === "object" ? "object" : "other",
        }),
  });
  if (visibleDropItem === undefined) {
    incomplete(
      dropVisibilityStatus === "not_visible"
        ? "RETURN_PATH_PROBE_DROP_NOT_VISIBLE_AFTER_LOOK"
        : dropVisibilityStatus === "ambiguous"
          ? "RETURN_PATH_PROBE_DROP_ID_NOT_UNIQUE"
          : dropVisibilityStatus === "cancelled"
            ? "RETURN_PATH_PROBE_DROP_VISIBILITY_CHECK_CANCELLED"
            : "RETURN_PATH_PROBE_DROP_OBSERVATION_UNAVAILABLE",
    );
  }

  const collectionResult = await body.execute(
    { kind: "collect_item", entityId: visibleDropItem.id },
    signal,
  );
  const itemCollectionEffectMatchedTarget =
    collectionResult.observedEffect?.type === "item_collected" &&
    collectionResult.observedEffect.entityId === visibleDropItem.id;
  updateReturnPathProbeDiagnostic(state, {
    itemCollectionAttempted: true,
    itemCollectionStatus: collectionResult.status,
    itemCollectionOutcome: collectionResult.itemCollectionOutcome ?? "none",
    itemCollectionPathFailureReason:
      collectionResult.itemCollectionPathFailureReason ?? "none",
    itemCollectionObservedEffect:
      collectionResult.observedEffect?.type === "item_collected"
        ? "item_collected"
        : "none",
    itemCollectionEffectMatchedTarget,
    itemCollectionRecoveryRequired: collectionResult.recoveryRequired,
  });

  const bodyObservationAfterCollection = collectionResult.after;
  const bodyDropAfterCollection =
    bodyObservationAfterCollection?.perception.entities.find(
      (entity) =>
        entity.id === visibleDropItem.id &&
        !entity.isPlayer &&
        entity.name === "item",
    );
  const bodyInventoryItemPresentAfterCollection =
    bodyObservationAfterCollection === null
      ? "unknown"
      : bodyObservationAfterCollection.self.inventory.some(
          (item) => item.name === "blue_wool" && item.count > 0,
        );
  const bodyPlayerDropDistanceBucketAfterCollection =
    bodyObservationAfterCollection === null ||
    bodyDropAfterCollection === undefined
      ? "unknown"
      : positionDistanceBucket(
          bodyObservationAfterCollection.self.position,
          bodyDropAfterCollection.position,
        );

  let rconDropPresentAfterCollection: boolean | undefined;
  let rconDropObservationAvailableAfterCollection = false;
  let rconPlayerDropDistanceObservationAvailableAfterCollection = false;
  let rconPlayerDropDistanceBucketAfterCollection:
    BodyPositionDriftBucket | "unknown" = "unknown";
  try {
    const rconDropPositionAfterCollection =
      await rconBlueWoolDropPositionWithinRadius(rcon, target, 16);
    rconDropPresentAfterCollection =
      rconDropPositionAfterCollection !== undefined;
    rconDropObservationAvailableAfterCollection = true;
    if (rconDropPositionAfterCollection !== undefined) {
      const rconPlayerPositionAfterCollection = parsePosition(
        await rcon.command(`data get entity ${botName} Pos`),
      );
      rconPlayerDropDistanceBucketAfterCollection = positionDistanceBucket(
        rconPlayerPositionAfterCollection,
        rconDropPositionAfterCollection,
      );
      rconPlayerDropDistanceObservationAvailableAfterCollection = true;
    }
  } catch {
    // Keep raw RCON replies private; report only whether the check completed.
  }
  let inventoryItemPresentAfterCollection: boolean | undefined;
  let inventoryObservationAvailableAfterCollection = false;
  try {
    inventoryItemPresentAfterCollection = await waitForRconInventoryBlueWool(
      rcon,
      botName,
      2_500,
    );
    inventoryObservationAvailableAfterCollection = true;
  } catch {
    // Keep raw RCON replies private; report only whether the check completed.
  }
  const itemPickupConfirmed =
    collectionResult.status === "successful" &&
    collectionResult.itemCollectionOutcome === "collected" &&
    itemCollectionEffectMatchedTarget &&
    inventoryItemPresentAfterCollection === true;
  updateReturnPathProbeDiagnostic(state, {
    bodyObservationAvailableAfterCollection:
      bodyObservationAfterCollection !== null,
    bodyDropVisibleAfterCollection:
      bodyObservationAfterCollection === null
        ? "unknown"
        : bodyDropAfterCollection !== undefined,
    bodyPlayerDropDistanceBucketAfterCollection,
    bodyInventoryItemPresentAfterCollection,
    ...(rconDropPresentAfterCollection === undefined
      ? {}
      : { rconDropPresentAfterCollection }),
    rconDropObservationAvailableAfterCollection,
    rconPlayerDropDistanceObservationAvailableAfterCollection,
    rconPlayerDropDistanceBucketAfterCollection,
    ...(inventoryItemPresentAfterCollection === undefined
      ? {}
      : { inventoryItemPresentAfterCollection }),
    inventoryObservationAvailableAfterCollection,
    itemPickupConfirmed,
  });

  if (!itemPickupConfirmed) {
    updateReturnPathProbeDiagnostic(state, { returnMoveSkippedNoPickup: true });
    if (collectionResult.itemCollectionOutcome === "target_unobservable")
      incomplete("RETURN_PATH_PROBE_TARGET_BECAME_UNOBSERVABLE");
    if (collectionResult.itemCollectionOutcome === "entity_removed")
      incomplete("RETURN_PATH_PROBE_TARGET_ENTITY_REMOVED");
    if (collectionResult.itemCollectionOutcome === "invalid_target")
      incomplete("RETURN_PATH_PROBE_VISIBLE_ITEM_KIND_REJECTED");
    if (collectionResult.itemCollectionOutcome === "pickup_out_of_range")
      incomplete("RETURN_PATH_PROBE_ITEM_PICKUP_OUT_OF_RANGE");
    if (collectionResult.itemCollectionOutcome === "path_failed")
      incomplete("RETURN_PATH_PROBE_ITEM_PATH_FAILED");
    if (collectionResult.itemCollectionOutcome === "deadline_expired")
      incomplete("RETURN_PATH_PROBE_ITEM_COLLECTION_DEADLINE");
    if (collectionResult.status !== "successful")
      incomplete("RETURN_PATH_PROBE_ITEM_COLLECTION_NOT_SUCCESSFUL");
    if (!inventoryObservationAvailableAfterCollection)
      incomplete("RETURN_PATH_PROBE_POST_COLLECTION_INVENTORY_UNAVAILABLE");
    incomplete("RETURN_PATH_PROBE_ITEM_PICKUP_NOT_CONFIRMED_BY_INVENTORY");
  }

  if (collectionResult.recoveryRequired) {
    updateReturnPathProbeDiagnostic(state, {
      returnMoveSkippedRecoveryRequired: true,
    });
    incomplete("RETURN_PATH_PROBE_COLLECTION_RECOVERY_REQUIRED");
  }

  updateReturnPathProbeDiagnostic(state, { returnMoveAttempted: true });
  const returnMove = await executeBodyMovePathProbe(
    body,
    { kind: "move_to", position: spawn, range: 4.5 },
    signal,
  );
  updateReturnPathProbeDiagnostic(state, { returnMove });
  const returnedPosition = parsePosition(
    await rcon.command(`data get entity ${botName} Pos`),
  );
  const returnRconArrivalConfirmed =
    Math.hypot(
      returnedPosition.x - spawn.x,
      returnedPosition.y - spawn.y,
      returnedPosition.z - spawn.z,
    ) <= 4.5;
  const itemPresentAfterReturn = await waitForRconInventoryBlueWool(
    rcon,
    botName,
    2_500,
  );
  updateReturnPathProbeDiagnostic(state, {
    returnRconArrivalConfirmed,
    itemPresentAfterReturn,
  });
  if (returnMove.status !== "successful" || !returnRconArrivalConfirmed)
    incomplete("RETURN_PATH_PROBE_SPAWN_RETURN_NOT_CONFIRMED");
  if (!itemPresentAfterReturn)
    incomplete("RETURN_PATH_PROBE_ITEM_NOT_RETAINED_AFTER_RETURN");
  if (!rconDropObservationAvailableAfterCollection)
    incomplete("RETURN_PATH_PROBE_POST_COLLECTION_DROP_UNAVAILABLE");
  if (rconDropPresentAfterCollection === true)
    incomplete("RETURN_PATH_PROBE_DROP_REMAINS_AFTER_COLLECTION");
}

async function waitForBodyAtPosition(
  body: PlayerBody,
  expected: Position,
  signal: AbortSignal,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal.aborted) {
    const position = (await body.observe()).self.position;
    if (
      Math.hypot(
        position.x - expected.x,
        position.y - expected.y,
        position.z - expected.z,
      ) <= 0.75
    ) {
      return true;
    }
    await waitMs(100);
  }
  return false;
}

async function observeReturnPathDigStage(
  body: PlayerBody,
  rcon: LocalRcon,
  botName: string,
  expected: Position,
): Promise<ReturnPathDigStageObservation> {
  let feetPosition: BlockPosition | undefined;
  let feetBlockClass: ReturnPathDigFeetClass = "unknown";
  let supportBlockClass: ReturnPathDigSupportClass = "unknown";
  let initialPlayerPosition: Position | undefined;
  try {
    initialPlayerPosition = parseOptionalPosition(
      await rcon.command(`data get entity ${botName} Pos`),
    );
  } catch {
    // Keep RCON replies private; an unavailable read is represented as unknown.
  }
  if (initialPlayerPosition !== undefined) {
    feetPosition = {
      x: Math.floor(initialPlayerPosition.x),
      y: Math.floor(initialPlayerPosition.y),
      z: Math.floor(initialPlayerPosition.z),
    };
    try {
      if (await isBlock(rcon, feetPosition, "air")) {
        feetBlockClass = "dry";
      } else if (await isBlock(rcon, feetPosition, "water")) {
        feetBlockClass = "water";
      } else {
        feetBlockClass = "other";
      }
    } catch {
      feetBlockClass = "unknown";
    }
    try {
      supportBlockClass = (await isBlock(
        rcon,
        {
          ...feetPosition,
          y: feetPosition.y - 1,
        },
        "stone",
      ))
        ? "stone"
        : "other";
    } catch {
      supportBlockClass = "unknown";
    }
  }
  let bodyPosition: Position | undefined;
  try {
    bodyPosition = (await body.observe()).self.position;
  } catch {
    // Keep Body diagnostics fixed and safe.
  }
  let playerPosition: Position | undefined;
  try {
    playerPosition = parseOptionalPosition(
      await rcon.command(`data get entity ${botName} Pos`),
    );
  } catch {
    // Keep RCON replies private; an unavailable read is represented as unknown.
  }
  const playerDistanceBucket = returnPathDistanceBucket(
    playerPosition,
    expected,
  );
  const bodyDistanceBucket = returnPathDistanceBucket(bodyPosition, expected);
  const feetCellStable =
    feetPosition !== undefined &&
    playerPosition !== undefined &&
    feetPosition.x === Math.floor(playerPosition.x) &&
    feetPosition.y === Math.floor(playerPosition.y) &&
    feetPosition.z === Math.floor(playerPosition.z);
  const positionsAgree =
    playerPosition !== undefined &&
    returnPathDistanceBucket(bodyPosition, playerPosition) === "<1";
  const stable =
    playerDistanceBucket === "<1" &&
    bodyDistanceBucket === "<1" &&
    feetCellStable &&
    positionsAgree;
  return {
    playerDistanceBucket,
    bodyDistanceBucket,
    feetBlockClass,
    supportBlockClass,
    stable,
    ready: stable && feetBlockClass === "dry" && supportBlockClass === "stone",
  };
}

function returnPathDistanceBucket(
  current: Position | undefined,
  expected: Position,
): BodyPositionDriftBucket | "unknown" {
  if (
    current === undefined ||
    ![current.x, current.y, current.z].every(Number.isFinite)
  ) {
    return "unknown";
  }
  return positionDriftBucket(
    Math.hypot(
      current.x - expected.x,
      current.y - expected.y,
      current.z - expected.z,
    ),
  );
}

async function rconInventoryHasBlueWool(
  rcon: LocalRcon,
  botName: string,
): Promise<boolean> {
  const inventory = await rcon.command(`data get entity ${botName} Inventory`);
  return /minecraft:blue_wool/iu.test(inventory);
}

async function rconInventoryItemCount(
  rcon: LocalRcon,
  botName: string,
  item: "bread",
): Promise<number> {
  const inventory = await rcon.command(`data get entity ${botName} Inventory`);
  const itemId = new RegExp(`\\bid\\s*:\\s*["']minecraft:${item}["']`, "u");
  let count = 0;
  for (const stack of inventory.matchAll(/\{[^{}]*\}/gu)) {
    if (!itemId.test(stack[0])) continue;
    const stackCount = /\b(?:count|Count)\s*:\s*(\d+)(?:[bBsSlL])?\b/u.exec(
      stack[0],
    );
    if (stackCount === null)
      incomplete("FOOD_INTENT_INVENTORY_COUNT_UNAVAILABLE");
    count += Number(stackCount[1]);
  }
  return count;
}

async function rconInventoryIsEmpty(
  rcon: LocalRcon,
  botName: string,
  failureCode = "NO_FOOD_FIXTURE_RCON_INVENTORY_NOT_EMPTY_OR_UNAVAILABLE",
): Promise<boolean> {
  const inventory = await rcon.command(`data get entity ${botName} Inventory`);
  if (!/\[\s*\]\s*$/u.test(inventory.trim())) incomplete(failureCode);
  return true;
}

async function rconFoodLevel(
  rcon: LocalRcon,
  botName: string,
): Promise<number> {
  const reply = await rcon.command(`data get entity ${botName} foodLevel`);
  const match = /(?:^|:\s*)(\d+)(?:[bBsSlL])?\s*$/u.exec(reply.trim());
  const foodLevel = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(foodLevel) || foodLevel < 0 || foodLevel > 20)
    incomplete("FOOD_INTENT_FOOD_LEVEL_UNAVAILABLE");
  return foodLevel;
}

async function rconEntityHealth(
  rcon: LocalRcon,
  botName: string,
  timeoutMs = 5_000,
): Promise<number> {
  const reply = await rcon.command(
    `data get entity ${botName} Health`,
    timeoutMs,
  );
  const match = /(?:^|:\s*)(\d+(?:\.\d+)?)(?:[bBsSlLfFdD])?\s*$/u.exec(
    reply.trim(),
  );
  const health = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(health) || health < 0 || health > 20)
    incomplete("DAMAGE_RESPONSE_RCON_HEALTH_UNAVAILABLE");
  return health;
}

async function rconActiveEffectsState(
  rcon: LocalRcon,
  botName: string,
): Promise<"empty" | "active" | "unknown"> {
  const reply = await rcon
    .command(`data get entity ${botName} active_effects`)
    .catch(() => "");
  return classifyRconActiveEffectsReply(reply);
}

const DAMAGE_RESPONSE_CANDIDATE_OPERATIONS = new Set([
  "look_sweep",
  "consume",
  "equip",
  "move_to",
  "move_relative",
]);

export function classifyDamageResponsePostDamageJudgment(
  judgments: PlayerEvidence["recentJudgments"],
  priorJudgments: ReadonlySet<string>,
  damageAppliedAt: number,
): "candidate" | "other" | "not_observed" | "unknown" {
  const fresh = judgments.filter(
    (judgment) =>
      !priorJudgments.has(
        `${judgment.revision ?? ""}:${judgment.decidedAt ?? ""}`,
      ),
  );
  const postDamage = fresh.filter((judgment) => {
    const decidedAt = Date.parse(judgment.decidedAt ?? "");
    return Number.isFinite(decidedAt) && decidedAt >= damageAppliedAt;
  });
  if (
    postDamage.some((judgment) =>
      DAMAGE_RESPONSE_CANDIDATE_OPERATIONS.has(
        safeOperationKind(judgment.operationKind) ?? "",
      ),
    )
  )
    return "candidate";
  if (
    fresh.some((judgment) => {
      const decidedAt = Date.parse(judgment.decidedAt ?? "");
      return (
        !Number.isFinite(decidedAt) ||
        (decidedAt >= damageAppliedAt &&
          safeOperationKind(judgment.operationKind) === undefined)
      );
    })
  )
    return "unknown";
  return postDamage.length > 0 ? "other" : "not_observed";
}

export function damageResponseHasJudgmentLinkedOutcome(
  beforeOutcomes: PlayerEvidence["recentOutcomes"],
  currentJudgments: PlayerEvidence["recentJudgments"],
  currentOutcomes: PlayerEvidence["recentOutcomes"],
  priorJudgments: ReadonlySet<string>,
  damageAppliedAt: number,
): boolean {
  const priorOutcomeIds = new Set(
    beforeOutcomes.map((outcome) => outcome.operationId),
  );
  const outcomes = currentOutcomes.filter(
    (outcome) =>
      !priorOutcomeIds.has(outcome.operationId) &&
      outcome.status === "successful",
  );
  return currentJudgments.some((judgment) => {
    const judgmentKey = `${judgment.revision ?? ""}:${judgment.decidedAt ?? ""}`;
    const judgmentAt = Date.parse(judgment.decidedAt ?? "");
    const operationKind = judgment.operationKind;
    if (
      priorJudgments.has(judgmentKey) ||
      !Number.isFinite(judgmentAt) ||
      judgmentAt < damageAppliedAt ||
      operationKind === undefined ||
      !DAMAGE_RESPONSE_CANDIDATE_OPERATIONS.has(operationKind)
    )
      return false;
    return outcomes.some(
      (outcome) =>
        outcome.kind === operationKind &&
        outcome.observedAt !== undefined &&
        Number.isFinite(Date.parse(outcome.observedAt)) &&
        Date.parse(outcome.observedAt) >= judgmentAt,
    );
  });
}

export function classifyRconActiveEffectsReply(
  reply: string,
): "empty" | "active" | "unknown" {
  const value = reply.trim();
  if (/^Found no elements matching active_effects$/iu.test(value))
    return "empty";
  if (/\[\s*\]\s*$/u.test(value)) return "empty";
  if (/\[\s*\{[\s\S]*\}\s*\]\s*$/u.test(value)) return "active";
  return "unknown";
}

export function damageResponseCleanupDisposition(
  primaryFailureCode: string | undefined,
  cleanupConfirmed: boolean,
):
  | {
      readonly primaryFailureCode?: string;
      readonly cleanupFailureCode: "DAMAGE_RESPONSE_FIXTURE_CLEANUP_NOT_CONFIRMED";
      readonly throwCleanupFailure: boolean;
    }
  | undefined {
  if (cleanupConfirmed) return undefined;
  return {
    ...(primaryFailureCode === undefined ? {} : { primaryFailureCode }),
    cleanupFailureCode: "DAMAGE_RESPONSE_FIXTURE_CLEANUP_NOT_CONFIRMED",
    throwCleanupFailure: primaryFailureCode === undefined,
  };
}

export function damageResponseFoodBaselineConfirmed(
  bodyFood: number | undefined,
  rconFood: number | undefined,
  expectedFood: number,
): boolean {
  return bodyFood === expectedFood && rconFood === expectedFood;
}

async function rconNaturalRegeneration(rcon: LocalRcon): Promise<boolean> {
  const reply = await rcon.command(
    `gamerule ${E2E_GAMERULES.naturalRegeneration.id}`,
  );
  const value = /(?:^|\s)(true|false)\s*$/iu.exec(reply.trim())?.[1];
  if (value === undefined)
    incomplete("DAMAGE_RESPONSE_REGENERATION_STATE_UNAVAILABLE");
  return value.toLowerCase() === "true";
}

async function rconHasActiveEffect(
  rcon: LocalRcon,
  botName: string,
  effect: "hunger" | "saturation",
): Promise<boolean> {
  const activeEffects = await rcon.command(
    `data get entity ${botName} active_effects`,
  );
  return new RegExp(`\\bid\\s*:\\s*["']minecraft:${effect}["']`, "iu").test(
    activeEffects,
  );
}

async function rconBlueWoolDropPositionNear(
  rcon: LocalRcon,
  target: BlockPosition,
): Promise<Position | undefined> {
  return rconBlueWoolDropPositionWithinRadius(rcon, target, 2);
}

async function rconBlueWoolDropPositionWithinRadius(
  rcon: LocalRcon,
  target: BlockPosition,
  radius: 2 | 4 | 8 | 16,
): Promise<Position | undefined> {
  const selector = `@e[type=minecraft:item,limit=1,sort=nearest,distance=..${radius},nbt={Item:{id:"minecraft:blue_wool"}}]`;
  const reply = await rcon.command(
    `execute positioned ${target.x + 0.5} ${target.y + 0.5} ${target.z + 0.5} if entity ${selector} run data get entity ${selector} Pos`,
  );
  return parseOptionalPosition(reply);
}

function parseOptionalPosition(value: string): Position | undefined {
  const match =
    /\[\s*(-?\d+(?:\.\d+)?)d?\s*,\s*(-?\d+(?:\.\d+)?)d?\s*,\s*(-?\d+(?:\.\d+)?)d?\s*\]/u.exec(
      value,
    );
  if (match === null) return undefined;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const z = Number(match[3]);
  if (![x, y, z].every(Number.isFinite)) return undefined;
  return { x, y, z };
}

async function waitForRconInventoryBlueWool(
  rcon: LocalRcon,
  botName: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await rconInventoryHasBlueWool(rcon, botName)) return true;
    if (Date.now() < deadline) await waitMs(100);
  } while (Date.now() < deadline);
  return false;
}

async function connectApplication(
  app: CompanionApplication,
  state: RunState,
): Promise<void> {
  try {
    await app.start();
  } catch (error) {
    state.applicationStartDiagnostic = applicationStartDiagnostic(error, state);
    incomplete("APPLICATION_START_FAILED");
  }
}

async function stopAndRestartForUnknownCase(
  state: RunState,
  context: CaseContext,
): Promise<{ readonly context: CaseContext; readonly stopGeneration: number }> {
  if (state.autonomousLifeProgress?.milestoneSeen !== true)
    incomplete("AUTONOMOUS_MILESTONE_NOT_RECORDED");
  updateUnknownCompositeDiagnostic(state, {
    unknownHandoffMilestoneConfirmed: true,
    unknownHandoffStopRequested: false,
    unknownHandoffStopLatchConfirmed: false,
    unknownHandoffActiveTerminalRequired: false,
    unknownHandoffActiveTerminalObserved: false,
    unknownHandoffPendingCancelled: false,
    unknownHandoffPendingOperationAtStop: false,
    unknownHandoffShutdownCompleted: false,
    unknownHandoffDisconnectConfirmed: false,
    unknownHandoffRestarted: false,
    unknownHandoffStoppedLatchRestored: false,
    unknownHandoffFixturePreparedWhileStopped: false,
    unknownHandoffResumeRequested: false,
    unknownHandoffResumed: false,
    unknownHandoffTaskSent: false,
  });

  const beforeStop = playerOf(await collect(context.runtime.app));
  if (beforeStop.stopped) incomplete("AUTONOMOUS_STOPPED_BEFORE_HANDOFF");
  const activeBeforeStop = beforeStop.activeOperation;
  const activeBodyStarted = typeof activeBeforeStop?.bodyStartedAt === "string";
  const terminalRequired = activeBeforeStop !== undefined && activeBodyStarted;
  updateUnknownCompositeDiagnostic(state, {
    unknownHandoffActiveOperationPresent: activeBeforeStop !== undefined,
    unknownHandoffActiveBodyStarted: activeBodyStarted,
    unknownHandoffActiveBodyElapsedBucket: activeBodyElapsedBucket(beforeStop),
    unknownHandoffActiveTerminalRequired: terminalRequired,
    unknownHandoffPendingOperationAtStop:
      activeBeforeStop !== undefined && !activeBodyStarted,
  });

  const stopGenerationBefore = beforeStop.stopGeneration;
  sendChat(context.owner, "今の行動を停止してください。");
  updateUnknownCompositeDiagnostic(state, {
    unknownHandoffStopRequested: true,
  });
  const stopped = await waitForPlayer(context, 45_000, (player) => {
    const activeTerminalObserved =
      terminalRequired &&
      hasTerminalOutcomeForOperation(
        activeBeforeStop.operationId,
        player.recentOutcomes,
      );
    const stopBoundaryConfirmed = isStoppedHandoffBoundaryConfirmed({
      stopped: player.stopped,
      activeCleared: !isOperationActive(player),
      stopGeneration: player.stopGeneration,
      previousStopGeneration: stopGenerationBefore,
      terminalRequired,
      ...(terminalRequired
        ? { operationId: activeBeforeStop.operationId }
        : {}),
      outcomes: player.recentOutcomes,
    });
    updateUnknownCompositeDiagnostic(state, {
      unknownHandoffStopLatchConfirmed: player.stopped,
      unknownHandoffActiveCleared: !isOperationActive(player),
      unknownHandoffStopGenerationAdvanced:
        player.stopGeneration > stopGenerationBefore,
      unknownHandoffActiveTerminalObserved: activeTerminalObserved,
      unknownHandoffPendingCancelled:
        activeBeforeStop !== undefined &&
        !activeBodyStarted &&
        stopBoundaryConfirmed,
    });
    return stopBoundaryConfirmed;
  });
  const stopGeneration = stopped.stopGeneration;

  await boundedShutdown(context.runtime.app, "ai_player_e2e_unknown_handoff");
  if (appForCleanup === context.runtime.app) appForCleanup = undefined;
  updateUnknownCompositeDiagnostic(state, {
    unknownHandoffShutdownCompleted: true,
  });
  await waitForPlayerEntityDisconnect(
    context.rcon,
    context.botName,
    Math.min(10_000, context.caseDeadlineAt - Date.now()),
  );
  updateUnknownCompositeDiagnostic(state, {
    unknownHandoffDisconnectConfirmed: true,
  });

  const { createApplication } = await import("../../src/app/application.js");
  const nextApp = createApplication(
    context.runtime.config,
    state.llmAdmission?.beforeCall,
  );
  appForCleanup = nextApp;
  await connectApplication(nextApp, state);
  const restartedEvidence = await collect(nextApp);
  const restartedPlayer = playerOf(restartedEvidence);
  if (
    restartedEvidence.connectionState !== "connected" ||
    !restartedPlayer.stopped ||
    restartedPlayer.stopGeneration !== stopGeneration ||
    isOperationActive(restartedPlayer)
  ) {
    incomplete("UNKNOWN_HANDOFF_STOPPED_RESTART_NOT_CONFIRMED");
  }
  updateUnknownCompositeDiagnostic(state, {
    unknownHandoffRestarted: true,
    unknownHandoffStoppedLatchRestored: true,
  });

  const restartedContext: CaseContext = {
    ...makeContext(
      state,
      nextApp,
      context.runtime.config,
      context.rcon,
      context.owner,
      context.guest,
    ),
    usageAtStart: context.usageAtStart,
    runUsageAtStart: context.runUsageAtStart,
    startedAt: context.startedAt,
    runDeadlineAt: context.runDeadlineAt,
    caseDeadlineAt: context.caseDeadlineAt,
    runBudget: context.runBudget,
    ...(context.caseBudget === undefined
      ? {}
      : { caseBudget: context.caseBudget }),
  };
  liveContext = restartedContext;
  return { context: restartedContext, stopGeneration };
}

async function waitForPlayerEntityDisconnect(
  rcon: LocalRcon,
  botName: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const positionPattern =
    /\[\s*-?\d+(?:\.\d+)?d?\s*,\s*-?\d+(?:\.\d+)?d?\s*,\s*-?\d+(?:\.\d+)?d?\s*\]/u;
  while (Date.now() < deadline) {
    const reply = await rcon.command(`data get entity ${botName} Pos`);
    if (/no entity was found/iu.test(reply)) return;
    if (!positionPattern.test(reply))
      incomplete("PLAYER_DISCONNECT_STATE_UNKNOWN");
    await waitMs(250);
  }
  incomplete("PLAYER_DISCONNECT_NOT_CONFIRMED");
}

function resumeAfterUnknownFixture(
  state: RunState,
  context: CaseContext,
  stopGeneration: number,
): Promise<PlayerEvidence> {
  updateUnknownCompositeDiagnostic(state, {
    unknownHandoffResumeRequested: true,
  });
  sendChat(context.owner, "自律を再開してください。");
  return waitForPlayer(context, 90_000, (player) => {
    const resumed = !player.stopped && player.stopGeneration > stopGeneration;
    updateUnknownCompositeDiagnostic(state, {
      unknownHandoffResumed: resumed,
    });
    return resumed;
  });
}

const APPLICATION_SHUTDOWN_TIMEOUT_MS = 10_000;

async function boundedShutdown(
  app: CompanionApplication | undefined,
  reason: string,
  timeoutMs = APPLICATION_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  if (app === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.shutdown(reason),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HarnessError("incomplete", "APPLICATION_SHUTDOWN_TIMEOUT"),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function connectPublicClient(
  port: number,
  username: string,
): Promise<Bot> {
  const bot = mineflayer.createBot({
    host: "127.0.0.1",
    port,
    username,
    auth: "offline",
    version: SERVER_VERSION,
    hideErrors: true,
  });
  await new Promise<void>((resolveSpawn, reject) => {
    const timeout = setTimeout(
      () =>
        reject(new HarnessError("incomplete", "PUBLIC_TEST_CLIENT_TIMEOUT")),
      45_000,
    );
    bot.once("spawn", () => {
      clearTimeout(timeout);
      resolveSpawn();
    });
    bot.once("error", () => {
      clearTimeout(timeout);
      reject(new HarnessError("incomplete", "PUBLIC_TEST_CLIENT_FAILED"));
    });
  });
  return bot;
}

function makeContext(
  state: RunState,
  app: CompanionApplication,
  config: ReturnType<typeof loadConfig>,
  rcon: LocalRcon,
  owner: Bot,
  guest: Bot,
): CaseContext {
  return {
    runtime: {
      app,
      config,
      databasePath: state.databasePath,
      exchangeDirectory: state.exchangeDirectory,
    },
    rcon,
    owner,
    guest,
    botName: state.botName,
    ownerName: state.ownerName,
    responseQueue: state.responses,
    usageAtStart: state.countersInitial ?? zeroCounters(),
    runUsageAtStart: state.countersInitial ?? zeroCounters(),
    startedAt: state.startedClock,
    runDeadlineAt: state.runDeadlineAt,
    caseDeadlineAt: state.runDeadlineAt,
    runBudget: state.runBudget,
  };
}

let liveContext: CaseContext | undefined;

function requireLiveContext(): CaseContext {
  if (liveContext === undefined) incomplete("LIVE_RUNTIME_CONTEXT_MISSING");
  return liveContext;
}

function ownerReturnSettlementContext(
  state: RunState,
): CaseContext | undefined {
  if (liveContext === undefined) return undefined;
  const caseDeadlineAt = state.ownerReturnCaseDeadlineAt;
  return caseDeadlineAt === undefined ||
    caseDeadlineAt === liveContext.caseDeadlineAt
    ? liveContext
    : { ...liveContext, caseDeadlineAt };
}

async function recordCase(
  state: RunState,
  id: string,
  deadlineMs: number,
  context: CaseContext,
  runCaseBody: (
    context: CaseContext,
  ) => Promise<Readonly<Record<string, boolean | number | string>>>,
): Promise<SafeCaseResult> {
  if (!isCaseSelectedForTarget(state.targetCase, id)) {
    const skipped: SafeCaseResult = {
      id,
      status: "incomplete",
      durationMs: 0,
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      usageStatus: "runtime_reported",
      evidence: {},
      reason: "CASE_NOT_SELECTED",
    };
    state.cases.push(skipped);
    return skipped;
  }
  const caseBudget = Object.entries(CASE_BUDGETS).find(
    ([caseId]) => caseId === id,
  )?.[1];
  if (caseBudget === undefined) incomplete("CASE_BUDGET_NOT_CONFIGURED");
  const caseAdmissionLimit = ownerReturnCaseCallLimit(
    state.targetCase,
    caseBudget.llmCalls,
    state.ownerReturnRequestGate,
  );
  if (caseAdmissionLimit === undefined)
    incomplete("OWNER_RETURN_REQUEST_GATE_NOT_READY");
  state.llmAdmission?.beginCase(caseAdmissionLimit);
  try {
    return await runCase(
      state,
      id,
      deadlineMs,
      caseBudget.llmCalls,
      caseBudget.totalTokens,
      async () => {
        const baseline = countersOf(await collect(context.runtime.app));
        const caseStarted = Date.now();
        const caseContext: CaseContext = {
          ...context,
          usageAtStart: baseline,
          runUsageAtStart: context.runUsageAtStart,
          startedAt: caseStarted,
          caseDeadlineAt: Math.min(
            caseStarted + deadlineMs,
            state.runDeadlineAt,
          ),
          runBudget: state.runBudget,
          caseBudget,
        };
        if (
          id === "owner_return_through_door" &&
          ownerReturnRequestGateEnabled(state.targetCase)
        ) {
          state.ownerReturnCaseDeadlineAt = caseContext.caseDeadlineAt;
        }
        const measured = await runCaseBody(caseContext);
        const finalUsage = countersOf(
          await collect(requireLiveContext().runtime.app),
        );
        const delta = subtractCounters(finalUsage, baseline);
        if (
          delta.llmCalls > caseBudget.llmCalls ||
          totalTokens(delta) > caseBudget.totalTokens
        ) {
          incomplete("CASE_LLM_BUDGET_EXCEEDED");
        }
        return {
          ...measured,
          llmCalls: delta.llmCalls,
          tokens: totalTokens(delta),
        };
      },
    );
  } finally {
    state.llmAdmission?.endCase();
    if (id === "gather_multi_target_continuity") {
      if (state.gatherMultiTargetRequestGate?.inFlightRequests === 0) {
        delete state.gatherMultiTargetRequestGate;
      }
      delete state.gatherMultiTargetRequestGateUsageStart;
    }
  }
}

async function runCase(
  state: RunState,
  id: string,
  deadlineMs: number,
  maxCalls: number,
  maxTokens: number,
  body: () => Promise<Readonly<Record<string, boolean | number | string>>>,
): Promise<SafeCaseResult> {
  const started = Date.now();
  const snapshotCapture: { latestEvidence?: Evidence } = {};
  const previousSnapshotCapture = activeCaseSnapshotCapture;
  activeCaseSnapshotCapture = snapshotCapture;
  let initial = zeroCounters();
  let initialCaptured = false;
  let caseExecuted = false;
  try {
    if (!shouldCollectAfterRun(state))
      incomplete(state.failureCode ?? "RUN_STOPPED_AFTER_BUDGET_OR_DEADLINE");
    const dependencyFailure = unknownHandoffCaseBlockCode(
      id,
      state.unknownHandoffDependency ?? "not_started",
    );
    if (dependencyFailure !== undefined) incomplete(dependencyFailure);
    caseExecuted = true;
    if (liveContext !== undefined) {
      initial = countersOf(await collect(liveContext.runtime.app));
      initialCaptured = true;
    }
    if (
      id === "owner_return_through_door" &&
      ownerReturnRequestGateEnabled(state.targetCase)
    ) {
      state.ownerReturnCaseUsageStart ??= initial;
      state.ownerReturnRequestGate ??= new AcceptedProviderRequestGate();
      updateOwnerReturnDiagnostic(state, {
        ...ownerReturnRequestDiagnosticPatch(state, "unknown", false),
      });
    }
    if (
      id === "gather_multi_target_continuity" &&
      isGatherMultiTargetCaseSelected(state.targetCase)
    ) {
      state.gatherMultiTargetRequestGateUsageStart = initial;
      state.gatherMultiTargetRequestGate = new AcceptedProviderRequestGate();
      state.gatherMultiTargetRequestedCounts = {
        oak_log: "unknown",
        birch_log: "unknown",
      };
      updateGatherMultiTargetDiagnostic(state, {
        gatherCaseStarted: true,
        gatherRequestedOakLogCount: "unknown",
        gatherRequestedBirchLogCount: "unknown",
        gatherRemainingQuantity: "unknown",
        gatherGoalCompletionStatus: "unknown_target_quantity_unspecified",
        gatherProgressExplanationStatus: "unverified_not_sampled",
      });
    }
    if (Date.now() >= state.runDeadlineAt) incomplete("RUN_DEADLINE_EXCEEDED");
    const timeoutMs = Math.max(
      1,
      Math.min(deadlineMs, state.runDeadlineAt - started),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evidence = await Promise.race([
      body(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new HarnessError("incomplete", "CASE_DEADLINE_EXCEEDED")),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    const terminalEvidence =
      liveContext === undefined
        ? undefined
        : await collect(liveContext.runtime.app);
    const final =
      terminalEvidence === undefined ? initial : countersOf(terminalEvidence);
    const delta = subtractCounters(final, initial);
    if (id === "no_food_replan" && terminalEvidence !== undefined) {
      const requestGate = state.noFoodReplanRequestGate;
      const caseStart = state.noFoodReplanCaseUsageStart;
      if (!requestGate?.acceptanceLatched || caseStart === undefined)
        incomplete("NO_FOOD_REPLAN_ACCEPTANCE_NOT_LATCHED");
      requestGate.observeRecordedCalls(
        subtractCounters(final, caseStart).llmCalls,
      );
      if (requestGate.requestsRecorded > requestGate.requestsStarted)
        incomplete("NO_FOOD_REPLAN_ADMISSION_USAGE_MISMATCH");
      if (requestGate.inFlightRequests !== 0)
        incomplete("NO_FOOD_REPLAN_ACCEPTED_REQUESTS_NOT_SETTLED");
    }
    if (id === "gather_multi_target_continuity") {
      const requestGate = state.gatherMultiTargetRequestGate;
      const requestGateUsageStart =
        state.gatherMultiTargetRequestGateUsageStart;
      if (!requestGate?.latched)
        incomplete("GATHER_MULTI_TARGET_ACCEPTANCE_NOT_LATCHED");
      if (requestGateUsageStart === undefined)
        incomplete("GATHER_MULTI_TARGET_ACCEPTANCE_GATE_MISSING");
      requestGate.observeRecordedCalls(
        subtractCounters(final, requestGateUsageStart).llmCalls,
      );
      if (
        requestGate.requestsRecorded > requestGate.requestsStarted ||
        requestGate.inFlightRequests !== 0
      ) {
        incomplete("GATHER_MULTI_TARGET_ACCEPTED_REQUESTS_NOT_SETTLED");
      }
      if (delta.usageUnknownCalls > 0)
        incomplete("GATHER_MULTI_TARGET_USAGE_PARTIAL_OR_UNKNOWN");
    }
    if (delta.llmCalls > maxCalls || totalTokens(delta) > maxTokens)
      incomplete("CASE_BUDGET_EXCEEDED");
    if (delta.usageUnknownCalls > 0) state.usageUncertain = true;
    if (id === "no_food_replan" && delta.usageUnknownCalls > 0)
      incomplete("LLM_USAGE_PARTIAL_OR_UNKNOWN");
    if (
      delta.llmCalls > 0 &&
      totalTokens(delta) === 0 &&
      delta.usageUnknownCalls === 0
    ) {
      state.usageUncertain = true;
      incomplete("LLM_USAGE_NOT_REPORTED");
    }
    const runDelta = subtractCounters(
      final,
      state.countersInitial ?? zeroCounters(),
    );
    if (
      runDelta.llmCalls > state.runBudget.llmCalls ||
      totalTokens(runDelta) > state.runBudget.totalTokens
    )
      incomplete("RUN_LLM_BUDGET_EXCEEDED");
    const item: SafeCaseResult = {
      id,
      status: "pass",
      durationMs: Date.now() - started,
      llmCalls: delta.llmCalls,
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      latencyMs: delta.latencyMs,
      usageStatus:
        delta.usageUnknownCalls > 0 ? "partial_or_unknown" : "runtime_reported",
      evidence: {
        ...evidence,
        ...(id === "no_food_replan" ? noFoodReplanRequestEvidence(state) : {}),
        ...(id === "gather_multi_target_continuity"
          ? gatherMultiTargetSafeEvidence(state)
          : {}),
        ...(id === "owner_return_through_door" &&
        ownerReturnRequestGateEnabled(state.targetCase)
          ? ownerReturnRequestSafeEvidence(state)
          : {}),
        ...safeUsageUnknownReasonEvidence(id, delta),
      },
    };
    await retainCasePlayerSnapshot(
      state,
      id,
      item.status,
      null,
      terminalEvidence ?? snapshotCapture.latestEvidence,
      terminalEvidence !== undefined
        ? "fresh_terminal"
        : snapshotCapture.latestEvidence !== undefined
          ? "last_collected"
          : "unavailable",
    );
    state.cases.push(item);
    return item;
  } catch (error) {
    const reason =
      error instanceof HarnessError ? error.code : "CASE_EXECUTION_ERROR";
    const caseStatus =
      error instanceof HarnessError ? error.status : "incomplete";
    if (
      id === "gather_multi_target_continuity" &&
      state.gatherMultiTargetRequestGate !== undefined
    ) {
      const sampledProgressStatus =
        state.gatherMultiTargetDiagnostic?.gatherProgressExplanationStatus;
      state.gatherMultiTargetRequestGate.latch();
      updateGatherMultiTargetDiagnostic(state, {
        gatherAcceptanceLatched: true,
        gatherProgressExplanationStatus:
          typeof sampledProgressStatus === "string"
            ? sampledProgressStatus
            : "unverified_not_sampled",
      });
    }
    const ownerReturnCase =
      id === "owner_return_through_door" &&
      ownerReturnRequestGateEnabled(state.targetCase);
    let ownerReturnFailureSettlement:
      Awaited<ReturnType<typeof settleOwnerReturnCaseFailure>> | undefined;
    if (ownerReturnCase && state.ownerReturnRequestGate !== undefined) {
      const settle = () =>
        settleOwnerReturnRequests(state, ownerReturnSettlementContext(state));
      ownerReturnFailureSettlement = await settleOwnerReturnCaseFailure(
        caseStatus,
        settle,
        /BUDGET|DEADLINE/u.test(reason)
          ? async () => {
              try {
                await boundedShutdown(
                  appForCleanup,
                  "ai_player_e2e_budget_or_deadline",
                );
              } catch {
                state.failureCode ??= "APPLICATION_SHUTDOWN_FAILED";
              }
            }
          : undefined,
      );
      if (ownerReturnFailureSettlement.usageUnknown) {
        state.usageUncertain = true;
      }
    }
    let terminalEvidence: Evidence | undefined;
    let final = initial;
    if (
      caseExecuted &&
      liveContext !== undefined &&
      shouldCollectAfterRun(state)
    ) {
      try {
        terminalEvidence = await collect(liveContext.runtime.app);
        final = countersOf(terminalEvidence);
      } catch {
        final = initialCaptured ? (state.countersFinal ?? initial) : initial;
      }
    } else if (
      ownerReturnCase &&
      state.countersFinal !== undefined &&
      initialCaptured
    ) {
      final = state.countersFinal;
    }
    const delta = subtractCounters(final, initial);
    const usageUncertain =
      id !== "body_operation_smoke" &&
      id !== "no_food_fixture_probe" &&
      id !== "no_food_continuity_probe" &&
      (ownerReturnCase
        ? delta.usageUnknownCalls > 0 ||
          (delta.llmCalls > 0 && totalTokens(delta) === 0) ||
          ownerReturnFailureSettlement?.usageUnknown !== false
        : /BUDGET|DEADLINE/u.test(reason) ||
          delta.usageUnknownCalls > 0 ||
          (delta.llmCalls > 0 && totalTokens(delta) === 0) ||
          caseStatus === "incomplete");
    if (usageUncertain) state.usageUncertain = true;
    const lastEvidence = terminalEvidence ?? snapshotCapture.latestEvidence;
    if (caseExecuted) {
      await retainCasePlayerSnapshot(
        state,
        id,
        caseStatus,
        reason,
        lastEvidence,
        terminalEvidence !== undefined
          ? "fresh_terminal"
          : lastEvidence !== undefined
            ? "last_collected"
            : "unavailable",
      );
    }
    if (/BUDGET|DEADLINE/u.test(reason)) {
      state.abortRequested = true;
      state.failureCode ??= reason;
      if (!ownerReturnCase) {
        try {
          await boundedShutdown(
            appForCleanup,
            "ai_player_e2e_budget_or_deadline",
          );
        } catch {
          state.failureCode ??= "APPLICATION_SHUTDOWN_FAILED";
        }
      }
    }
    const item: SafeCaseResult = {
      id,
      status: ownerReturnFailureSettlement?.caseStatus ?? caseStatus,
      durationMs: Date.now() - started,
      llmCalls: delta.llmCalls,
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      latencyMs: delta.latencyMs,
      usageStatus: usageUncertain ? "partial_or_unknown" : "runtime_reported",
      evidence: {
        ...(id === "body_operation_smoke"
          ? bodySmokeEvidence(state.bodySmokeDiagnostic)
          : {}),
        ...(reason === "RUN_STOPPED_AFTER_BUDGET_OR_DEADLINE"
          ? {}
          : safeFailureEvidence(state, id)),
        ...(id === "unknown_composite"
          ? (state.unknownCompositeDiagnostic ?? {})
          : {}),
        ...(id === "game_action_discretion" && /BUDGET|DEADLINE/u.test(reason)
          ? safeGameActionFailureEvidence(state, lastEvidence)
          : {}),
        ...safeUsageUnknownReasonEvidence(id, delta),
      },
      reason,
    };
    state.cases.push(item);
    return item;
  } finally {
    if (activeCaseSnapshotCapture === snapshotCapture) {
      activeCaseSnapshotCapture = previousSnapshotCapture;
    }
  }
}

async function collect(app: CompanionApplication): Promise<Evidence> {
  try {
    const evidence = (await app.collectLiveEvidence()) as Evidence;
    if (activeCaseSnapshotCapture !== undefined) {
      activeCaseSnapshotCapture.latestEvidence = evidence;
    }
    const state = currentRunState;
    if (state !== undefined) {
      try {
        const player = playerOf(evidence);
        const counters = countersOf(evidence);
        state.countersFinal = counters;
        if (
          state.targetCase === "no_food_replan" &&
          state.noFoodReplanCaseUsageStart !== undefined
        ) {
          state.noFoodReplanLatestCounters = counters;
          const caseCalls = subtractCounters(
            counters,
            state.noFoodReplanCaseUsageStart,
          ).llmCalls;
          state.noFoodReplanRequestGate?.observeRecordedCalls(caseCalls);
        }
        if (
          ownerReturnRequestGateEnabled(state.targetCase) &&
          state.ownerReturnCaseUsageStart !== undefined
        ) {
          const caseCalls = subtractCounters(
            counters,
            state.ownerReturnCaseUsageStart,
          ).llmCalls;
          state.ownerReturnRequestGate?.observeRecordedCalls(caseCalls);
        }
        if (
          state.gatherMultiTargetRequestGate !== undefined &&
          state.gatherMultiTargetRequestGateUsageStart !== undefined
        ) {
          const caseCalls = subtractCounters(
            counters,
            state.gatherMultiTargetRequestGateUsageStart,
          ).llmCalls;
          state.gatherMultiTargetRequestGate.observeRecordedCalls(caseCalls);
        }
        state.lastKnownPlayerDiagnostic = safePlayerDiagnostic(
          player,
          counters,
        );
      } catch {
        // Preserve the caller's existing validation and its safe error code.
      }
    }
    return evidence;
  } catch {
    incomplete("LIVE_EVIDENCE_COLLECTION_FAILED");
  }
}

async function retainCasePlayerSnapshot(
  state: RunState,
  caseId: string,
  caseStatus: Status,
  reason: string | null,
  evidence: Evidence | undefined,
  source: "fresh_terminal" | "last_collected" | "unavailable",
): Promise<void> {
  let snapshot: Readonly<Record<string, unknown>> | null = null;
  if (evidence !== undefined) {
    try {
      snapshot = projectPlayerSnapshot(playerOf(evidence));
    } catch {
      // Keep the case result and retain a row that explicitly has no snapshot.
    }
  }
  const record = {
    schema: "ai-player-e2e-private-player-snapshots/v1",
    caseId,
    caseStatus,
    reason,
    source,
    capturedAt: new Date().toISOString(),
    snapshot,
  };
  const diagnosticsDirectory = join(
    tmpdir(),
    "ai-player-e2e-private-diagnostics",
  );
  try {
    await mkdir(diagnosticsDirectory, { recursive: true, mode: 0o700 });
    await chmod(diagnosticsDirectory, 0o700);
    const destination =
      state.privatePlayerSnapshotSidecarPath ??
      join(diagnosticsDirectory, `${state.id}-player-snapshots.jsonl`);
    const isFirstRecord = state.playerSnapshotSidecarRecordCount === undefined;
    await writePlayerSnapshotRecord(destination, record, isFirstRecord);
    state.privatePlayerSnapshotSidecarPath = destination;
    state.playerSnapshotSidecarRecordCount =
      (state.playerSnapshotSidecarRecordCount ?? 0) + 1;
    if (state.playerSnapshotSidecarFailureCode === undefined) {
      state.playerSnapshotSidecarRetained = true;
    }
  } catch {
    state.playerSnapshotSidecarRetained = false;
    state.playerSnapshotSidecarFailureCode ??=
      "PLAYER_SNAPSHOT_SIDECAR_WRITE_FAILED";
  }
}

async function waitForPlayer(
  context: CaseContext,
  timeoutMs: number,
  predicate: (player: PlayerEvidence) => boolean | Promise<boolean>,
): Promise<PlayerEvidence> {
  const player = await observeForPlayer(context, timeoutMs, predicate);
  if (player !== undefined) return player;
  if (Date.now() >= context.runDeadlineAt) incomplete("RUN_DEADLINE_EXCEEDED");
  incomplete("CASE_DEADLINE_EXCEEDED");
}

async function observeForPlayer(
  context: CaseContext,
  timeoutMs: number,
  predicate: (player: PlayerEvidence) => boolean | Promise<boolean>,
  onOwnerReturnBudgetStop?: (
    player: PlayerEvidence | undefined,
    reason: string,
  ) => Promise<void>,
): Promise<PlayerEvidence | undefined> {
  const stopForBudget = async (
    reason: string,
    player?: PlayerEvidence,
  ): Promise<never> => {
    if (onOwnerReturnBudgetStop !== undefined) {
      let stopPlayer = player;
      if (stopPlayer === undefined) {
        try {
          stopPlayer = playerOf(await collect(context.runtime.app));
        } catch {
          stopPlayer = undefined;
        }
      }
      try {
        await onOwnerReturnBudgetStop(stopPlayer, reason);
      } catch {
        // Preserve the stop reason that initiated target finalization.
      }
    }
    incomplete(reason);
  };
  const deadline = Math.min(
    Date.now() + timeoutMs,
    context.caseDeadlineAt,
    context.runDeadlineAt,
  );
  while (Date.now() < deadline) {
    const admissionFailure = currentRunState?.failureCode;
    if (
      admissionFailure === "RUN_LLM_BUDGET_EXCEEDED" ||
      admissionFailure === "CASE_LLM_BUDGET_EXCEEDED"
    ) {
      await stopForBudget(admissionFailure);
    }
    const player = playerOf(await collect(context.runtime.app));
    const caseDelta = subtractCounters(player.counters, context.usageAtStart);
    const runDelta = subtractCounters(player.counters, context.runUsageAtStart);
    if (
      runDelta.llmCalls > context.runBudget.llmCalls ||
      totalTokens(runDelta) > context.runBudget.totalTokens
    )
      await stopForBudget("RUN_LLM_BUDGET_EXCEEDED", player);
    if (
      context.caseBudget !== undefined &&
      (caseDelta.llmCalls > context.caseBudget.llmCalls ||
        totalTokens(caseDelta) > context.caseBudget.totalTokens)
    ) {
      await stopForBudget("CASE_LLM_BUDGET_EXCEEDED", player);
    }
    if (
      currentRunState !== undefined &&
      ownerReturnRequestGateEnabled(currentRunState.targetCase) &&
      caseDelta.usageUnknownCalls > 0
    ) {
      await stopForBudget("LLM_USAGE_PARTIAL_OR_UNKNOWN", player);
    }
    if (await predicate(player)) return player;
    await waitMs(800);
  }
  return undefined;
}

function sendChat(client: Bot, message: string): void {
  client.chat(message);
}

function isOperationActive(player: PlayerEvidence): boolean {
  return player.activeOperation !== undefined;
}

function activeBodyElapsedBucket(
  player: PlayerEvidence,
  now = Date.now(),
): string {
  const startedAt = player.activeOperation?.bodyStartedAt;
  if (startedAt === undefined)
    return isOperationActive(player) ? "not_started" : "none";
  const elapsedMs = now - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "unknown";
  if (elapsedMs < 2_000) return "under_2s";
  if (elapsedMs < 10_000) return "2_to_10s";
  return "over_10s";
}

function newOutcomes(
  before: PlayerEvidence,
  after: PlayerEvidence,
): PlayerEvidence["recentOutcomes"] {
  const beforeIds = new Set(
    before.recentOutcomes.map((outcome) => outcome.operationId),
  );
  return after.recentOutcomes.filter(
    (outcome) => !beforeIds.has(outcome.operationId),
  );
}

function hasNewOutcome(before: PlayerEvidence, after: PlayerEvidence): boolean {
  return newOutcomes(before, after).length > 0;
}

function skillActivityKey(
  activity: PlayerEvidence["skillActivity"][number],
): string {
  return `${activity.kind}:${activity.skillId}:${activity.version}:${activity.at}`;
}

function proposalState(player: PlayerEvidence): string {
  return player.proposals
    .map(
      (proposal) =>
        `${proposal.id}:${proposal.status ?? ""}:${proposal.resolution ?? ""}`,
    )
    .sort()
    .join("\n");
}

function ownerPreferenceWasResolved(
  before: PlayerEvidence,
  after: PlayerEvidence,
): boolean {
  const previousProposalIds = new Set(
    before.proposals.map((proposal) => proposal.id),
  );
  return after.proposals.some(
    (proposal) =>
      !previousProposalIds.has(proposal.id) &&
      (proposal.status === "adopted" || proposal.status === "compromised"),
  );
}

function safeObservationText(
  lastObservation: PlayerEvidence["lastObservation"],
): string {
  if (lastObservation === undefined) return "";
  return JSON.stringify({
    visibleBlockNames: lastObservation.visibleBlockNames,
    visibleContainers: lastObservation.visibleContainers,
  }).toLowerCase();
}

interface BlockRegion {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

interface BlockPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface BuildingFixture {
  readonly cells: readonly BlockPosition[];
  readonly region: BlockRegion;
  readonly target: BlockPosition;
  readonly yaw: number;
}

function regionAround(position: Position): BlockRegion {
  const x = Math.floor(position.x);
  const z = Math.floor(position.z);
  return {
    minX: x - 12,
    minY: 63,
    minZ: z - 12,
    maxX: x + 12,
    maxY: 72,
    maxZ: z + 12,
  };
}

function fixturePoint(
  origin: Position,
  offsetX: number,
  offsetZ: number,
  y = 64,
): BlockPosition {
  return {
    x: Math.floor(origin.x) + offsetX,
    y,
    z: Math.floor(origin.z) + offsetZ,
  };
}

function unknownFixtureTarget(origin: Position): BlockPosition {
  return fixturePoint(origin, 5, 0);
}

async function configureUnknownFixture(
  rcon: LocalRcon,
  origin: Position,
  botName: string,
): Promise<void> {
  const wallX = Math.floor(origin.x) + 2;
  const z = Math.floor(origin.z);
  const target = unknownFixtureTarget(origin);
  const wall = { x: wallX, y: 64, z };
  const targetSupport = { x: target.x, y: target.y - 1, z: target.z };
  await rcon.command(`clear ${botName}`);
  await rcon.command(`fill ${wallX} 64 ${z - 1} ${wallX} 64 ${z + 1} stone`);
  await rcon.command(`setblock ${target.x} ${target.y} ${target.z} blue_wool`);
  await setAndVerifyGamerule(rcon, "advanceTime", false);
  await rcon.command("time set 1000");
  if (!(await isBlock(rcon, wall, "stone")))
    incomplete("UNKNOWN_WALL_FIXTURE_NOT_CONFIRMED");
  if (!(await isBlock(rcon, { x: wallX, y: 65, z }, "air")))
    incomplete("UNKNOWN_FIXTURE_INITIAL_VIEW_BLOCKED");
  if (!(await isBlock(rcon, targetSupport, "stone")))
    incomplete("UNKNOWN_DRY_GROUND_FIXTURE_NOT_CONFIRMED");
  if (!(await isBlock(rcon, target, "blue_wool")))
    incomplete("UNKNOWN_TARGET_FIXTURE_NOT_CONFIRMED");
  await verifyUnknownFixtureSightline(
    rcon,
    { x: origin.x, y: origin.y + 1.62, z: origin.z },
    target,
    UNKNOWN_FIXTURE_YAW,
    "UNKNOWN_FIXTURE_INITIAL_VIEW_NOT_IN_FIELD_OF_VIEW",
    "UNKNOWN_FIXTURE_INITIAL_VIEW_CORRIDOR_BLOCKED",
  );
  await verifyUnknownFixtureLateralApproach(rcon, origin, target, z);
}

async function verifyUnknownFixtureLateralApproach(
  rcon: LocalRcon,
  origin: Position,
  target: BlockPosition,
  centerZ: number,
): Promise<void> {
  const routeCells: BlockPosition[] = [];
  for (let offset = 0; offset <= 3; offset += 1) {
    routeCells.push(fixturePoint(origin, 0, offset));
  }
  const approachX = target.x - 1;
  const approachOffsetX = approachX - Math.floor(origin.x);
  for (let offsetX = 1; offsetX <= approachOffsetX; offsetX += 1) {
    routeCells.push(fixturePoint(origin, offsetX, 3));
  }
  for (let offsetZ = 2; offsetZ >= 0; offsetZ -= 1) {
    routeCells.push(fixturePoint(origin, approachOffsetX, offsetZ));
  }
  for (const routeCell of routeCells) {
    if (
      !(await isBlock(
        rcon,
        { x: routeCell.x, y: routeCell.y - 1, z: routeCell.z },
        "stone",
      )) ||
      !(await isBlock(rcon, routeCell, "air")) ||
      !(await isBlock(
        rcon,
        { x: routeCell.x, y: routeCell.y + 1, z: routeCell.z },
        "air",
      ))
    ) {
      incomplete("UNKNOWN_FIXTURE_LATERAL_ROUTE_UNAVAILABLE");
    }
  }

  await verifyUnknownFixtureSightline(
    rcon,
    { x: origin.x, y: origin.y + 1.62, z: centerZ + 3.5 },
    target,
    UNKNOWN_FIXTURE_YAW,
    "UNKNOWN_FIXTURE_SIDE_VIEW_NOT_IN_FIELD_OF_VIEW",
    "UNKNOWN_FIXTURE_SIDE_VIEW_CORRIDOR_BLOCKED",
  );
}

async function verifyUnknownFixtureSightline(
  rcon: LocalRcon,
  eye: Position,
  target: BlockPosition,
  yaw: number,
  fieldOfViewFailureCode: string,
  corridorFailureCode: string,
): Promise<void> {
  const targetCenter = {
    x: target.x + 0.5,
    y: target.y + 0.5,
    z: target.z + 0.5,
  };
  const dx = targetCenter.x - eye.x;
  const dy = targetCenter.y - eye.y;
  const dz = targetCenter.z - eye.z;
  const horizontalDistance = Math.hypot(dx, dz);
  const expectedYaw = javaYawForDirection(dx, dz);
  const horizontalAngle = angularDistance(expectedYaw, yaw);
  const verticalAngle = Math.abs(
    (Math.atan2(dy, horizontalDistance) * 180) / Math.PI,
  );
  if (
    Math.hypot(horizontalDistance, dy) > 16 ||
    horizontalAngle > 55 ||
    verticalAngle > 40
  ) {
    incomplete(fieldOfViewFailureCode);
  }

  const sampleCount = Math.ceil(Math.hypot(horizontalDistance, dy) * 8);
  const clearViewCells = new Map<string, BlockPosition>();
  for (let sample = 1; sample < sampleCount; sample += 1) {
    const ratio = sample / sampleCount;
    const cell = {
      x: Math.floor(eye.x + dx * ratio),
      y: Math.floor(eye.y + dy * ratio),
      z: Math.floor(eye.z + dz * ratio),
    };
    if (cell.x === target.x && cell.y === target.y && cell.z === target.z)
      continue;
    clearViewCells.set(`${cell.x},${cell.y},${cell.z}`, cell);
  }
  for (const cell of clearViewCells.values()) {
    if (!(await isBlock(rcon, cell, "air"))) incomplete(corridorFailureCode);
  }
}

async function prepareUnknownObservationClients(
  rcon: LocalRcon,
  ownerName: string,
  guestName: string,
): Promise<void> {
  const observers = [
    { name: ownerName, x: 64 },
    { name: guestName, x: -64 },
  ] as const;
  for (const observer of observers) {
    await forceLoadRegion(
      rcon,
      {
        minX: observer.x - 1,
        minY: 199,
        minZ: 63,
        maxX: observer.x + 1,
        maxY: 199,
        maxZ: 65,
      },
      incomplete,
    );
    await rcon.command(
      `fill ${observer.x - 1} 199 63 ${observer.x + 1} 199 65 minecraft:stone replace`,
    );
    for (let x = observer.x - 1; x <= observer.x + 1; x += 1) {
      for (let z = 63; z <= 65; z += 1) {
        if (!(await isBlock(rcon, { x, y: 199, z }, "stone")))
          incomplete("UNKNOWN_OBSERVER_PLATFORM_NOT_CONFIRMED");
      }
    }
    await rcon.command(`tp ${observer.name} ${observer.x} 200 64`);
    const position = parsePosition(
      await rcon.command(`data get entity ${observer.name} Pos`),
    );
    if (
      Math.hypot(position.x - observer.x, position.y - 200, position.z - 64) >
        1.5 ||
      !(await isBlock(rcon, { x: observer.x, y: 199, z: 64 }, "stone"))
    ) {
      incomplete("UNKNOWN_OBSERVER_POSITION_UNSAFE");
    }
  }
}

async function configureHiddenContainer(
  rcon: LocalRcon,
  origin: Position = { x: 0, y: 64, z: 0 },
): Promise<{ readonly chest: BlockPosition }> {
  const wallX = Math.floor(origin.x) + 2;
  const z = Math.floor(origin.z);
  const chest = fixturePoint(origin, 6, 0);
  await rcon.command(`fill ${wallX} 64 ${z - 2} ${wallX} 67 ${z + 2} stone`);
  await rcon.command(`setblock ${chest.x} ${chest.y} ${chest.z} chest`);
  await rcon.command(
    `item replace block ${chest.x} ${chest.y} ${chest.z} container.0 with emerald 1`,
  );
  return { chest };
}

async function removeHiddenContainerFixture(
  rcon: LocalRcon,
  origin: Position,
  fixture: { readonly chest: BlockPosition },
): Promise<void> {
  const wallX = Math.floor(origin.x) + 2;
  const z = Math.floor(origin.z);
  await rcon.command(
    `fill ${wallX} 64 ${z - 2} ${wallX} 67 ${z + 2} air replace stone`,
  );
  await rcon.command(
    `setblock ${fixture.chest.x} ${fixture.chest.y} ${fixture.chest.z} air`,
  );
  for (let y = 64; y <= 67; y += 1) {
    for (let wallZ = z - 2; wallZ <= z + 2; wallZ += 1) {
      if (!(await isBlock(rcon, { x: wallX, y, z: wallZ }, "air")))
        incomplete("OCCLUSION_FIXTURE_CLEANUP_UNVERIFIED");
    }
  }
  if (!(await isBlock(rcon, fixture.chest, "air")))
    incomplete("OCCLUSION_FIXTURE_CLEANUP_UNVERIFIED");
}

async function configureAutonomousBuildFixture(rcon: LocalRcon): Promise<void> {
  await rcon.command("fill -7 64 3 -3 66 6 oak_planks hollow");
  await rcon.command("setblock -5 64 3 air");
  await rcon.command("setblock -5 65 3 air");
  await rcon.command("setblock -7 64 0 chest");
  await rcon.command(
    "item replace block -7 64 0 container.0 with oak_planks 16",
  );
}

async function configureAutonomousResourceFixture(
  rcon: LocalRcon,
): Promise<void> {
  for (const block of AUTONOMOUS_RESOURCE_FIXTURE) {
    await rcon.command(`setblock ${block.x} ${block.y} ${block.z} oak_log`);
  }
  for (const block of AUTONOMOUS_RESOURCE_FIXTURE) {
    if (!(await isBlock(rcon, block, "oak_log")))
      incomplete("AUTONOMOUS_RESOURCE_FIXTURE_NOT_CONFIRMED");
  }
}

async function removeAutonomousResourceFixture(rcon: LocalRcon): Promise<void> {
  for (const block of AUTONOMOUS_RESOURCE_FIXTURE) {
    await rcon.command(
      `fill ${block.x} ${block.y} ${block.z} ${block.x} ${block.y} ${block.z} air replace oak_log`,
    );
  }
  for (const block of AUTONOMOUS_RESOURCE_FIXTURE) {
    if (await isBlock(rcon, block, "oak_log"))
      incomplete("AUTONOMOUS_RESOURCE_FIXTURE_CLEANUP_UNVERIFIED");
  }
}

async function availableLogFixtureSites(
  rcon: LocalRcon,
  origin: Position,
): Promise<readonly BlockPosition[]> {
  const directions = [
    { x: 1, z: 0 },
    { x: 1, z: 1 },
    { x: 0, z: 1 },
    { x: -1, z: 1 },
    { x: -1, z: 0 },
    { x: -1, z: -1 },
    { x: 0, z: -1 },
    { x: 1, z: -1 },
  ] as const;
  const available: { index: number; position: BlockPosition }[] = [];
  for (const [index, direction] of directions.entries()) {
    for (const radius of [3, 4, 5, 6]) {
      const position = fixturePoint(
        origin,
        direction.x * radius,
        direction.z * radius,
        Math.floor(origin.y),
      );
      if (await isBlock(rcon, position, "air")) {
        available.push({ index, position });
        break;
      }
    }
  }
  // A gap of at most 90 degrees leaves a log in every 110-degree view cone.
  const allAnglesCovered = available.every((entry, index) => {
    const next = available[(index + 1) % available.length];
    return (
      next !== undefined &&
      (next.index - entry.index + directions.length) % directions.length <= 2
    );
  });
  if (available.length < 4 || !allAnglesCovered)
    incomplete("LEARNING_LOG_FIXTURE_SITE_OCCUPIED");
  return available.map(({ position }) => position);
}

async function configureLogFixture(
  rcon: LocalRcon,
  logs: readonly BlockPosition[],
  botName: string,
  onPlacementConfirmed: (confirmedCount: number) => void,
): Promise<void> {
  await rcon.command(`clear ${botName} minecraft:oak_log`);
  for (const log of logs) {
    if (!(await isBlock(rcon, log, "air")))
      incomplete("LEARNING_LOG_FIXTURE_SITE_OCCUPIED");
    await rcon.command(`setblock ${log.x} ${log.y} ${log.z} oak_log`);
  }
  let confirmedCount = 0;
  for (const log of logs) {
    if (!(await isBlock(rcon, log, "oak_log")))
      incomplete("LEARNING_LOG_FIXTURE_NOT_CONFIRMED");
    confirmedCount += 1;
    onPlacementConfirmed(confirmedCount);
  }
}

async function orientForLearningLogFixture(
  rcon: LocalRcon,
  botName: string,
  position: Position,
  activeOperationAtOrient: boolean,
): Promise<LearningFixtureOrientationReadback> {
  const previousRotation = await readLearningFixtureRotation(rcon, botName);
  if (previousRotation === undefined)
    incomplete("LEARNING_LOG_FIXTURE_ROTATION_READBACK_UNAVAILABLE");
  await rcon.command(
    `tp ${botName} ${position.x} ${position.y} ${position.z} ${previousRotation.yaw} ${LEARNING_FIXTURE_PITCH}`,
  );
  const confirmedPosition = parsePosition(
    await rcon.command(`data get entity ${botName} Pos`),
  );
  if (
    Math.hypot(
      confirmedPosition.x - position.x,
      confirmedPosition.y - position.y,
      confirmedPosition.z - position.z,
    ) > 0.5
  ) {
    incomplete("LEARNING_LOG_FIXTURE_POSITION_READBACK_MISMATCH");
  }
  const rotation = await readLearningFixtureRotation(rcon, botName);
  if (rotation === undefined)
    incomplete("LEARNING_LOG_FIXTURE_ROTATION_READBACK_UNAVAILABLE");
  return {
    position: confirmedPosition,
    ...classifyLearningFixtureOrientation(
      previousRotation.yaw,
      LEARNING_FIXTURE_PITCH,
      rotation,
      activeOperationAtOrient,
    ),
  };
}

async function readLearningFixtureRotation(
  rcon: LocalRcon,
  botName: string,
): Promise<ReturnType<typeof parseEntityRotation>> {
  for (let attempt = 1; attempt <= ROTATION_READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      const rotation = parseEntityRotation(
        await rcon.command(`data get entity ${botName} Rotation`),
      );
      if (rotation !== undefined) return rotation;
    } catch (error) {
      const retryableRconFailure =
        error instanceof HarnessError &&
        (error.code === "RCON_TIMEOUT" ||
          error.code === "RCON_UNAVAILABLE" ||
          error.code === "RCON_COMMAND_FAILED");
      if (!retryableRconFailure) throw error;
    }
    if (attempt < ROTATION_READ_MAX_ATTEMPTS)
      await waitMs(ROTATION_READ_RETRY_DELAY_MS);
  }
  return undefined;
}

async function removeLearningLogFixture(
  rcon: LocalRcon,
  logs: readonly BlockPosition[],
): Promise<void> {
  for (const log of logs) {
    try {
      await rcon.command(
        `fill ${log.x} ${log.y} ${log.z} ${log.x} ${log.y} ${log.z} air replace oak_log`,
      );
    } catch {
      incomplete("LEARNING_LOG_FIXTURE_CLEANUP_UNVERIFIED");
    }
  }
  for (const log of logs) {
    let stillPresent: boolean;
    try {
      stillPresent = await isBlock(rcon, log, "oak_log");
    } catch {
      incomplete("LEARNING_LOG_FIXTURE_CLEANUP_UNVERIFIED");
    }
    if (stillPresent) incomplete("LEARNING_LOG_FIXTURE_CLEANUP_UNVERIFIED");
  }
}

async function findBuildingFixture(
  rcon: LocalRcon,
  origin: Position,
): Promise<BuildingFixture> {
  const directions = [
    { x: 1, z: 0, yaw: -90 },
    { x: -1, z: 0, yaw: 90 },
    { x: 0, z: 1, yaw: 0 },
    { x: 0, z: -1, yaw: 180 },
  ] as const;
  const originX = Math.floor(origin.x);
  const originZ = Math.floor(origin.z);
  for (const direction of directions) {
    const centerX = originX + direction.x * 4;
    const centerZ = originZ + direction.z * 4;
    const cells: BlockPosition[] = [];
    for (const y of [64, 65, 66]) {
      for (const across of [-1, 0, 1]) {
        const position = {
          x: centerX + (direction.x === 0 ? across : 0),
          y,
          z: centerZ + (direction.z === 0 ? across : 0),
        };
        cells.push(position);
      }
    }
    const target = cells.find(
      (cell) => cell.y === 65 && cell.x === centerX && cell.z === centerZ,
    );
    if (target === undefined) incomplete("BUILDING_FIXTURE_SITE_UNAVAILABLE");
    const clearLine = [];
    for (let distance = 1; distance < 4; distance += 1) {
      clearLine.push({
        x: originX + direction.x * distance,
        y: 65,
        z: originZ + direction.z * distance,
      });
    }
    let siteAvailable = true;
    for (const position of [...cells, ...clearLine]) {
      if (!(await isBlock(rcon, position, "air"))) {
        siteAvailable = false;
        break;
      }
    }
    if (siteAvailable) {
      return {
        cells,
        region: regionAround(origin),
        target,
        yaw: direction.yaw,
      };
    }
  }
  incomplete("BUILDING_FIXTURE_SITE_UNAVAILABLE");
}

async function configureBuildingFixture(
  rcon: LocalRcon,
  botName: string,
  origin: Position,
  fixture: BuildingFixture,
): Promise<number> {
  const targetKey = `${fixture.target.x},${fixture.target.y},${fixture.target.z}`;
  for (const cell of fixture.cells) {
    if (`${cell.x},${cell.y},${cell.z}` === targetKey) continue;
    await rcon.command(`setblock ${cell.x} ${cell.y} ${cell.z} oak_planks`);
  }
  for (const cell of fixture.cells) {
    const expected =
      `${cell.x},${cell.y},${cell.z}` === targetKey ? "air" : "oak_planks";
    if (!(await isBlock(rcon, cell, expected)))
      incomplete("BUILDING_FIXTURE_NOT_CONFIRMED");
  }
  await rcon.command(
    `item replace entity ${botName} hotbar.0 with oak_planks 16`,
  );
  await rcon.command(
    `tp ${botName} ${origin.x} ${origin.y} ${origin.z} ${fixture.yaw} ${UNKNOWN_FIXTURE_PITCH}`,
  );
  const facingPosition = parsePosition(
    await rcon.command(`data get entity ${botName} Pos`),
  );
  if (
    Math.hypot(
      facingPosition.x - origin.x,
      facingPosition.y - origin.y,
      facingPosition.z - origin.z,
    ) > 1.5
  ) {
    incomplete("BUILDING_FIXTURE_POSITION_READBACK_MISMATCH");
  }
  const rotation = parseEntityRotation(
    await rcon.command(`data get entity ${botName} Rotation`),
  );
  if (
    rotation === undefined ||
    angularDistance(rotation.yaw, fixture.yaw) > 2 ||
    Math.abs(rotation.pitch - UNKNOWN_FIXTURE_PITCH) > 2
  ) {
    incomplete("BUILDING_FIXTURE_FACING_NOT_CONFIRMED");
  }
  return Date.now();
}

async function removeBuildingFixture(
  rcon: LocalRcon,
  fixture: BuildingFixture,
): Promise<void> {
  for (const cell of fixture.cells) {
    try {
      await rcon.command(
        `fill ${cell.x} ${cell.y} ${cell.z} ${cell.x} ${cell.y} ${cell.z} air replace oak_planks`,
      );
    } catch {
      incomplete("BUILDING_FIXTURE_CLEANUP_UNVERIFIED");
    }
  }
  for (const cell of fixture.cells) {
    let isAir: boolean;
    try {
      isAir = await isBlock(rcon, cell, "air");
    } catch {
      incomplete("BUILDING_FIXTURE_CLEANUP_UNVERIFIED");
    }
    if (!isAir) incomplete("BUILDING_FIXTURE_CLEANUP_UNVERIFIED");
  }
}

async function configureParallelFixture(
  rcon: LocalRcon,
  origin: Position,
  botName: string,
  ownerName: string,
): Promise<void> {
  const barrierX = Math.floor(origin.x) + 5;
  const marker = fixturePoint(origin, 36, 0);
  await rcon.command(
    `fill ${barrierX} 64 ${marker.z - 24} ${barrierX} 67 ${marker.z + 24} stone`,
  );
  await rcon.command(
    `setblock ${marker.x} ${marker.y} ${marker.z} redstone_block`,
  );
  await rcon.command(
    `setblock ${marker.x + 1} ${marker.y} ${marker.z} gold_block`,
  );
  await rcon.command(
    `tp ${ownerName} ${Math.floor(origin.x) - 20} 64 ${Math.floor(origin.z)}`,
  );
  await rcon.command(`clear ${botName} minecraft:redstone_block`);
  await rcon.command(
    `item replace entity ${botName} hotbar.0 with iron_pickaxe 1`,
  );
}

async function fixtureLogsRemaining(
  rcon: LocalRcon,
  logs: readonly BlockPosition[],
): Promise<number> {
  let remaining = 0;
  for (const log of logs) {
    if (await isBlock(rcon, log, "oak_log")) remaining += 1;
  }
  return remaining;
}

async function readWorldSnapshot(
  rcon: LocalRcon,
  botName: string,
  region: BlockRegion = REGION,
): Promise<WorldSnapshot> {
  const positionText = await rcon.command(`data get entity ${botName} Pos`);
  const position = parsePosition(positionText);
  const blockRegionChanged = await regionChanged(rcon, region);
  const inventory = await rcon.command(`data get entity ${botName} Inventory`);
  return {
    position,
    blockRegionChanged,
    inventorySignature: createHash("sha256").update(inventory).digest("hex"),
  };
}

async function captureBlockBaseline(
  rcon: LocalRcon,
  origin?: Position,
): Promise<BlockRegion> {
  const region = origin === undefined ? REGION : regionAround(origin);
  await establishBaseline(rcon, region, REGION_BASELINE, incomplete);
  return region;
}

function parsePosition(value: string): Position {
  const match =
    /\[\s*(-?\d+(?:\.\d+)?)d?\s*,\s*(-?\d+(?:\.\d+)?)d?\s*,\s*(-?\d+(?:\.\d+)?)d?\s*\]/u.exec(
      value,
    );
  if (match === null) incomplete("RCON_POSITION_UNAVAILABLE");
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

async function regionChanged(
  rcon: LocalRcon,
  region: BlockRegion = REGION,
): Promise<boolean> {
  return !(await regionsEqual(rcon, region, REGION_BASELINE, incomplete));
}

async function isBlock(
  rcon: LocalRcon,
  position: Position,
  block: string,
): Promise<boolean> {
  return blockIs(rcon, position, block, incomplete);
}

function worldChangedFromBlock(
  beforeChanged: boolean,
  afterChanged: boolean,
): boolean {
  return !beforeChanged && afterChanged;
}

function observedWorldProgress(
  before: WorldSnapshot,
  after: WorldSnapshot,
): "blocks" | "position" | "inventory" | undefined {
  if (
    worldChangedFromBlock(before.blockRegionChanged, after.blockRegionChanged)
  )
    return "blocks";
  if (before.inventorySignature !== after.inventorySignature)
    return "inventory";
  const distance = Math.hypot(
    after.position.x - before.position.x,
    after.position.y - before.position.y,
    after.position.z - before.position.z,
  );
  return distance >= 1.25 ? "position" : undefined;
}

function zeroCounters(): Counters {
  return {
    llmCalls: 0,
    usageUnknownCalls: 0,
    usageUnknownRequestErrorCalls: 0,
    usageUnknownResponseUsageMissingCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    thoughts: 0,
    learningUpdates: 0,
  };
}

interface SkillRow {
  readonly id: string;
  readonly version: number;
  readonly body: string;
}

interface SkillRevisionRow {
  readonly skill_id: string;
  readonly version: number;
  readonly conditions_json: string;
  readonly body: string;
  readonly expected_outcome: string;
  readonly confidence: number;
}

interface SuccessfulDerivedSkillRow {
  readonly run_id: string;
  readonly skill_id: string;
  readonly skill_version: number;
}

interface EvidenceRevisionRow {
  readonly run_id: string;
  readonly receipt_run_id: string;
  readonly receipt_skill_id_at_use: string | null;
  readonly receipt_skill_version_at_use: number | null;
  readonly skill_id: string;
  readonly operation_name: string;
  readonly observed_outcome: string;
  readonly skill_version_at_use: number;
  readonly revision_version: number;
}

function readSkillSnapshot(databasePath: string): SkillSnapshot {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000,
  });
  try {
    const skills = database
      .prepare("SELECT id, version, body FROM mc_bot_skills")
      .all() as SkillRow[];
    const revisions = database
      .prepare(
        "SELECT skill_id, version, conditions_json, body, expected_outcome, confidence FROM mc_bot_skill_revisions",
      )
      .all() as SkillRevisionRow[];
    const revisionVersionsBySkill = new Map<string, Set<number>>();
    const revisionDefinitionsBySkill = new Map<
      string,
      Map<
        number,
        {
          conditions: string[];
          body: string;
          expectedOutcome: string;
          confidence: number;
        }
      >
    >();
    for (const revision of revisions) {
      const versions =
        revisionVersionsBySkill.get(revision.skill_id) ?? new Set<number>();
      versions.add(revision.version);
      revisionVersionsBySkill.set(revision.skill_id, versions);
      const definitions =
        revisionDefinitionsBySkill.get(revision.skill_id) ??
        new Map<
          number,
          {
            conditions: string[];
            body: string;
            expectedOutcome: string;
            confidence: number;
          }
        >();
      definitions.set(revision.version, {
        conditions: JSON.parse(revision.conditions_json) as string[],
        body: revision.body,
        expectedOutcome: revision.expected_outcome,
        confidence: revision.confidence,
      });
      revisionDefinitionsBySkill.set(revision.skill_id, definitions);
    }
    const count = (table: string): number => {
      if (
        !new Set([
          "mc_bot_skill_revisions",
          "mc_bot_skill_evidence_receipts",
          "mc_bot_skill_import_receipts",
        ]).has(table)
      )
        throw new Error("UNSAFE_TABLE");
      const row = database
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { readonly count: number };
      return row.count;
    };
    const importReceiptsBySkill = database
      .prepare(
        "SELECT skill_id, COUNT(*) AS count FROM mc_bot_skill_import_receipts GROUP BY skill_id",
      )
      .all() as { readonly skill_id: string; readonly count: number }[];
    const successfulDerivedSkills = database
      .prepare(
        "SELECT derived.run_id, derived.skill_id, derived.skill_version FROM mc_bot_skill_derived_hypotheses AS derived INNER JOIN mc_bot_skill_evidence_receipts AS receipt ON receipt.receipt_id = derived.receipt_id WHERE receipt.observed_outcome = 'successful'",
      )
      .all() as SuccessfulDerivedSkillRow[];
    const evidenceRevisions = database
      .prepare(
        `SELECT evidence_revision.run_id, receipt.run_id AS receipt_run_id,
                receipt.skill_id_at_use AS receipt_skill_id_at_use,
                receipt.skill_version_at_use AS receipt_skill_version_at_use,
                evidence_revision.skill_id,
                evidence_revision.skill_version_at_use, evidence_revision.revision_version,
                receipt.operation_name, receipt.observed_outcome
         FROM mc_bot_skill_evidence_revisions AS evidence_revision
         INNER JOIN mc_bot_skill_evidence_receipts AS receipt
           ON receipt.receipt_id = evidence_revision.receipt_id`,
      )
      .all() as EvidenceRevisionRow[];
    return {
      skillIds: new Set(skills.map((skill) => skill.id)),
      skillCount: skills.length,
      revisionCount: count("mc_bot_skill_revisions"),
      evidenceReceiptCount: count("mc_bot_skill_evidence_receipts"),
      successfulDerivedSkillIds: new Set(
        successfulDerivedSkills.map((row) => row.skill_id),
      ),
      successfulDerivedHypothesesByRunId: new Map(
        successfulDerivedSkills.map((row) => [
          row.run_id,
          { skillId: row.skill_id, skillVersion: row.skill_version },
        ]),
      ),
      revisionVersionsBySkill,
      revisionDefinitionsBySkill,
      evidenceRevisionsByRunId: new Map(
        evidenceRevisions.map((row) => [
          row.run_id,
          {
            receiptRunId: row.receipt_run_id,
            receiptSkillIdAtUse: row.receipt_skill_id_at_use,
            receiptSkillVersionAtUse: row.receipt_skill_version_at_use,
            skillId: row.skill_id,
            operationName: row.operation_name,
            observedOutcome: row.observed_outcome,
            skillVersionAtUse: row.skill_version_at_use,
            revisionVersion: row.revision_version,
          },
        ]),
      ),
      learnedBodiesBySkill: new Map(
        skills.map((skill) => [skill.id, skill.body]),
      ),
      learnedBodiesUnderLimit: skills.every(
        (skill) => Buffer.byteLength(skill.body, "utf8") <= 8_192,
      ),
      importReceiptCount: count("mc_bot_skill_import_receipts"),
      importReceiptCountsBySkill: new Map(
        importReceiptsBySkill.map((row) => [row.skill_id, row.count]),
      ),
    };
  } finally {
    database.close();
  }
}

function readDbContainsOwnerFact(
  databasePath: string,
  syntheticFact: string,
): boolean {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000,
  });
  try {
    const row = database
      .prepare(
        "SELECT payload_json FROM player_runtime_state WHERE singleton_id = 1",
      )
      .get() as { readonly payload_json: string } | undefined;
    if (row === undefined) return false;
    return hasPersistedOwnerFact(row.payload_json, syntheticFact);
  } catch {
    incomplete("PERSISTENT_RUNTIME_FACT_EVIDENCE_MISSING");
  } finally {
    database.close();
  }
}

function readDbTableCount(databasePath: string, table: string): number {
  if (table !== "player_runtime_state") throw new Error("UNSAFE_TABLE");
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000,
  });
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM player_runtime_state")
      .get() as { readonly count: number };
    return row.count;
  } catch {
    incomplete("PERSISTENT_RUNTIME_DB_EVIDENCE_MISSING");
  } finally {
    database.close();
  }
}

function safeImportFileName(fileName: string): boolean {
  return (
    /^[a-z0-9][a-z0-9._-]{0,95}\.md$/u.test(fileName) &&
    !fileName.includes("..") &&
    !fileName.includes("/")
  );
}

async function exchangeMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        safeImportFileName(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

const SYNTHETIC_SKILL_EDIT_MARKER =
  "Synthetic acceptance note: apply only when the marked fixture is reachable.";
const SYNTHETIC_SKILL_CONDITION_MARKER =
  "Synthetic acceptance condition: the visible fixture is reachable.";

function appendSyntheticSkillEdit(markdown: string): string {
  const metadataBlock = /```mc-bot-skill\s*\n([\s\S]*?)\n```/u.exec(markdown);
  if (metadataBlock === null || !markdown.includes("\n\n## 本文\n")) {
    incomplete("EXPORTED_SKILL_MARKDOWN_INVALID");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataBlock[1] ?? "") as unknown;
  } catch {
    incomplete("EXPORTED_SKILL_MARKDOWN_INVALID");
  }
  const record = isRecord(metadata) ? metadata : undefined;
  const skill = record?.skill;
  if (
    record === undefined ||
    !isRecord(skill) ||
    !Array.isArray(skill.conditions) ||
    !skill.conditions.every((condition) => typeof condition === "string")
  ) {
    incomplete("EXPORTED_SKILL_MARKDOWN_INVALID");
  }
  const editedMetadata = JSON.stringify(
    {
      ...record,
      skill: {
        ...skill,
        conditions: [...skill.conditions, SYNTHETIC_SKILL_CONDITION_MARKER],
      },
    },
    null,
    2,
  );
  const editedMarkdown = markdown.replace(
    metadataBlock[0],
    `\`\`\`mc-bot-skill\n${editedMetadata}\n\`\`\``,
  );
  return `${editedMarkdown.trimEnd()}\n\n${SYNTHETIC_SKILL_EDIT_MARKER}\n`;
}

function observationBoundarySidecarPath(state: RunState): string {
  return join(
    tmpdir(),
    "ai-player-e2e-private-diagnostics",
    `${state.id}-observation-replies.json`,
  );
}

function gatherProgressReplySidecarPath(state: RunState): string {
  return join(
    tmpdir(),
    "ai-player-e2e-private-diagnostics",
    `${state.id}-gather-progress-reply.jsonl`,
  );
}

async function retainGatherProgressReply(
  state: RunState,
  reply: string,
): Promise<string> {
  if (reply.length > 4_000)
    incomplete("GATHER_PROGRESS_REPLY_EXCEEDS_PRIVATE_SAMPLE_LIMIT");
  const destination = gatherProgressReplySidecarPath(state);
  const directory = dirname(destination);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writePlayerSnapshotRecord(
      destination,
      {
        schema: "ai-player-e2e-private-gather-progress-reply/v1",
        reply,
      },
      true,
    );
  } catch {
    state.gatherProgressReplySidecarRetained = false;
    incomplete("GATHER_PROGRESS_REPLY_SIDECAR_WRITE_FAILED");
  }
  const hash = createHash("sha256").update(reply).digest("hex");
  state.gatherProgressReplyHash = hash;
  state.gatherProgressReplySidecarRetained = true;
  updateGatherMultiTargetDiagnostic(state, {
    gatherProgressReplySampled: true,
    gatherProgressReplyReceivedAfterQuestion: true,
    gatherProgressReplyHash: hash,
    gatherProgressReplySidecarRetained: true,
    gatherProgressReplyReviewRequired: true,
    gatherProgressExplanationStatus: "sampled_pending_private_review",
  });
  return hash;
}

async function retainObservationBoundaryReplies(
  state: RunState,
): Promise<void> {
  const capture = state.observationBoundaryCapture;
  if (capture === undefined) return;
  const diagnosticsDirectory = join(
    tmpdir(),
    "ai-player-e2e-private-diagnostics",
  );
  const destination = observationBoundarySidecarPath(state);
  const end = capture.responseEnd ?? state.responses.length;
  const replies = state.responses
    .slice(capture.responseStart, end)
    .filter(
      ({ at }) =>
        capture.requestSentAt === undefined || at >= capture.requestSentAt,
    )
    .map(({ at, text }) => ({ at, text }));
  try {
    await mkdir(diagnosticsDirectory, { recursive: true, mode: 0o700 });
    await chmod(diagnosticsDirectory, 0o700);
    await writeFile(
      destination,
      `${JSON.stringify(
        {
          schema: "ai-player-e2e-private-observation-replies/v1",
          requestSentAt: capture.requestSentAt ?? null,
          visibleObservationAt: capture.visibleObservationAt ?? null,
          replies,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await chmod(destination, 0o600);
    state.observationBoundarySidecarRetained = true;
  } catch {
    state.observationBoundarySidecarRetained = false;
    markCleanupFailure(state, "OBSERVATION_REPLY_SIDECAR_WRITE_FAILED");
  }
}

async function cleanup(state: RunState): Promise<void> {
  const settleStatus = await settleOwnerReturnBeforeShutdown(
    ownerReturnRequestGateEnabled(state.targetCase) &&
      state.ownerReturnRequestGate !== undefined,
    () => settleOwnerReturnRequests(state, ownerReturnSettlementContext(state)),
    async () => {
      try {
        await boundedShutdown(appForCleanup, "ai_player_e2e_finished");
      } catch {
        markCleanupFailure(state, "APPLICATION_SHUTDOWN_FAILED");
      }
    },
  );
  if (settleStatus !== undefined && ownerReturnUsageIsUnknown(settleStatus))
    state.usageUncertain = true;
  try {
    ownerForCleanup?.quit();
    guestForCleanup?.quit();
  } catch {
    markCleanupFailure(state, "TEST_CLIENT_SHUTDOWN_FAILED");
  }
  const server = serverForCleanup;
  if (server !== undefined && !processHasExited(server)) {
    try {
      server.stdin.write("stop\n");
      if (!(await waitForProcessExit(server, 10_000))) {
        server.kill("SIGTERM");
      }
      if (!(await waitForProcessExit(server, 5_000))) {
        server.kill("SIGKILL");
      }
      if (!(await waitForProcessExit(server, 3_000))) {
        markCleanupFailure(state, "SERVER_SHUTDOWN_FAILED");
      }
    } catch {
      markCleanupFailure(state, "SERVER_SHUTDOWN_FAILED");
    }
  }
  state.serverProcessExited = server === undefined || processHasExited(server);
  if (!state.serverProcessExited)
    markCleanupFailure(state, "SERVER_PROCESS_REMAINS");
  await finalizePrivateServerLog(state);
  const listenerResults = await Promise.all([
    loopbackPortIsClosed(state.serverPort),
    loopbackPortIsClosed(state.rconPort),
  ]);
  state.loopbackListenersClosed = listenerResults.every(Boolean);
  if (!state.loopbackListenersClosed)
    markCleanupFailure(state, "LOOPBACK_LISTENER_REMAINS");
  await rm(state.isolatedDirectory, { recursive: true, force: true }).catch(
    () => undefined,
  );
  state.temporaryWorldRemoved = !(await pathExists(state.isolatedDirectory));
  if (!state.temporaryWorldRemoved)
    markCleanupFailure(state, "ISOLATED_WORLD_CLEANUP_FAILED");
  appForCleanup = undefined;
  ownerForCleanup = undefined;
  guestForCleanup = undefined;
  serverForCleanup = undefined;
}

async function finalizePrivateServerLog(state: RunState): Promise<void> {
  const stream = state.privateServerLogStream;
  if (stream !== undefined) {
    const closed = finished(stream)
      .then(() => true)
      .catch(() => false);
    stream.end();
    const didClose = await Promise.race([
      closed,
      waitMs(2_000).then(() => false),
    ]);
    if (!didClose) {
      stream.destroy();
      state.privateServerLogWriteFailed = true;
      markCleanupFailure(state, "PRIVATE_SERVER_LOG_FLUSH_FAILED");
    }
    state.privateServerLogStream = undefined;
  }
  if (state.privateServerLogWriteFailed === true) {
    markCleanupFailure(state, "PRIVATE_SERVER_LOG_WRITE_FAILED");
  }
  if (
    state.status === "pass" ||
    !(await pathExists(state.privateServerLogPath))
  ) {
    state.privateDiagnosticLogRetained = false;
    return;
  }
  const diagnosticsDirectory = join(
    tmpdir(),
    "ai-player-e2e-private-diagnostics",
  );
  const destination = join(diagnosticsDirectory, `${state.id}.log`);
  try {
    await mkdir(diagnosticsDirectory, { recursive: true, mode: 0o700 });
    await chmod(diagnosticsDirectory, 0o700);
    await chmod(state.privateServerLogPath, 0o600);
    await copyFile(state.privateServerLogPath, destination);
    await chmod(destination, 0o600);
    state.privateDiagnosticLogPath = destination;
    state.privateDiagnosticLogRetained = true;
  } catch {
    state.privateDiagnosticLogRetained = false;
    markCleanupFailure(state, "PRIVATE_SERVER_LOG_RETAIN_FAILED");
  }
}

async function loopbackPortIsClosed(port: number): Promise<boolean> {
  const socket = createConnection({ host: "127.0.0.1", port });
  return new Promise((resolveClosed) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveClosed(closed);
    };
    const timer = setTimeout(() => finish(false), 1_000);
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => {
      const code = isRecord(error) ? error.code : undefined;
      finish(code === "ECONNREFUSED");
    });
  });
}

function markCleanupFailure(state: RunState, code: string): void {
  state.failureCode ??= code;
  if (state.status !== "fail") state.status = "incomplete";
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (processHasExited(child)) return true;
  return new Promise((resolveExit) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveExit(processHasExited(child));
    }, timeoutMs);
    child.once("exit", onExit);
    if (processHasExited(child)) onExit();
  });
}

function processHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return !(isRecord(error) && error.code === "ENOENT");
  }
}

async function writeArtifact(state: RunState): Promise<void> {
  if (state.usageUncertain === true && state.status !== "fail")
    state.status = "incomplete";
  if (state.usageUncertain === true) {
    state.failureCode ??= "LLM_USAGE_PARTIAL_OR_UNKNOWN";
  }
  const finalStatus = state.status ?? "incomplete";
  if (
    finalStatus !== "pass" &&
    state.failureCode === undefined &&
    state.cases.length === 0
  ) {
    state.failureCode = "RUN_DID_NOT_COMPLETE";
  }
  const finalCounters =
    state.countersFinal ?? state.countersInitial ?? zeroCounters();
  const runUsage = subtractCounters(
    finalCounters,
    state.countersInitial ?? zeroCounters(),
  );
  const artifact = {
    schema: "ai-player-e2e-result/v1",
    runId: state.id,
    status: state.status ?? "incomplete",
    startedAt: state.startedAt,
    durationMs: Date.now() - state.startedClock,
    model: isNoGptDiagnosticProbeOnly() ? "not_used" : MODEL,
    targetCase: state.targetCase ?? null,
    minecraftVersion: SERVER_VERSION,
    world: {
      fresh: true,
      seed: state.seed,
      seedIsSynthetic: true,
      fixture: state.worldFixture,
      nonOperatorClients:
        process.env.AI_PLAYER_E2E_NO_FOOD_FIXTURE_PROBE_ONLY === "YES" ||
        isNoFoodContinuityProbeOnly()
          ? 1
          : 3,
      loopbackOnly: true,
      serverCacheAreasCopied: state.copiedServerCacheAreas ?? [],
    },
    cleanup: {
      serverProcessExited: state.serverProcessExited === true,
      loopbackListenersClosed: state.loopbackListenersClosed === true,
      temporaryWorldRemoved: state.temporaryWorldRemoved === true,
    },
    diagnostics: {
      serverReadyObserved: state.serverReadyObserved === true,
      applicationStart: state.applicationStartDiagnostic ?? null,
      bodyOperationSmoke: state.bodySmokeDiagnostic ?? null,
      deathRecoveryFixtureProbe: state.deathRecoveryFixtureDiagnostic ?? null,
      observationBoundary: {
        replyReceived:
          state.observationBoundaryDiagnostic?.replyReceived === true,
        responseHeuristicClassification:
          state.observationBoundaryDiagnostic
            ?.responseHeuristicClassification ?? "not_evaluated",
        manualReviewRequired: true,
        sidecarRetained: state.observationBoundarySidecarRetained === true,
      },
      playerSnapshotSidecar: {
        retained: state.playerSnapshotSidecarRetained === true,
        failureCode: state.playerSnapshotSidecarFailureCode ?? null,
      },
      noFoodContinuity: isNoFoodContinuityProbeOnly()
        ? noFoodContinuitySafeEvidence(state)
        : null,
      foodIntentContinuity: state.foodIntentContinuityDiagnostic ?? null,
      ownerReturnThroughDoor: state.ownerReturnDiagnostic ?? null,
    },
    budgets: {
      run: state.runBudget,
      perCase: CASE_BUDGETS,
      perCaseDeadlinesMs: CASE_DEADLINES,
      exceeded:
        state.failureCode?.includes("BUDGET") === true ||
        state.failureCode?.includes("DEADLINE") === true,
    },
    usage: {
      llmCalls: runUsage.llmCalls,
      inputTokens: runUsage.inputTokens,
      outputTokens: runUsage.outputTokens,
      totalTokens: totalTokens(runUsage),
      latencyMs: runUsage.latencyMs,
      status:
        state.usageUncertain === true
          ? "partial_or_unknown"
          : "runtime_reported",
    },
    cases: state.cases,
    failureCode: state.failureCode,
    publicationBoundary: {
      containsRawChat: false,
      containsRawServerLogs: false,
      containsCredentials: false,
      containsPlayerNamesOrUuids: false,
      containsCoordinates: false,
      containsSyntheticWorldSeed: true,
      temporaryWorldRemoved: state.temporaryWorldRemoved === true,
    },
  };
  await writeFile(
    state.artifactPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof HarnessError && /^[A-Z0-9_]+$/u.test(error.code)
        ? error.code
        : "UNEXPECTED_FAILURE";
    process.stderr.write(`INCOMPLETE AI_PLAYER_E2E_${code}\n`);
    process.exitCode = 1;
  });
}
