import { z } from "zod";

const integerFromEnvironment = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const environmentSchema = z.object({
  MINECRAFT_HOST: z.string().trim().min(1),
  MINECRAFT_PORT: integerFromEnvironment(1, 65_535).default(25_565),
  MINECRAFT_USERNAME: z.string().trim().min(1),
  MINECRAFT_AUTH: z.enum(["microsoft", "offline"]).default("microsoft"),
  MINECRAFT_VERSION: z.string().trim().default("1.21.11"),
  OWNER_USERNAME: z.string().trim().min(1),
  OPENAI_API_KEY: z.string().trim().min(1),
  OPENAI_MODEL: z.string().trim().default("gpt-5.6-luna"),
  DATABASE_PATH: z.string().trim().default("data/companion.sqlite"),
  PERSONA_PATH: z.string().trim().default("config/persona.example.json"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  MAX_MOVE_DISTANCE: integerFromEnvironment(1, 1_024).default(128),
  MAX_GATHER_COUNT: integerFromEnvironment(1, 64).default(64),
  TASK_TIMEOUT_MS: integerFromEnvironment(1_000, 3_600_000).default(900_000),
  SKILL_RETRY_LIMIT: integerFromEnvironment(0, 10).default(2),
  FOLLOW_DISTANCE: z.coerce.number().min(2).max(16).default(3),
  HUNGER_THRESHOLD: integerFromEnvironment(1, 19).default(14),
  RECONNECT_ENABLED: booleanFromEnvironment.default(true),
  RECONNECT_MAX_ATTEMPTS: integerFromEnvironment(0, 20).default(5),
  RECONNECT_DELAY_MS: integerFromEnvironment(250, 60_000).default(5_000),
  MEMORY_CONTEXT_LIMIT: integerFromEnvironment(1, 50).default(12),
});

export type Environment = z.infer<typeof environmentSchema>;

export interface AppConfig {
  minecraft: {
    host: string;
    port: number;
    username: string;
    auth: "microsoft" | "offline";
    version: string;
  };
  ownerUsername: string;
  openai: {
    apiKey: string;
    model: string;
  };
  databasePath: string;
  personaPath: string;
  logLevel: Environment["LOG_LEVEL"];
  limits: {
    maxMoveDistance: number;
    maxGatherCount: number;
    taskTimeoutMs: number;
    skillRetryLimit: number;
    followDistance: number;
    hungerThreshold: number;
    memoryContextLimit: number;
  };
  reconnect: {
    enabled: boolean;
    maxAttempts: number;
    delayMs: number;
  };
}
