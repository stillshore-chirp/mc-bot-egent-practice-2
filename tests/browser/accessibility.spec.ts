import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { routeDashboardApi } from "./api-fixture";

test("recorded trace screen has no critical axe violations", async ({
  page,
}) => {
  await routeDashboardApi(page);
  await page.goto("/");
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.filter(({ impact }) => impact === "critical"),
  ).toEqual([]);
});
