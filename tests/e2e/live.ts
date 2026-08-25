import { createInterface } from "node:readline/promises";

import { config as loadEnvironmentFile } from "dotenv";

import type { CompanionApplication } from "../../src/app/application.js";
import {
  ConfigurationError,
  loadConfig,
} from "../../src/config/load-config.js";

const scenarios = [
  "botが独立したplayerとして接続した",
  "指定利用者の日本語chatを認識し日本語で応答した",
  "指定利用者を安全な距離で追従した",
  "停止指示で移動または長時間作業を即時中断した",
  "空腹を観測して安全な食料を摂取した",
  "利用者が明示した情報だけを構造化記憶へ保存した",
  "process再起動後に構造化記憶を復元した",
  "指定種類・指定数の原木を収集した",
  "依頼者の再観測位置へ帰還した",
  "inventory差分に基づいて実収集数を報告した",
  "resource・path・timeout・cancelの失敗を確認済み状態とともに報告した",
  "切断後に設定上限内で復帰するか明示的な失敗状態になった",
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
  let activeApplication = createApplication(config);
  application = activeApplication;
  await activeApplication.start();
  process.stdout.write(
    "実環境sessionを開始しました。各操作をMinecraftで実行し、観測結果だけを記録してください。\n",
  );

  const results: {
    readonly scenario: number;
    readonly status: ScenarioStatus;
    readonly evidence: Awaited<
      ReturnType<CompanionApplication["collectLiveEvidence"]>
    >;
  }[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    if (index === 6) {
      process.stdout.write(
        "永続記憶の復元確認のため、bot process相当のapplicationを再起動します。\n",
      );
      await activeApplication.shutdown("live_e2e_restart");
      activeApplication = createApplication(config);
      application = activeApplication;
      await activeApplication.start();
    }
    const status = await readStatus(
      `${String(index + 1)}. ${scenario} [pass/fail/skip]: `,
    );
    results.push({
      scenario: index + 1,
      status,
      evidence: await activeApplication.collectLiveEvidence(),
    });
  }
  const passed = results.filter(({ status }) => status === "pass").length;
  const failed = results.filter(({ status }) => status === "fail").length;
  const skipped = results.filter(({ status }) => status === "skip").length;
  process.stdout.write(
    `${JSON.stringify({ evidence: "operator_observed_live_environment", passed, failed, skipped, results })}\n`,
  );
  if (failed > 0 || skipped > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${safeE2EError(error)}\n`);
  process.exitCode = 1;
} finally {
  terminal.close();
  await application?.shutdown("live_e2e_finished");
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

function safeE2EError(error: unknown): string {
  if (error instanceof ConfigurationError) return error.message;
  if (error instanceof Error && error.message.startsWith("LIVE_E2E_")) {
    return error.message;
  }
  return `LIVE_E2E_START_FAILED:${error instanceof Error ? error.name : "UnknownError"}`;
}
