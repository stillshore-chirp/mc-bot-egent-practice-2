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
    limits: {
      maxMoveDistance: env.MAX_MOVE_DISTANCE,
      maxGatherCount: env.MAX_GATHER_COUNT,
      taskTimeoutMs: env.TASK_TIMEOUT_MS,
      skillRetryLimit: env.SKILL_RETRY_LIMIT,
      followDistance: env.FOLLOW_DISTANCE,
      hungerThreshold: env.HUNGER_THRESHOLD,
      memoryContextLimit: env.MEMORY_CONTEXT_LIMIT,
    },
    reconnect: {
      enabled: env.RECONNECT_ENABLED,
      maxAttempts: env.RECONNECT_MAX_ATTEMPTS,
      delayMs: env.RECONNECT_DELAY_MS,
    },
  };
}
