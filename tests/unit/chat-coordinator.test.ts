import { describe, expect, it } from "vitest";

import { isImmediateStopCommand } from "../../src/agent/chat-coordinator.js";

describe("immediate stop command", () => {
  it.each([
    "停止",
    "停止して",
    " 止まって ",
    "止めて",
    "ストップ",
    "やめて",
    "中止",
    "中断",
  ])("accepts the exact safety command %s", (message) =>
    expect(isImmediateStopCommand(message)).toBe(true),
  );

  it("does not treat an ordinary sentence as a stop command", () => {
    expect(isImmediateStopCommand("停止方法を教えて")).toBe(false);
  });
});
