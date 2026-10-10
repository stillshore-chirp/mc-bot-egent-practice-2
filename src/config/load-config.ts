import { environmentSchema, type AppConfig } from "./schema.js";

export class ConfigurationError extends Error {
  public constructor(public readonly issues: readonly string[]) {
    super(`設定が不正です: ${issues.join("; ")}`);
    this.name = "ConfigurationError";
  }
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }

  const env = parsed.data;
  return {
    minecraft: {
      host: env.MINECRAFT_HOST,
      port: env.MINECRAFT_PORT,
      username: env.MINECRAFT_USERNAME,
      auth: env.MINECRAFT_AUTH,
      version: env.MINECRAFT_VERSION,
    },
    ownerUsername: env.OWNER_USERNAME,
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
    },
    databasePath: env.DATABASE_PATH,
    personaPath: env.PERSONA_PATH,
    logLevel: env.LOG_LEVEL,
    connection: {
      timeoutMs: env.CONNECT_TIMEOUT_MS,
      reconnectEnabled: env.RECONNECT_ENABLED,
      reconnectMaxAttempts: env.RECONNECT_MAX_ATTEMPTS,
      reconnectDelayMs: env.RECONNECT_DELAY_MS,
    },
    memoryContextLimit: env.MEMORY_CONTEXT_LIMIT,
    dashboard: {
      enabled: env.DASHBOARD_ENABLED,
      host: env.DASHBOARD_HOST,
      port: env.DASHBOARD_PORT,
      ...(env.DASHBOARD_AUTH_TOKEN === undefined
        ? {}
        : { authToken: env.DASHBOARD_AUTH_TOKEN }),
    },
  };
}
