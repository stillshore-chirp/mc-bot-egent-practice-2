import { config as loadEnvironmentFile } from "dotenv";

import type { CompanionApplication } from "./app/application.js";
import { ConfigurationError, loadConfig } from "./config/load-config.js";
import { registerGracefulShutdown } from "./runtime/shutdown.js";

loadEnvironmentFile({ path: ".env.local", quiet: true });
loadEnvironmentFile({ path: ".env", override: false, quiet: true });

let application: CompanionApplication | undefined;
let unregisterShutdown: (() => void) | undefined;

try {
  const loadedConfig = loadConfig();
  const { createApplication } = await import("./app/application.js");
  const app = createApplication(loadedConfig);
  application = app;
  unregisterShutdown = registerGracefulShutdown(() => app.shutdown());
  await app.start();
} catch (error) {
  unregisterShutdown?.();
  await application?.shutdown("startup_failed");
  process.stderr.write(`${safeStartupError(error)}\n`);
  process.exitCode = 1;
}

function safeStartupError(error: unknown): string {
  if (error instanceof ConfigurationError) return error.message;
  return `起動に失敗しました（${error instanceof Error ? error.name : "UnknownError"}）。設定と安全な構造化ログを確認してください。`;
}
