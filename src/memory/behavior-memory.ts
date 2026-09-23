import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  behaviorMemoryCategories,
  behaviorMemoryConfidences,
  behaviorMemoryScopes,
  behaviorMemorySources,
  behaviorMemoryStatuses,
} from "./types.js";
import type {
  BehaviorMemoryCategory,
  BehaviorMemoryConfidence,
  BehaviorMemoryRecord,
  BehaviorMemoryScope,
  BehaviorMemorySource,
  BehaviorMemoryStatus,
  ForgetBehaviorMemoryInput,
  RememberBehaviorMemoryInput,
} from "./types.js";

const MAX_SLOT_LENGTH = 80;
const MAX_VALUE_LENGTH = 240;
const MAX_SUMMARY_LENGTH = 240;
const MAX_RETRACTION_REASON_LENGTH = 300;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_LIST_LIMIT = 30;
const DEFAULT_LIST_LIMIT = 12;

const secretLabel =
  /(?:^|[\s_:=,-])(api[\s_-]?key|authorization|bearer|password|private[\s_-]?key|secret|token)(?:$|[\s_:=,-])/iu;
const secretValue =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u;
const sensitivePersonalData =
  /(?:住所|電話番号|メールアドレス|本名|生年月日|マイナンバー|パスワード|\b\d{3}[- ]?\d{4}[- ]?\d{4}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b)/iu;
const untrustedAttribution =
  /[「」『』“”"'`]|(?:他人|第三者|別の人|他のプレイヤー|別のプレイヤー|看板|本|書物|ログ|ツール結果|tool結果|引用|引用文|システムメッセージ|と言った|と言っていた|と書いてある|と書かれている|が言った|が書いた)/iu;
const protectedOverride =
  /(?:安全|保護|認証|権限|停止|危険|確認).{0,24}(?:無視|解除|無効|省略|回避|迂回|しなくて(?:いい|よい)|守らなくて(?:いい|よい)|なくて(?:いい|よい)|(?:無|な)しで|(?:無|な)しに|不要|いらない|要らない|必要ない)|(?:無視|解除|無効|省略|回避|迂回|しなくて(?:いい|よい)|守らなくて(?:いい|よい)|なくて(?:いい|よい)|(?:無|な)しで|(?:無|な)しに|不要|いらない|要らない|必要ない).{0,24}(?:安全|保護|認証|権限|停止|危険|確認)/iu;

export const behaviorMemoryMigration = [
  "CREATE TABLE behavior_memories (id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE, category TEXT NOT NULL CHECK (category IN ('communication', 'autonomy', 'workflow', 'planning', 'feedback', 'general')), slot TEXT NOT NULL, value TEXT NOT NULL, summary TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('owner_explicit', 'owner_correction', 'owner_feedback')), confidence TEXT NOT NULL CHECK (confidence IN ('explicit', 'corrected', 'repeated_feedback', 'corroborated')), scope TEXT NOT NULL CHECK (scope IN ('owner_global')), support_count INTEGER NOT NULL DEFAULT 1 CHECK (support_count BETWEEN 1 AND 20), status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'retracted')), superseded_by_id TEXT, retraction_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX behavior_memories_player_updated_idx ON behavior_memories(player_id, status, updated_at DESC)",
  "CREATE UNIQUE INDEX behavior_memories_active_slot_idx ON behavior_memories(player_id, category, slot) WHERE status = 'active'",
].join(";\n");

/** Stores only an opaque accepted-message key and its resulting record id. */
export const behaviorMemoryEventMigration = [
  "CREATE TABLE behavior_memory_events (player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL, memory_id TEXT NOT NULL REFERENCES behavior_memories(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (player_id, idempotency_key))",
  "CREATE INDEX behavior_memory_events_memory_idx ON behavior_memory_events(memory_id)",
].join(";\n");

interface BehaviorMemoryRow {
  readonly id: string;
  readonly player_id: string;
  readonly category: string;
  readonly slot: string;
  readonly value: string;
  readonly summary: string;
  readonly source: string;
  readonly confidence: string;
  readonly scope: string;
  readonly support_count: number;
  readonly status: string;
  readonly superseded_by_id: string | null;
  readonly retraction_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface BehaviorMemoryEventRow {
  readonly memory_id: string;
}

export interface BehaviorMemoryExtraction {
  readonly category: BehaviorMemoryCategory;
  readonly slot: string;
  readonly value: string;
  readonly summary: string;
  readonly source: BehaviorMemorySource;
  readonly confidence: BehaviorMemoryConfidence;
  readonly scope: BehaviorMemoryScope;
  readonly reason:
    "explicit_preference" | "owner_correction" | "repeated_feedback";
}

export interface BehaviorMemoryCommand {
  readonly kind: "list" | "forget";
  readonly category?: BehaviorMemoryCategory;
  readonly slot?: string;
}

/**
 * Durable behavior memory is an adapter over the MemoryStore connection.  It
 * stores only typed owner summaries; there is intentionally no transcript
 * column or API that accepts a conversation history.
 */
export class BehaviorMemoryRepository {
  public constructor(private readonly database: Database.Database) {}

  public remember(input: RememberBehaviorMemoryInput): BehaviorMemoryRecord {
    const normalized = normalizeInput(input);
    this.requirePlayer(normalized.playerId);
    const now = timestamp();

    return this.database.transaction(() => {
      const previous =
        normalized.idempotencyKey === undefined
          ? undefined
          : this.findEvent(normalized.playerId, normalized.idempotencyKey);
      if (previous !== undefined) return previous;

      const active = this.findActive(
        normalized.playerId,
        normalized.category,
        normalized.slot,
      );
      const superseded = this.resolveSuperseded(
        normalized.playerId,
        normalized.supersedesId,
        active,
      );
      let record: BehaviorMemoryRecord;
      if (
        active?.value === normalized.value &&
        active.summary === normalized.summary
      ) {
        if (superseded !== undefined && superseded.id !== active.id) {
          this.database
            .prepare<[string, string, string]>(
              "UPDATE behavior_memories SET status = 'superseded', superseded_by_id = ?, updated_at = ? WHERE id = ? AND status = 'active'",
            )
            .run(active.id, now, superseded.id);
        }
        if (
          normalized.source === "owner_feedback" &&
          active.source !== "owner_feedback"
        ) {
          record = behaviorMemory(active);
        } else {
          const supportCount =
            normalized.source === "owner_feedback"
              ? Math.min(20, active.support_count + 1)
              : Math.max(active.support_count, normalized.supportCount);
          const confidence =
            normalized.source === "owner_feedback"
              ? supportCount >= 2
                ? "corroborated"
                : "repeated_feedback"
              : normalized.confidence;
          this.database
            .prepare<
              [
                BehaviorMemorySource,
                BehaviorMemoryConfidence,
                number,
                string,
                string,
              ]
            >(
              "UPDATE behavior_memories SET source = ?, confidence = ?, support_count = ?, updated_at = ? WHERE id = ?",
            )
            .run(normalized.source, confidence, supportCount, now, active.id);
          record = behaviorMemory({
            ...active,
            source: normalized.source,
            confidence,
            support_count: supportCount,
            updated_at: now,
          });
        }
      } else {
        const id = randomUUID();
        if (superseded !== undefined) {
          this.database
            .prepare<[string, string, string]>(
              "UPDATE behavior_memories SET status = 'superseded', superseded_by_id = ?, updated_at = ? WHERE id = ? AND status = 'active'",
            )
            .run(id, now, superseded.id);
        }
        this.database
          .prepare<
            [
              string,
              string,
              BehaviorMemoryCategory,
              string,
              string,
              string,
              BehaviorMemorySource,
              BehaviorMemoryConfidence,
              BehaviorMemoryScope,
              number,
              string,
              string,
            ]
          >(
            "INSERT INTO behavior_memories (id, player_id, category, slot, value, summary, source, confidence, scope, support_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
          )
          .run(
            id,
            normalized.playerId,
            normalized.category,
            normalized.slot,
            normalized.value,
            normalized.summary,
            normalized.source,
            normalized.confidence,
            normalized.scope,
            normalized.supportCount,
            now,
            now,
          );
        record = behaviorMemory({
          id,
          player_id: normalized.playerId,
          category: normalized.category,
          slot: normalized.slot,
          value: normalized.value,
          summary: normalized.summary,
          source: normalized.source,
          confidence: normalized.confidence,
          scope: normalized.scope,
          support_count: normalized.supportCount,
          status: "active",
          superseded_by_id: null,
          retraction_reason: null,
          created_at: now,
          updated_at: now,
        });
      }
      if (normalized.idempotencyKey !== undefined) {
        this.recordEvent(
          normalized.playerId,
          normalized.idempotencyKey,
          record.id,
          now,
        );
      }
      return record;
    })();
  }

  public correct(input: {
    readonly playerId: string;
    readonly memoryId?: string;
    readonly category: BehaviorMemoryCategory;
    readonly slot: string;
    readonly value: string;
    readonly summary: string;
    readonly idempotencyKey?: string;
  }): BehaviorMemoryRecord {
    const memoryId =
      input.memoryId === undefined && input.slot.startsWith("owner_preference_")
        ? this.resolveImplicitCorrection(input.playerId)
        : input.memoryId;
    return this.remember({
      playerId: input.playerId,
      category: input.category,
      slot: input.slot,
      value: input.value,
      summary: input.summary,
      source: "owner_correction",
      confidence: "corrected",
      scope: "owner_global",
      ...(memoryId === undefined ? {} : { supersedesId: memoryId }),
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
    });
  }

  public list(
    playerId: string,
    input: { readonly limit?: number; readonly query?: string } = {},
  ): BehaviorMemoryRecord[] {
    this.requirePlayer(playerId);
    const limit = listLimit(input.limit);
    const query = cleanQuery(input.query);
    const rows = this.database
      .prepare<[string], BehaviorMemoryRow>(
        "SELECT id, player_id, category, slot, value, summary, source, confidence, scope, support_count, status, superseded_by_id, retraction_reason, created_at, updated_at FROM behavior_memories WHERE player_id = ? AND status = 'active' ORDER BY updated_at DESC",
      )
      .all(playerId);
    return rows
      .filter((row) => {
        if (query.length === 0) return true;
        return [row.category, row.slot, row.value, row.summary].some((part) =>
          part.toLocaleLowerCase().includes(query),
        );
      })
      .slice(0, limit)
      .map(behaviorMemory);
  }

  public forget(input: ForgetBehaviorMemoryInput): BehaviorMemoryRecord[] {
    this.requirePlayer(input.playerId);
    const reason = cleanText(
      input.reason ?? "owner requested forgetting this preference",
      "behavior memory retraction reason",
      MAX_RETRACTION_REASON_LENGTH,
    );
    if (
      input.memoryId === undefined &&
      input.category === undefined &&
      input.slot === undefined
    ) {
      throw new BehaviorMemoryError(
        "A behavior memory id or category/slot selector is required.",
      );
    }
    const rows =
      input.memoryId === undefined
        ? this.database
            .prepare<
              [
                string,
                BehaviorMemoryCategory | null,
                BehaviorMemoryCategory | null,
                string | null,
                string | null,
              ],
              BehaviorMemoryRow
            >(
              "SELECT id, player_id, category, slot, value, summary, source, confidence, scope, support_count, status, superseded_by_id, retraction_reason, created_at, updated_at FROM behavior_memories WHERE player_id = ? AND status = 'active' AND (? IS NULL OR category = ?) AND (? IS NULL OR slot = ?)",
            )
            .all(
              input.playerId,
              input.category ?? null,
              input.category ?? null,
              input.slot ?? null,
              input.slot ?? null,
            )
        : this.database
            .prepare<[string, string], BehaviorMemoryRow>(
              "SELECT id, player_id, category, slot, value, summary, source, confidence, scope, support_count, status, superseded_by_id, retraction_reason, created_at, updated_at FROM behavior_memories WHERE player_id = ? AND id = ? AND status = 'active'",
            )
            .all(input.playerId, cleanId(input.memoryId));
    const now = timestamp();
    const update = this.database.prepare<[string, string, string, string]>(
      "UPDATE behavior_memories SET status = 'retracted', retraction_reason = ?, updated_at = ? WHERE id = ? AND player_id = ?",
    );
    return this.database.transaction(() => {
      for (const row of rows) {
        update.run(reason, now, row.id, input.playerId);
      }
      return rows.map((row) =>
        behaviorMemory({
          ...row,
          status: "retracted",
          retraction_reason: reason,
          updated_at: now,
        }),
      );
    })();
  }

  public isApplicable(record: BehaviorMemoryRecord): boolean {
    return (
      record.status === "active" &&
      (record.confidence !== "repeated_feedback" || record.supportCount >= 2)
    );
  }

  private findActive(
    playerId: string,
    category: BehaviorMemoryCategory,
    slot: string,
  ): BehaviorMemoryRow | undefined {
    return this.database
      .prepare<[string, BehaviorMemoryCategory, string], BehaviorMemoryRow>(
        "SELECT id, player_id, category, slot, value, summary, source, confidence, scope, support_count, status, superseded_by_id, retraction_reason, created_at, updated_at FROM behavior_memories WHERE player_id = ? AND category = ? AND slot = ? AND status = 'active'",
      )
      .get(playerId, category, slot);
  }

  private findEvent(
    playerId: string,
    idempotencyKey: string,
  ): BehaviorMemoryRecord | undefined {
    const event = this.database
      .prepare<[string, string], BehaviorMemoryEventRow>(
        "SELECT memory_id FROM behavior_memory_events WHERE player_id = ? AND idempotency_key = ?",
      )
      .get(playerId, idempotencyKey);
    if (event === undefined) return undefined;
    const row = this.database
      .prepare<[string, string], BehaviorMemoryRow>(
        "SELECT id, player_id, category, slot, value, summary, source, confidence, scope, support_count, status, superseded_by_id, retraction_reason, created_at, updated_at FROM behavior_memories WHERE player_id = ? AND id = ?",
      )
      .get(playerId, event.memory_id);
    if (row === undefined) {
      throw new BehaviorMemoryError(
        "Behavior memory event refers to a missing record.",
      );
    }
    return behaviorMemory(row);
  }

  private recordEvent(
    playerId: string,
    idempotencyKey: string,
    memoryId: string,
    createdAt: string,
  ): void {
    this.database
      .prepare<[string, string, string, string]>(
        "INSERT INTO behavior_memory_events (player_id, idempotency_key, memory_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(playerId, idempotencyKey, memoryId, createdAt);
  }

  private resolveSuperseded(
    playerId: string,
    supersedesId: string | undefined,
    active: BehaviorMemoryRow | undefined,
  ): BehaviorMemoryRow | undefined {
    if (supersedesId !== undefined) {
      const id = cleanId(supersedesId);
      const target = this.database
        .prepare<[string, string], BehaviorMemoryRow>(
          "SELECT id, player_id, category, slot, value, summary, source, confidence, scope, support_count, status, superseded_by_id, retraction_reason, created_at, updated_at FROM behavior_memories WHERE id = ? AND player_id = ?",
        )
        .get(id, playerId);
      if (target === undefined) {
        throw new BehaviorMemoryError("Unknown behavior memory id.");
      }
      if (target.status !== "active") {
        throw new BehaviorMemoryError(
          "Only an active behavior memory can be corrected.",
        );
      }
      return target;
    }
    return active;
  }

  private resolveImplicitCorrection(playerId: string): string | undefined {
    const candidates = this.database
      .prepare<[string], { readonly id: string }>(
        "SELECT id FROM behavior_memories WHERE player_id = ? AND slot LIKE 'owner_preference_%' AND status = 'active' ORDER BY updated_at DESC",
      )
      .all(playerId);
    if (candidates.length > 1) {
      throw new BehaviorMemoryError(
        "Multiple open-ended behavior memories require an explicit id for correction.",
      );
    }
    return candidates[0]?.id;
  }

  private requirePlayer(playerId: string): void {
    const id = cleanId(playerId);
    const row = this.database
      .prepare<[string], { readonly id: string }>(
        "SELECT id FROM players WHERE id = ?",
      )
      .get(id);
    if (row === undefined) {
      throw new BehaviorMemoryError("Unknown player id.");
    }
  }
}

export class BehaviorMemoryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BehaviorMemoryError";
  }
}

/**
 * Extract only stable owner feedback.  The caller must enforce owner
 * authorization before invoking this function.  A momentary command is not a
 * memory candidate, and the returned value is a short typed summary rather
 * than the original chat message.
 */
export function extractBehaviorMemory(
  message: string,
): readonly BehaviorMemoryExtraction[] {
  const normalized = normalizeMessage(message);
  if (normalized.length === 0 || normalized.length > 500) return [];
  if (
    secretLabel.test(normalized) ||
    secretValue.test(normalized) ||
    sensitivePersonalData.test(normalized)
  )
    return [];
  if (untrustedAttribution.test(normalized)) return [];
  if (protectedOverride.test(normalized)) return [];
  if (/今だけ|今回は|一旦|この作業だけ/iu.test(normalized)) return [];
  if (parseBehaviorMemoryCommand(normalized) !== undefined) return [];

  const stable =
    /覚えて(?:おいて)?|記憶して|今後|次から|これから|いつも|継続して|好み|訂正|修正|違う|前の|(?:感情|気持ち).{0,16}(?:重視|優先|大事|大切)|(?:重視|優先).{0,16}(?:感情|気持ち)/u.test(
      normalized,
    );
  const correction = /訂正|修正|違う|前の/u.test(normalized);
  if (isSafetyConcern(normalized)) return [];
  const known = knownPreferences(normalized, stable, correction);
  if (
    known.length > 0 &&
    (stable || hasFeedbackSignal(normalized) || known.length >= 2)
  ) {
    return known;
  }
  if (!stable) return [];

  const tail = stablePreferenceTail(normalized);
  if (tail.length < 3 || tail.length > 160) return [];
  if (
    secretLabel.test(tail) ||
    secretValue.test(tail) ||
    sensitivePersonalData.test(tail)
  )
    return [];
  if (protectedOverride.test(tail)) return [];

  const category = classifyCategory(tail);
  const slot = `owner_preference_${hash(tail).slice(0, 12)}`;
  const source: BehaviorMemorySource = correction
    ? "owner_correction"
    : "owner_explicit";
  return [
    {
      category,
      slot,
      value: tail,
      summary: `利用者の継続希望: ${tail}`,
      source,
      confidence: correction ? "corrected" : "explicit",
      scope: "owner_global",
      reason: correction ? "owner_correction" : "explicit_preference",
    },
  ];
}

/**
 * Match bounded canonical preferences. Repeated corrective feedback can
 * become a preference without requiring the owner to say「覚えて」. It starts
 * as low confidence and is promoted by the repository after a second matching
 * signal.
 */
function knownPreferences(
  message: string,
  stable: boolean,
  correction: boolean,
): BehaviorMemoryExtraction[] {
  const feedback = hasFeedbackSignal(message);
  const repeated = !stable && feedback;
  const reason = correction
    ? "owner_correction"
    : repeated
      ? "repeated_feedback"
      : "explicit_preference";
  const source: BehaviorMemorySource = repeated
    ? "owner_feedback"
    : correction
      ? "owner_correction"
      : "owner_explicit";
  const confidence: BehaviorMemoryConfidence = repeated
    ? "repeated_feedback"
    : correction
      ? "corrected"
      : "explicit";
  const results: BehaviorMemoryExtraction[] = [];
  const slots = new Set<string>();
  const add = (candidate: BehaviorMemoryExtraction): void => {
    if (slots.has(candidate.slot)) return;
    slots.add(candidate.slot);
    results.push(candidate);
  };

  const emotionPreference =
    /感情|気持ち|不満|苛立|いら立|失望|つら|辛い|悲し|困って|腹立|拒絶/iu.test(
      message,
    ) && /重視|優先|大事|大切|受け止|配慮|考慮|汲|寄り添/iu.test(message);
  const emotionFeedback =
    feedback &&
    /不満|苛立|いら立|失望|つら|辛い|悲し|困って|腹立|拒絶/iu.test(message) &&
    /対応|説明|返答|理由|次|行動|断る/iu.test(message);
  if (emotionPreference || emotionFeedback) {
    add(
      extraction(
        "feedback",
        "owner_emotion",
        "prioritize_owner_emotion",
        "事実整理より利用者の感情を先に受け止め、次の行動へ反映する",
        source,
        confidence,
        reason,
      ),
    );
  }

  if (/専門用語|難しい言葉|分かりにく|わかりにく|平易|かみ砕/iu.test(message)) {
    add(
      extraction(
        "communication",
        "terminology",
        "plain_language",
        "専門用語を避け、平易な言葉で説明する",
        source,
        confidence,
        reason,
      ),
    );
  }
  const briefRequested =
    /短く|簡潔|要点だけ|長すぎ|冗長|くどい/iu.test(message) &&
    /説明|返答|回答|話|文章|長|専門用語|平易/iu.test(message);
  const detailedRequested =
    stable &&
    /詳しく|長め|丁寧|背景も/iu.test(message) &&
    /説明|返答|回答|話|文章/iu.test(message);
  const briefNegated =
    /(?:短く|簡潔|要点だけ|長すぎ|冗長|くどい).{0,16}(?:ではなく|じゃなく|にせず|ではなくて)/iu.test(
      message,
    );
  const detailedNegated =
    /(?:詳しく|長め|丁寧|背景も).{0,16}(?:ではなく|じゃなく|にせず|ではなくて)/iu.test(
      message,
    );
  if (briefRequested && (!detailedRequested || !briefNegated)) {
    add(
      extraction(
        "communication",
        "length",
        "brief",
        "説明と返答を短く、要点中心にする",
        source,
        confidence,
        reason,
      ),
    );
  }
  if (
    detailedRequested &&
    (!briefRequested || briefNegated || !detailedNegated)
  ) {
    add(
      extraction(
        "communication",
        "length",
        "detailed",
        "必要な背景を含めて丁寧に説明する",
        source,
        confidence,
        reason,
      ),
    );
  }
  if (
    /安全な選択|安全に|低リスク|可逆|自分で判断|自律|任せて|細かく指示しないと|プログラムされた動作/iu.test(
      message,
    ) &&
    /任せ|判断|進め|動作|指示|自律/iu.test(message)
  ) {
    add(
      extraction(
        "autonomy",
        "safe_low_impact",
        "delegate_safe_low_impact",
        "観測できる安全な低影響・可逆の選択は自分で進める",
        source,
        confidence,
        reason,
      ),
    );
  }
  if (
    /毎回|いちいち|細かく|同じ|また|何度も|繰り返/iu.test(message) &&
    /確認|質問|指示|教え|説明/iu.test(message) &&
    /しない|聞かない|求めない|不要|減ら|避け|繰り返さ/iu.test(message)
  ) {
    add(
      extraction(
        "workflow",
        "confirmation",
        "avoid_repeated_confirmation",
        "同じ確認や細かな指示を繰り返し求めない",
        source,
        confidence,
        reason,
      ),
    );
  }
  if (
    /状況|文脈|前の説明|会話|読み取/iu.test(message) &&
    /読|見|考慮|踏まえ|使/iu.test(message)
  ) {
    add(
      extraction(
        "planning",
        "context",
        "use_conversation_context",
        "直前までの会話と現在状態を踏まえて判断する",
        source,
        confidence,
        reason,
      ),
    );
  }
  if (
    /停止|失敗|できない|拒絶|断る/iu.test(message) &&
    /理由|原因|次|再開|説明/iu.test(message)
  ) {
    add(
      extraction(
        "feedback",
        "blocker_explanation",
        "explain_reason_and_next_step",
        "停止・失敗時は理由と次に可能な操作を説明する",
        source,
        confidence,
        reason,
      ),
    );
  }
  return results;
}

function hasFeedbackSignal(message: string): boolean {
  return /また|何度も|繰り返|同じ|長すぎ|冗長|くどい|分かりにく|わかりにく|細かく指示|プログラムされた動作|状況を読|文脈を読/u.test(
    message,
  );
}

function isSafetyConcern(message: string): boolean {
  return (
    /安全確認|安全|保護|認証|権限|停止/iu.test(message) &&
    /しない|しなく|しなかっ|なく|無い|できていない|されていない|不足|不十分|足り|欠け|抜け|軽視|怠|無視|回避/iu.test(
      message,
    )
  );
}

export function parseBehaviorMemoryCommand(
  message: string,
): BehaviorMemoryCommand | undefined {
  const normalized = normalizeMessage(message);
  if (
    /何を覚えて|覚えていること|記憶一覧|記憶している|好み.*一覧|設定.*確認/iu.test(
      normalized,
    )
  ) {
    return { kind: "list" };
  }
  if (/忘れて|記憶から削除|覚えないで|取り消して/iu.test(normalized)) {
    const known = knownSlotFromMessage(normalized);
    return {
      kind: "forget",
      ...(known ?? {}),
    };
  }
  return undefined;
}

function knownSlotFromMessage(
  message: string,
): Pick<BehaviorMemoryCommand, "category" | "slot"> | undefined {
  if (/専門用語|平易|わかりやす/iu.test(message)) {
    return { category: "communication", slot: "terminology" };
  }
  if (/短く|簡潔|長め|詳しく/iu.test(message)) {
    return { category: "communication", slot: "length" };
  }
  if (/安全|低リスク|可逆|自律|任せ/iu.test(message)) {
    return { category: "autonomy", slot: "safe_low_impact" };
  }
  if (/確認|細かく|同じ指示|繰り返/iu.test(message)) {
    return { category: "workflow", slot: "confirmation" };
  }
  if (/状況|文脈|会話/iu.test(message)) {
    return { category: "planning", slot: "context" };
  }
  if (/感情|気持ち|不満|苛立|失望/iu.test(message)) {
    return { category: "feedback", slot: "owner_emotion" };
  }
  return undefined;
}

export function behaviorMemoryDescription(
  record: Pick<BehaviorMemoryRecord, "slot" | "value" | "summary">,
): string {
  const descriptions: Record<string, string> = {
    plain_language: "専門用語を避けて平易に説明する",
    brief: "返答を短く要点中心にする",
    detailed: "必要な背景を含めて丁寧に説明する",
    delegate_safe_low_impact: "安全で低影響・可逆な選択を自分で進める",
    avoid_repeated_confirmation: "同じ確認や細かな指示を繰り返し求めない",
    use_conversation_context: "会話と現在状態を踏まえて判断する",
    explain_reason_and_next_step: "停止・失敗時に理由と次の操作を説明する",
    prioritize_owner_emotion:
      "事実整理より利用者の感情を先に受け止め、次の行動へ反映する",
  };
  return descriptions[record.value] ?? record.summary;
}

function extraction(
  category: BehaviorMemoryCategory,
  slot: string,
  value: string,
  summary: string,
  source: BehaviorMemorySource,
  confidence: BehaviorMemoryConfidence,
  reason: BehaviorMemoryExtraction["reason"],
): BehaviorMemoryExtraction {
  return {
    category,
    slot,
    value,
    summary,
    source,
    confidence,
    scope: "owner_global",
    reason,
  };
}

function normalizeInput(
  input: RememberBehaviorMemoryInput,
): RememberBehaviorMemoryInput & {
  readonly scope: BehaviorMemoryScope;
  readonly supportCount: number;
} {
  const category = behaviorCategory(input.category);
  const slot = cleanText(input.slot, "behavior memory slot", MAX_SLOT_LENGTH);
  const value = cleanText(
    input.value,
    "behavior memory value",
    MAX_VALUE_LENGTH,
  );
  const summary = cleanText(
    input.summary,
    "behavior memory summary",
    MAX_SUMMARY_LENGTH,
  );
  const source = behaviorSource(input.source);
  const confidence = behaviorConfidence(input.confidence);
  const scope = behaviorScope(input.scope ?? "owner_global");
  const idempotencyKey = cleanIdempotencyKey(input.idempotencyKey);
  const supportCount = integer(
    input.supportCount ?? 1,
    "behavior memory support count",
    1,
    20,
  );
  const safeKnownConfirmation =
    category === "workflow" &&
    slot === "confirmation" &&
    value === "avoid_repeated_confirmation";
  if (
    protectedOverride.test(summary) ||
    (protectedOverride.test(value) && !safeKnownConfirmation)
  ) {
    throw new BehaviorMemoryError(
      "Behavior memory cannot weaken safety, authorization, or stop rules.",
    );
  }
  if (source === "owner_feedback") {
    if (confidence !== "repeated_feedback" && confidence !== "corroborated") {
      throw new BehaviorMemoryError(
        "Owner feedback must remain low-confidence until corroborated.",
      );
    }
  } else if (confidence !== "explicit" && confidence !== "corrected") {
    throw new BehaviorMemoryError(
      "Explicit owner memory must use explicit or corrected confidence.",
    );
  }
  return {
    ...input,
    category,
    slot,
    value,
    summary,
    source,
    confidence,
    scope,
    supportCount,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function behaviorMemory(row: BehaviorMemoryRow): BehaviorMemoryRecord {
  return {
    id: cleanId(row.id),
    playerId: cleanId(row.player_id),
    category: behaviorCategory(row.category),
    slot: cleanText(
      row.slot,
      "persisted behavior memory slot",
      MAX_SLOT_LENGTH,
    ),
    value: cleanText(
      row.value,
      "persisted behavior memory value",
      MAX_VALUE_LENGTH,
    ),
    summary: cleanText(
      row.summary,
      "persisted behavior memory summary",
      MAX_SUMMARY_LENGTH,
    ),
    source: behaviorSource(row.source),
    confidence: behaviorConfidence(row.confidence),
    scope: behaviorScope(row.scope),
    supportCount: integer(
      row.support_count,
      "persisted behavior memory support count",
      1,
      20,
    ),
    status: behaviorStatus(row.status),
    ...(row.superseded_by_id === null
      ? {}
      : { supersededById: cleanId(row.superseded_by_id) }),
    ...(row.retraction_reason === null
      ? {}
      : {
          retractionReason: cleanText(
            row.retraction_reason,
            "persisted behavior memory retraction reason",
            MAX_RETRACTION_REASON_LENGTH,
          ),
        }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stablePreferenceTail(message: string): string {
  const tail = message
    .replace(
      /^(?:覚えて(?:おいて)?|記憶して(?:おいて)?|今後(?:は)?|次から(?:は)?|これから(?:は)?|いつも|継続して|訂正[:：]?|修正[:：]?|違う[。,:： ]*)/u,
      "",
    )
    .replace(/[「」"'`]/gu, "")
    .replace(/[。！!？?]+$/gu, "")
    .trim();
  return tail.slice(0, 160);
}

function classifyCategory(value: string): BehaviorMemoryCategory {
  if (/説明|言葉|話|返答|専門用語/iu.test(value)) return "communication";
  if (/計画|文脈|状況|優先|目的|状態/iu.test(value)) return "planning";
  if (/判断|任せ|自律|作業/iu.test(value)) return "autonomy";
  if (/確認|指示|進め方|繰り返/iu.test(value)) return "workflow";
  return "general";
}

function normalizeMessage(value: string): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function cleanQuery(value: string | undefined): string {
  return normalizeMessage(value ?? "").toLocaleLowerCase();
}

function cleanId(value: string): string {
  const id = cleanText(value, "behavior memory id", 100);
  if (!/^[0-9a-f-]{8,100}$/iu.test(id)) {
    throw new BehaviorMemoryError("Behavior memory id is invalid.");
  }
  return id;
}

function cleanIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) ||
    secretLabel.test(value) ||
    secretValue.test(value)
  ) {
    throw new BehaviorMemoryError("Behavior memory event key is invalid.");
  }
  return value;
}

function cleanText(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new BehaviorMemoryError(`${label} must be text.`);
  }
  const normalized = normalizeMessage(value);
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new BehaviorMemoryError(
      `${label} must be 1-${String(maxLength)} characters.`,
    );
  }
  if (
    secretLabel.test(normalized) ||
    secretValue.test(normalized) ||
    sensitivePersonalData.test(normalized)
  ) {
    throw new BehaviorMemoryError(
      `${label} contains protected credential-like text.`,
    );
  }
  return normalized;
}

function integer(
  value: number,
  label: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BehaviorMemoryError(`${label} must be an integer in range.`);
  }
  return value;
}

function listLimit(value: number | undefined): number {
  return integer(
    value ?? DEFAULT_LIST_LIMIT,
    "behavior memory limit",
    1,
    MAX_LIST_LIMIT,
  );
}

function behaviorCategory(value: string): BehaviorMemoryCategory {
  if (!behaviorMemoryCategories.includes(value as BehaviorMemoryCategory)) {
    throw new BehaviorMemoryError("Unsupported behavior memory category.");
  }
  return value as BehaviorMemoryCategory;
}

function behaviorSource(value: string): BehaviorMemorySource {
  if (!behaviorMemorySources.includes(value as BehaviorMemorySource)) {
    throw new BehaviorMemoryError("Unsupported behavior memory source.");
  }
  return value as BehaviorMemorySource;
}

function behaviorConfidence(value: string): BehaviorMemoryConfidence {
  if (!behaviorMemoryConfidences.includes(value as BehaviorMemoryConfidence)) {
    throw new BehaviorMemoryError("Unsupported behavior memory confidence.");
  }
  return value as BehaviorMemoryConfidence;
}

function behaviorScope(value: string): BehaviorMemoryScope {
  if (!behaviorMemoryScopes.includes(value as BehaviorMemoryScope)) {
    throw new BehaviorMemoryError("Unsupported behavior memory scope.");
  }
  return value as BehaviorMemoryScope;
}

function behaviorStatus(value: string): BehaviorMemoryStatus {
  if (!behaviorMemoryStatuses.includes(value as BehaviorMemoryStatus)) {
    throw new BehaviorMemoryError("Unsupported behavior memory status.");
  }
  return value as BehaviorMemoryStatus;
}

function timestamp(): string {
  return new Date().toISOString();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
