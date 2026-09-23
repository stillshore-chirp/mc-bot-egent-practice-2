import { describe, expect, it } from "vitest";

import {
  classifyVitalsQuestion,
  renderVitalsAnswer,
} from "../../src/agent/vitals-answer.js";
import type { GameStatus } from "../../src/tools/contracts.js";

const dryBot: GameStatus = {
  observedAt: "2026-01-01T00:00:00.000Z",
  subject: "bot",
  source: "minecraft",
  requesterVitals: "unobserved",
  connected: true,
  spawned: true,
  health: 20,
  food: 18,
  oxygen: 20,
  oxygenState: "not_applicable",
  inWater: false,
  inLava: false,
  suffocating: false,
  position: null,
  inventory: {},
  activeTaskState: null,
};

describe("vital observation attribution", () => {
  it("reports the Bot's water and oxygen while leaving the owner's condition unknown", () => {
    const combined =
      classifyVitalsQuestion("あなたと私の水中状態と酸素はどう？");
    expect(combined).not.toBeNull();
    if (combined === null) throw new Error("vitals question not classified");
    const answer = renderVitalsAnswer(combined, {
      ...dryBot,
      oxygen: 4,
      oxygenState: "low",
      inWater: true,
    });
    expect(answer).toContain("Bot自身の観測では、水中にいます、酸素は4/20");
    expect(answer).toContain("あなたの酸素・水中状態は観測できていません");
  });

  it("does not infer a swimming owner's condition from a dry Bot", () => {
    const question = classifyVitalsQuestion("私は水中にいる？");
    expect(question).not.toBeNull();
    if (question === null) throw new Error("vitals question not classified");
    const answer = renderVitalsAnswer(question, dryBot);
    expect(answer).toBe("あなたの水中状態は観測できていません。");
    expect(answer).not.toContain("水中にはいません");
  });

  it("keeps both subjects distinct when the Bot is dry", () => {
    const question = classifyVitalsQuestion("あなたと私は水中ですか？");
    expect(question).not.toBeNull();
    if (question === null) throw new Error("vitals question not classified");
    const answer = renderVitalsAnswer(question, dryBot);
    expect(answer).toContain("Bot自身の観測では、水中にはいません");
    expect(answer).toContain("あなたの水中状態は観測できていません");
  });

  it("does not consume an action that follows a vital question", () => {
    expect(classifyVitalsQuestion("私は水中？それから来て")).toBeNull();
  });
});
