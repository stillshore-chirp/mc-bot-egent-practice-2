import type {
  CognitiveTraceEvent,
  CognitiveTraceSpan,
  TraceAttributes,
  TraceRedactionManifest,
  TraceScalar,
} from "./contracts.js";
import { TRACE_SCHEMA_VERSION } from "./contracts.js";

const PRIVATE_KEY =
  /(?:api[_-]?key|authorization|bearer|cookie|password|secret|token|username|player|owner|host|address|ip|coordinate|position|prompt|response|conversation|chat|memory[_-]?(?:value|content)|raw|header)/iu;
const SECRET_VALUE =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const UUID_IN_TEXT =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const COORDINATE_TRIPLE =
  /\(?\s*-?\d+(?:\.\d+)?\s*[,/]\s*-?\d+(?:\.\d+)?\s*[,/]\s*-?\d+(?:\.\d+)?\s*\)?/gu;
const MAX_ATTRIBUTE_COUNT = 100;
const MAX_TEXT_LENGTH = 1_000;

export function sanitizeTraceText(value: string): string {
  return value
    .slice(0, MAX_TEXT_LENGTH)
    .replace(SECRET_VALUE, "[REDACTED_SECRET]")
    .replace(IPV4, "[REDACTED_ADDRESS]")
    .replace(UUID_IN_TEXT, "[REDACTED_ID]")
    .replace(COORDINATE_TRIPLE, "[REDACTED_POSITION]");
}

export function sanitizeTraceAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): TraceAttributes | undefined {
  if (attributes === undefined) return undefined;
  const sanitized: Record<string, TraceScalar> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (Object.keys(sanitized).length >= MAX_ATTRIBUTE_COUNT) break;
    if (PRIVATE_KEY.test(key)) continue;
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      sanitized[key] = value;
      continue;
    }
    if (typeof value === "string") {
      sanitized[key] = sanitizeTraceText(value);
    }
  }
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

export function presenterSafeEvent(
  event: CognitiveTraceEvent,
): CognitiveTraceEvent {
  const span =
    event.span === undefined ? undefined : presenterSafeSpan(event.span);
  const result =
    event.result === undefined
      ? undefined
      : event.result.sensitivity === "sensitive"
        ? { ...event.result, summary: "機微情報を非表示" }
        : {
            ...event.result,
            summary: sanitizeTraceText(event.result.summary),
            ...(event.result.verificationSummary === undefined
              ? {}
              : {
                  verificationSummary: sanitizeTraceText(
                    event.result.verificationSummary,
                  ),
                }),
          };
  return {
    ...event,
    ...(event.summary === undefined
      ? {}
      : { summary: sanitizeTraceText(event.summary) }),
    ...(span === undefined ? {} : { span }),
    ...(result === undefined ? {} : { result }),
    attributes: undefined,
  };
}

export function createPresenterRedactionManifest(): TraceRedactionManifest {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    policy: "presenter-v1",
    removedFields: [
      "event.attributes",
      "span.attributes",
      "span.inputRefs",
      "span.outputRefs",
      "span.memoryRefs",
      "span.metrics.inputTokens",
      "span.metrics.outputTokens",
      "sensitive summaries",
    ],
  };
}

function presenterSafeSpan(span: CognitiveTraceSpan): CognitiveTraceSpan {
  const sensitive = span.sensitivity === "sensitive";
  const metrics =
    span.metrics === undefined
      ? undefined
      : {
          ...(span.metrics.durationMs === undefined
            ? {}
            : { durationMs: span.metrics.durationMs }),
          ...(span.metrics.modelLatencyMs === undefined
            ? {}
            : { modelLatencyMs: span.metrics.modelLatencyMs }),
          ...(span.metrics.toolCalls === undefined
            ? {}
            : { toolCalls: span.metrics.toolCalls }),
        };
  return {
    ...span,
    ...(span.summary === undefined
      ? {}
      : {
          summary: sensitive
            ? "機微情報を非表示"
            : sanitizeTraceText(span.summary),
        }),
    ...(span.decisionSummary === undefined
      ? {}
      : {
          decisionSummary: sensitive
            ? "判断要約なし"
            : sanitizeTraceText(span.decisionSummary),
        }),
    ...(span.expectedResult === undefined || sensitive
      ? {}
      : { expectedResult: sanitizeTraceText(span.expectedResult) }),
    ...(span.actualResult === undefined
      ? {}
      : {
          actualResult: sensitive
            ? "機微情報を非表示"
            : sanitizeTraceText(span.actualResult),
        }),
    ...(span.verificationResult === undefined
      ? {}
      : {
          verificationResult: sensitive
            ? "機微情報を非表示"
            : sanitizeTraceText(span.verificationResult),
        }),
    inputRefs: undefined,
    outputRefs: undefined,
    memoryRefs: undefined,
    attributes: undefined,
    ...(metrics === undefined ? {} : { metrics }),
  };
}
