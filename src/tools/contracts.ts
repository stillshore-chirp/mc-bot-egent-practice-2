import type { DeliveryController } from "../app/delivery-controller.js";
import type { HostileGoal } from "../decision/hostile-response.js";
import type { ArmorEquipment } from "../domain/snapshot.js";
import type {
  SafeActionCandidate,
  SafeActionObservationRequest,
  SafeActionStep,
} from "../decision/safe-action-planner.js";
import type { SafeChoiceAuthorization } from "../decision/safe-choice.js";
import type {
  CollectItemInput,
  CraftItemInput,
  GeneralActionCandidate,
  GeneralActionObservationInput,
  MineBlockInput,
  PlaceBlockInput,
  SmeltItemInput,
} from "../minecraft/general-actions.js";
import type {
  BehaviorMemoryCategory,
  BehaviorMemoryRecord,
  ForgetBehaviorMemoryInput,
  RememberBehaviorMemoryInput,
} from "../memory/types.js";
import type { BehaviorMemoryExtraction } from "../memory/behavior-memory.js";
export type ErrorCategory =
  | "connection"
  | "observation"
  | "path"
  | "resource"
  | "inventory"
  | "authorization"
  | "permission"
  | "timeout"
  | "cancelled"
  | "llm"
  | "persistence"
  | "safety"
  | "validation"
  | "internal";

export interface EvidenceReference {
  kind:
    "minecraft_snapshot" | "inventory_delta" | "memory_record" | "task_state";
  observedAt: string;
  summary: string;
}

export interface ToolFailure {
  category: ErrorCategory;
  code: string;
  retryable: boolean;
  failedAt: string;
  confirmedState: Record<string, unknown>;
  nextActions: string[];
  userSummary: string;
}

export interface ActionProgress {
  readonly completedCount: number;
  readonly requestedCount: number;
  /** Canonical inventory item represented by the verified progress delta. */
  readonly item?: string;
}

export type ToolResult<T> =
  | {
      success: true;
      data: T;
      evidence: EvidenceReference[];
      userSummary: string;
      progress?: ActionProgress;
      verificationReceipt?: {
        receiptId: string;
        commitmentId: string;
        toolName: string;
      };
    }
  | { success: false; error: ToolFailure };

export interface Position {
  x: number;
  y: number;
  z: number;
  dimension: string;
}

export interface GameStatus {
  readonly observedAt: string;
  readonly subject: "bot";
  readonly source: "minecraft";
  readonly requesterVitals: "unobserved";
  connected: boolean;
  spawned: boolean;
  health: number;
  food: number;
  oxygen: number | null;
  oxygenState: "normal" | "low" | "not_applicable" | "unknown";
  inWater: boolean;
  inLava: boolean;
  suffocating: boolean;
  position: Position | null;
  inventory: Readonly<Record<string, number>>;
  /** Null means equipment slots could not be observed. */
  readonly armor?: ArmorEquipment | null;
  activeTaskState: string | null;
  /** Plain-language summary of the currently running task, when any. */
  readonly activeTaskSummary?: string | null;
  /** Latest task outcome, including terminal work, in plain user-facing text. */
  readonly latestTaskState?: string | null;
}

export interface Surroundings {
  readonly observedAt: string;
  readonly subject: "bot";
  readonly source: "minecraft";
  readonly requesterVitals: "unobserved";
  readonly oxygen: number | null;
  readonly oxygenState: "normal" | "low" | "not_applicable" | "unknown";
  readonly inWater: boolean;
  blocks: readonly { name: string; distance: number }[];
  entities: readonly { kind: string; distance: number }[];
  hazards: readonly string[];
}

export interface SafeResourceCandidate {
  readonly resource: string;
  readonly distance: number;
}

export interface SafeResourceSearchResult {
  readonly candidates: readonly SafeResourceCandidate[];
  readonly attemptedWaypoints: number;
  readonly blockedWaypoints: number;
  readonly stop?: { readonly code: string; readonly reason: string };
}

export interface SafeActionSearchResult {
  readonly candidates: readonly SafeActionCandidate[];
  readonly attemptedWaypoints: number;
  readonly blockedWaypoints: number;
  readonly stop?: { readonly code: string; readonly reason: string };
}

export interface ActionReport {
  before: GameStatus | null;
  after: GameStatus | null;
  outcome: "completed" | "failed" | "cancelled";
  failureCategory?: ErrorCategory;
  failureCode?: string;
  failureRetryable?: boolean;
  failedAt?: string;
  confirmedState?: Readonly<Record<string, unknown>>;
  nextActions?: readonly string[];
  evidenceKind?: EvidenceReference["kind"];
  summary: string;
}

export interface GameController {
  readonly delivery?: Pick<
    DeliveryController,
    "register" | "list" | "forget" | "deliver"
  >;
  observeStatus(): Promise<GameStatus>;
  observeSurroundings(
    radius: number,
    includeEntities: boolean,
  ): Promise<Surroundings>;
  /**
   * Returns candidates that passed the server-side protection boundary.
   * Adapters without this observation must make callers stop safely.
   */
  findSafeResourceCandidates?(
    maxDistance: number,
    count: number,
    signal: AbortSignal,
    allowedNames?: readonly string[],
  ): Promise<readonly SafeResourceCandidate[]>;
  /** Bounded movement to observe protected resources when the first view is empty. */
  searchSafeResourceCandidates?(
    maxDistance: number,
    count: number,
    signal: AbortSignal,
    allowedNames?: readonly string[],
  ): Promise<SafeResourceSearchResult>;
  /**
   * Observes provider-backed candidates for a high-level goal. The goal is
   * descriptive only; returned candidates still need the safe planner and
   * each step needs normal tool validation before execution.
   */
  findSafeActionCandidates?(
    request: SafeActionObservationRequest,
    signal: AbortSignal,
  ): Promise<readonly SafeActionCandidate[]>;
  /** Moves only to bounded observation points, then rechecks server permission. */
  searchSafeActionCandidates?(
    request: SafeActionObservationRequest,
    signal: AbortSignal,
  ): Promise<SafeActionSearchResult>;
  observeActionCandidates(
    input: GeneralActionObservationInput,
    signal: AbortSignal,
  ): Promise<readonly GeneralActionCandidate[]>;
  say(message: string): Promise<void>;
  followOwner(
    safeDistance: number,
    maxDurationSeconds: number,
    signal: AbortSignal,
  ): Promise<ActionReport>;
  respondToHostiles(
    goal: HostileGoal,
    signal: AbortSignal,
  ): Promise<ActionReport>;
  stopCurrentAction(reason: string): Promise<ActionReport>;
  moveTo(
    destination: Omit<Position, "dimension">,
    radius: number,
    signal: AbortSignal,
  ): Promise<ActionReport>;
  gatherResource(
    resource: string,
    count: number,
    signal: AbortSignal,
  ): Promise<ActionReport>;
  mineBlock(input: MineBlockInput, signal: AbortSignal): Promise<ActionReport>;
  collectItem(
    input: CollectItemInput,
    signal: AbortSignal,
  ): Promise<ActionReport>;
  craftItem(input: CraftItemInput, signal: AbortSignal): Promise<ActionReport>;
  placeBlock(
    input: PlaceBlockInput,
    signal: AbortSignal,
  ): Promise<ActionReport>;
  smeltItem(input: SmeltItemInput, signal: AbortSignal): Promise<ActionReport>;
  returnToOwner(
    safeDistance: number,
    signal: AbortSignal,
  ): Promise<ActionReport>;
  currentPosition(): Promise<Position>;
}

export type MemoryKind = "fact" | "location" | "commitment" | "episode";

export interface MemoryPort {
  rememberPlayerFact(input: {
    playerId: string;
    subject: string;
    predicate: string;
    value: string;
    source: "player_stated";
  }): unknown;
  rememberLocation(input: {
    playerId: string;
    name: string;
    purpose: string;
    dimension: string;
    x: number;
    y: number;
    z: number;
  }): unknown;
  recall(input: {
    playerId: string;
    query: string;
    kinds: MemoryKind[];
    limit: number;
  }): unknown[];
  setCommitment(input: {
    playerId: string;
    description: string;
    fulfillment?: {
      toolName: "gather_resource";
      resource: string;
      count: number;
    };
  }): {
    id: string;
  };
  getCommitment(input: { playerId: string; commitmentId: string }):
    | {
        status: "active" | "completed" | "cancelled";
        fulfillment?: {
          toolName: "gather_resource";
          resource: string;
          count: number;
        };
      }
    | undefined;
  completeCommitment(input: {
    playerId: string;
    commitmentId: string;
    outcome: string;
    verificationSource: "owner_confirmation" | "verified_tool_result";
    verificationEvidence: string;
  }): unknown;
}

export interface BehaviorMemoryPort {
  remember(input: RememberBehaviorMemoryInput): BehaviorMemoryRecord;
  correct(input: {
    readonly playerId: string;
    readonly memoryId?: string;
    readonly category: RememberBehaviorMemoryInput["category"];
    readonly slot: string;
    readonly value: string;
    readonly summary: string;
    readonly idempotencyKey?: string;
  }): BehaviorMemoryRecord;
  list(
    playerId: string,
    input?: { readonly limit?: number; readonly query?: string },
  ): BehaviorMemoryRecord[];
  isApplicable(record: BehaviorMemoryRecord): boolean;
  forget(input: ForgetBehaviorMemoryInput): BehaviorMemoryRecord[];
}

export interface ToolContext {
  correlationId: string;
  requesterUsername: string;
  authorizedOwnerUsername: string;
  playerId: string;
  signal: AbortSignal;
  requestKind: "owner_message" | "runtime_reassessment";
  /**
   * A trusted request-boundary decision. Tool/model arguments must never
   * manufacture this value. Omitted means delegated low-impact only.
   */
  safeActionAuthorization?: SafeChoiceAuthorization;
  /** One concrete owner-goal clarification produced at the request boundary. */
  safeActionClarification?: string;
  /**
   * Mutable, request-scoped accounting for the owner authorization. It is
   * created only by the authenticated request boundary and prevents another
   * model tool call from replaying the same bounded goal.
   */
  safeActionAuthorizationUsage?: {
    remainingCount: number;
    consumed: boolean;
  };
  /** Internal marker set only while the deterministic plan executor runs a step. */
  safeActionStepExecution?: boolean;
  /** False while a stopped owner goal is discussed; also blocks memory writes. */
  allowActionTools?: boolean;
  /** Trusted per-request action and memory-write scope. */
  allowedActionToolNames?: readonly string[];
  /** Requested delivery-target kinds for registration or forgetting. */
  allowedDeliveryTargetKinds?: readonly ("home" | "chest")[];
  /** Called only after the public say tool has delivered a message. */
  recordDeliveredAssistantMessage?: (message: string) => void;
  /** Candidates extracted from this authenticated owner message only. */
  behaviorMemoryCandidates?: readonly BehaviorMemoryExtraction[];
  /** The exact preference the authenticated owner asked to forget this turn. */
  behaviorMemoryForgetTarget?: {
    readonly category: BehaviorMemoryCategory;
    readonly slot: string;
  };
  /** Owner-only presentation preference; never changes safety facts or actions. */
  behaviorNotificationOneSentence?: boolean;
  /** Opaque accepted-message id used to make behavior writes idempotent. */
  behaviorMemoryEventId?: string;
  executionEvidence: {
    verifiedActionReceipts: {
      receiptId: string;
      commitmentId: string;
      correlationId: string;
      toolName: string;
      evidence: EvidenceReference[];
      used: boolean;
    }[];
  };
  executeSafeActionStep?: (
    step: SafeActionStep,
    context: ToolContext,
  ) => Promise<ToolResult<unknown>>;
  game: GameController;
  memory: MemoryPort;
  /** Optional on older integrations; behavior tools fail closed when absent. */
  behaviorMemory?: BehaviorMemoryPort;
  limits: {
    maxMoveDistance: number;
    maxGatherCount: number;
    /** Optional generic-plan wall-clock cap; the planner applies its own hard cap. */
    maxSafeActionDurationMs?: number;
    followDistance: number;
    memoryContextLimit: number;
  };
}

export function actionReportResult(
  report: ActionReport,
): ToolResult<ActionReport> {
  const observedAt = new Date().toISOString();
  if (report.outcome === "completed") {
    const progress = actionProgress(report.confirmedState);
    return {
      success: true,
      data: report,
      evidence: [
        {
          kind: report.evidenceKind ?? "minecraft_snapshot",
          observedAt,
          summary: report.summary,
        },
      ],
      userSummary: report.summary,
      ...(progress === undefined ? {} : { progress }),
    };
  }
  return {
    success: false,
    error: {
      category:
        report.failureCategory ??
        (report.outcome === "cancelled" ? "cancelled" : "internal"),
      code: report.failureCode ?? report.outcome.toUpperCase(),
      retryable: report.failureRetryable ?? false,
      failedAt: report.failedAt ?? "minecraft_action",
      confirmedState: {
        ...(report.confirmedState ?? {}),
        after: report.after,
      },
      nextActions: [...(report.nextActions ?? [])],
      userSummary: report.summary,
    },
  };
}

function actionProgress(
  confirmedState: Readonly<Record<string, unknown>> | undefined,
): ActionProgress | undefined {
  if (confirmedState === undefined) return undefined;
  const requestedCount = firstInteger(confirmedState, [
    "requestedCount",
    "targetCount",
  ]);
  const completedCount = firstInteger(confirmedState, [
    "collectedCount",
    "minedCount",
    "craftedCount",
    "placedCount",
    "smeltedCount",
  ]);
  if (
    requestedCount === undefined ||
    completedCount === undefined ||
    requestedCount < 1 ||
    completedCount < 0
  ) {
    return undefined;
  }
  const item =
    typeof confirmedState.item === "string"
      ? confirmedState.item
      : typeof confirmedState.resource === "string"
        ? confirmedState.resource
        : undefined;
  return {
    completedCount,
    requestedCount,
    ...(item === undefined ? {} : { item }),
  };
}

function firstInteger(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
