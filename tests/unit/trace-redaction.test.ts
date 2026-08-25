import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { TRACE_SCHEMA_VERSION } from "../../src/trace/contracts.js";
import {
  presenterSafeEvent,
  sanitizeTraceAttributes,
  sanitizeTraceText,
} from "../../src/trace/redaction.js";

describe("trace redaction", () => {
  it("removes blocked attributes and masks identifiers, coordinates, addresses, and secrets", () => {
    expect(
      sanitizeTraceAttributes({
        requestKind: "owner_chat",
        username: "private-user",
        position: "1, 64, -8",
        token: "secret",
      }),
    ).toEqual({ requestKind: "owner_chat" });
    const id = randomUUID();
    const sanitized = sanitizeTraceText(
      `sk-proj-abcdefghijklmnop at 192.168.1.2 ${id} (1, 64, -8)`,
    );
    expect(sanitized).toContain("[REDACTED_SECRET]");
    expect(sanitized).toContain("[REDACTED_ADDRESS]");
    expect(sanitized).toContain("[REDACTED_ID]");
    expect(sanitized).toContain("[REDACTED_POSITION]");
    expect(sanitized).not.toContain(id);
  });

  it("removes internal references, token metrics, and attributes in presenter output", () => {
    const traceId = randomUUID();
    const spanId = randomUUID();
    const safe = presenterSafeEvent({
      schemaVersion: TRACE_SCHEMA_VERSION,
      eventId: randomUUID(),
      traceId,
      spanId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: "span.succeeded",
      attributes: { requestKind: "owner_chat" },
      span: {
        schemaVersion: TRACE_SCHEMA_VERSION,
        traceId,
        spanId,
        sequence: 1,
        stage: "deliberation",
        name: "判断",
        status: "succeeded",
        endedAt: new Date().toISOString(),
        inputRefs: [randomUUID()],
        outputRefs: [randomUUID()],
        memoryRefs: [randomUUID()],
        metrics: {
          durationMs: 12,
          inputTokens: 200,
          outputTokens: 40,
        },
        attributes: { model: "internal" },
        sensitivity: "internal",
      },
    });

    expect(safe.attributes).toBeUndefined();
    expect(safe.span?.inputRefs).toBeUndefined();
    expect(safe.span?.outputRefs).toBeUndefined();
    expect(safe.span?.memoryRefs).toBeUndefined();
    expect(safe.span?.attributes).toBeUndefined();
    expect(safe.span?.metrics).toEqual({ durationMs: 12 });
  });
});
