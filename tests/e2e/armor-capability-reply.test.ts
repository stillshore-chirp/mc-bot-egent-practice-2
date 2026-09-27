import { describe, expect, it } from "vitest";

import {
  accuratelyReportsIronHelmetEquipped,
  classifyArmorCapabilityReply,
  hasAccurateIronHelmetCompletionNotice,
} from "./armor-capability-reply.js";

describe("armor capability reply classifier", () => {
  it("requires the direct operations, furnace interface, and absent smelt kind", () => {
    expect(
      classifyArmorCapabilityReply(
        "digで採掘でき、equipで装備できます。かまどのopen_windowとwindow_transferは使えますが、専用のsmelt操作はありません。",
      ),
    ).toEqual({
      digAndEquipAvailable: true,
      furnaceUiAvailable: true,
      dedicatedSmeltStatementObserved: true,
      dedicatedSmeltReportedUnavailable: true,
    });
  });

  it("does not accept missing or directly denied capabilities", () => {
    expect(
      classifyArmorCapabilityReply(
        "digはできますがequipは使えません。炉の画面を開けます。専用smeltはありません。",
      ),
    ).toEqual({
      digAndEquipAvailable: false,
      furnaceUiAvailable: true,
      dedicatedSmeltStatementObserved: true,
      dedicatedSmeltReportedUnavailable: true,
    });
    expect(classifyArmorCapabilityReply("条件はまだ分かりません。")).toEqual({
      digAndEquipAvailable: false,
      furnaceUiAvailable: false,
      dedicatedSmeltStatementObserved: false,
      dedicatedSmeltReportedUnavailable: false,
    });
    expect(
      classifyArmorCapabilityReply(
        "digとequipは使えますが、かまどのopen_windowは使えません。専用smelt操作もありません。",
      ),
    ).toEqual({
      digAndEquipAvailable: true,
      furnaceUiAvailable: false,
      dedicatedSmeltStatementObserved: true,
      dedicatedSmeltReportedUnavailable: true,
    });
  });

  it("records an explicit smelt claim without making it a gate", () => {
    expect(
      classifyArmorCapabilityReply(
        "digとequipで採掘・装備ができ、かまどのopen_windowとwindow_transferも使えます。smelt操作も利用できます。",
      ),
    ).toEqual({
      digAndEquipAvailable: true,
      furnaceUiAvailable: true,
      dedicatedSmeltStatementObserved: true,
      dedicatedSmeltReportedUnavailable: false,
    });
  });

  it("requires an affirmative iron helmet completion notice", () => {
    expect(
      accuratelyReportsIronHelmetEquipped("鉄のヘルメットを装備しました。"),
    ).toBe(true);
    expect(
      accuratelyReportsIronHelmetEquipped(
        "装備操作は成功と判定されました。実行後、頭の装備欄にiron_helmetがあることを観測しました。",
      ),
    ).toBe(true);
    expect(
      accuratelyReportsIronHelmetEquipped("鉄のヘルメットは未確認です。"),
    ).toBe(false);
    expect(accuratelyReportsIronHelmetEquipped("装備しました。")).toBe(false);
  });

  it("matches one complete runtime notice among post-outcome chat candidates", () => {
    const runtimeNotice =
      "装備操作は成功と判定されました。実行後、頭の装備欄にiron_helmetがあることを観測しました。";

    expect(
      hasAccurateIronHelmetCompletionNotice([
        "提案の解決を確認しました。",
        runtimeNotice,
      ]),
    ).toBe(true);
    expect(
      hasAccurateIronHelmetCompletionNotice([
        "頭の装備欄にiron_helmetがありました。",
        "装備操作は成功と判定されました。",
      ]),
    ).toBe(false);
    expect(
      hasAccurateIronHelmetCompletionNotice(["提案の解決を確認しました。"]),
    ).toBe(false);
  });
});
