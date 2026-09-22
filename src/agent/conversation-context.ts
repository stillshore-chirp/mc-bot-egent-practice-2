export type ConversationRole = "user" | "assistant";

export interface ConversationTurn {
  readonly role: ConversationRole;
  readonly text: string;
}

export interface ConversationPreferences {
  readonly concise: boolean;
  readonly avoidJargon: boolean;
}

export interface ConversationSnapshot {
  readonly turns: readonly ConversationTurn[];
  readonly preferences: ConversationPreferences;
}

const MAX_TURNS = 8;
const MAX_TURN_LENGTH = 400;

const DEFAULT_PREFERENCES: ConversationPreferences = {
  concise: false,
  avoidJargon: false,
};

function compactText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").slice(0, MAX_TURN_LENGTH);
}

function mentionsAvoidJargon(message: string): boolean {
  return (
    /(専門用語|内部用語|エラーコード|コード名)/u.test(message) &&
    /(使わない|使わず|避け|なし|やめて|出さない)/u.test(message)
  );
}

function requestsJargon(message: string): boolean {
  return (
    /(専門用語|内部用語|エラーコード|コード名)/u.test(message) &&
    /(使って|使い|含めて|詳しいコード)/u.test(message)
  );
}

function requestsConcise(message: string): boolean {
  return /(短く|簡潔に|手短に|ひとことで|長くしない|要点だけ)/u.test(message);
}

function requestsDetailed(message: string): boolean {
  return /(詳しく|詳細に|長めに|丁寧に|理由も説明)/u.test(message);
}

export function updateConversationPreferences(
  previous: ConversationPreferences,
  message: string,
): ConversationPreferences {
  const normalized = compactText(message);
  return {
    concise: requestsDetailed(normalized)
      ? false
      : requestsConcise(normalized) || previous.concise,
    avoidJargon: requestsJargon(normalized)
      ? false
      : mentionsAvoidJargon(normalized) || previous.avoidJargon,
  };
}

interface ConversationState {
  turns: ConversationTurn[];
  preferences: ConversationPreferences;
}

/**
 * Keeps only a short, in-memory conversation window. It deliberately does
 * not persist raw chat in MemoryStore or trace data.
 */
export class ConversationContextStore {
  readonly #sessions = new Map<string, ConversationState>();

  public snapshot(key: string): ConversationSnapshot {
    const state = this.#sessions.get(key);
    if (state === undefined) {
      return { turns: [], preferences: DEFAULT_PREFERENCES };
    }
    return {
      turns: [...state.turns],
      preferences: state.preferences,
    };
  }

  public previewUser(key: string, message: string): ConversationSnapshot {
    const snapshot = this.snapshot(key);
    return {
      ...snapshot,
      preferences: updateConversationPreferences(snapshot.preferences, message),
    };
  }

  public recordUser(key: string, message: string): void {
    const state = this.#state(key);
    state.preferences = updateConversationPreferences(
      state.preferences,
      message,
    );
    this.#append(state, { role: "user", text: message });
  }

  public recordAssistant(key: string, message: string): void {
    this.#append(this.#state(key), { role: "assistant", text: message });
  }

  #state(key: string): ConversationState {
    const existing = this.#sessions.get(key);
    if (existing !== undefined) return existing;
    const created: ConversationState = {
      turns: [],
      preferences: DEFAULT_PREFERENCES,
    };
    this.#sessions.set(key, created);
    return created;
  }

  #append(state: ConversationState, turn: ConversationTurn): void {
    const text = compactText(turn.text);
    if (text.length === 0) return;
    state.turns.push({ role: turn.role, text });
    if (state.turns.length > MAX_TURNS) {
      state.turns.splice(0, state.turns.length - MAX_TURNS);
    }
  }
}

export function renderConversationContext(
  snapshot: ConversationSnapshot,
): string {
  const lines = [
    "直近の会話は今回の依頼を理解するための参照文脈です。古い依頼を勝手に再実行せず、今回の発話で継続が明らかな場合だけ対象を引き継いでください。",
  ];
  if (snapshot.turns.length === 0) {
    lines.push("直近の会話履歴はありません。");
  } else {
    lines.push("直近の会話:");
    for (const turn of snapshot.turns) {
      lines.push(`${turn.role === "user" ? "利用者" : "Bot"}: ${turn.text}`);
    }
  }
  if (snapshot.preferences.concise) {
    lines.push("利用者の説明方法の希望: 短く要点だけ話す。");
  }
  if (snapshot.preferences.avoidJargon) {
    lines.push(
      "利用者の説明方法の希望: 内部名や専門用語を使わず、平易に話す。",
    );
  }
  return lines.join("\n");
}
