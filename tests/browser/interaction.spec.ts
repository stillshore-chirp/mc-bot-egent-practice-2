import { expect, test } from "@playwright/test";

import { routeDashboardApi } from "./api-fixture";
import { events, spans } from "./fixtures/trace";

test("narrow viewport keeps the dashboard usable", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 900 });
  await routeDashboardApi(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "処理トレース" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
});

test("200 percent text remains readable", async ({ page }) => {
  await routeDashboardApi(page);
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await expect(
    page.getByRole("heading", { name: "トレース一覧" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /資源収集の処理を確認/ }),
  ).toBeVisible();
});

test("prefers-reduced-motion disables animated transitions", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await routeDashboardApi(page);
  await page.goto("/");
  const transition = await page
    .getByRole("button", { name: "Presenter Mode" })
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(transition)).toBeLessThan(0.001);
});

test("webgl context loss announces and exposes the functional fallback", async ({
  page,
}) => {
  await routeDashboardApi(page);
  await page.goto("/");
  const canvas = page.locator("canvas.graph-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.locator('[data-scene-ready="true"]')).toBeVisible({
    timeout: 5_000,
  });
  const canvasHandle = await canvas.elementHandle();
  expect(canvasHandle).not.toBeNull();
  await expect
    .poll(async () =>
      canvas.evaluate((element) =>
        Number(element.dataset.rendererGeometries ?? "0"),
      ),
    )
    .toBeGreaterThan(0);
  await canvas.evaluate((element) =>
    element.dispatchEvent(
      new Event("webglcontextlost", { bubbles: false, cancelable: true }),
    ),
  );
  await expect(page.getByText(/WebGLコンテキストが失われたため/)).toBeVisible({
    timeout: 5_000,
  });
  await expect(
    page.getByRole("group", { name: "処理トレースの2Dグラフ" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      canvasHandle.evaluate((element) => element.dataset.sceneDisposed),
    )
    .toBe("true");
  expect(
    await canvasHandle.evaluate((element) => ({
      edges: Number(element.dataset.sceneEdges ?? "-1"),
      nodes: Number(element.dataset.sceneNodes ?? "-1"),
      pulses: Number(element.dataset.scenePulses ?? "-1"),
    })),
  ).toEqual({ edges: 0, nodes: 0, pulses: 0 });
  await canvasHandle.dispose();
});

test("hidden tab pauses the scene RAF and resumes it when visible", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.requestAnimationFrame.bind(window);
    let count = 0;
    window.requestAnimationFrame = (callback) => {
      count += 1;
      return original(callback);
    };
    Object.defineProperty(window, "__dashboardRafCount", {
      configurable: true,
      get: () => count,
    });
  });
  await routeDashboardApi(page);
  await page.goto("/");
  await expect(page.locator('[data-scene-ready="true"]')).toBeVisible({
    timeout: 5_000,
  });
  const before = await page.evaluate(
    () =>
      (window as unknown as { __dashboardRafCount: number })
        .__dashboardRafCount,
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(150);
  const hidden = await page.evaluate(
    () =>
      (window as unknown as { __dashboardRafCount: number })
        .__dashboardRafCount,
  );
  await page.waitForTimeout(150);
  const hiddenLater = await page.evaluate(
    () =>
      (window as unknown as { __dashboardRafCount: number })
        .__dashboardRafCount,
  );
  expect(hidden).toBeGreaterThanOrEqual(before);
  expect(hiddenLater).toBe(hidden);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as unknown as { __dashboardRafCount: number })
            .__dashboardRafCount,
      ),
    )
    .toBeGreaterThan(hidden);
});

test("pausing live updates buffers real SSE events and resumes through the reducer", async ({
  page,
}) => {
  const runningEvent = {
    ...events[0],
    eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    streamId: 6,
    sequence: 6,
    timestamp: "2026-08-25T00:00:05.000Z",
    type: "span.started" as const,
    span: {
      ...spans[0],
      sequence: 6,
      status: "running" as const,
      endedAt: undefined,
    },
  };
  await routeDashboardApi(page, {
    streamDelayMs: 800,
    streamBody: `event: trace\ndata: ${JSON.stringify(runningEvent)}\n\n`,
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "トレース一覧" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await page.getByRole("button", { name: "Live更新を一時停止" }).click();
  await expect(
    page.getByRole("button", { name: "Live更新を再開" }),
  ).toBeVisible();
  await expect(page.getByText(/Live更新停止/)).toBeVisible();
  await expect(
    page
      .getByRole("listbox", { name: "処理ノード一覧" })
      .getByRole("option")
      .first(),
  ).toContainText("成功");
  await page.getByRole("button", { name: "Live更新を再開" }).click();
  await expect(page.getByText("実行中").first()).toBeVisible({
    timeout: 5_000,
  });
});

test("live pause reports bounded-buffer overflow as degraded observability", async ({
  page,
}) => {
  const burst = Array.from({ length: 501 }, (_, index) => ({
    ...events[0],
    eventId: `dddddddd-dddd-4ddd-8ddd-${(index + 1).toString(16).padStart(12, "0")}`,
    streamId: 100 + index,
    sequence: 6 + index,
    timestamp: "2026-08-25T00:00:05.000Z",
    type: "span.progress" as const,
    progress: 0.5,
    span: { ...spans[0], sequence: 6 + index, status: "running" as const },
  }));
  await routeDashboardApi(page, {
    streamDelayMs: 2_000,
    traceDelayMs: 4_000,
    streamBody: burst
      .map((event) => `event: trace\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "トレース一覧" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await page.getByRole("button", { name: "Live更新を一時停止" }).click();
  await expect(page.getByText(/Live buffer overflow/)).toBeVisible({
    timeout: 20_000,
  });
});
