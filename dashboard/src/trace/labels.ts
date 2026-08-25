import type { CognitiveStage, TraceResultKind, TraceStatus } from "@trace";

export const stageLabels: Record<CognitiveStage, string> = {
  request: "依頼",
  perception: "知覚",
  memory_read: "記憶検索",
  context: "コンテキスト",
  deliberation: "判断",
  plan: "計画",
  tool: "Tool選択",
  skill: "Skill実行",
  minecraft_action: "Minecraft操作",
  verification: "検証",
  memory_write: "記憶更新",
  response: "応答",
  reflex: "即時対応",
  cancellation: "キャンセル",
  recovery: "回復",
  system: "システム",
};

export const statusLabels: Record<TraceStatus, string> = {
  queued: "待機中",
  running: "実行中",
  waiting: "保留中",
  succeeded: "成功",
  failed: "失敗",
  cancelled: "キャンセル済み",
  skipped: "スキップ",
};

export const statusSymbols: Record<TraceStatus, string> = {
  queued: "○",
  running: "●",
  waiting: "◌",
  succeeded: "✓",
  failed: "!",
  cancelled: "×",
  skipped: "—",
};

export const resultKindLabels: Record<TraceResultKind, string> = {
  selected_tool: "選択したTool",
  tool_result: "Tool結果",
  skill_result: "Skill結果",
  minecraft_state_delta: "Minecraft状態差分",
  verification_result: "検証結果",
  memory_update_result: "記憶更新結果",
  final_response: "最終応答",
};

export const stageLanes: Record<CognitiveStage, string> = {
  request: "input",
  perception: "perception",
  memory_read: "memory",
  context: "memory",
  deliberation: "deliberation",
  plan: "deliberation",
  tool: "tool",
  skill: "tool",
  minecraft_action: "minecraft",
  verification: "verification",
  memory_write: "memory-write",
  response: "response",
  reflex: "safety",
  cancellation: "safety",
  recovery: "safety",
  system: "system",
};

export const stageColors: Record<CognitiveStage, string> = {
  request: "#86b8ff",
  perception: "#5eead4",
  memory_read: "#b8a4ff",
  context: "#9a86ff",
  deliberation: "#ffcf70",
  plan: "#f6b26b",
  tool: "#f09b6e",
  skill: "#f38ba8",
  minecraft_action: "#e879f9",
  verification: "#67e8f9",
  memory_write: "#a7f3d0",
  response: "#c4b5fd",
  reflex: "#fb7185",
  cancellation: "#fda4af",
  recovery: "#fde68a",
  system: "#94a3b8",
};

export function formatDate(value: string | undefined): string {
  if (value === undefined) return "時刻不明";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "時刻不明";
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function formatDuration(
  startedAt: string | undefined,
  endedAt: string | undefined,
): string {
  if (startedAt === undefined) return "—";
  const start = Date.parse(startedAt);
  const end = endedAt === undefined ? Date.now() : Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  const milliseconds = Math.max(0, end - start);
  return milliseconds < 1_000
    ? `${String(milliseconds)}ms`
    : `${(milliseconds / 1_000).toFixed(1)}s`;
}

export function truncate(value: string | undefined, length = 180): string {
  if (value === undefined || value.length <= length) return value ?? "—";
  return `${value.slice(0, Math.max(0, length - 1))}…`;
}
