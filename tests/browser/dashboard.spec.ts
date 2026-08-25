import { expect, test } from "@playwright/test";

import { routeDashboardApi } from "./api-fixture";
import { bundle, run } from "./fixtures/trace";

test.describe("trace dashboard", () => {
  test("shows only persisted traces and supports keyboard node inspection", async ({
    page,
  }) => {
    await routeDashboardApi(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "トレース一覧" }),
    ).toBeVisible();
    await expect(page.getByLabel("Position: 座標は秘匿済み")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /資源収集の処理を確認/ }),
    ).toBeVisible();
    const node = page.getByRole("option", { name: /判断.*成功/ });
    await node.focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("heading", { name: "ノード詳細" }),
    ).toBeVisible();
    await expect(page.getByText("観測結果から次の処理を決定")).toBeVisible();
  });

  test("replays the same event data and announces presenter redaction", async ({
    page,
  }) => {
    await routeDashboardApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Replay" }).click();
    await expect(page.getByText(/5 \/ 5 event/)).toBeVisible();
    await page.getByRole("button", { name: "Presenter Mode" }).click();
    await expect(
      page.getByRole("heading", { name: "Presenter Mode" }),
    ).toBeVisible();
    await expect(
      page.getByText(/raw prompt、model response、記憶本文/),
    ).toBeVisible();
  });

  test("replay before the first event has no future nodes", async ({
    page,
  }) => {
    await routeDashboardApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Replay" }).click();
    for (let index = 0; index < 5; index += 1) {
      await page.getByRole("button", { name: "1イベント戻る" }).click();
    }
    await expect(
      page.getByRole("region", { name: "Replay controls" }).getByText("開始前"),
    ).toBeVisible();
    await expect(
      page.getByRole("listbox", { name: "処理ノード一覧" }).getByRole("option"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "1イベント進む" }).click();
    await expect(page.getByText(/1 \/ 5 event/)).toBeVisible();
    await expect(
      page.getByRole("listbox", { name: "処理ノード一覧" }).getByRole("option"),
    ).toHaveCount(1);
  });

  test("renders a useful empty state when the API has no trace", async ({
    page,
  }) => {
    await page.route("**/api/dashboard/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ observability: { state: "ok" } }),
      }),
    );
    await page.route("**/api/traces", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ traces: [] }),
      }),
    );
    await page.route("**/api/stream", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "",
      }),
    );
    await page.goto("/");
    await expect(page.getByText(/実行トレースはまだありません/)).toBeVisible();
    await expect(
      page.getByText(/ここに処理グラフが表示されます/),
    ).toBeVisible();
  });

  test("marks, exports and imports only a backend-validated demo-safe bundle", async ({
    page,
  }) => {
    await routeDashboardApi(page);
    let demoSafe = false;
    await page.route("**/api/traces", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ traces: [{ ...run, demoSafe }] }),
      }),
    );
    await page.route("**/api/traces/*/demo-safe", (route) => {
      demoSafe = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(bundle),
      });
    });
    await page.goto("/");

    await page.getByRole("button", { name: "demo-safeにする" }).click();
    await expect(
      page.getByText("demo-safeマークを保存しました。"),
    ).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "export", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`trace-${run.traceId}.json`);
    await expect(
      page.getByText("秘匿化済みトレースをexportしました。"),
    ).toBeVisible();

    await page.getByLabel("demo-safeトレースJSONをimport").setInputFiles({
      name: "recorded-real-trace.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(bundle)),
    });
    await expect(
      page.getByText("demo-safeトレースをimportしました。"),
    ).toBeVisible();
  });

  test("presenter fullscreen control delegates to the browser API", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "__fullscreenRequests", {
        configurable: true,
        writable: true,
        value: 0,
      });
      Object.defineProperty(Element.prototype, "requestFullscreen", {
        configurable: true,
        value: async () => {
          const target = window as typeof window & {
            __fullscreenRequests: number;
          };
          target.__fullscreenRequests += 1;
        },
      });
    });
    await routeDashboardApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Presenter Mode" }).click();
    await page.getByRole("button", { name: "全画面", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __fullscreenRequests: number })
              .__fullscreenRequests,
        ),
      )
      .toBe(1);
    await expect(
      page.getByRole("button", { name: "全画面", exact: true }),
    ).toBeVisible();
  });
});
