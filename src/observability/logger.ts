import pino, { type Logger } from "pino";

import type { AppConfig } from "../config/schema.js";
import { currentCorrelationId } from "./correlation.js";

const REDACTED_PATHS = [
  "apiKey",
  "openai.apiKey",
  "config.openai.apiKey",
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
    mixin: () => {
      const correlationId = currentCorrelationId();
      return correlationId === undefined ? {} : { correlationId };
    },
    redact: {
      paths: [...REDACTED_PATHS],
      censor: "[REDACTED]",
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  });
}

export function childLogger(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId });
}
