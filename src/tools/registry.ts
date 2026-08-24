import { z } from "zod";

import {
  actionReportResult,
  type EvidenceReference,
  type ToolResult,
} from "./contracts.js";
import type { ToolDefinition } from "./definition.js";

const noInput = z.object({}).strict();
const resourceNames = [
  "oak_log",
  "spruce_log",
  "birch_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "pale_oak_log",
  "crimson_stem",
  "warped_stem",
] as const;

const memoryKinds = ["fact", "location", "commitment", "episode"] as const;

function nowEvidence(
  kind: EvidenceReference["kind"],
  summary: string,
): EvidenceReference[] {
  return [{ kind, observedAt: new Date().toISOString(), summary }];
}

function defineTool<Name extends string, Input extends z.ZodType, Output>(
  definition: ToolDefinition<Name, Input, Output>,
): ToolDefinition<Name, Input, Output> {
  return definition;
}

export const toolDefinitions = [
  defineTool({
    name: "observe_status",
    description:
      "Minecraftで現在観測できる体力、空腹、位置、所持品、作業状態を返す。",
    input: noInput,
    fixtures: { valid: [{}], invalid: [{ unexpected: true }] },
    action: false,
    execute: async (_input, context) => {
      const status = await context.game.observeStatus();
      return {
        success: true,
        data: status,
        evidence: nowEvidence("minecraft_snapshot", "現在状態を観測した"),
        userSummary: "現在のMinecraft状態を確認しました。",
      };
    },
  }),
  defineTool({
    name: "observe_surroundings",
    description: "指定半径内で実際に観測できるblock、entity、危険を返す。",
    input: z
      .object({
        radius: z.number().int().min(1).max(32),
        includeEntities: z.boolean(),
      })
      .strict(),
    fixtures: {
      valid: [{ radius: 8, includeEntities: true }],
      invalid: [{ radius: 100, includeEntities: false }],
    },
    action: false,
    execute: async (input, context) => {
      const surroundings = await context.game.observeSurroundings(
        input.radius,
        input.includeEntities,
      );
      return {
        success: true,
        data: surroundings,
        evidence: nowEvidence("minecraft_snapshot", "周囲を観測した"),
        userSummary: "周囲のMinecraft状態を確認しました。",
      };
    },
  }),
  defineTool({
    name: "say",
    description: "指定利用者へMinecraft chatで日本語の短いメッセージを送る。",
    input: z.object({ message: z.string().trim().min(1).max(240) }).strict(),
    fixtures: {
      valid: [{ message: "分かりました。" }],
      invalid: [{ message: "" }],
    },
    action: false,
    execute: async (input, context) => {
      await context.game.say(input.message);
      return {
        success: true,
        data: { delivered: true },
        evidence: [],
        userSummary: "メッセージを送信しました。",
      };
    },
  }),
  defineTool({
    name: "follow_player",
    description: "認可済み利用者を安全な距離で、指定時間を上限に追従する。",
    input: z
      .object({
        safeDistance: z.number().min(2).max(16),
        maxDurationSeconds: z.number().int().min(1).max(900),
      })
      .strict(),
    fixtures: {
      valid: [{ safeDistance: 3, maxDurationSeconds: 60 }],
      invalid: [{ safeDistance: 0, maxDurationSeconds: 60 }],
    },
    action: true,
    execute: async (input, context) => {
      if (input.safeDistance < context.limits.followDistance) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "FOLLOW_DISTANCE_BELOW_CONFIGURED_MINIMUM",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              requested: input.safeDistance,
              minimum: context.limits.followDistance,
            },
            nextActions: ["設定された安全距離以上を指定する"],
            userSummary:
              "設定された安全距離より近いため追従を開始しませんでした。",
          },
        };
      }
      return actionReportResult(
        await context.game.followOwner(
          input.safeDistance,
          input.maxDurationSeconds,
          context.signal,
        ),
      );
    },
  }),
  defineTool({
    name: "stop_current_action",
    description: "現在の移動・採掘・長時間作業を直ちに中断する。",
    input: z.object({ reason: z.string().trim().min(1).max(160) }).strict(),
    fixtures: {
      valid: [{ reason: "利用者の停止指示" }],
      invalid: [{ reason: "" }],
    },
    action: true,
    execute: async (input, context) =>
      actionReportResult(await context.game.stopCurrentAction(input.reason)),
  }),
  defineTool({
    name: "move_to",
    description:
      "現在dimension内の上限距離内にある座標へ移動し、前後状態で到達を判定する。",
    input: z
      .object({
        x: z.number(),
        y: z.number(),
        z: z.number(),
        radius: z.number().min(1).max(8),
      })
      .strict(),
    fixtures: {
      valid: [{ x: 1, y: 64, z: 1, radius: 2 }],
      invalid: [{ x: 1, y: 64, z: 1, radius: 0 }],
    },
    action: true,
    execute: async (input, context) => {
      const current = await context.game.currentPosition();
      const distance = Math.hypot(
        input.x - current.x,
        input.y - current.y,
        input.z - current.z,
      );
      if (distance > context.limits.maxMoveDistance) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "MOVE_DISTANCE_EXCEEDED",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              distance,
              maximum: context.limits.maxMoveDistance,
            },
            nextActions: ["より近い目的地を指定する"],
            userSummary: "許可された移動距離を超えるため移動しませんでした。",
          },
        };
      }
      return actionReportResult(
        await context.game.moveTo(
          { x: input.x, y: input.y, z: input.z },
          input.radius,
          context.signal,
        ),
      );
    },
  }),
  defineTool({
    name: "gather_resource",
    description:
      "指定した原木を探索・採取・回収し、所持品差分を確認して利用者へ戻る。",
    input: z
      .object({
        resource: z.enum(resourceNames),
        count: z.number().int().min(1).max(64),
      })
      .strict(),
    fixtures: {
      valid: [{ resource: "oak_log", count: 4 }],
      invalid: [{ resource: "stone", count: 4 }],
    },
    action: true,
    execute: async (input, context) => {
      if (input.count > context.limits.maxGatherCount) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "GATHER_COUNT_EXCEEDED",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              requested: input.count,
              maximum: context.limits.maxGatherCount,
            },
            nextActions: ["数量を減らして依頼する"],
            userSummary: "許可された採取数を超えるため開始しませんでした。",
          },
        };
      }
      return actionReportResult(
        await context.game.gatherResource(
          input.resource,
          input.count,
          context.signal,
        ),
      );
    },
  }),
  defineTool({
    name: "return_to_player",
    description: "認可済み利用者の現在位置を再観測して安全な距離まで戻る。",
    input: z.object({ safeDistance: z.number().min(2).max(16) }).strict(),
    fixtures: { valid: [{ safeDistance: 3 }], invalid: [{ safeDistance: 0 }] },
    action: true,
    execute: async (input, context) => {
      if (input.safeDistance < context.limits.followDistance) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "RETURN_DISTANCE_BELOW_CONFIGURED_MINIMUM",
            retryable: false,
            failedAt: "precondition",
            confirmedState: {
              requested: input.safeDistance,
              minimum: context.limits.followDistance,
            },
            nextActions: ["設定された安全距離以上を指定する"],
            userSummary:
              "設定された安全距離より近いため帰還を開始しませんでした。",
          },
        };
      }
      return actionReportResult(
        await context.game.returnToOwner(input.safeDistance, context.signal),
      );
    },
  }),
  defineTool({
    name: "remember_player_fact",
    description: "利用者が明示した事実を、推論と区別して構造化記憶へ保存する。",
    input: z
      .object({
        subject: z.string().trim().min(1).max(80),
        predicate: z.string().trim().min(1).max(80),
        value: z.string().trim().min(1).max(500),
      })
      .strict(),
    fixtures: {
      valid: [{ subject: "利用者", predicate: "好きな木", value: "桜" }],
      invalid: [{ subject: "", predicate: "好きな木", value: "桜" }],
    },
    action: false,
    execute: async (input, context) => {
      const record = context.memory.rememberPlayerFact({
        playerId: context.playerId,
        ...input,
        source: "player_stated",
      });
      return {
        success: true,
        data: { stored: true, record },
        evidence: nowEvidence(
          "memory_record",
          "利用者が明示した事実を保存した",
        ),
        userSummary: "教えてもらった事実を記憶しました。",
      };
    },
  }),
  defineTool({
    name: "remember_location",
    description: "現在観測している場所へ名前と用途を付けて記憶する。",
    input: z
      .object({
        name: z.string().trim().min(1).max(100),
        purpose: z.string().trim().min(1).max(300),
      })
      .strict(),
    fixtures: {
      valid: [{ name: "拠点", purpose: "帰還場所" }],
      invalid: [{ name: "", purpose: "帰還場所" }],
    },
    action: false,
    execute: async (input, context) => {
      const position = await context.game.currentPosition();
      const record = context.memory.rememberLocation({
        playerId: context.playerId,
        ...input,
        ...position,
      });
      return {
        success: true,
        data: { stored: true, record },
        evidence: nowEvidence(
          "memory_record",
          "現在地をMinecraft観測とともに保存した",
        ),
        userSummary: `${input.name}を場所として記憶しました。`,
      };
    },
  }),
  defineTool({
    name: "recall_memory",
    description: "現在の会話・作業に関連する構造化記憶だけを検索する。",
    input: z
      .object({
        query: z.string().trim().min(1).max(200),
        kinds: z.array(z.enum(memoryKinds)).min(1).max(memoryKinds.length),
        limit: z.number().int().min(1).max(20),
      })
      .strict(),
    fixtures: {
      valid: [{ query: "拠点", kinds: ["location"], limit: 5 }],
      invalid: [{ query: "", kinds: [], limit: 5 }],
    },
    action: false,
    execute: async (input, context) => {
      const limit = Math.min(input.limit, context.limits.memoryContextLimit);
      const records = context.memory.recall({
        playerId: context.playerId,
        query: input.query,
        kinds: input.kinds,
        limit,
      });
      return {
        success: true,
        data: { records },
        evidence: nowEvidence(
          "memory_record",
          `${String(records.length)}件の関連記憶を取得した`,
        ),
        userSummary: `${String(records.length)}件の関連記憶を確認しました。`,
      };
    },
  }),
  defineTool({
    name: "set_commitment",
    description: "利用者との約束を未完了状態で保存する。",
    input: z
      .object({ description: z.string().trim().min(1).max(500) })
      .strict(),
    fixtures: {
      valid: [{ description: "原木を集める" }],
      invalid: [{ description: "" }],
    },
    action: false,
    execute: async (input, context) => {
      const commitment = context.memory.setCommitment({
        playerId: context.playerId,
        description: input.description,
      });
      return {
        success: true,
        data: commitment,
        evidence: nowEvidence("memory_record", "未完了の約束を保存した"),
        userSummary: "約束として記憶しました。",
      };
    },
  }),
  defineTool({
    name: "complete_commitment",
    description: "観測結果または利用者の確認に基づき、既存の約束を完了にする。",
    input: z
      .object({
        commitmentId: z.string().trim().min(1).max(100),
        outcome: z.string().trim().min(1).max(500),
        basis: z.enum(["owner_confirmation", "verified_tool_result"]),
        evidenceSummary: z.string().trim().min(1).max(500),
      })
      .strict(),
    fixtures: {
      valid: [
        {
          commitmentId: "commitment-id",
          outcome: "観測済みの結果",
          basis: "owner_confirmation",
          evidenceSummary: "指定利用者が現在の発話で完了を確認した",
        },
      ],
      invalid: [
        {
          commitmentId: "",
          outcome: "結果",
          basis: "owner_confirmation",
          evidenceSummary: "確認済み",
        },
      ],
    },
    action: false,
    execute: async (input, context) => {
      if (
        input.basis === "verified_tool_result" &&
        !context.executionEvidence.verifiedActionSuccess
      ) {
        return {
          success: false,
          error: {
            category: "validation",
            code: "COMMITMENT_VERIFIED_ACTION_MISSING",
            retryable: false,
            failedAt: "complete_commitment",
            confirmedState: { verifiedActionSuccess: false },
            nextActions: ["観測で成功した行動後に完了を記録する"],
            userSummary:
              "確認済みのMinecraft行動結果がないため、約束を完了にしませんでした。",
          },
        };
      }
      const commitment = context.memory.completeCommitment({
        playerId: context.playerId,
        commitmentId: input.commitmentId,
        outcome: input.outcome,
        verificationSource: input.basis,
        verificationEvidence: input.evidenceSummary,
      });
      return {
        success: true,
        data: commitment,
        evidence: nowEvidence("memory_record", "約束を完了状態へ更新した"),
        userSummary: "約束の完了を記録しました。",
      };
    },
  }),
] as const;

export type RegisteredToolName = (typeof toolDefinitions)[number]["name"];

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return toolDefinitions.find((definition) => definition.name === name);
}

export function isToolResult(value: unknown): value is ToolResult<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    typeof value.success === "boolean"
  );
}
