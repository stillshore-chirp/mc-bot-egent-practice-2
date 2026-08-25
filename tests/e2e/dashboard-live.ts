import { createInterface } from "node:readline/promises";

import { config as loadEnvironmentFile } from "dotenv";

import type { CompanionApplication } from "../../src/app/application.js";
import {
  ConfigurationError,
  loadConfig,
} from "../../src/config/load-config.js";
import {
  cognitiveTraceRunSchema,
  cognitiveTraceSpanSchema,
  type CognitiveStage,
  type CognitiveTraceRun,
  type TraceStatus,
} from "../../src/trace/contracts.js";

interface DashboardScenario {
  readonly instruction: string;
  readonly requiredStages: readonly CognitiveStage[];
  readonly terminalStatuses?: readonly TraceStatus[] | undefined;
  readonly requiresResult?: boolean | undefined;
  readonly operatorOnly?: boolean | undefined;
}

const scenarios: readonly DashboardScenario[] = [
  {
    instruction: "日本語の会話だけを行い、応答traceを画面で確認する",
    requiredStages: ["request", "context", "deliberation", "response"],
    terminalStatuses: ["succeeded"],
    requiresResult: true,
  },
  {
    instruction: "保存済み記憶を検索して応答し、memory_readを確認する",
    requiredStages: ["request", "memory_read", "deliberation", "response"],
    terminalStatuses: ["succeeded"],
  },
  {
    instruction:
      "許可済みtest worldで原木収集、帰還、inventoryと距離の検証、応答、記憶更新を行う",
    requiredStages: [
      "request",
      "perception",
      "memory_read",
      "context",
      "deliberation",
      "tool",
      "skill",
      "minecraft_action",
      "verification",
      "response",
      "memory_write",
    ],
    terminalStatuses: ["succeeded", "failed"],
    requiresResult: true,
  },
  {
    instruction: "実toolまたはskillのfailure / retry経路を発生させて確認する",
    requiredStages: ["tool"],
    terminalStatuses: ["failed"],
  },
  {
    instruction: "実行中の作業へ停止指示を送りcancellationを確認する",
    requiredStages: ["cancellation"],
    terminalStatuses: ["cancelled"],
  },
  {
    instruction: "許可済みの危険条件でreflex割り込みを確認する",
    requiredStages: ["reflex"],
    terminalStatuses: ["succeeded", "failed"],
  },
  {
    instruction: "明示した情報または検証済み結果を記憶へ保存する",
    requiredStages: ["memory_write"],
    terminalStatuses: ["succeeded"],
    requiresResult: true,
  },
  {
    instruction: "完了した実traceをReplayし、seek / step / speedを確認する",
    requiredStages: [],
    operatorOnly: true,
  },
  {
    instruction:
      "Presenter ModeでRecorded real trace、redaction、fullscreenを確認する",
    requiredStages: [],
    operatorOnly: true,
  },
  {
    instruction: "live stream切断と復帰、backfill、gap表示を確認する",
    requiredStages: [],
    operatorOnly: true,
  },
] as const;

type ScenarioStatus = "pass" | "fail" | "skip";

loadEnvironmentFile({ path: ".env.local", quiet: true });
loadEnvironmentFile({ path: ".env", override: false, quiet: true });

let application: CompanionApplication | undefined;
const terminal = createInterface({
  input: process.stdin,
  output: process.stdout,
});

try {
  requireLivePreflight();
  const config = loadConfig();
  const { createApplication } = await import("../../src/app/application.js");
  application = createApplication(config);
  await application.start();
  const dashboardUrl = dashboardBaseUrl(
    config.dashboard.host,
    config.dashboard.port,
  );
  const authorization = config.dashboard.authToken;
  process.stdout.write(
    "dashboard実環境sessionを開始しました。各操作を実worldと実画面で行い、観測結果だけを入力してください。\n",
  );

  const results = [];
  for (const [index, scenario] of scenarios.entries()) {
    const notBefore = new Date().toISOString();
    const operatorStatus = await readStatus(
      `${String(index + 1)}. ${scenario.instruction} [pass/fail/skip]: `,
    );
    const evidence =
      operatorStatus === "pass"
        ? await collectSafeEvidence(
            dashboardUrl,
            authorization,
            scenario,
            notBefore,
          ).catch(() => undefined)
        : undefined;
    const evidenceSatisfied = evidence?.matched === true;
    results.push({
      scenario: index + 1,
      status:
        operatorStatus === "pass" && !evidenceSatisfied
          ? ("fail" as const)
          : operatorStatus,
      evidence: evidence ?? {
        dashboardAvailable: false,
        matched: false,
        stageCount: 0,
        eventCount: 0,
        resultCount: 0,
        terminal: false,
      },
    });
  }

  const passed = results.filter(({ status }) => status === "pass").length;
  const failed = results.filter(({ status }) => status === "fail").length;
  const skipped = results.filter(({ status }) => status === "skip").length;
  process.stdout.write(
    `${JSON.stringify({ evidence: "operator_and_persisted_dashboard_trace", passed, failed, skipped, results })}\n`,
  );
  if (failed > 0 || skipped > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${safeE2EError(error)}\n`);
  process.exitCode = 1;
} finally {
  terminal.close();
  await application?.shutdown("dashboard_live_e2e_finished");
}

function requireLivePreflight(): void {
  if (process.env.LIVE_E2E_CONFIRMED !== "true") {
    throw new Error("LIVE_E2E_PREFLIGHT_NOT_CONFIRMED");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("LIVE_E2E_REQUIRES_INTERACTIVE_TERMINAL");
  }
}

async function readStatus(prompt: string): Promise<ScenarioStatus> {
  for (;;) {
    const answer = (await terminal.question(prompt)).trim().toLowerCase();
    if (answer === "pass" || answer === "fail" || answer === "skip") {
      return answer;
    }
    process.stdout.write("pass、fail、skipのいずれかを入力してください。\n");
  }
}

async function collectSafeEvidence(
  baseUrl: string,
  token: string | undefined,
  scenario: DashboardScenario,
  notBefore: string,
): Promise<{
  readonly dashboardAvailable: boolean;
  readonly matched: boolean;
  readonly stageCount: number;
  readonly eventCount: number;
  readonly resultCount: number;
  readonly terminal: boolean;
}> {
  const headers = dashboardHeaders(token);
  const response = await fetch(`${baseUrl}/api/traces?limit=20`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("DASHBOARD_E2E_API_UNAVAILABLE");
  const payload = (await response.json()) as { readonly traces?: unknown };
  const runs = (
    Array.isArray(payload.traces)
      ? payload.traces.map((value) => cognitiveTraceRunSchema.parse(value))
      : []
  ).filter(
    (run) => scenario.operatorOnly === true || run.startedAt >= notBefore,
  );
  for (const run of runs) {
    const detail = await getSafeTraceDetail(baseUrl, headers, run);
    const stages = new Set(detail.stages);
    const stageMatch = scenario.requiredStages.every((stage) =>
      stages.has(stage),
    );
    const terminalMatch =
      scenario.terminalStatuses === undefined ||
      scenario.terminalStatuses.includes(run.status);
    const resultMatch =
      scenario.requiresResult !== true || detail.resultCount > 0;
    if (stageMatch && terminalMatch && resultMatch) {
      return {
        dashboardAvailable: true,
        matched: true,
        stageCount: stages.size,
        eventCount: run.eventCount,
        resultCount: detail.resultCount,
        terminal: isTerminal(run.status),
      };
    }
  }
  return {
    dashboardAvailable: true,
    matched: scenario.operatorOnly === true && runs.length > 0,
    stageCount: 0,
    eventCount: 0,
    resultCount: 0,
    terminal: false,
  };
}

async function getSafeTraceDetail(
  baseUrl: string,
  headers: HeadersInit,
  run: CognitiveTraceRun,
): Promise<{
  readonly stages: readonly CognitiveStage[];
  readonly resultCount: number;
}> {
  const response = await fetch(`${baseUrl}/api/traces/${run.traceId}`, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("DASHBOARD_E2E_TRACE_UNAVAILABLE");
  const payload = (await response.json()) as {
    readonly spans?: unknown;
    readonly results?: unknown;
  };
  const spans = Array.isArray(payload.spans)
    ? payload.spans.map((value) => cognitiveTraceSpanSchema.parse(value))
    : [];
  return {
    stages: spans.map(({ stage }) => stage),
    resultCount: Array.isArray(payload.results) ? payload.results.length : 0,
  };
}

function dashboardBaseUrl(host: string, port: number): string {
  const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = browserHost.includes(":")
    ? `[${browserHost}]`
    : browserHost;
  return `http://${formattedHost}:${String(port)}`;
}

function dashboardHeaders(token: string | undefined): HeadersInit {
  return token === undefined
    ? { accept: "application/json" }
    : { accept: "application/json", authorization: `Bearer ${token}` };
}

function isTerminal(status: TraceStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled"
  );
}

function safeE2EError(error: unknown): string {
  if (error instanceof ConfigurationError) return error.message;
  if (error instanceof Error && error.message.startsWith("LIVE_E2E_")) {
    return error.message;
  }
  return `DASHBOARD_LIVE_E2E_FAILED:${error instanceof Error ? error.name : "UnknownError"}`;
}
