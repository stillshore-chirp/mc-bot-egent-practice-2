import pino, { type Logger } from "pino";

import type { AppConfig } from "../config/schema.js";

const REDACTED_PATHS = [
  "apiKey",
  "openai.apiKey",
  "config.openai.apiKey",
  "authToken",
  "dashboard.authToken",
  "config.dashboard.authToken",
  "authorization",
  "headers.authorization",
  "minecraft.host",
  "minecraft.username",
  "ownerUsername",
  "playerName",
  "username",
  "conversation",
  "memory.value",
] as const;

export function createLogger(config: Pick<AppConfig, "logLevel">): Logger {
  return pino({
    level: config.logLevel,
    base: null,
    redact: {
      paths: [...REDACTED_PATHS],
      censor: "[REDACTED]",
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  });
}
