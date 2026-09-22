import type { DeliveryController } from "../app/delivery-controller.js";
import type {
  BehaviorMemoryRecord,
  ForgetBehaviorMemoryInput,
  RememberBehaviorMemoryInput,
} from "../memory/types.js";
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

export type ToolResult<T> =
  | {
      success: true;
      data: T;
      evidence: EvidenceReference[];
      userSummary: string;
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
  say(message: string): Promise<void>;
  followOwner(
    safeDistance: number,
    maxDurationSeconds: number,
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
  /** False while a stopped owner goal is being discussed without resuming it. */
  allowActionTools?: boolean;
  /** Called only after the public say tool has delivered a message. */
  recordDeliveredAssistantMessage?: (message: string) => void;
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
  game: GameController;
  memory: MemoryPort;
  /** Optional on older integrations; behavior tools fail closed when absent. */
  behaviorMemory?: BehaviorMemoryPort;
  limits: {
    maxMoveDistance: number;
    maxGatherCount: number;
    followDistance: number;
    memoryContextLimit: number;
  };
}

export function actionReportResult(
  report: ActionReport,
): ToolResult<ActionReport> {
  const observedAt = new Date().toISOString();
  if (report.outcome === "completed") {
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
