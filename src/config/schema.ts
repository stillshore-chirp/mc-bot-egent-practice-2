import { z } from "zod";

import { sameMinecraftIdentity } from "../domain/minecraft-identity.js";

const integerFromEnvironment = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const optionalTrimmedEnvironment = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0 ? undefined : value,
  z.string().trim().optional(),
);

export const environmentSchema = z
  .object({
    MINECRAFT_HOST: z.string().trim().min(1),
    MINECRAFT_PORT: integerFromEnvironment(1, 65_535).default(25_565),
    MINECRAFT_USERNAME: z.string().trim().min(1),
    MINECRAFT_AUTH: z.enum(["microsoft", "offline"]).default("microsoft"),
    MINECRAFT_VERSION: z.string().trim().default("1.21.11"),
    OWNER_USERNAME: z.string().trim().min(1),
    OPENAI_API_KEY: z.string().trim().min(1),
    OPENAI_MODEL: z.string().trim().default("gpt-6-luna"),
    DATABASE_PATH: z.string().trim().default("data/companion.sqlite"),
    PERSONA_PATH: z.string().trim().default("config/persona.example.json"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    CONNECT_TIMEOUT_MS: integerFromEnvironment(1_000, 300_000).default(60_000),
    MEMORY_CONTEXT_LIMIT: integerFromEnvironment(1, 50).default(12),
    DASHBOARD_ENABLED: booleanFromEnvironment.default(true),
    DASHBOARD_HOST: z.string().trim().default("127.0.0.1"),
    DASHBOARD_PORT: integerFromEnvironment(1, 65_535).default(4_310),
    DASHBOARD_AUTH_TOKEN: optionalTrimmedEnvironment,
    RECONNECT_ENABLED: booleanFromEnvironment.default(true),
    RECONNECT_MAX_ATTEMPTS: integerFromEnvironment(0, 20).default(5),
    RECONNECT_DELAY_MS: integerFromEnvironment(250, 60_000).default(5_000),
  })
  .superRefine((environment, context) => {
    if (
      sameMinecraftIdentity(
        environment.MINECRAFT_USERNAME,
        environment.OWNER_USERNAME,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["OWNER_USERNAME"],
        message: "owner and Bot must use different Minecraft identities",
      });
    }
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(
      environment.DASHBOARD_HOST,
    );
    if (
      environment.DASHBOARD_AUTH_TOKEN !== undefined &&
      environment.DASHBOARD_AUTH_TOKEN.length < 32
    ) {
      context.addIssue({
        code: "custom",
        path: ["DASHBOARD_AUTH_TOKEN"],
        message: "dashboard token must contain at least 32 characters",
      });
    }
    if (!loopback) {
      context.addIssue({
        code: "custom",
        path: ["DASHBOARD_HOST"],
        message: "dashboard only supports loopback binding",
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export interface AppConfig {
  readonly minecraft: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly auth: "microsoft" | "offline";
    readonly version: string;
  };
  readonly ownerUsername: string;
  readonly openai: {
    readonly apiKey: string;
    readonly model: string;
  };
  readonly databasePath: string;
  readonly personaPath: string;
  readonly logLevel: Environment["LOG_LEVEL"];
  readonly connection: {
    readonly timeoutMs: number;
    readonly reconnectEnabled: boolean;
    readonly reconnectMaxAttempts: number;
    readonly reconnectDelayMs: number;
  };
  readonly memoryContextLimit: number;
  readonly dashboard: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly authToken?: string | undefined;
  };
}
