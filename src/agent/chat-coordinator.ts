import type { Logger } from "pino";

import type { RuntimeReassessmentRunOutcome } from "../app/runtime-reassessment-gate.js";
import type { HostileGoal } from "../decision/hostile-response.js";
import {
  createCorrelationId,
  runWithCorrelation,
} from "../observability/correlation.js";
import type { CognitiveStage } from "../trace/contracts.js";
import type {
  TraceService,
  TraceSession,
  WithSpanOptions,
} from "../trace/service.js";
import type {
  GameController,
  GameStatus,
  ToolContext,
} from "../tools/contracts.js";
import {
  classifyArmorQuestion,
  hasWearableCarriedArmor,
  isContextualArmorEquipSuggestion,
  renderArmorAnswer,
  type ArmorQuestionSubject,
} from "./armor-answer.js";
import { isExplicitGoalResumeMessage } from "./conversation-context.js";
import type { OpenAIDeliberationAgent } from "./openai-agent.js";
import {
  classifyVitalsQuestion,
  renderVitalsAnswer,
  type VitalsQuestion,
} from "./vitals-answer.js";

const stopTeForms =
  "(?:止めて|停止して|やめて|中止して|中断して|止まって|ストップして)";
const stopTeSuffix =
  "(?:ください|下さい|ほしい(?:です)?|くれ(?![てた])|ちょうだい|お願い(?:します)?)?(?:ね|よ)?";
const stopImperatives =
  "(?:止まれ|止めろ|やめろ|停止しろ|中止しろ|中断しろ|ストップしろ|止まりなさい|止めなさい|やめなさい|停止しなさい|中止しなさい|中断しなさい)";
const TARGETED_STOP_COMMAND_PATTERN = new RegExp(
  `${stopTeForms}${stopTeSuffix}$|${stopImperatives}$|(?:停止|中止|中断|ストップ)$`,
  "u",
);
const DEFERRED_STOP_CONDITION_PATTERN =
  /(?:もし|仮に|なら|たら|場合(?:は|に|$)|とき(?:は|に|$)|時(?:は|に|$)|(?:して|終わって|戻って)から)/u;
const DEFERRED_STOP_TIME_PATTERN =
  /(?:あとで|後で|後ほど|明日|次回|次に|(?:あと|後|今から|これから)\s*[0-9０-９一二三四五六七八九十]+\s*(?:秒|分|時間|日)(?:後|で|に|経ったら)|[0-9０-９一二三四五六七八九十]+\s*(?:秒|分|時間|日)(?:後|経ったら))/u;
const STOP_FAILURE_MESSAGE =
  "Minecraftの停止処理を完了できなかったため、新しい作業は開始しません。";

function splitStopClauses(message: string): string[] {
  const punctuationClauses =
    message.match(/[^、，,。！？!?]+(?:[、，,。！？!?]|$)/gu) ?? [];
  const grouped: string[] = [];
  let deferredPrefix = "";
  for (const clause of punctuationClauses) {
    const combined = deferredPrefix + clause;
    const normalized = normalizedStopClause(combined);
    if (
      /[、，,]$/u.test(clause) &&
      hasDeferredStopPrefix(normalized) &&
      !TARGETED_STOP_COMMAND_PATTERN.test(normalized)
    ) {
      deferredPrefix = combined;
      continue;
    }
    grouped.push(combined);
    deferredPrefix = "";
  }
  if (deferredPrefix.length > 0) grouped.push(deferredPrefix);
  return grouped
    .flatMap((clause) => clause.split(/(?=代わりに|その代わり)/u))
    .flatMap(splitInlineStopClause)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function splitInlineStopClause(clause: string): string[] {
  if (/[?？]/u.test(clause)) return [clause];
  const normalized = normalizedStopClause(clause);
  const commands = new RegExp(
    `${stopTeForms}${stopTeSuffix}|${stopImperatives}`,
    "gu",
  );
  for (const match of normalized.matchAll(commands)) {
    const end = match.index + match[0].length;
    const stop = normalized.slice(0, end).trim();
    const rest = normalized.slice(end).trim();
    if (
      rest.length > 0 &&
      isStopClause(stop) &&
      (!/ほしい(?:です)?(?:ね|よ)?$/u.test(match[0]) ||
        /^(?:今すぐ|すぐに?|直ちに|ただちに)$/u.test(rest)) &&
      !/(?:ない|ません|ではない|じゃない|不要|しまった|かどうか|^い(?:る|た|ました)|^みた|^もら|^くれた|^くれて|^いい|^よい|^良い|^と|^って|^は)/u.test(
        rest,
      )
    ) {
      return [stop, rest];
    }
  }
  return [clause];
}

function normalizedStopClause(clause: string): string {
  return clause.replace(/[、，,。！!]$/u, "").trim();
}

function hasDeferredStopPrefix(prefix: string): boolean {
  return (
    DEFERRED_STOP_CONDITION_PATTERN.test(prefix) ||
    DEFERRED_STOP_TIME_PATTERN.test(prefix)
  );
}

function isStopClause(clause: string): boolean {
  if (/[?？]/u.test(clause)) return false;
  const normalized = normalizedStopClause(clause);
  if (/[「」『』“”"'`]/u.test(normalized)) return false;
  const command = TARGETED_STOP_COMMAND_PATTERN.exec(normalized);
  if (command === null) return false;
  return !hasDeferredStopPrefix(normalized.slice(0, command.index));
}

function isSafeReadOnlyFollowUp(message: string): boolean {
  return (
    /(?:周囲|周り|辺り|足元|近く|状態|状況|現状|所持品|インベントリ)(?:を|の)?(?:確認して|見て|観測して|調べて)(?:ください|下さい)?[。！!]?$/u.test(
      message,
    ) ||
    /(?:説明して|教えて|答えて|話して|要約して)(?:ください|下さい)?[。！!]?$/u.test(
      message,
    ) ||
    /(?:要約|説明|手順|例|文章|返答|回答)を(?:作って|書いて)(?:ください|下さい)?[。！!]?$/u.test(
      message,
    ) ||
    /^(?:もっと)?(?:短く|詳しく|簡潔に)[。！!]?$/u.test(message) ||
    /(?:短く|簡潔に|詳しく|専門用語).*(?:話して|説明して|答えて|使わないで)(?:ください|下さい)?[。！!]?$/u.test(
      message,
    ) ||
    /^(?:なぜ|どうして)[?？]?$/u.test(message)
  );
}

function immediateStopFollowUp(message: string): string | undefined {
  const clauses = splitStopClauses(message);
  const stopIndex = clauses.findIndex(isStopClause);
  if (stopIndex < 0) return undefined;
  const followUp = clauses
    .slice(stopIndex + 1)
    .join(" ")
    .replace(/^(?:代わりに|その代わり)\s*/u, "")
    .trim();
  return followUp.length > 0 &&
    ((isExplicitGoalResumeMessage(followUp) && !/[?？]/u.test(followUp)) ||
      isReadOnlyStatusQuestion(followUp) ||
      classifyVitalsQuestion(followUp) !== null ||
      isSafeReadOnlyFollowUp(followUp))
    ? followUp
    : undefined;
}

function isCapabilityWhyQuestion(message: string): boolean {
  return (
    /^(?:なぜ|どうして).*(?:建築|設置|破壊|サーバー|管理|未提供|できない|できません)/u.test(
      message,
    ) && !/(?:失敗|止ま|中断|完了|作業)/u.test(message)
  );
}

/**
 * Short, read-only status questions are answered independently of a long
 * running owner action. This keeps a harmless question from waiting behind a
 * follow or gather operation while leaving that operation untouched.
 */
export function isReadOnlyStatusQuestion(message: string): boolean {
  const normalized = message.trim().replace(/\s+/gu, " ");
  if (isImmediateStopCommand(normalized)) return false;
  if (classifyArmorQuestion(normalized) !== null) return true;
  if (normalized === "なぜ") return true;
  if (/^(?:状態|状況|進捗)(?:を教えて|を説明して)?[?？]?$/u.test(normalized)) {
    return true;
  }
  if (/[?？]/u.test(normalized)) {
    const questionMark = normalized.search(/[?？]/u);
    if (
      questionMark >= 0 &&
      !/^[。！!]*$/u.test(normalized.slice(questionMark + 1).trim())
    ) {
      return false;
    }
  }
  const includesAction =
    /(?:集め|採取|掘|移動|来て|追従|戻|探|収納|建築|作って|始め|続け|再開|使って|置いて|取り|停止|止ま|止め|ストップ|やめ|中止|中断)/u.test(
      normalized,
    );
  const isCapabilityWhy = isCapabilityWhyQuestion(normalized);
  const isReasonForStoppedWork =
    !isCapabilityWhy &&
    /^(?:なぜ|どうして).*(?:止ま|失敗|できな)/u.test(normalized);
  if (
    includesAction &&
    (!isReasonForStoppedWork || isExplicitGoalResumeMessage(normalized))
  ) {
    return false;
  }
  return (
    isReasonForStoppedWork ||
    /(?:今|現在|いま).*(?:どうな|何して|状態|状況|進捗|止ま)/u.test(
      normalized,
    ) ||
    /(?:何してる|何をしてる|どうなってる|どうなっています|なぜ(?:止ま|失敗|できな))/u.test(
      normalized,
    )
  );
}

export function hostileResponseIntent(message: string): HostileGoal | null {
  const normalized = message.trim().replace(/[。！!]+$/gu, "");
  if (/[?？「」『』“”]/u.test(normalized)) return null;
  if (
    /(?:敵|モンスター|ゾンビ村人|ゾンビ|スケルトン|クリーパー)(?:を|のことを)助けて/u.test(
      normalized,
    )
  )
    return null;

  const negatedEvade =
    /(?:逃げ(?:ないで|るな|なくていい|てはいけない)|退避(?:しないで|するな|は不要|不要|してはいけない)|距離を取(?:らないで|るな|ってはいけない)|離れ(?:ないで|るな|てはいけない))/gu;
  const negatedAttack =
    /(?:倒|攻撃|戦|応戦|反撃|撃滅|討伐|退治|やっつけ)[^、，,。！!]{0,8}(?:ないで|なくていい|不要|するな|すな|はいけない|必要はない|ほしくない|やめて)/gu;
  const hasNegatedEvade = negatedEvade.test(normalized);
  const hasNegatedAttack = negatedAttack.test(normalized);
  const affirmativeEvade = normalized.replace(negatedEvade, "");
  const affirmativeAttack = normalized.replace(negatedAttack, "");
  const conditionalEvade =
    /(?:無理|危険|倒せな|攻撃できな).{0,8}(?:なら|場合|とき|たら)[、，,\s]{0,3}.{0,12}(?:退避|逃げ|距離を取)/gu;
  const hasConditionalEvade = affirmativeEvade.match(conditionalEvade) !== null;
  const directEvade = affirmativeEvade.replace(conditionalEvade, "");
  const evadeCommand =
    /(?:逃げ(?:て|ろ|なさい|たい|るのを助けて)|逃走(?:して|しろ)|退避(?:して|しろ|しなさい)|距離を取(?:って|れ|りたい)|(?:敵|モンスター).{0,8}離れ(?:て|ろ)|安全な場所へ(?:移動|行って))(?:ください|下さい|くれ|ほしい(?:です)?|ね|よ)?$/u;
  if (
    directEvade
      .split(/[、，,。！!]/u)
      .some((clause) => evadeCommand.test(clause.trim()))
  ) {
    return "evade";
  }

  const latestCombatCommand = [
    ...normalized.matchAll(
      /(?:倒(?:して|せ|しろ|しなさい)|攻撃(?:して|しろ|せよ)|撃滅(?:して|せよ|しろ|しなさい)|討伐(?:して|しろ|せよ)|退治(?:して|しろ|せよ)|やっつけ(?:て|ろ)|応戦(?:して|しろ|せよ)|反撃(?:して|しろ|せよ))/gu,
    ),
  ].at(-1);
  if (latestCombatCommand !== undefined) {
    const followingText = normalized.slice(
      latestCombatCommand.index + latestCombatCommand[0].length,
    );
    if (
      /(?:とは|って)(?:言って(?:い)?ない|言ったわけではない)|(?:やっぱり|やはり).{0,12}(?:やめ|中止|撤回|しないで)|(?:やめて|中止|撤回|取り消し)/u.test(
        followingText,
      )
    ) {
      return null;
    }
  }

  const clauses = affirmativeAttack.split(/[、，,。！!]/u);
  const distress = clauses.some((clause) => {
    const text = clause.trim();
    return (
      /(?:敵|モンスター|襲われ|ゾンビ|スケルトン|クリーパー|ファントム).*(?:対処して|どうにかして|何とかして)(?:ください|下さい|くれ|ほしい(?:です)?|ね|よ)?$/u.test(
        text,
      ) ||
      /(?:敵|モンスター|ゾンビ|スケルトン|クリーパー|ファントム)(?:から|に襲われ).{0,12}助けて(?:ください|下さい|くれ|ほしい(?:です)?|ね|よ)?$/u.test(
        text,
      ) ||
      /襲われ.{0,12}助けて(?:ください|下さい|くれ|ほしい(?:です)?|ね|よ)?$/u.test(
        text,
      )
    );
  });
  if (hasNegatedAttack) return distress ? "evade" : null;
  const combat = clauses.some((clause) => {
    const hostileTarget =
      /(?:敵|モンスター|ゾンビ|スケルトン|クリーパー|ファントム|そいつら?|あいつら?|やつら|奴ら)/u.test(
        clause,
      );
    const nonHostileTarget =
      /(?:木|樹|原木|竹|草|ブロック).{0,5}(?:倒|攻撃|撃滅|討伐|退治)/u.test(
        clause,
      );
    const explicitCombat =
      /(?:撃滅(?:して|せよ|しろ|しなさい)|討伐(?:して|しろ|せよ)|退治(?:して|しろ|せよ)|やっつけ(?:て|ろ))(?:ください|下さい|くれ|ほしい(?:です)?|ね|よ)?$/u.test(
        clause.trim(),
      );
    const genericCombat =
      /(?:倒(?:して|せ|しろ|しなさい)|攻撃(?:して|しろ|せよ))(?:ください|下さい|くれ|ほしい(?:です)?|ね|よ)?$/u.test(
        clause.trim(),
      );
    const defensiveCombat =
      /(?:応戦|反撃)(?:して|しろ|せよ)(?:ください|下さい|くれ|ほしい(?:です)?|ね|よ)?$/u.test(
        clause.trim(),
      );
    return (
      (explicitCombat && hostileTarget && !nonHostileTarget) ||
      (genericCombat &&
        !nonHostileTarget &&
        (hostileTarget || hasNegatedEvade)) ||
      (defensiveCombat && !nonHostileTarget)
    );
  });
  if (combat || distress) return "eliminate";
  return hasConditionalEvade &&
    /(?:敵|モンスター|ゾンビ|スケルトン|クリーパー)/u.test(normalized)
    ? "evade"
    : null;
}

export function isHostileResponseCommand(message: string): boolean {
  return hostileResponseIntent(message) !== null;
}

export function isHostileEvadeIntent(message: string): boolean {
  return hostileResponseIntent(message) === "evade";
}

/**
 * Presentation-only preferences that the status fast path may consume. They
 * never alter the observed state, safety decision, authorization, or action
 * selection. The defaults preserve the bounded, plain-language contract even
 * when an older context factory does not expose behavior memory.
 */
export interface StatusPresentationPreferences {
  readonly brief: boolean;
  readonly plainLanguage: boolean;
}

const DEFAULT_STATUS_PRESENTATION: StatusPresentationPreferences = {
  brief: true,
  plainLanguage: true,
};

export function renderReadOnlyStatus(
  status: GameStatus,
  preferences: StatusPresentationPreferences = DEFAULT_STATUS_PRESENTATION,
): string {
  if (!status.connected) {
    return "Minecraftへの接続を確認できません。再接続後に現在の状態を確認してください。";
  }
  const summary = status.activeTaskSummary?.trim();
  if (summary !== undefined && summary.length > 0) {
    return preferences.brief ? compactStatusSummary(summary) : summary;
  }
  const task = status.activeTaskState?.trim();
  if (task === undefined || task.length === 0) {
    const latest = status.latestTaskState?.trim();
    if (latest !== undefined && latest.length > 0) {
      const result = `${latest}現在、進行中のMinecraft作業はありません。`;
      return preferences.brief ? compactStatusSummary(result) : result;
    }
    return "現在、進行中のMinecraft作業は確認できません。直前の作業結果は追加の観測が必要です。";
  }
  if (task.startsWith("作業を一時停止中")) {
    return task;
  }
  const [kind] = task.split(":", 1);
  const description =
    kind === "follow_player"
      ? "利用者への追従を続けています。"
      : kind === "gather_resource"
        ? "資源の収集を続けています。"
        : kind === "move_to"
          ? "指定場所への移動を続けています。"
          : kind === "return_to_player"
            ? "利用者の場所への帰還を続けています。"
            : "Minecraft作業を続けています。";
  return description;
}

function compactStatusSummary(summary: string): string {
  // Safety summaries carry the current check and next operation. Keep the
  // full text so a brief preference cannot remove actionable safety facts.
  if (
    /(?:安全|危険|停止|再確認|次の操作|進行中|作業はありません|完了)/u.test(
      summary,
    )
  )
    return summary;
  const firstSentence = /^.*?[。！？!?]/u.exec(summary)?.[0];
  return firstSentence?.trim() ?? summary;
}

function oneSentenceNotification(text: string): string {
  // Keep every observed fact and safety instruction; only join sentence
  // boundaries when the owner explicitly prefers a single notification line.
  return text
    .trim()
    .replace(/されません。\s*(?=\S)/gu, "されず、")
    .replace(/ありません。\s*(?=\S)/gu, "なく、")
    .replace(/できません。\s*(?=\S)/gu, "できず、")
    .replace(/[。！？!?]\s*(?=\S)/gu, "、")
    .replace(/\s*\n+\s*/gu, "、")
    .replace(/、{2,}/gu, "、");
}

export interface ChatContextFactory {
  clearPendingOwnerGoal?(): void;
  /** Persist owner behavior candidates when the chat message is accepted. */
  acceptOwnerMessage?(
    requesterUsername: string,
    message: string,
    eventId: string,
  ): void;
  /** Read presentation-only owner preferences for the factual status path. */
  readOwnerStatusPreferences?(
    requesterUsername: string,
  ): StatusPresentationPreferences | Promise<StatusPresentationPreferences>;
  create(
    requesterUsername: string,
    message: string,
    signal: AbortSignal,
    correlationId: string,
    requestKind: ToolContext["requestKind"],
    ownerTurnContext?: { readonly recentBotArmorStatus: boolean },
  ): Promise<{
    personaContext: string;
    memoryContext: string;
    worldContext: string;
    toolContext: ToolContext;
  }>;
}

export type RuntimeReassessmentEvent =
  | "startup_reassessment"
  | "safety_stabilized"
  | "safety_failed"
  | "connection_recovered";

interface DeliveredReplyRecorder {
  beginOwnerRequest?: (
    requesterUsername: string,
    message: string,
  ) => number | undefined;
  pendingOwnerRequestId?: (requesterUsername: string) => number | undefined;
  latestOwnerRequestId?: (requesterUsername: string) => number | undefined;
  recordDeliveredOwnerExchange?: (
    requesterUsername: string,
    message: string,
    text: string,
  ) => void;
  recordDeliveredReply?: (
    requesterUsername: string,
    requestKind: ToolContext["requestKind"],
    text: string,
    conversationRequestId?: number,
  ) => void;
  recordCancelledRequest?: (
    requesterUsername: string,
    requestKind: ToolContext["requestKind"],
    conversationRequestId?: number,
  ) => void;
}

type ConversationAgent = Pick<OpenAIDeliberationAgent, "deliberate"> &
  DeliveredReplyRecorder;

export interface RuntimeReassessmentContext {
  readonly event: RuntimeReassessmentEvent;
  readonly stateKey: string;
  readonly causeKey?: string | undefined;
}

async function safeWithTraceSpan<T>(
  traceService: TraceService | undefined,
  stage: CognitiveStage,
  name: string,
  options: WithSpanOptions<T>,
  operation: () => Promise<T>,
): Promise<T> {
  if (traceService === undefined) return operation();

  let operationPromise: Promise<T> | undefined;
  const invoke = (): Promise<T> => {
    operationPromise = Promise.resolve().then(operation);
    return operationPromise;
  };

  try {
    return await traceService.withSpan(stage, name, options, invoke);
  } catch {
    // Trace failures must not execute the primary operation twice. If the
    // operation already started, return its original result/error instead.
    if (operationPromise !== undefined) {
      return operationPromise;
    }
    return operation();
  }
}

async function safeWithTrace<T>(
  traceService: TraceService | undefined,
  session: TraceSession,
  operation: () => Promise<T>,
): Promise<T> {
  if (traceService === undefined) return operation();

  let operationPromise: Promise<T> | undefined;
  const invoke = (): Promise<T> => {
    operationPromise = Promise.resolve().then(operation);
    return operationPromise;
  };

  try {
    return await traceService.withTrace(session, invoke);
  } catch {
    if (operationPromise !== undefined) {
      return operationPromise;
    }
    return operation();
  }
}

async function safeStartTrace(
  traceService: TraceService | undefined,
  requestSummary: string,
  requestKind: ToolContext["requestKind"],
  attributes: Readonly<Record<string, unknown>> = {},
): Promise<TraceSession | undefined> {
  if (traceService === undefined) return undefined;
  try {
    return await traceService.startTrace(requestSummary, {
      attributes: { requestKind, ...attributes },
    });
  } catch {
    return undefined;
  }
}

async function safeCompleteTrace(
  session: TraceSession | undefined,
  status: "succeeded" | "failed" | "cancelled",
  summary: string,
): Promise<void> {
  if (session === undefined) return;
  try {
    await session.complete(status, { summary });
  } catch {
    // Trace completion is best effort; the companion response path remains
    // authoritative when observability is degraded.
  }
}

export class ChatCoordinator {
  readonly #ownerUsername: string;
  readonly #game: GameController;
  readonly #agent: ConversationAgent;
  readonly #contextFactory: ChatContextFactory;
  readonly #logger: Logger;
  readonly #traceService: TraceService | undefined;
  readonly #immediateStopListeners = new Set<() => void>();
  readonly #ownerMessageListeners = new Set<() => void>();
  readonly #readOnlyStatusQuestions = new Set<Promise<void>>();
  readonly #readOnlyStatusDeliveries = new Set<Promise<boolean>>();
  #activeController: AbortController | undefined;
  #activeRequestKind: ToolContext["requestKind"] | undefined;
  #stopTail: Promise<void> = Promise.resolve();
  #conversationTail: Promise<RuntimeReassessmentRunOutcome | undefined> =
    Promise.resolve(undefined);
  #generation = 0;
  #runtimeGeneration = 0;
  #armorFollowupUntil = 0;

  public constructor(input: {
    ownerUsername: string;
    game: GameController;
    agent: ConversationAgent;
    contextFactory: ChatContextFactory;
    logger: Logger;
    traceService?: TraceService;
  }) {
    this.#ownerUsername = input.ownerUsername;
    this.#game = input.game;
    this.#agent = input.agent;
    this.#contextFactory = input.contextFactory;
    this.#logger = input.logger;
    this.#traceService = input.traceService;
  }

  public async handleChat(username: string, message: string): Promise<boolean> {
    if (username !== this.#ownerUsername) return false;

    const normalized = message.trim();
    const contextualArmorFollowup =
      Date.now() <= this.#armorFollowupUntil &&
      isContextualArmorEquipSuggestion(normalized);
    this.#armorFollowupUntil = 0;
    const stopFollowUp = immediateStopFollowUp(normalized);
    if (isImmediateStopCommand(normalized)) {
      this.#runtimeGeneration += 1;
      const ownerMessageGeneration = this.#runtimeGeneration;
      this.#generation += 1;
      this.#contextFactory.clearPendingOwnerGoal?.();
      const stopGeneration = this.#generation;
      this.#notifyImmediateStop();
      this.#activeController?.abort(new Error("OWNER_STOP_REQUESTED"));
      const recorder = this.#agent as unknown as DeliveredReplyRecorder;
      const pendingRequestId = recorder.pendingOwnerRequestId?.(username);
      const interruptedRequestId =
        pendingRequestId ?? recorder.latestOwnerRequestId?.(username);
      const stopRun = this.#stopTail
        .catch(() => undefined)
        .then(async () => {
          const session = await safeStartTrace(
            this.#traceService,
            "停止指示を受信",
            "owner_message",
          );
          const stop = async (): Promise<void> => {
            const report = await safeWithTraceSpan(
              this.#traceService,
              "cancellation",
              "Minecraft作業を停止",
              {
                summary: "停止指示を処理",
                summarizeResult: () => "停止処理を実行",
              },
              () => this.#game.stopCurrentAction("利用者の即時停止指示"),
            );
            const hadActiveTask =
              (report.before?.activeTaskSummary?.trim().length ?? 0) > 0 ||
              (report.before?.activeTaskState?.trim().length ?? 0) > 0;
            // A status message already being sent precedes the stop result
            // in both chat and the recorded conversation history.
            await Promise.allSettled([...this.#readOnlyStatusDeliveries]);
            if (pendingRequestId !== undefined || hadActiveTask) {
              if (interruptedRequestId === undefined) {
                recorder.recordCancelledRequest?.(username, "owner_message");
              } else {
                recorder.recordCancelledRequest?.(
                  username,
                  "owner_message",
                  interruptedRequestId,
                );
              }
            }
            await safeWithTraceSpan(
              this.#traceService,
              "response",
              "停止結果を応答",
              {
                summary: "停止結果を送信",
                resultKind: "final_response",
                summarizeResult: () => "停止結果を送信",
              },
              () => this.#game.say(report.summary),
            );
          };
          try {
            if (session === undefined) await stop();
            else await safeWithTrace(this.#traceService, session, stop);
            await safeCompleteTrace(session, "succeeded", "停止結果を送信");
          } catch (error) {
            await safeCompleteTrace(session, "failed", "停止処理に失敗");
            throw error;
          }
        });
      this.#stopTail = stopRun;
      try {
        await stopRun;
      } catch (error) {
        try {
          await this.#game.say(STOP_FAILURE_MESSAGE);
        } catch {
          // The stop error remains the primary failure; chat delivery is best effort.
        }
        throw error;
      }
      if (
        stopFollowUp !== undefined &&
        stopGeneration === this.#generation &&
        ownerMessageGeneration === this.#runtimeGeneration
      ) {
        await this.handleChat(username, stopFollowUp);
      }
      return true;
    }

    const acceptedCorrelationId = createCorrelationId();
    try {
      this.#contextFactory.acceptOwnerMessage?.(
        username,
        normalized,
        acceptedCorrelationId,
      );
    } catch (error) {
      this.#logger.warn(
        {
          code: "OWNER_BEHAVIOR_MEMORY_ACCEPT_FAILED",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "owner behavior memory acceptance failed",
      );
    }
    this.#runtimeGeneration += 1;
    this.#notifyOwnerMessage();

    if (this.#activeRequestKind === "runtime_reassessment") {
      this.#activeController?.abort(new Error("OWNER_MESSAGE_PRIORITIZED"));
    }

    const vitalsQuestion = classifyVitalsQuestion(normalized);
    const armorQuestion = classifyArmorQuestion(normalized);
    if (
      vitalsQuestion !== null ||
      armorQuestion !== null ||
      isReadOnlyStatusQuestion(normalized)
    ) {
      const questionGeneration = this.#generation;
      let prefetchedStatus: GameStatus | undefined;
      if (normalized === "なぜ") {
        try {
          prefetchedStatus = await this.#game.observeStatus();
        } catch {
          // Without a confirmed live task, let the normal conversation path
          // use the prior explanation instead of inventing a current reason.
        }
        if (questionGeneration !== this.#generation) return true;
        const activeTask =
          prefetchedStatus?.activeTaskSummary?.trim() ??
          prefetchedStatus?.activeTaskState?.trim();
        if (activeTask === undefined || activeTask.length === 0) {
          prefetchedStatus = undefined;
        }
      }
      if (
        vitalsQuestion !== null ||
        normalized !== "なぜ" ||
        prefetchedStatus !== undefined
      ) {
        const statusQuestion = this.#answerReadOnlyStatusQuestion(
          username,
          normalized,
          questionGeneration,
          prefetchedStatus,
          vitalsQuestion,
          armorQuestion,
        );
        this.#readOnlyStatusQuestions.add(statusQuestion);
        try {
          await statusQuestion;
        } finally {
          this.#readOnlyStatusQuestions.delete(statusQuestion);
        }
        return true;
      }
    }

    const hostileResponse = isHostileResponseCommand(normalized);
    if (hostileResponse) {
      this.#contextFactory.clearPendingOwnerGoal?.();
      this.#activeController?.abort(
        new Error("OWNER_HOSTILE_RESPONSE_PRIORITIZED"),
      );
    }
    const generation = this.#generation;
    const stopBoundary = this.#stopTail;
    this.#conversationTail = this.#conversationTail
      .catch(() => undefined)
      .then(async () => {
        try {
          await stopBoundary;
        } catch {
          await this.#game.say(
            "前のMinecraft作業を安全に停止できなかったため、新しい作業は開始しません。",
          );
          return undefined;
        }
        if (generation !== this.#generation) return undefined;
        if (hostileResponse) {
          await this.#game.stopCurrentAction(
            "所有者の敵対対象への新しい対処依頼",
          );
          return this.#respondToHostiles(username, normalized);
        }
        return this.#deliberate(
          username,
          normalized,
          "owner_message",
          undefined,
          acceptedCorrelationId,
          contextualArmorFollowup ? { recentBotArmorStatus: true } : undefined,
        );
      });
    await this.#conversationTail;
    return true;
  }

  public onImmediateStop(listener: () => void): () => void {
    this.#immediateStopListeners.add(listener);
    return () => this.#immediateStopListeners.delete(listener);
  }

  public onOwnerMessage(listener: () => void): () => void {
    this.#ownerMessageListeners.add(listener);
    return () => this.#ownerMessageListeners.delete(listener);
  }

  public async handleRuntimeEvent(
    event: RuntimeReassessmentEvent,
    context: Omit<RuntimeReassessmentContext, "event"> = {
      stateKey: event,
    },
  ): Promise<RuntimeReassessmentRunOutcome | undefined> {
    const messages = {
      startup_reassessment:
        "再起動後の未完了の約束または中断した作業を確認し、開始済みの行動が確認できればその事実を含め、利用者に必要な状態変化だけを2文以内で短く報告してください。内部処理や制約は説明せず、確認できた作業状態を正確に扱い、新しい行動を開始しないでください。",
      safety_stabilized:
        "安全介入後の状態と中断した作業を確認し、開始済みの行動が確認できればその事実を含め、利用者に必要な状態変化だけを2文以内で短く報告してください。内部処理や制約は説明せず、確認できた作業状態を正確に扱い、新しい行動を開始しないでください。",
      safety_failed:
        "安全介入後の安定状態を確認できませんでした。Bot自身の観測値と観測時刻を主体付きで、危険の状態と確認できた作業状態・開始済みの行動だけを2文以内で短く伝えてください。利用者の体力・空腹・酸素・水中状態は未確認と明示し、停止・再観測・安全な場所への移動など次の安全な処理と未確認範囲を利用者に判断してもらい、新しい採取や追従を開始しないでください。",
      connection_recovered:
        "Minecraft接続復旧後の状態を確認し、開始済みの行動が確認できればその事実を含め、利用者に必要な状態変化だけを2文以内で短く報告してください。内部処理や制約は説明せず、確認できた作業状態を正確に扱い、新しい行動を開始しないでください。",
    } as const;
    const message =
      event === "safety_failed" &&
      /SHORE_NOT_OBSERVED|SHORE_NOT_REACHED/u.test(context.stateKey)
        ? `Botは乾いた岸へまだ到達していません。${context.stateKey.includes("SHORE_NOT_OBSERVED") ? "観測範囲に安全な乾いた岸を確認できませんでした。" : "岸の候補は見えましたが、安全な経路での到達を確認できませんでした。"}今のBot自身の水中状態・酸素・体力を再観測して、一時的な呼吸回復を帰還完了と扱わず、浮上して呼吸を確保することと次に安全に観測できる方向を具体的に伝えてください。未観測の岸への移動や採取は開始しないでください。`
        : messages[event];
    const generation = this.#generation;
    const runtimeGeneration = this.#runtimeGeneration;
    this.#conversationTail = this.#conversationTail
      .catch(() => undefined)
      .then(() =>
        generation === this.#generation &&
        runtimeGeneration === this.#runtimeGeneration
          ? this.#deliberate(
              this.#ownerUsername,
              message,
              "runtime_reassessment",
              { event, ...context },
            )
          : "cancelled",
      );
    return this.#conversationTail;
  }

  public async shutdown(): Promise<void> {
    this.#generation += 1;
    this.#contextFactory.clearPendingOwnerGoal?.();
    this.#activeController?.abort(new Error("APPLICATION_SHUTDOWN"));
    await Promise.allSettled([
      this.#conversationTail,
      this.#stopTail,
      ...this.#readOnlyStatusQuestions,
    ]);
  }

  #notifyImmediateStop(): void {
    for (const listener of this.#immediateStopListeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.warn(
          {
            code: "IMMEDIATE_STOP_LISTENER_FAILED",
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
          "immediate stop listener failed",
        );
      }
    }
  }

  #notifyOwnerMessage(): void {
    for (const listener of this.#ownerMessageListeners) {
      try {
        listener();
      } catch (error) {
        this.#logger.warn(
          {
            code: "OWNER_MESSAGE_LISTENER_FAILED",
            errorType: error instanceof Error ? error.name : "UnknownError",
          },
          "owner message listener failed",
        );
      }
    }
  }

  async #answerReadOnlyStatusQuestion(
    username: string,
    message: string,
    questionGeneration: number,
    prefetchedStatus?: GameStatus,
    vitalsQuestion: VitalsQuestion | null = null,
    armorQuestion: ArmorQuestionSubject | null = null,
  ): Promise<void> {
    const recorder = this.#agent as unknown as DeliveredReplyRecorder;
    const session = await safeStartTrace(
      this.#traceService,
      "利用者の状態質問を受信",
      "owner_message",
      { responseMode: "read_only_status" },
    );
    const process = async (): Promise<boolean> => {
      if (questionGeneration !== this.#generation) return false;
      let status: GameStatus | undefined = prefetchedStatus;
      if (
        status === undefined &&
        (vitalsQuestion?.bot ?? armorQuestion !== "requester")
      ) {
        try {
          status = await safeWithTraceSpan(
            this.#traceService,
            "perception",
            "Minecraft状態を観測",
            {
              summary: "現在のMinecraft状態を観測",
              resultKind: "minecraft_state_delta",
              summarizeResult: () => "現在状態を観測",
            },
            () => this.#game.observeStatus(),
          );
        } catch {
          // A status question still receives an honest, bounded answer when
          // observation is temporarily unavailable.
        }
      }
      if (questionGeneration !== this.#generation) return false;
      let preferences = DEFAULT_STATUS_PRESENTATION;
      try {
        preferences =
          (await this.#contextFactory.readOwnerStatusPreferences?.(username)) ??
          DEFAULT_STATUS_PRESENTATION;
      } catch {
        // Status reporting stays available when optional memory reads fail.
      }
      if (questionGeneration !== this.#generation) return false;
      const reply =
        armorQuestion !== null
          ? `${vitalsQuestion === null ? "" : renderVitalsAnswer(vitalsQuestion, status)}${renderArmorAnswer(armorQuestion, status)}`
          : vitalsQuestion === null
            ? status === undefined
              ? "現在のMinecraft状態を確認できません。再観測が必要です。"
              : renderReadOnlyStatus(status, preferences)
            : renderVitalsAnswer(vitalsQuestion, status);
      const delivery = (async (): Promise<boolean> => {
        const delivered = await safeWithTraceSpan(
          this.#traceService,
          "response",
          "状態質問への応答",
          {
            summary: "確認済み状態を送信",
            resultKind: "final_response",
            summarizeResult: () => "確認済み状態を送信",
          },
          async () => {
            if (questionGeneration !== this.#generation) return false;
            await this.#game.say(reply);
            return true;
          },
        );
        if (delivered) {
          this.#armorFollowupUntil =
            armorQuestion === "bot" && hasWearableCarriedArmor(status)
              ? Date.now() + 2 * 60_000
              : 0;
          recorder.recordDeliveredOwnerExchange?.(username, message, reply);
        }
        return delivered;
      })();
      this.#readOnlyStatusDeliveries.add(delivery);
      try {
        return await delivery;
      } finally {
        this.#readOnlyStatusDeliveries.delete(delivery);
      }
    };
    try {
      const delivered =
        session === undefined
          ? await process()
          : await safeWithTrace(this.#traceService, session, process);
      await safeCompleteTrace(
        session,
        delivered ? "succeeded" : "cancelled",
        delivered ? "状態質問へ応答" : "停止指示を優先",
      );
    } catch (error) {
      this.#logger.error(
        {
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "read-only status question failed",
      );
      await safeCompleteTrace(session, "failed", "状態質問への応答に失敗");
      throw error;
    }
  }

  async #respondToHostiles(
    username: string,
    message: string,
  ): Promise<RuntimeReassessmentRunOutcome> {
    const controller = new AbortController();
    this.#activeController = controller;
    this.#activeRequestKind = "owner_message";
    const recorder = this.#agent as unknown as DeliveredReplyRecorder;
    recorder.beginOwnerRequest?.(username, message);
    const session = await safeStartTrace(
      this.#traceService,
      "敵対対象への対処依頼を受信",
      "owner_message",
    );
    try {
      const report = await safeWithTraceSpan(
        this.#traceService,
        "minecraft_action",
        "敵対対象への対処",
        { summary: "観測に応じた攻撃または退避" },
        () =>
          this.#game.respondToHostiles(
            isHostileEvadeIntent(message) ? "evade" : "eliminate",
            controller.signal,
          ),
      );
      if (controller.signal.aborted) {
        await safeCompleteTrace(session, "cancelled", "停止を優先");
        return "cancelled";
      }
      await this.#game.say(report.summary);
      recorder.recordDeliveredOwnerExchange?.(
        username,
        message,
        report.summary,
      );
      await safeCompleteTrace(
        session,
        report.outcome === "completed" ? "succeeded" : "failed",
        "ゲーム内で観測した対処結果を送信",
      );
      return report.outcome === "completed" ? "completed" : "failed";
    } catch (error) {
      if (controller.signal.aborted) {
        await safeCompleteTrace(session, "cancelled", "停止を優先");
        return "cancelled";
      }
      this.#logger.error(
        { errorType: error instanceof Error ? error.name : "UnknownError" },
        "hostile response failed",
      );
      const summary =
        "敵への対処中に操作を完了できませんでした。現在位置と周囲の危険を再確認してください。";
      await this.#game.say(summary);
      recorder.recordDeliveredOwnerExchange?.(username, message, summary);
      await safeCompleteTrace(session, "failed", "敵への対処に失敗");
      return "failed";
    } finally {
      if (this.#activeController === controller) {
        this.#activeController = undefined;
        this.#activeRequestKind = undefined;
      }
    }
  }

  async #deliberate(
    username: string,
    message: string,
    requestKind: ToolContext["requestKind"],
    reassessment?: RuntimeReassessmentContext,
    acceptedCorrelationId?: string,
    ownerTurnContext?: { readonly recentBotArmorStatus: boolean },
  ): Promise<RuntimeReassessmentRunOutcome> {
    const controller = new AbortController();
    this.#activeController = controller;
    this.#activeRequestKind = requestKind;
    const recorder = this.#agent as unknown as DeliveredReplyRecorder;
    const conversationRequestId =
      requestKind === "owner_message"
        ? recorder.beginOwnerRequest?.(username, message)
        : undefined;
    const reassessmentAttributes =
      reassessment === undefined
        ? {}
        : {
            runtimeEvent: reassessment.event,
            runtimeStateKey: reassessment.stateKey,
            ...(reassessment.causeKey === undefined
              ? {}
              : { runtimeCauseKey: reassessment.causeKey }),
          };
    const session = await safeStartTrace(
      this.#traceService,
      requestKind === "runtime_reassessment"
        ? "runtime再評価を受信"
        : "利用者依頼を受信",
      requestKind,
      reassessmentAttributes,
    );
    const withinSession = <T>(operation: () => Promise<T>): Promise<T> =>
      session === undefined
        ? operation()
        : safeWithTrace(this.#traceService, session, operation);
    const process = async (): Promise<void> => {
      const correlationId = acceptedCorrelationId ?? createCorrelationId();
      await runWithCorrelation(correlationId, async () => {
        const context = await this.#contextFactory.create(
          username,
          message,
          controller.signal,
          correlationId,
          requestKind,
          ownerTurnContext,
        );
        const reply = await this.#agent.deliberate({
          message,
          ...context,
          ...(conversationRequestId === undefined
            ? {}
            : { conversationRequestId }),
        });
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? new Error("REQUEST_ABORTED");
        }
        const deliveredText =
          requestKind === "runtime_reassessment" &&
          context.toolContext.behaviorNotificationOneSentence === true
            ? oneSentenceNotification(reply.text)
            : reply.text;
        await safeWithTraceSpan(
          this.#traceService,
          "response",
          "利用者向け応答",
          {
            summary: "最終応答を送信",
            resultKind: "final_response",
            summarizeResult: () => "最終応答を送信",
          },
          () => this.#game.say(deliveredText),
        );
        const deliveredRequestId =
          reply.conversationRequestId ?? conversationRequestId;
        if (deliveredRequestId === undefined) {
          recorder.recordDeliveredReply?.(username, requestKind, deliveredText);
        } else {
          recorder.recordDeliveredReply?.(
            username,
            requestKind,
            deliveredText,
            deliveredRequestId,
          );
        }
      });
    };
    try {
      const tracedProcess =
        requestKind === "runtime_reassessment"
          ? () =>
              safeWithTraceSpan(
                this.#traceService,
                "recovery",
                "runtime状態を再評価",
                {
                  summary: "接続・安全状態を再評価",
                  attributes: reassessmentAttributes,
                },
                process,
              )
          : process;
      await withinSession(tracedProcess);
      await safeCompleteTrace(session, "succeeded", "応答を送信");
      return "completed";
    } catch (error) {
      if (controller.signal.aborted) {
        await withinSession(() =>
          safeWithTraceSpan(
            this.#traceService,
            "cancellation",
            "会話処理を中断",
            {
              summary: "停止または終了指示を処理",
            },
            async () => undefined,
          ),
        );
        await safeCompleteTrace(session, "cancelled", "処理を中断");
        return "cancelled";
      }
      this.#logger.error(
        {
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "deliberation failed",
      );
      try {
        const errorText =
          "会話処理に失敗しました。直前のMinecraft状態と作業結果を再確認してください。";
        await withinSession(() =>
          safeWithTraceSpan(
            this.#traceService,
            "response",
            "エラー応答",
            {
              summary: "処理失敗を通知",
              resultKind: "final_response",
              summarizeResult: () => "処理失敗を通知",
            },
            () => this.#game.say(errorText),
          ),
        );
        if (conversationRequestId === undefined) {
          recorder.recordDeliveredReply?.(username, requestKind, errorText);
        } else {
          recorder.recordDeliveredReply?.(
            username,
            requestKind,
            errorText,
            conversationRequestId,
          );
        }
      } finally {
        await safeCompleteTrace(session, "failed", "処理に失敗");
      }
      return "failed";
    } finally {
      if (this.#activeController === controller) {
        this.#activeController = undefined;
        this.#activeRequestKind = undefined;
      }
    }
  }
}

export function isImmediateStopCommand(message: string): boolean {
  const normalized = message.trim().replace(/\s+/gu, " ");
  return splitStopClauses(normalized).some(isStopClause);
}
