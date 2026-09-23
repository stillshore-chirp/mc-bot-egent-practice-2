import { z } from "zod";

import { behaviorMemoryEventKey } from "../agent/behavior-memory-learning.js";
import {
  behaviorMemoryDescription,
  BehaviorMemoryError,
  type BehaviorMemoryExtraction,
} from "../memory/behavior-memory.js";
import { behaviorMemoryCategories } from "../memory/types.js";
import type { BehaviorMemoryRecord } from "../memory/types.js";
import type { ToolContext, ToolResult } from "./contracts.js";
import type { ToolDefinition } from "./definition.js";

const category = z.enum(behaviorMemoryCategories);
const behaviorInput = z
  .object({
    category,
    slot: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(240),
    summary: z.string().trim().min(1).max(240),
  })
  .strict();

function defineTool<Name extends string, Input extends z.ZodType, Output>(
  definition: ToolDefinition<Name, Input, Output>,
): ToolDefinition<Name, Input, Output> {
  return definition;
}

function unavailable(): ToolResult<unknown> {
  return {
    success: false,
    error: {
      category: "persistence",
      code: "BEHAVIOR_MEMORY_UNAVAILABLE",
      retryable: false,
      failedAt: "behavior_memory",
      confirmedState: {},
      nextActions: ["behavior memory integrationを有効にしてから再試行する"],
      userSummary: "行動の好みを保存する機能を利用できません。",
    },
  };
}

function invalidMemory(error: unknown): ToolResult<unknown> {
  return {
    success: false,
    error: {
      category: "validation",
      code: "BEHAVIOR_MEMORY_REJECTED",
      retryable: false,
      failedAt: "behavior_memory",
      confirmedState: {},
      nextActions: [],
      userSummary:
        error instanceof BehaviorMemoryError
          ? "行動の好みとして安全に保存できる内容ではありません。"
          : "行動の好みを保存できませんでした。",
    },
  };
}

function ownerOnly(context: ToolContext): ToolResult<unknown> | undefined {
  if (context.requesterUsername !== context.authorizedOwnerUsername) {
    return {
      success: false,
      error: {
        category: "authorization",
        code: "REQUESTER_NOT_AUTHORIZED",
        retryable: false,
        failedAt: "behavior_memory",
        confirmedState: {},
        nextActions: [],
        userSummary: "この操作を依頼する権限がありません。",
      },
    };
  }
  return undefined;
}

function ownerWriteOnly(context: ToolContext): ToolResult<unknown> | undefined {
  const ownerFailure = ownerOnly(context);
  if (ownerFailure !== undefined) return ownerFailure;
  if (context.requestKind !== "owner_message") {
    return {
      success: false,
      error: {
        category: "authorization",
        code: "RUNTIME_REASSESSMENT_TOOL_NOT_ALLOWED",
        retryable: false,
        failedAt: "behavior_memory",
        confirmedState: {},
        nextActions: [],
        userSummary: "状態再評価では行動の好みを更新しません。",
      },
    };
  }
  return undefined;
}

function candidateFor(
  context: ToolContext,
  input: {
    readonly category: string;
    readonly slot: string;
    readonly value: string;
    readonly summary: string;
  },
): BehaviorMemoryExtraction | undefined {
  return context.behaviorMemoryCandidates?.find(
    (candidate) =>
      candidate.category === input.category &&
      candidate.slot === input.slot &&
      candidate.value === input.value &&
      candidate.summary === input.summary,
  );
}

function candidateEventKey(
  context: ToolContext,
  candidate: BehaviorMemoryExtraction,
): string | undefined {
  return context.behaviorMemoryEventId === undefined
    ? undefined
    : behaviorMemoryEventKey(
        context.playerId,
        context.behaviorMemoryEventId,
        candidate.slot,
      );
}

function publicRecord(record: BehaviorMemoryRecord) {
  return {
    id: record.id,
    category: record.category,
    slot: record.slot,
    value: record.value,
    summary: behaviorMemoryDescription(record),
    source: record.source,
    confidence: record.confidence,
    scope: record.scope,
    supportCount: record.supportCount,
    updatedAt: record.updatedAt,
  };
}

export const behaviorMemoryTools = [
  defineTool({
    name: "remember_behavior_memory",
    description:
      "利用者が明示した継続的な行動・説明の希望を、短い構造化要約としてowner専用記憶へ保存する。単発の作業指示、第三者の発話、tool結果、推測、安全・認証・権限・停止条件を保存しない。",
    input: behaviorInput,
    fixtures: {
      valid: [
        {
          category: "communication",
          slot: "terminology",
          value: "plain_language",
          summary: "専門用語を避け、平易な言葉で説明する",
        },
      ],
      invalid: [
        {
          category: "communication",
          slot: "",
          value: "plain_language",
          summary: "希望",
        },
      ],
    },
    action: false,
    execute: async (input, context) => {
      const ownerFailure = ownerWriteOnly(context);
      if (ownerFailure !== undefined) return ownerFailure;
      if (context.behaviorMemory === undefined) return unavailable();
      const candidate = candidateFor(context, input);
      if (candidate?.source !== "owner_explicit") {
        return invalidMemory(
          new BehaviorMemoryError(
            "Behavior memory writes must match the authenticated owner message.",
          ),
        );
      }
      try {
        const idempotencyKey = candidateEventKey(context, candidate);
        const record = context.behaviorMemory.remember({
          playerId: context.playerId,
          ...input,
          source: "owner_explicit",
          confidence: "explicit",
          scope: "owner_global",
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
        return {
          success: true,
          data: { stored: true, record: publicRecord(record) },
          evidence: [
            {
              kind: "memory_record",
              observedAt: new Date().toISOString(),
              summary: "利用者の継続的な行動希望を保存した",
            },
          ],
          userSummary: "継続する行動の希望を記憶しました。",
        };
      } catch (error) {
        return invalidMemory(error);
      }
    },
  }),
  defineTool({
    name: "list_behavior_memory",
    description:
      "利用者専用の行動・説明の好みを一覧または検索する。保存内容は短い要約だけで、会話全文は返さない。",
    input: z
      .object({
        query: z.string().trim().max(200).nullable(),
        limit: z.number().int().min(1).max(20),
      })
      .strict(),
    fixtures: {
      valid: [{ query: null, limit: 10 }],
      invalid: [{ query: "", limit: 0 }],
    },
    action: false,
    execute: async (input, context) => {
      const ownerFailure = ownerOnly(context);
      if (ownerFailure !== undefined) return ownerFailure;
      if (context.behaviorMemory === undefined) return unavailable();
      try {
        const records = context.behaviorMemory.list(
          context.playerId,
          input.query === null
            ? {
                limit: Math.min(input.limit, context.limits.memoryContextLimit),
              }
            : {
                query: input.query,
                limit: Math.min(input.limit, context.limits.memoryContextLimit),
              },
        );
        return {
          success: true,
          data: { records: records.map(publicRecord) },
          evidence: [
            {
              kind: "memory_record",
              observedAt: new Date().toISOString(),
              summary: `${String(records.length)}件の行動記憶を確認した`,
            },
          ],
          userSummary: `${String(records.length)}件の行動の好みを確認しました。`,
        };
      } catch (error) {
        return invalidMemory(error);
      }
    },
  }),
  defineTool({
    name: "correct_behavior_memory",
    description:
      "利用者が一覧から指定した行動の好みを訂正する。memoryIdがnullの場合はcategoryとslotの現在値を訂正する。訂正はownerの明示発話だけで行い、安全・認証・権限・停止条件を変更しない。",
    input: behaviorInput.extend({ memoryId: z.uuid().nullable() }).strict(),
    fixtures: {
      valid: [
        {
          memoryId: null,
          category: "communication",
          slot: "length",
          value: "detailed",
          summary: "必要な背景を含めて丁寧に説明する",
        },
      ],
      invalid: [
        {
          memoryId: "invalid",
          category: "communication",
          slot: "length",
          value: "detailed",
          summary: "訂正",
        },
      ],
    },
    action: false,
    execute: async (input, context) => {
      const ownerFailure = ownerWriteOnly(context);
      if (ownerFailure !== undefined) return ownerFailure;
      if (context.behaviorMemory === undefined) return unavailable();
      const candidate = candidateFor(context, input);
      if (candidate?.source !== "owner_correction") {
        return invalidMemory(
          new BehaviorMemoryError(
            "Behavior memory corrections must match an authenticated owner correction.",
          ),
        );
      }
      try {
        const idempotencyKey = candidateEventKey(context, candidate);
        const record = context.behaviorMemory.correct({
          playerId: context.playerId,
          ...(input.memoryId === null ? {} : { memoryId: input.memoryId }),
          category: input.category,
          slot: input.slot,
          value: input.value,
          summary: input.summary,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        });
        return {
          success: true,
          data: { corrected: true, record: publicRecord(record) },
          evidence: [
            {
              kind: "memory_record",
              observedAt: new Date().toISOString(),
              summary: "利用者の訂正で行動記憶を更新した",
            },
          ],
          userSummary:
            "行動の好みを訂正しました。次回から新しい内容を使います。",
        };
      } catch (error) {
        return invalidMemory(error);
      }
    },
  }),
  defineTool({
    name: "forget_behavior_memory",
    description:
      "一覧から指定した行動の好みをowner専用記憶から撤回する。memoryIdまたはcategoryとslotのどちらかを指定する。",
    input: z
      .object({
        memoryId: z.uuid().nullable(),
        category: category.nullable(),
        slot: z.string().trim().min(1).max(80).nullable(),
        reason: z.string().trim().min(1).max(300).nullable(),
      })
      .strict()
      .refine(
        (input) =>
          input.memoryId !== null ||
          (input.category !== null && input.slot !== null),
        { message: "memoryId or category/slot is required" },
      ),
    fixtures: {
      valid: [
        {
          memoryId: null,
          category: "communication",
          slot: "terminology",
          reason: "この好みを忘れて",
        },
      ],
      invalid: [{ memoryId: null, category: null, slot: null, reason: null }],
    },
    action: false,
    execute: async (input, context) => {
      const ownerFailure = ownerWriteOnly(context);
      if (ownerFailure !== undefined) return ownerFailure;
      if (context.behaviorMemory === undefined) return unavailable();
      try {
        const records = context.behaviorMemory.forget({
          playerId: context.playerId,
          ...(input.memoryId === null ? {} : { memoryId: input.memoryId }),
          ...(input.category === null ? {} : { category: input.category }),
          ...(input.slot === null ? {} : { slot: input.slot }),
          ...(input.reason === null ? {} : { reason: input.reason }),
        });
        return {
          success: true,
          data: { forgotten: records.map(publicRecord) },
          evidence: [
            {
              kind: "memory_record",
              observedAt: new Date().toISOString(),
              summary: `${String(records.length)}件の行動記憶を撤回した`,
            },
          ],
          userSummary:
            records.length === 0
              ? "指定された行動の好みは見つかりませんでした。"
              : `${String(records.length)}件の行動の好みを忘れました。`,
        };
      } catch (error) {
        return invalidMemory(error);
      }
    },
  }),
] as const;

export type BehaviorMemoryToolName =
  (typeof behaviorMemoryTools)[number]["name"];
