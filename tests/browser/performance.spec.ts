import { expect, test } from "@playwright/test";

import type {
  CognitiveTraceDetail,
  CognitiveTraceEvent,
  CognitiveTraceRun,
  CognitiveTraceSpan,
} from "../../src/trace/contracts";
import { calculateLayout } from "../../dashboard/src/graph/layout";
import {
  emptyTraceState,
  traceReducer,
} from "../../dashboard/src/trace/reducer";

const traceId = "00000000-0000-4000-8000-000000000001";

test("deterministic layout remains bounded for 150 and 500 sanitized nodes", () => {
  const small = createSpans(150);
  const large = createSpans(500);
  const smallStart = performance.now();
  const smallLayout = calculateLayout(small, []);
  const smallElapsed = performance.now() - smallStart;
  const largeStart = performance.now();
  const first = calculateLayout(large, []);
  const largeElapsed = performance.now() - largeStart;
  const second = calculateLayout(large, []);
  expect(smallLayout.size).toBe(150);
  expect(first.size).toBe(500);
  expect([...first]).toEqual([...second]);
  expect(smallElapsed).toBeLessThan(500);
  expect(largeElapsed).toBeLessThan(1_000);
});

test("shared reducer handles 1000 ordered events without integrity drift", () => {
  const spans = createSpans(500);
  const events = createEvents(spans);
  const started = performance.now();
  const state = events.reduce(
    (current, event) => traceReducer(current, { type: "apply", event }),
    emptyTraceState,
  );
  const elapsed = performance.now() - started;
  expect(state.events).toHaveLength(1_000);
  expect(state.spans).toHaveLength(500);
  expect(state.lastSequence).toBe(1_000);
  expect(state.gaps).toEqual([]);
  expect(state.duplicateEvents).toBe(0);
  expect(elapsed).toBeLessThan(5_000);
});

test("browser renders 500 sanitized nodes and 1000 events within the UI budget", async ({
  page,
}) => {
  const spans = createSpans(500);
  const events = createEvents(spans);
  const run: CognitiveTraceRun = {
    schemaVersion: 1,
    traceId,
    rootSpanId: spans[0]?.spanId ?? id(2),
    status: "succeeded",
    requestSummary: "sanitized performance trace",
    startedAt: "2026-08-25T00:00:00.000Z",
    endedAt: "2026-08-25T00:00:10.000Z",
    lastSequence: 1_000,
    eventCount: 1_000,
    demoSafe: true,
    source: "recorded",
  };
  const detail: CognitiveTraceDetail = { run, spans, links: [], results: [] };
  await page.route("**/api/dashboard/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ observability: { state: "ok" } }),
    }),
  );
  await page.route("**/api/traces/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detail),
    }),
  );
  await page.route("**/api/traces/*/events", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events }),
    }),
  );
  await page.route("**/api/traces", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ traces: [run] }),
    }),
  );
  await page.route("**/api/stream", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
  const started = Date.now();
  await page.goto("/");
  await expect(
    page.getByRole("option", { name: /sanitized-node-1\b/ }),
  ).toBeVisible({ timeout: 10_000 });
  const elapsed = Date.now() - started;
  expect(
    await page
      .getByRole("listbox", { name: "処理ノード一覧" })
      .getByRole("option")
      .count(),
  ).toBe(500);
  expect(elapsed).toBeLessThan(5_000);
});

function createSpans(count: number): CognitiveTraceSpan[] {
  return Array.from({ length: count }, (_, index) => {
    const spanId = id(index + 2);
    return {
      schemaVersion: 1,
      traceId,
      spanId,
      ...(index === 0 ? {} : { parentSpanId: id(index + 1) }),
      sequence: index + 1,
      stage: index % 2 === 0 ? "tool" : "verification",
      name: `sanitized-node-${index + 1}`,
      status: "succeeded",
      startedAt: "2026-08-25T00:00:00.000Z",
      endedAt: "2026-08-25T00:00:00.010Z",
      summary: "sanitized test trace",
      sensitivity: "public",
    };
  });
}

function createEvents(
  spans: readonly CognitiveTraceSpan[],
): CognitiveTraceEvent[] {
  return spans.flatMap((span, index) => {
    const started: CognitiveTraceEvent = {
      schemaVersion: 1,
      eventId: id(10_000 + index * 2),
      streamId: index * 2 + 1,
      traceId,
      spanId: span.spanId,
      sequence: index * 2 + 1,
      timestamp: "2026-08-25T00:00:00.000Z",
      type: "span.started",
      span: { ...span, status: "running" },
    };
    const succeeded: CognitiveTraceEvent = {
      schemaVersion: 1,
      eventId: id(10_001 + index * 2),
      streamId: index * 2 + 2,
      traceId,
      spanId: span.spanId,
      sequence: index * 2 + 2,
      timestamp: "2026-08-25T00:00:00.010Z",
      type: "span.succeeded",
      span,
    };
    return [started, succeeded];
  });
}

function id(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
