import { expect, test } from "@playwright/test";

import { routeDashboardApi } from "./api-fixture";

test.use({ timezoneId: "UTC" });

test("recorded trace dashboard visual baseline", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    const fixedNow = 1_000;
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => fixedNow,
    });
  });
  await routeDashboardApi(page);
  await page.goto("/");
  await page.getByRole("listbox", { name: "処理ノード一覧" }).waitFor();
  await expect(page).toHaveScreenshot("recorded-trace-dashboard.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.05,
    scale: "css",
  });
});
