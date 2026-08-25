import { resolve } from "node:path";

import { expect, test } from "@playwright/test";
import pino from "pino";

import { DashboardHttpServer } from "../../src/dashboard/http-server.js";
import { TraceService } from "../../src/trace/service.js";
import { TraceStore } from "../../src/trace/store.js";

const authToken = "test-only-production-server-token-32-characters";
let address: string;
let server: DashboardHttpServer;
let service: TraceService;
let store: TraceStore;

test.beforeAll(async () => {
  store = TraceStore.open(":memory:");
  service = new TraceService(store, pino({ level: "silent" }));
  const session = await service.startTrace("静的配信経路の確認");
  await service.withTrace(session, async () =>
    service.withSpan(
      "context",
      "browser production context",
      {
        summary: "保存済みコンテキストを確認",
        resultKind: "tool_result",
        summarizeResult: () => "構造化された確認結果",
      },
      async () => "ok",
    ),
  );
  await session.complete("succeeded", { summary: "静的配信確認を完了" });
  server = new DashboardHttpServer(
    service,
    {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      authToken,
      staticDirectory: resolve("dashboard/dist"),
      maxAgeDays: 30,
      maxTraces: 500,
      getBotHealth: async () => ({
        botState: "unknown",
        connectionState: "test-isolated",
        aiState: "idle",
        memoryState: "available",
        reflexState: "inactive",
        positionState: "unavailable",
      }),
    },
    pino({ level: "silent" }),
  );
  await server.start();
  const resolvedAddress = server.address;
  if (resolvedAddress === undefined)
    throw new Error("dashboard test server did not bind");
  address = resolvedAddress;
});

test.afterAll(async () => {
  await server.stop();
  store.close();
});

test("built dashboard, CSP, Basic auth, dynamic graph and real SSE work together", async ({
  browser,
}) => {
  const context = await browser.newContext({
    httpCredentials: {
      origin: address,
      username: "observer",
      password: authToken,
    },
  });
  const page = await context.newPage();
  const response = await page.goto(address);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain(
    "connect-src 'self'",
  );
  await expect(
    page.getByRole("heading", { name: "処理トレース" }),
  ).toBeVisible();
  await expect(page.getByText("ライブ接続")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-scene-ready="true"]')).toBeVisible({
    timeout: 10_000,
  });
  expect(
    await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .some(({ name }) => /\/assets\/.*\.js$/u.test(name)),
    ),
  ).toBe(true);

  const liveSession = await service.startTrace("SSEで追加された実保存run");
  await liveSession.complete("succeeded", { summary: "SSE配信を完了" });
  await expect(
    page.getByRole("button", { name: /SSEで追加された実保存run/ }),
  ).toBeVisible({ timeout: 10_000 });

  await context.close();
});
