import { describe, expect, it } from "vitest";
import {
  classifyArmorQuestion,
  renderArmorAnswer,
} from "../../src/agent/armor-answer.js";
import type { GameStatus } from "../../src/tools/contracts.js";

const status: GameStatus = {
  observedAt: "2026-09-23T00:00:00.000Z",
  subject: "bot",
  source: "minecraft",
  requesterVitals: "unobserved",
  connected: true,
  spawned: true,
  health: 20,
  food: 20,
  oxygen: 20,
  oxygenState: "not_applicable",
  inWater: false,
  inLava: false,
  suffocating: false,
  position: null,
  inventory: { iron_helmet: 1 },
  armor: { head: null, torso: null, legs: null, feet: null },
  activeTaskState: null,
};

describe("armor status answer", () => {
  it("routes status questions but leaves equipment commands and permission questions alone", () => {
    expect(classifyArmorQuestion("防具を装備してる？")).toBe("bot");
    expect(classifyArmorQuestion("今の防具の装備状態を教えて")).toBe("bot");
    expect(classifyArmorQuestion("私の防具は？")).toBe("requester");
    expect(classifyArmorQuestion("私は防具を装備してる？")).toBe("requester");
    expect(classifyArmorQuestion("村人の防具は？")).toBeNull();
    expect(classifyArmorQuestion("村人は防具を装備してる？")).toBeNull();
    expect(classifyArmorQuestion("Steveの防具は？")).toBeNull();
    expect(classifyArmorQuestion("剣を装備してる？")).toBeNull();
    expect(classifyArmorQuestion("盾は装備してる？")).toBeNull();
    expect(classifyArmorQuestion("防具を装備して")).toBeNull();
    expect(classifyArmorQuestion("防具を装備してもいい？")).toBeNull();
    expect(classifyArmorQuestion("防具を装備して？")).toBeNull();
    expect(classifyArmorQuestion("防具を着て？")).toBeNull();
    expect(classifyArmorQuestion("防具を脱いで？")).toBeNull();
    expect(classifyArmorQuestion("防具を装備しないで？")).toBeNull();
    expect(classifyArmorQuestion("木を集めて、防具は？")).toBeNull();
  });

  it("keeps carried, equipped, removed and unobserved armor distinct", () => {
    const carried = renderArmorAnswer("bot", status);
    expect(carried).toContain("頭は未装備");
    expect(carried).toContain("所持品の防具は鉄のヘルメット1個");

    const equipped = renderArmorAnswer("bot", {
      ...status,
      inventory: {},
      armor: {
        head: "iron_helmet",
        torso: null,
        legs: null,
        feet: null,
      },
    });
    expect(equipped).toContain("頭は鉄のヘルメット");
    expect(equipped).toContain("所持品に防具はありません");

    const removed = renderArmorAnswer("bot", status);
    expect(removed).toBe(carried);
    expect(renderArmorAnswer("bot", { ...status, armor: null })).toContain(
      "装備スロットは未確認",
    );
    expect(renderArmorAnswer("requester", status)).toContain(
      "観測できていません",
    );
  });
});
