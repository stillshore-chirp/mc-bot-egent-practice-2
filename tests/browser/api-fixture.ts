import type { Page, Route } from "@playwright/test";

import { bundle, detail, events, run, traces } from "./fixtures/trace";

export interface DashboardApiFixtureOptions {
  readonly streamBody?: string;
  readonly streamDelayMs?: number;
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
  await page.route("**/api/traces/*", (route) => json(route, detail));
  await page.route("**/api/traces/*/events", (route) =>
    json(route, { events }),
  );
  await page.route("**/api/traces/*/demo-safe", (route) => json(route, bundle));
  await page.route("**/api/traces/*/export", (route) => json(route, bundle));
  await page.route("**/api/traces/import", (route) =>
    json(route, { trace: { ...run, source: "recorded", demoSafe: true } }),
  );
  await page.route("**/api/traces", (route) => json(route, { traces }));
  await page.route("**/api/stream", async (route) => {
    if (options.streamDelayMs !== undefined)
      await new Promise((resolve) =>
        setTimeout(resolve, options.streamDelayMs),
      );
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
