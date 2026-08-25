import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { routeDashboardApi } from "./api-fixture";

test("uses the functional 2D graph when WebGL 2 is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = HTMLCanvasElement.prototype.getContext;
    const fallbackGetContext = function getContext(
      this: HTMLCanvasElement,
      kind: string,
      ...args: unknown[]
    ) {
      if (kind === "webgl2") return null;
      return original.call(this, kind as never, ...(args as []));
    };
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: fallbackGetContext,
    });
  });
  await routeDashboardApi(page);
  await page.goto("/");
  await expect(page.getByText(/WebGL 2を利用できないため/)).toBeVisible();
  await expect(
    page.getByRole("group", { name: "処理トレースの2Dグラフ" }),
  ).toBeVisible();
  const firstNode = page.getByRole("button", { name: /依頼、成功/ });
  await firstNode.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "ノード詳細" })).toBeVisible();
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.filter(({ impact }) => impact === "critical"),
  ).toEqual([]);
});

test("2D fallback remains contained at narrow width and 200 percent text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 380, height: 900 });
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = HTMLCanvasElement.prototype.getContext;
    const fallbackGetContext = function getContext(
      this: HTMLCanvasElement,
      kind: string,
      ...args: unknown[]
    ) {
      if (kind === "webgl2") return null;
      return original.call(this, kind as never, ...(args as []));
    };
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: fallbackGetContext,
    });
  });
  await routeDashboardApi(page);
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  await expect(
    page.getByRole("group", { name: "処理トレースの2Dグラフ" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    ),
  ).toBe(false);
});
