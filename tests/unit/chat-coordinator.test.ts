import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { OpenAIDeliberationAgent } from "../../src/agent/openai-agent.js";
import {
  ChatCoordinator,
  isImmediateStopCommand,
  type ChatContextFactory,
} from "../../src/agent/chat-coordinator.js";
import type { GameController } from "../../src/tools/contracts.js";

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

  it("notifies pending-runtime cancellation synchronously on owner stop", async () => {
    const calls: string[] = [];
    const coordinator = new ChatCoordinator({
      ownerUsername: "owner",
      game: {
        stopCurrentAction: vi.fn(async () => ({
          outcome: "cancelled",
          summary: "停止しました。",
        })),
        say: vi.fn(async () => undefined),
      } as unknown as GameController,
      agent: {} as OpenAIDeliberationAgent,
      contextFactory: {} as ChatContextFactory,
      logger: {
        warn: vi.fn(),
      } as unknown as Logger,
    });
    coordinator.onImmediateStop(() => calls.push("pending-cancelled"));

    const handled = coordinator.handleChat("owner", "停止");
    expect(calls).toEqual(["pending-cancelled"]);
    expect(await handled).toBe(true);
  });
});
