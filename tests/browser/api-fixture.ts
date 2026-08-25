import type { Page, Route } from "@playwright/test";

import type {
  CognitiveTraceDetail,
  CognitiveTraceEvent,
  CognitiveTraceRun,
} from "../../src/trace/contracts";

import { bundle, detail, events, run, traces } from "./fixtures/trace";

export interface DashboardApiFixtureOptions {
  readonly streamBody?: string;
  readonly streamDelayMs?: number;
  readonly onStreamEmit?: () => void;
  readonly traceDelayMs?: number;
  readonly traces?: readonly CognitiveTraceRun[];
  readonly resolveTraces?: () => readonly CognitiveTraceRun[];
  readonly resolveTrace?: (traceId: string) =>
    | {
        readonly detail: CognitiveTraceDetail;
        readonly events: readonly CognitiveTraceEvent[];
        readonly delayMs?: number;
      }
    | undefined;
}

export async function routeDashboardApi(
  page: Page,
  options: DashboardApiFixtureOptions = {},
): Promise<void> {
  await page.route("**/api/dashboard/health", (route) =>
    json(route, {
      observability: { state: "ok" },
      bot: {
        botState: "online",
        connectionState: "connected",
        aiState: "ready",
        memoryState: "ready",
        reflexState: "idle",
        taskStatus: "succeeded",
        taskPhase: "response",
        health: 20,
        food: 18,
        positionState: "available_redacted",
      },
    }),
  );
  await page.route("**/api/traces/*", async (route) => {
    const resolved = resolveTraceFixture(route, options);
    await wait(resolved?.delayMs ?? options.traceDelayMs);
    await json(route, resolved?.detail ?? detail);
  });
  await page.route("**/api/traces/*/events", async (route) => {
    const resolved = resolveTraceFixture(route, options);
    await wait(resolved?.delayMs ?? options.traceDelayMs);
    await json(route, { events: resolved?.events ?? events });
  });
  await page.route("**/api/traces/*/demo-safe", (route) => json(route, bundle));
  await page.route("**/api/traces/*/export", (route) => json(route, bundle));
  await page.route("**/api/traces/import", (route) =>
    json(route, { trace: { ...run, source: "recorded", demoSafe: true } }),
  );
  await page.route("**/api/traces", (route) =>
    json(route, {
      traces: options.resolveTraces?.() ?? options.traces ?? traces,
    }),
  );
  await page.route("**/api/stream", async (route) => {
    if (options.streamDelayMs !== undefined)
      await new Promise((resolve) =>
        setTimeout(resolve, options.streamDelayMs),
      );
    options.onStreamEmit?.();
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: options.streamBody ?? "",
    });
  });
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function wait(delayMs: number | undefined): Promise<void> {
  if (delayMs === undefined) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function resolveTraceFixture(
  route: Route,
  options: DashboardApiFixtureOptions,
): ReturnType<NonNullable<DashboardApiFixtureOptions["resolveTrace"]>> {
  const segments = new URL(route.request().url()).pathname.split("/");
  const traceId = segments[3];
  return traceId === undefined ? undefined : options.resolveTrace?.(traceId);
}
