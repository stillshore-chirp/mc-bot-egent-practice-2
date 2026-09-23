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

  it("labels the Bot's health and food and does not treat land oxygen as a danger reading", () => {
    const question = classifyVitalsQuestion("あなたの体力、空腹、酸素は？");
    expect(question).not.toBeNull();
    if (question === null) throw new Error("vitals question not classified");
    const answer = renderVitalsAnswer(question, dryBot);
    expect(answer).toContain("体力は20/20");
    expect(answer).toContain("満腹度は18/20");
    expect(answer).toContain("地上にいて酸素低下は観測していません");
    expect(answer).not.toContain("酸素は20/20");
  });

  it.each([
    "私は水中？それから来て",
    "来て。あなたの体力は？",
    "あなたの体力を回復して？",
    "水中の木を採取できる？",
  ])("does not consume an action inside a vital question: %s", (message) => {
    expect(classifyVitalsQuestion(message)).toBeNull();
  });

  it.each([
    "ゾンビの体力は？",
    "私の息子の体力は？",
    "息子はどう？",
    "あの人は水中？",
  ])(
    "keeps third-party subjects on the ordinary conversation path: %s",
    (message) => {
      expect(classifyVitalsQuestion(message)).toBeNull();
    },
  );

  it("still recognizes a direct question about the Bot's breathing", () => {
    expect(classifyVitalsQuestion("あなたの息は大丈夫？")?.vitals).toContain(
      "oxygen",
    );
  });
});
