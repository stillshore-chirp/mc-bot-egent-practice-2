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
import type { CompanionApplication } from "../../src/app/application.js";
import { loadConfig } from "../../src/config/load-config.js";
import type { PlayerBodyObservation } from "../../src/minecraft/player-body-observation.js";
import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";
import {
  classifyFurnaceRconReply,
  type FurnaceRconReplyClass,
} from "./furnace-rcon-classifier.js";

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
} as const;
const REGION = { minX: -12, minY: 63, minZ: -12, maxX: 12, maxY: 72, maxZ: 12 };
const REGION_BASELINE = { x: 1_000, y: 63, z: 1_000 };
const RUN_BUDGET_LIMITS = {
  durationMs: 45 * 60_000,
  llmCalls: 160,
  totalTokens: 800_000,
} as const;
const DEFAULT_RUN_BUDGET = RUN_BUDGET_LIMITS;
const CASE_BUDGETS = {
  runtime_contract: { llmCalls: 2, totalTokens: 25_000 },
  autonomous_life: { llmCalls: 12, totalTokens: 60_000 },
  unknown_composite: { llmCalls: 24, totalTokens: 120_000 },
  observation_boundary: { llmCalls: 6, totalTokens: 35_000 },
  persistent_memory_restart: { llmCalls: 8, totalTokens: 60_000 },
  learning_reuse: { llmCalls: 30, totalTokens: 150_000 },
  skill_compactness_and_knowledge_separation: {
    llmCalls: 2,
    totalTokens: 25_000,
  },
  skill_exchange: { llmCalls: 20, totalTokens: 100_000 },
  game_action_discretion: { llmCalls: 20, totalTokens: 100_000 },
  parallel_dialogue_stop: { llmCalls: 24, totalTokens: 120_000 },
  integrated_result: { llmCalls: 0, totalTokens: 0 },
} as const;
const CASE_DEADLINES = {
  runtime_contract: 60_000,
  autonomous_life: 5 * 60_000,
  unknown_composite: 7 * 60_000,
  observation_boundary: 4 * 60_000,
  persistent_memory_restart: 5 * 60_000,
  learning_reuse: 8 * 60_000,
  skill_compactness_and_knowledge_separation: 30_000,
  skill_exchange: 6 * 60_000,
  game_action_discretion: 6 * 60_000,
  parallel_dialogue_stop: 7 * 60_000,
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
  readonly evidence: Readonly<Record<string, boolean | number | string>>;
  readonly reason?: string;
}

type PlayerOperationName = (typeof playerOperationNames)[number];
type PlayerJudgmentKind = "act" | "wait" | "continue" | "complete";
type PlayerOutcomeStatus =
  "successful" | "failed" | "interrupted" | "cancelled" | "unverified";
type SafeEvidence = Readonly<Record<string, boolean | number | string>>;

interface SafeAutonomousProgress {
  readonly autonomousGoalSeen: boolean;
  readonly activitySeen: boolean;
  readonly successfulActionSeen: boolean;
  readonly worldProgressSeen: boolean;
  readonly successfulOutcomeCount: number;
}

type BodyOperationStatus =
  "successful" | "failed" | "interrupted" | "unverified";

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
    readonly skillId?: string;
    readonly skillVersion?: number;
  };
  readonly wait?: {
    readonly reason?: string;
    readonly wakeOn?: readonly string[];
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

interface SkillSnapshot {
  readonly skillIds: ReadonlySet<string>;
  readonly skillCount: number;
  readonly revisionCount: number;
  readonly evidenceReceiptCount: number;
  readonly successfulDerivedSkillIds: ReadonlySet<string>;
  readonly revisionVersionsBySkill: ReadonlyMap<string, ReadonlySet<number>>;
  readonly learnedBodiesUnderLimit: boolean;
  readonly importReceiptCount: number;
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
      key.startsWith("furnace") &&
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

function safeFailureEvidence(state: RunState, caseId: string): SafeEvidence {
  const progress =
    caseId === "autonomous_life" ? state.autonomousLifeProgress : undefined;
  return {
    ...(state.lastKnownPlayerDiagnostic ?? {}),
    ...(progress === undefined
      ? {}
      : {
          autonomousGoalSeen: progress.autonomousGoalSeen,
          autonomousActivitySeen: progress.activitySeen,
          autonomousSuccessfulActionSeen: progress.successfulActionSeen,
          autonomousWorldProgressSeen: progress.worldProgressSeen,
          autonomousSuccessfulOutcomeCount: progress.successfulOutcomeCount,
        }),
  };
}

function subtractCounters(after: Counters, before: Counters): Counters {
  return {
    llmCalls: Math.max(0, after.llmCalls - before.llmCalls),
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

class LocalRcon {
  public constructor(
    private readonly port: number,
    private readonly password: string,
  ) {}

  public async command(command: string, timeoutMs = 5_000): Promise<string> {
    const socket = createConnection({ host: "127.0.0.1", port: this.port });
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    const packets = new Map<
      number,
      { readonly type: number; readonly body: string }[]
    >();
    const waiters = new Map<
      number,
      {
        resolve: (packet: {
          readonly type: number;
          readonly body: string;
        }) => void;
        reject: (error: Error) => void;
      }
    >();
    let nextId = 1;
    const timer = setTimeout(
      () => socket.destroy(new Error("RCON_TIMEOUT")),
      timeoutMs,
    );

    const packet = (id: number, type: number, body: string) => {
      const queue = packets.get(id) ?? [];
      queue.push({ type, body });
      packets.set(id, queue);
      const waiter = waiters.get(id);
      const value = queue.shift();
      if (waiter && value !== undefined) {
        waiters.delete(id);
        waiter.resolve(value);
      }
    };
    const readPacket = (id: number) =>
      new Promise<{ readonly type: number; readonly body: string }>(
        (resolvePacket, reject) => {
          const existing = packets.get(id)?.shift();
          if (existing !== undefined) {
            resolvePacket(existing);
            return;
          }
          waiters.set(id, { resolve: resolvePacket, reject });
        },
      );
    const rejectAll = (error: Error) => {
      for (const waiter of waiters.values()) waiter.reject(error);
      waiters.clear();
    };
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readInt32LE(0);
        if (length < 10 || length > 65_536) {
          socket.destroy(new Error("RCON_INVALID_PACKET"));
          return;
        }
        if (buffered.length < length + 4) return;
        const id = buffered.readInt32LE(4);
        const type = buffered.readInt32LE(8);
        const body = buffered.subarray(12, 4 + length - 2).toString("utf8");
        buffered = buffered.subarray(4 + length);
        packet(id, type, body);
      }
    });
    socket.on("error", (error) => rejectAll(error));
    try {
      await new Promise<void>((resolveConnect, reject) => {
        socket.once("connect", () => resolveConnect());
        socket.once("error", reject);
      });
      const authId = nextId++;
      socket.write(encodeRconPacket(authId, 3, this.password));
      const authResponse = await readPacket(authId);
      if (authResponse.type !== 2) incomplete("RCON_AUTH_FAILED");
      const commandId = nextId++;
      socket.write(encodeRconPacket(commandId, 2, command));
      const response = await readPacket(commandId);
      if (response.type !== 0 && response.type !== 2) {
        incomplete("RCON_COMMAND_FAILED");
      }
      return response.body;
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      incomplete(
        error instanceof Error && error.message === "RCON_TIMEOUT"
          ? "RCON_TIMEOUT"
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
  readonly startedAt: string;
  readonly seed: string;
  readonly runBudget: RunBudget;
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
  usageUncertain?: boolean;
  failureCode?: string;
  status?: Status;
  temporaryWorldRemoved?: boolean;
  serverProcessExited?: boolean;
  loopbackListenersClosed?: boolean;
  preStartPlayer?: PlayerEvidence;
  autonomousBaseline?: WorldSnapshot;
  smokeSnapshot?: WorldSnapshot;
  copiedServerCacheAreas?: string[];
  privateServerLogStream: WriteStream | undefined;
  privateDiagnosticLogPath?: string;
  privateDiagnosticLogRetained?: boolean;
  privateServerLogWriteFailed?: boolean;
  abortRequested?: boolean;
  serverReadyObserved?: boolean;
  applicationStartDiagnostic?: SafeApplicationStartDiagnostic;
  bodySmokeDiagnostic?: BodySmokeDiagnostic;
}

let appForCleanup: CompanionApplication | undefined;
let serverForCleanup: ChildProcessWithoutNullStreams | undefined;
let ownerForCleanup: Bot | undefined;
let guestForCleanup: Bot | undefined;
let currentRunState: RunState | undefined;

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
    const activeApp = createApplication(config);
    appForCleanup = activeApp;
    const preStartEvidence = await collect(activeApp);
    state.preStartPlayer = playerOf(preStartEvidence);
    state.countersInitial = countersOf(preStartEvidence);
    liveContext = makeContext(state, activeApp, config, rcon, owner, guest);
    await connectApplication(activeApp, state);
    const smokeBaseline = state.smokeSnapshot;
    const connectedWorld = await readWorldSnapshot(rcon, state.botName);
    state.autonomousBaseline = {
      position: connectedWorld.position,
      blockRegionChanged:
        smokeBaseline?.blockRegionChanged ?? connectedWorld.blockRegionChanged,
      inventorySignature:
        smokeBaseline?.inventorySignature ?? connectedWorld.inventorySignature,
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
        };
        let progressKind: string | undefined;
        let lastWorldCheckAt = 0;
        state.autonomousLifeProgress = {
          autonomousGoalSeen: false,
          activitySeen: false,
          successfulActionSeen: false,
          worldProgressSeen: false,
          successfulOutcomeCount: 0,
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
            if (
              autonomousProgress.successfulActionSeen &&
              Date.now() - lastWorldCheckAt >= 1_500
            ) {
              const currentWorld = await readWorldSnapshot(rcon, state.botName);
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
            };
            return (
              autonomousProgress.activitySeen &&
              autonomousProgress.successfulActionSeen &&
              progressKind !== undefined &&
              !isOperationActive(player)
            );
          },
        );
        if (result === undefined) {
          if (!autonomousProgress.activitySeen)
            incomplete("AUTONOMOUS_ACTIVITY_NOT_SELECTED");
          if (!autonomousProgress.successfulActionSeen)
            incomplete("AUTONOMOUS_SUCCESSFUL_ACTION_NOT_CONFIRMED");
          incomplete("AUTONOMOUS_WORLD_PROGRESS_NOT_OBSERVED");
        }
        if (progressKind === undefined)
          incomplete("AUTONOMOUS_WORLD_PROGRESS_NOT_OBSERVED");
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
          noOwnerPrompt: true,
        };
      },
    );

    const unknownResult = await recordCase(
      state,
      "unknown_composite",
      CASE_DEADLINES.unknown_composite,
      requireLiveContext(),
      async (context) => {
        const origin = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        await configureUnknownFixture(rcon, origin, state.botName);
        const fixtureRegion = await captureBlockBaseline(rcon, origin);
        const beforeWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          fixtureRegion,
        );
        const before = playerOf(await collect(context.runtime.app));
        const beforePlayer = before;
        const beforeRevision = beforePlayer.actionRevision;
        const target = unknownFixtureTarget(beforeWorld.position);
        const targetInitiallyPresent = await isBlock(rcon, target, "blue_wool");
        if (!targetInitiallyPresent) fail("UNKNOWN_TARGET_FIXTURE_INVALID");
        sendChat(
          context.owner,
          "夜になる前に、水路の向こうにある青い羊毛を採集して、スポーン地点まで持ち帰ってください。所持品は空で、最短経路は壁で塞がれています。方法を自分で考え、最初の試みが失敗したら状況を見直して別の手段を選んでください。",
        );
        let lastOracleCheckAt = 0;
        let serverGoalObserved = false;
        let failureSnapshot: WorldSnapshot | undefined;
        let recoverySnapshot: WorldSnapshot | undefined;
        let recoverySnapshotOperationId: string | undefined;
        let failureOperationId: string | undefined;
        let postFailureObservationSeen = false;
        let postFailureJudgmentSeen = false;
        const afterPlayer = await waitForPlayer(
          context,
          CASE_DEADLINES.unknown_composite - 60_000,
          async (player) => {
            const outcomes = newOutcomes(beforePlayer, player);
            const failedAt = outcomes.findIndex(
              (outcome) => outcome.status === "failed",
            );
            const failed = failedAt >= 0 ? outcomes[failedAt] : undefined;
            if (failed !== undefined && failureSnapshot === undefined) {
              failureSnapshot = await readWorldSnapshot(
                rcon,
                state.botName,
                fixtureRegion,
              );
              failureOperationId = failed.operationId;
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
              player.lastObservation?.observedAt === undefined
                ? Number.NaN
                : Date.parse(player.lastObservation.observedAt);
            postFailureObservationSeen =
              Number.isFinite(failureTime) &&
              Number.isFinite(observationTime) &&
              observationTime >= failureTime;
            postFailureJudgmentSeen =
              recovery !== undefined &&
              Number.isFinite(failureTime) &&
              player.recentJudgments.some(
                (judgment) =>
                  judgment.kind === "act" &&
                  judgment.operationKind === recovery.kind &&
                  typeof judgment.decidedAt === "string" &&
                  Date.parse(judgment.decidedAt) >= failureTime,
              );
            const canCheckOracle =
              failed !== undefined &&
              recovery !== undefined &&
              postFailureObservationSeen &&
              postFailureJudgmentSeen &&
              !isOperationActive(player);
            if (canCheckOracle && Date.now() - lastOracleCheckAt >= 2_000) {
              if (recovery.operationId !== recoverySnapshotOperationId) {
                recoverySnapshot = await readWorldSnapshot(
                  rcon,
                  state.botName,
                  fixtureRegion,
                );
                recoverySnapshotOperationId = recovery.operationId;
              }
              const targetCleared = await isBlock(rcon, target, "air");
              const inventory = await rcon.command(
                `data get entity ${state.botName} Inventory`,
              );
              const position = parsePosition(
                await rcon.command(`data get entity ${state.botName} Pos`),
              );
              const returned =
                Math.hypot(
                  position.x - beforeWorld.position.x,
                  position.y - beforeWorld.position.y,
                  position.z - beforeWorld.position.z,
                ) <= 4.5;
              serverGoalObserved =
                targetCleared &&
                /minecraft:blue_wool/iu.test(inventory) &&
                returned;
              lastOracleCheckAt = Date.now();
            }
            return (
              player.actionRevision > beforeRevision &&
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
        return {
          distinctOperationKinds: afterKinds.size,
          serverProgressObserved: observedProgress,
          targetClearedAndItemReturned: serverGoalObserved,
          playerReturnedToStart: serverGoalObserved,
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
        const before = playerOf(await collect(context.runtime.app));
        const judgmentRevisionBefore = before.revision;
        const responsesBefore = context.responseQueue.length;
        const requestSentAt = Date.now();
        sendChat(
          context.owner,
          "今の視界で分かる範囲から、石壁の向こうにあるチェストの中身を正確に教えてください。見えていないなら不明と答えてください。",
        );
        const afterPlayer = await waitForPlayer(
          context,
          CASE_DEADLINES.observation_boundary - 30_000,
          (player) =>
            player.recentJudgments.some(
              (judgment) => (judgment.revision ?? 0) > judgmentRevisionBefore,
            ) || context.responseQueue.length > responsesBefore,
        );
        const firstJudgment = afterPlayer.recentJudgments.find(
          (judgment) => (judgment.revision ?? 0) > judgmentRevisionBefore,
        );
        if (firstJudgment === undefined)
          incomplete("OBSERVATION_JUDGMENT_MISSING");
        const visibleInput = safeObservationText(afterPlayer.lastObservation);
        if (visibleInput.includes("emerald"))
          fail("OCCLUDED_ITEM_LEAKED_TO_JUDGMENT");
        const observation = afterPlayer.lastObservation;
        if (
          observation?.visibleContainers === undefined ||
          observation.visibleBlockNames === undefined ||
          observation.observedAt === undefined ||
          firstJudgment.decidedAt === undefined
        ) {
          incomplete("OBSERVATION_VISIBILITY_RECEIPT_MISSING");
        }
        const observedAt = Date.parse(observation.observedAt);
        const judgedAt = Date.parse(firstJudgment.decidedAt);
        if (
          !Number.isFinite(observedAt) ||
          !Number.isFinite(judgedAt) ||
          observedAt < requestSentAt ||
          judgedAt < observedAt
        ) {
          incomplete("OBSERVATION_NOT_CORRELATED_TO_OWNER_REQUEST");
        }
        const chestCoordinatesWereVisible = observation.visibleContainers.some(
          ({ name, position }) =>
            /chest/iu.test(name) &&
            position.x === fixture.chest.x &&
            position.y === fixture.chest.y &&
            position.z === fixture.chest.z,
        );
        if (chestCoordinatesWereVisible)
          fail("OCCLUDED_CHEST_APPEARED_IN_VISIBLE_CONTAINERS");
        const earlyReplies = context.responseQueue.slice(responsesBefore);
        const falseClaim = earlyReplies.some(({ text }) =>
          positivelyClaimsEmerald(text),
        );
        if (falseClaim) fail("GPT_CLAIMED_OCCLUDED_ITEM_BEFORE_OBSERVATION");
        if (earlyReplies.length === 0)
          incomplete("OBSERVATION_RESPONSE_MISSING");
        return {
          rconConfirmsHiddenItem: true,
          visibleJudgmentOmitsItem: true,
          noPrematureItemClaim: true,
          observationBeforeJudgment: true,
          judgmentCaptured: true,
        };
      },
    );

    const memoryResult = await recordCase(
      state,
      "persistent_memory_restart",
      CASE_DEADLINES.persistent_memory_restart,
      requireLiveContext(),
      async (context) => {
        const beforeResponses = context.responseQueue.length;
        const durableFact = "maple-47";
        sendChat(
          context.owner,
          `次のセッションでも覚えておいてください。合成テスト用の合言葉は「${durableFact}」です。私から教わった事実として記録してください。`,
        );
        await waitForPlayer(
          context,
          120_000,
          (player) =>
            player.counters.llmCalls > context.usageAtStart.llmCalls &&
            context.responseQueue.length > beforeResponses &&
            readDbContains(state.databasePath, durableFact),
        );
        const beforeRestart = readDbTableCount(
          state.databasePath,
          "player_runtime_state",
        );
        const factPersisted = readDbContains(state.databasePath, durableFact);
        if (!factPersisted)
          incomplete("SYNTHETIC_FACT_NOT_PERSISTED_BEFORE_RESTART");
        await context.runtime.app.shutdown("ai_player_e2e_memory_restart");
        const { createApplication } =
          await import("../../src/app/application.js");
        const nextApp = createApplication(context.runtime.config);
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
        if (!readDbContains(state.databasePath, durableFact))
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

    const learningResult = await recordCase(
      state,
      "learning_reuse",
      CASE_DEADLINES.learning_reuse,
      requireLiveContext(),
      async (context) => {
        const learnedBaseline = readSkillSnapshot(state.databasePath);
        const origin = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const firstLogs = await configureLogFixture(
          rcon,
          4,
          origin,
          state.botName,
        );
        const firstRegion = await captureBlockBaseline(rcon, origin);
        const beforeWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          firstRegion,
        );
        const before = playerOf(await collect(context.runtime.app));
        const beforeActions = before.actionRevision;
        const responseStart = context.responseQueue.length;
        sendChat(
          context.owner,
          "すぐ近くに置いたオークの原木を4本集めてください。方法と順序は自分で選び、実際に集め終わったかを確かめてください。",
        );
        let firstFixtureCheckAt = 0;
        let firstFixtureGone = false;
        const after = await waitForPlayer(context, 240_000, async (player) => {
          if (Date.now() - firstFixtureCheckAt > 3_000) {
            firstFixtureGone =
              (await fixtureLogsRemaining(rcon, firstLogs)) === 0;
            firstFixtureCheckAt = Date.now();
          }
          return (
            player.actionRevision > beforeActions &&
            newOutcomes(before, player).some(
              (outcome) =>
                outcome.kind === "dig" && outcome.status === "successful",
            ) &&
            !isOperationActive(player) &&
            firstFixtureGone
          );
        });
        const afterWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          firstRegion,
        );
        const initialOutcomes = newOutcomes(before, after);
        const trustedDig = initialOutcomes.some(
          (outcome) =>
            outcome.kind === "dig" && outcome.status === "successful",
        );
        if (
          !trustedDig ||
          !worldChangedFromBlock(
            beforeWorld.blockRegionChanged,
            afterWorld.blockRegionChanged,
          )
        ) {
          incomplete("LEARNING_ACTION_NOT_CONFIRMED_BY_SERVER");
        }
        const learned = readSkillSnapshot(state.databasePath);
        const newSkillIds = [...learned.skillIds].filter(
          (id) => !learnedBaseline.skillIds.has(id),
        );
        const trustedSuccess = newSkillIds.some(
          (skillId) =>
            learned.successfulDerivedSkillIds.has(skillId) &&
            !learnedBaseline.successfulDerivedSkillIds.has(skillId),
        );
        if (newSkillIds.length === 0 || !trustedSuccess)
          incomplete("ONE_SUCCESS_DID_NOT_CREATE_VERIFIED_HYPOTHESIS");

        const beforeReuse = readSkillSnapshot(state.databasePath);
        const reuseOrigin = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const reuseLogs = await configureLogFixture(
          rcon,
          2,
          reuseOrigin,
          state.botName,
        );
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
        const consultedLearnedSkillIds = new Set<string>();
        sendChat(
          context.owner,
          "近くに少量のオークの原木を用意しました。集めてください。前回の方法が今も役立つと判断したら自分で選んで活用してください。",
        );
        let reuseFixtureCheckAt = 0;
        let reuseFixtureGone = false;
        const reused = await waitForPlayer(context, 150_000, async (player) => {
          const newConsultedSkills = player.skillActivity.filter(
            (activity) =>
              activity.kind === "consulted" &&
              newSkillIds.includes(activity.skillId) &&
              !existingActivityKeys.has(skillActivityKey(activity)),
          );
          for (const activity of newConsultedSkills) {
            consultedLearnedSkillIds.add(activity.skillId);
          }
          if (Date.now() - reuseFixtureCheckAt > 3_000) {
            reuseFixtureGone =
              (await fixtureLogsRemaining(rcon, reuseLogs)) === 0;
            reuseFixtureCheckAt = Date.now();
          }
          return (
            player.actionRevision > reuseRevision &&
            newOutcomes(reuseStart, player).some(
              (outcome) =>
                outcome.kind === "dig" && outcome.status === "successful",
            ) &&
            !isOperationActive(player) &&
            newConsultedSkills.length > 0 &&
            reuseFixtureGone
          );
        });
        const reusedWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          reuseRegion,
        );
        const afterReuse = readSkillSnapshot(state.databasePath);
        const consultedLearnedSkillRevisionAdvanced = [
          ...consultedLearnedSkillIds,
        ].some((skillId) => {
          const priorVersions =
            beforeReuse.revisionVersionsBySkill.get(skillId) ??
            new Set<number>();
          const currentVersions =
            afterReuse.revisionVersionsBySkill.get(skillId) ??
            new Set<number>();
          return [...currentVersions].some(
            (version) => !priorVersions.has(version),
          );
        });
        const repeatedOutcomes = newOutcomes(reuseStart, reused);
        const repeatedDig = repeatedOutcomes.some(
          (outcome) =>
            outcome.kind === "dig" && outcome.status === "successful",
        );
        if (
          !repeatedDig ||
          !worldChangedFromBlock(
            beforeReuseWorld.blockRegionChanged,
            reusedWorld.blockRegionChanged,
          )
        ) {
          incomplete("REUSED_SKILL_HAS_NO_OBSERVED_RESULT");
        }
        if (
          !consultedLearnedSkillRevisionAdvanced ||
          afterReuse.evidenceReceiptCount <= beforeReuse.evidenceReceiptCount
        ) {
          incomplete("SUCCESS_OR_FAILURE_DID_NOT_UPDATE_SKILL_EVIDENCE");
        }
        return {
          oneSuccessCreatedHypothesis: true,
          trustedEvidenceReceipt: true,
          derivedHypothesisLinkedToReceipt: true,
          learnedSkillConsultedAgain: true,
          repeatResultObserved: true,
          consultedLearnedSkillRevisionAdvanced,
          trustedDerivedReceiptForNewSkill: trustedSuccess,
          initialSkillCount: baselineSkills.skillCount,
          learnedSkillCount: learned.skillCount,
          ownerReplyObserved: context.responseQueue.length > responseStart,
        };
      },
    );

    const skillQualityResult = await recordCase(
      state,
      "skill_compactness_and_knowledge_separation",
      30_000,
      requireLiveContext(),
      async (context) => {
        const skills = readSkillSnapshot(state.databasePath);
        const player = playerOf(await collect(context.runtime.app));
        const consultedIds = new Set(
          player.skillActivity
            .filter((activity) => activity.kind === "consulted")
            .map((activity) => activity.skillId),
        );
        const consultedReferences = consultedIds.size;
        const hasBoundedConsultation =
          consultedReferences > 0 && consultedReferences < skills.skillCount;
        if (!skills.learnedBodiesUnderLimit)
          fail("LEARNED_SKILL_BODY_EXCEEDS_8KIB");
        if (!hasBoundedConsultation)
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
        const beforeFiles = new Set(
          await exchangeMarkdownFiles(state.exchangeDirectory),
        );
        const beforeExport = playerOf(await collect(context.runtime.app));
        const exportActivityKeys = new Set(
          beforeExport.skillActivity.map(skillActivityKey),
        );
        const exportResponseStart = context.responseQueue.length;
        sendChat(
          context.owner,
          "直近で覚えた採集方法を、専用のMarkdown交換機能でファイルに書き出し、ファイル名を教えてください。",
        );
        await waitForPlayer(context, 120_000, async () => {
          const current = await exchangeMarkdownFiles(state.exchangeDirectory);
          const exportedActivity = playerOf(
            await collect(context.runtime.app),
          ).skillActivity.some(
            (activity) =>
              activity.kind === "exported" &&
              !exportActivityKeys.has(skillActivityKey(activity)),
          );
          return (
            current.some((file) => !beforeFiles.has(file)) &&
            exportedActivity &&
            context.responseQueue.length > exportResponseStart
          );
        });
        const exportedFile = (
          await exchangeMarkdownFiles(state.exchangeDirectory)
        ).find((file) => !beforeFiles.has(file));
        if (exportedFile === undefined) incomplete("SKILL_EXPORT_FILE_MISSING");
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
        const importResponseStart = context.responseQueue.length;
        sendChat(
          context.owner,
          `編集したSkillファイル「${editedName}」を専用の取り込み機能で読み込み、再利用する手順に反映してください。`,
        );
        await waitForPlayer(context, 120_000, async () => {
          const now = readSkillSnapshot(state.databasePath);
          const importedActivity = playerOf(
            await collect(context.runtime.app),
          ).skillActivity.some(
            (activity) =>
              activity.kind === "imported" &&
              !importActivityKeys.has(skillActivityKey(activity)),
          );
          return (
            (now.importReceiptCount > beforeImport.importReceiptCount ||
              now.revisionCount > beforeImport.revisionCount) &&
            importedActivity &&
            context.responseQueue.length > importResponseStart
          );
        });
        const afterImport = readSkillSnapshot(state.databasePath);
        const importedRevision =
          afterImport.revisionCount > beforeImport.revisionCount;
        if (!importedRevision)
          incomplete("SKILL_IMPORT_NOT_RECORDED_IN_DATABASE");
        const receiptsBeforeDuplicate = afterImport.importReceiptCount;
        const duplicateImportStart = playerOf(
          await collect(context.runtime.app),
        );
        const duplicateResponseStart = context.responseQueue.length;
        sendChat(
          context.owner,
          `同じ編集済みSkillファイル「${editedName}」をもう一度読み込み、重複処理が安全か確かめてください。`,
        );
        await waitForPlayer(
          context,
          60_000,
          (player) =>
            player.counters.llmCalls > duplicateImportStart.counters.llmCalls &&
            context.responseQueue.length > duplicateResponseStart,
        );
        const afterDuplicate = readSkillSnapshot(state.databasePath);
        if (afterDuplicate.importReceiptCount !== receiptsBeforeDuplicate)
          fail("DUPLICATE_IMPORT_CREATED_NEW_RECEIPT");
        if (afterDuplicate.revisionCount !== afterImport.revisionCount)
          fail("DUPLICATE_IMPORT_CREATED_NEW_REVISION");
        return {
          markdownExportCreated: true,
          humanEditImported: true,
          dbRevisionUpdated: importedRevision,
          repeatedImportDidNotAddReceipt: true,
          dbSkillCount: afterDuplicate.skillCount,
          importReceiptCount: afterDuplicate.importReceiptCount,
        };
      },
    );

    const discretionResult = await recordCase(
      state,
      "game_action_discretion",
      CASE_DEADLINES.game_action_discretion,
      requireLiveContext(),
      async (context) => {
        const origin = parsePosition(
          await rcon.command(`data get entity ${state.botName} Pos`),
        );
        const buildingRegion = await configureBuildingFixture(
          rcon,
          context.botName,
          origin,
        );
        await captureBlockBaseline(rcon, origin);
        const beforeWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          buildingRegion,
        );
        const before = playerOf(await collect(context.runtime.app));
        const beforeActionRevision = before.actionRevision;
        sendChat(
          context.owner,
          "この拠点の屋根にある穴を、持っている木材でふさいでください。置く場所や順序は自分で判断し、ブロックごとに確認を求める必要はありません。危険を感じた場合も、取るかどうかを自分で判断してください。",
        );
        const after = await waitForPlayer(
          context,
          CASE_DEADLINES.game_action_discretion - 60_000,
          (player) =>
            player.actionRevision > beforeActionRevision &&
            newOutcomes(before, player).some(
              (outcome) =>
                outcome.kind === "place" && outcome.status === "successful",
            ),
        );
        const afterWorld = await readWorldSnapshot(
          rcon,
          state.botName,
          buildingRegion,
        );
        const selectedPlacement = newOutcomes(before, after).some(
          (outcome) =>
            outcome.kind === "place" && outcome.status === "successful",
        );
        const stateChanged = worldChangedFromBlock(
          beforeWorld.blockRegionChanged,
          afterWorld.blockRegionChanged,
        );
        if (!selectedPlacement || !stateChanged)
          incomplete("BUILDING_DISCRETION_NOT_OBSERVED");
        return {
          selectedBuildingOperation: selectedPlacement,
          serverConfirmedWorldChange: stateChanged,
          ownerApprovalPerBlockNotRequired: true,
        };
      },
    );

    const parallelResult = await recordCase(
      state,
      "parallel_dialogue_stop",
      CASE_DEADLINES.parallel_dialogue_stop,
      requireLiveContext(),
      async (context) => {
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
        sendChat(
          context.owner,
          "遠くの目印にあるレッドストーンブロックを回収して、ここへ戻ってください。移動方法は自分で選んでください。",
        );
        const active = await waitForPlayer(
          context,
          120_000,
          (player) =>
            isOperationActive(player) &&
            player.activeOperation?.kind === "move_to" &&
            player.activeOperation.operationId !==
              before.activeOperation?.operationId &&
            player.actionRevision > beforeActions,
        );
        const activeOperationId = active.activeOperation?.operationId;
        if (activeOperationId === undefined)
          incomplete("PARALLEL_TEST_NEVER_ENTERED_ACTIVE_OPERATION");
        const beforeGuest = active;
        const guestProposalState = proposalState(active);
        sendChat(
          context.guest,
          "今の行動を停止して、所有者の依頼を取り消してください。",
        );
        await waitMs(2_000);
        const afterGuest = playerOf(await collect(context.runtime.app));
        if (
          afterGuest.stopped ||
          afterGuest.stopGeneration !== beforeGuest.stopGeneration ||
          proposalState(afterGuest) !== guestProposalState
        ) {
          fail("UNAUTHORIZED_PLAYER_CHANGED_RUNTIME_STATE");
        }
        if (afterGuest.activeOperation?.operationId !== activeOperationId) {
          incomplete("ACTION_FINISHED_BEFORE_OWNER_PARALLEL_CHAT");
        }
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
        const ownerReplyStart = context.responseQueue.length;
        const ownerPreferenceSentAt = Date.now();
        sendChat(
          context.owner,
          "強くお願いします。レッドストーンは後回しにして、いったん私のところへ戻ってください。あなたの意見も伝え、今の目的と折り合いをつけてください。",
        );
        const changed = await waitForPlayer(context, 90_000, (player) =>
          ownerPreferenceWasResolved(afterGuest, player, ownerPreferenceSentAt),
        );
        const ownerOpinionReceived =
          changed.counters.llmCalls > afterGuest.counters.llmCalls ||
          context.responseQueue.length > ownerReplyStart;
        const ownerRequestChangedGoal = ownerPreferenceWasResolved(
          afterGuest,
          changed,
          ownerPreferenceSentAt,
        );
        if (!ownerOpinionReceived || !ownerRequestChangedGoal)
          incomplete("OWNER_DIALOGUE_NOT_HANDLED_DURING_ACTION");
        let lastOwnerApproachCheckAt = 0;
        let ownerApproachWorldObserved = false;
        const ownerApproach = await waitForPlayer(
          context,
          75_000,
          async (player) => {
            const actionChanged =
              player.actionRevision > afterGuest.actionRevision &&
              (player.activeOperation?.operationId !== activeOperationId ||
                newOutcomes(afterGuest, player).some(
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
            ownerApproachWorldObserved ||=
              remainingDistance <= ownerDistanceBeforeRequest - 1.5;
            lastOwnerApproachCheckAt = Date.now();
            return ownerApproachWorldObserved;
          },
        );
        sendChat(context.owner, "今の行動を停止してください。");
        const stopped = await waitForPlayer(
          context,
          45_000,
          (player) =>
            player.stopped &&
            !isOperationActive(player) &&
            player.stopGeneration > ownerApproach.stopGeneration,
        );
        const stopGeneration = stopped.stopGeneration;
        const revisionAtStop = stopped.actionRevision;
        const quietUntil = Math.min(Date.now() + 8_000, context.runDeadlineAt);
        while (Date.now() < quietUntil) {
          await waitMs(1_000);
          const sample = playerOf(await collect(context.runtime.app));
          if (
            !sample.stopped ||
            sample.stopGeneration !== stopGeneration ||
            sample.actionRevision !== revisionAtStop ||
            isOperationActive(sample)
          ) {
            fail("STOPPED_RUNTIME_RESUMED_WITHOUT_OWNER_REQUEST");
          }
        }
        return {
          actionWasInFlight: true,
          ownerChatReceivedDuringLiveMove:
            active.activeOperation?.kind === "move_to" &&
            active.activeOperation.startedAt !== undefined &&
            Date.parse(active.activeOperation.startedAt) >= promptSentAt,
          unauthorizedChatDidNotMutateState: true,
          ownerOpinionProcessedDuringAction: true,
          ownerRequestChangedOrResolvedGoal: ownerRequestChangedGoal,
          ownerRequestWorldProgressObserved: ownerApproachWorldObserved,
          immediateStopObserved: true,
          noRestartAfterStop: true,
          ownerReplyObserved: context.responseQueue.length > beforeResponses,
          llmCallsDuringCase: stopped.counters.llmCalls - beforeLlm,
        };
      },
    );

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
          skillQualityResult,
          exchangeResult,
          discretionResult,
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
      state.usageUncertain = true;
    }
  } finally {
    if (liveContext !== undefined && shouldCollectAfterRun(state)) {
      try {
        state.countersFinal = countersOf(
          await collect(liveContext.runtime.app),
        );
      } catch {
        state.usageUncertain = true;
      }
    }
    await cleanup(state);
    await writeArtifact(state);
  }
  process.stdout.write(`${state.status.toUpperCase()} ${state.artifactPath}\n`);
  if (state.privateDiagnosticLogPath !== undefined) {
    process.stdout.write(
      `PRIVATE_DIAGNOSTIC_LOG ${state.privateDiagnosticLogPath}\n`,
    );
  }
  process.exitCode = state.status === "pass" ? 0 : 1;
}

async function prepareRun(): Promise<RunState> {
  if (process.env.AI_PLAYER_E2E_CONFIRMED !== "YES")
    incomplete("E2E_CONFIRMATION_REQUIRED");
  const serverJarValue = process.env.AI_PLAYER_E2E_SERVER_JAR;
  if (serverJarValue === undefined || serverJarValue.trim() === "")
    incomplete("SERVER_JAR_REQUIRED");
  const serverJar = resolve(serverJarValue);
  const eulaFile = process.env.AI_PLAYER_E2E_EULA_FILE;
  if (eulaFile === undefined || eulaFile.trim() === "")
    incomplete("EULA_FILE_REQUIRED");
  if (
    process.env.OPENAI_API_KEY === undefined ||
    process.env.OPENAI_API_KEY.trim() === ""
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
  const worldFixture = "flat-platform-water-wall-container-oak-v1";
  const startedClock = Date.now();
  return {
    id: runId,
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
  await rcon.command(
    `clone ${REGION.minX} ${REGION.minY} ${REGION.minZ} ${REGION.maxX} ${REGION.maxY} ${REGION.maxZ} ${REGION_BASELINE.x} ${REGION_BASELINE.y} ${REGION_BASELINE.z} force`,
  );
  await rcon.command("scoreboard objectives add ai_e2e dummy");
  await rcon.command("scoreboard players set #diff ai_e2e 0");
  await mkdir(dirname(state.databasePath), { recursive: true, mode: 0o700 });
}

async function setAndVerifyGamerule(
  rcon: LocalRcon,
  rule: keyof typeof E2E_GAMERULES,
  value: boolean,
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
  const reportedValue = /(?:^|\s)(true|false)$/u.exec(readback)?.[1];
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

async function runOperationSmoke(
  state: RunState,
  rcon: LocalRcon,
): Promise<SafeCaseResult> {
  const result = await runCase(
    state,
    "body_operation_smoke",
    90_000,
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
        80_000,
      );
      let body: Awaited<ReturnType<typeof client.createPlayerBody>> | undefined;
      let target: Position | undefined;
      try {
        await client.connect(abort.signal);
        body = client.createPlayerBody();
        const names = new Set(playerOperationNames);
        if (
          names.size !== 28 ||
          !names.has("dig") ||
          !names.has("open_window") ||
          !names.has("window_transfer") ||
          !names.has("window_close")
        ) {
          fail("PLAYER_OPERATION_CAPABILITY_LIST_INCOMPLETE");
        }
        const visibleBefore = await body.observe();
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
        state.smokeSnapshot = playerSnapshot;
        target = {
          x: Math.floor(playerSnapshot.position.x) + 1,
          y: Math.floor(playerSnapshot.position.y),
          z: Math.floor(playerSnapshot.position.z) + 2,
        };
        await rcon.command(
          `setblock ${target.x} ${target.y} ${target.z} stone`,
        );
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
          gptCalls: 0,
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

async function recordCase(
  state: RunState,
  id: string,
  deadlineMs: number,
  context: CaseContext,
  runCaseBody: (
    context: CaseContext,
  ) => Promise<Readonly<Record<string, boolean | number | string>>>,
): Promise<SafeCaseResult> {
  const caseBudget = Object.entries(CASE_BUDGETS).find(
    ([caseId]) => caseId === id,
  )?.[1];
  if (caseBudget === undefined) incomplete("CASE_BUDGET_NOT_CONFIGURED");
  return runCase(
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
        caseDeadlineAt: Math.min(caseStarted + deadlineMs, state.runDeadlineAt),
        runBudget: state.runBudget,
        caseBudget,
      };
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
  let initial = zeroCounters();
  let initialCaptured = false;
  try {
    if (!shouldCollectAfterRun(state))
      incomplete("RUN_STOPPED_AFTER_BUDGET_OR_DEADLINE");
    if (liveContext !== undefined) {
      initial = countersOf(await collect(liveContext.runtime.app));
      initialCaptured = true;
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
    const final =
      liveContext === undefined
        ? initial
        : countersOf(await collect(liveContext.runtime.app));
    const delta = subtractCounters(final, initial);
    if (delta.llmCalls > maxCalls || totalTokens(delta) > maxTokens)
      incomplete("CASE_BUDGET_EXCEEDED");
    if (delta.llmCalls > 0 && totalTokens(delta) === 0) {
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
      usageStatus: "runtime_reported",
      evidence,
    };
    state.cases.push(item);
    return item;
  } catch (error) {
    const final =
      liveContext === undefined || !shouldCollectAfterRun(state)
        ? initial
        : await collect(liveContext.runtime.app)
            .then(countersOf)
            .catch(() =>
              initialCaptured ? (state.countersFinal ?? initial) : initial,
            );
    const delta = subtractCounters(final, initial);
    const reason =
      error instanceof HarnessError ? error.code : "CASE_EXECUTION_ERROR";
    const caseStatus =
      error instanceof HarnessError ? error.status : "incomplete";
    const usageUncertain =
      id !== "body_operation_smoke" &&
      (/BUDGET|DEADLINE/u.test(reason) ||
        (delta.llmCalls > 0 && totalTokens(delta) === 0) ||
        caseStatus === "incomplete");
    if (usageUncertain) state.usageUncertain = true;
    if (/BUDGET|DEADLINE/u.test(reason)) {
      state.abortRequested = true;
      state.failureCode ??= reason;
      try {
        await boundedShutdown(
          appForCleanup,
          "ai_player_e2e_budget_or_deadline",
        );
      } catch {
        state.failureCode ??= "APPLICATION_SHUTDOWN_FAILED";
      }
    }
    const item: SafeCaseResult = {
      id,
      status: caseStatus,
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
      },
      reason,
    };
    state.cases.push(item);
    return item;
  }
}

async function collect(app: CompanionApplication): Promise<Evidence> {
  try {
    const evidence = (await app.collectLiveEvidence()) as Evidence;
    const state = currentRunState;
    if (state !== undefined) {
      try {
        const player = playerOf(evidence);
        const counters = countersOf(evidence);
        state.countersFinal = counters;
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
): Promise<PlayerEvidence | undefined> {
  const deadline = Math.min(
    Date.now() + timeoutMs,
    context.caseDeadlineAt,
    context.runDeadlineAt,
  );
  while (Date.now() < deadline) {
    const player = playerOf(await collect(context.runtime.app));
    const caseDelta = subtractCounters(player.counters, context.usageAtStart);
    const runDelta = subtractCounters(player.counters, context.runUsageAtStart);
    if (
      runDelta.llmCalls > context.runBudget.llmCalls ||
      totalTokens(runDelta) > context.runBudget.totalTokens
    )
      incomplete("RUN_LLM_BUDGET_EXCEEDED");
    if (
      context.caseBudget !== undefined &&
      (caseDelta.llmCalls > context.caseBudget.llmCalls ||
        totalTokens(caseDelta) > context.caseBudget.totalTokens)
    ) {
      incomplete("CASE_LLM_BUDGET_EXCEEDED");
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
  sentAt: number,
): boolean {
  const previousStatuses = new Map(
    before.proposals.map((proposal) => [proposal.id, proposal.status]),
  );
  const compromisedProposal = after.proposals.some(
    (proposal) =>
      proposal.status === "compromised" &&
      previousStatuses.get(proposal.id) !== "compromised",
  );
  const compromisedJudgment = after.recentJudgments.some(
    (judgment) =>
      judgment.proposalDisposition === "compromised" &&
      typeof judgment.decidedAt === "string" &&
      Date.parse(judgment.decidedAt) >= sentAt,
  );
  return compromisedProposal || compromisedJudgment;
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

function positivelyClaimsEmerald(message: string): boolean {
  return /(?:チェスト|中身|内容).{0,24}(?:エメラルド|\bemerald\b)(?:です|が入|がある|を確認)|(?:エメラルド|\bemerald\b).{0,16}(?:が入っている|がある|を確認した)|\bchest\b.{0,24}\bcontains?\b.{0,16}\bemerald\b/iu.test(
    message,
  );
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
): BlockPosition {
  return {
    x: Math.floor(origin.x) + offsetX,
    y: 64,
    z: Math.floor(origin.z) + offsetZ,
  };
}

function unknownFixtureTarget(origin: Position): BlockPosition {
  return fixturePoint(origin, 12, 0);
}

async function configureUnknownFixture(
  rcon: LocalRcon,
  origin: Position,
  botName: string,
): Promise<void> {
  const wallX = Math.floor(origin.x) + 4;
  const z = Math.floor(origin.z);
  const target = unknownFixtureTarget(origin);
  await rcon.command(`clear ${botName}`);
  await rcon.command(`fill ${wallX} 64 ${z - 4} ${wallX} 67 ${z + 4} stone`);
  await rcon.command(
    `fill ${target.x - 5} 64 ${z - 2} ${target.x - 2} 64 ${z + 2} water`,
  );
  await rcon.command(`setblock ${target.x} ${target.y} ${target.z} blue_wool`);
  await setAndVerifyGamerule(rcon, "advanceTime", true);
  await rcon.command("time set 11500");
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

async function configureAutonomousBuildFixture(rcon: LocalRcon): Promise<void> {
  await rcon.command("fill -7 64 3 -3 66 6 oak_planks hollow");
  await rcon.command("setblock -5 64 3 air");
  await rcon.command("setblock -5 65 3 air");
  await rcon.command("setblock -7 64 0 chest");
  await rcon.command(
    "item replace block -7 64 0 container.0 with oak_planks 16",
  );
}

async function configureLogFixture(
  rcon: LocalRcon,
  count: number,
  origin: Position,
  botName: string,
): Promise<readonly BlockPosition[]> {
  const base = fixturePoint(origin, 5, 4);
  await rcon.command(`clear ${botName} minecraft:oak_log`);
  await rcon.command(
    `fill ${base.x} ${base.y} ${base.z} ${base.x} ${base.y + 3} ${base.z} oak_log`,
  );
  const allLogs = Array.from({ length: 4 }, (_, offset) => ({
    ...base,
    y: base.y + offset,
  }));
  for (const log of allLogs.slice(count)) {
    await rcon.command(`setblock ${log.x} ${log.y} ${log.z} air`);
  }
  return allLogs.slice(0, count);
}

async function configureBuildingFixture(
  rcon: LocalRcon,
  botName: string,
  origin: Position,
): Promise<BlockRegion> {
  const center = fixturePoint(origin, 0, 0);
  await rcon.command(
    `fill ${center.x - 2} 64 ${center.z + 3} ${center.x + 2} 66 ${center.z + 7} oak_planks hollow`,
  );
  await rcon.command(`setblock ${center.x} 66 ${center.z + 5} air`);
  await rcon.command(
    `item replace entity ${botName} hotbar.0 with oak_planks 16`,
  );
  return regionAround(origin);
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
  await rcon.command(
    `clone ${region.minX} ${region.minY} ${region.minZ} ${region.maxX} ${region.maxY} ${region.maxZ} ${REGION_BASELINE.x} ${REGION_BASELINE.y} ${REGION_BASELINE.z} force`,
  );
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
  await rcon.command("scoreboard players set #diff ai_e2e 0");
  await rcon.command(
    `execute unless blocks ${region.minX} ${region.minY} ${region.minZ} ${region.maxX} ${region.maxY} ${region.maxZ} ${REGION_BASELINE.x} ${REGION_BASELINE.y} ${REGION_BASELINE.z} all run scoreboard players set #diff ai_e2e 1`,
  );
  const value = await rcon.command("scoreboard players get #diff ai_e2e");
  return /has 1\b/u.test(value);
}

async function isBlock(
  rcon: LocalRcon,
  position: Position,
  block: string,
): Promise<boolean> {
  await rcon.command("scoreboard players set #probe ai_e2e 0");
  await rcon.command(
    `execute if block ${position.x} ${position.y} ${position.z} minecraft:${block} run scoreboard players set #probe ai_e2e 1`,
  );
  return /has 1\b/u.test(
    await rcon.command("scoreboard players get #probe ai_e2e"),
  );
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
}

interface SuccessfulDerivedSkillRow {
  readonly skill_id: string;
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
      .prepare("SELECT skill_id, version FROM mc_bot_skill_revisions")
      .all() as SkillRevisionRow[];
    const revisionVersionsBySkill = new Map<string, Set<number>>();
    for (const revision of revisions) {
      const versions =
        revisionVersionsBySkill.get(revision.skill_id) ?? new Set<number>();
      versions.add(revision.version);
      revisionVersionsBySkill.set(revision.skill_id, versions);
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
    const successfulDerivedSkills = database
      .prepare(
        "SELECT DISTINCT derived.skill_id FROM mc_bot_skill_derived_hypotheses AS derived INNER JOIN mc_bot_skill_evidence_receipts AS receipt ON receipt.receipt_id = derived.receipt_id WHERE receipt.observed_outcome = 'successful'",
      )
      .all() as SuccessfulDerivedSkillRow[];
    return {
      skillIds: new Set(skills.map((skill) => skill.id)),
      skillCount: skills.length,
      revisionCount: count("mc_bot_skill_revisions"),
      evidenceReceiptCount: count("mc_bot_skill_evidence_receipts"),
      successfulDerivedSkillIds: new Set(
        successfulDerivedSkills.map((row) => row.skill_id),
      ),
      revisionVersionsBySkill,
      learnedBodiesUnderLimit: skills.every(
        (skill) => Buffer.byteLength(skill.body, "utf8") <= 8_192,
      ),
      importReceiptCount: count("mc_bot_skill_import_receipts"),
    };
  } finally {
    database.close();
  }
}

function readDbContains(databasePath: string, syntheticFact: string): boolean {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000,
  });
  try {
    const row = database
      .prepare(
        "SELECT COUNT(*) AS count FROM player_runtime_state WHERE payload_json LIKE ?",
      )
      .get(`%${syntheticFact}%`) as { readonly count: number };
    return row.count > 0;
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

function appendSyntheticSkillEdit(markdown: string): string {
  const separator = "\n\n## 本文\n";
  if (
    !markdown.includes("```mc-bot-skill\n") ||
    !markdown.includes(separator)
  ) {
    incomplete("EXPORTED_SKILL_MARKDOWN_INVALID");
  }
  return `${markdown.trimEnd()}\n\nSynthetic acceptance note: apply only when the marked fixture is reachable.\n`;
}

async function cleanup(state: RunState): Promise<void> {
  try {
    await boundedShutdown(appForCleanup, "ai_player_e2e_finished");
  } catch {
    markCleanupFailure(state, "APPLICATION_SHUTDOWN_FAILED");
  }
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
    model: MODEL,
    minecraftVersion: SERVER_VERSION,
    world: {
      fresh: true,
      seed: state.seed,
      seedIsSynthetic: true,
      fixture: state.worldFixture,
      nonOperatorClients: 3,
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

void main().catch(() => {
  process.stderr.write("INCOMPLETE AI_PLAYER_E2E_UNEXPECTED_FAILURE\n");
  process.exitCode = 1;
});
