import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { Response } from "openai/resources/responses/responses.js";

import { McSkillRepository } from "../../src/mc-skills/index.js";
import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";
import type { PlayerBody } from "../../src/minecraft/player-body.js";
import type {
  PlayerMemoryPort,
  PlayerThoughtDecision,
  PlayerRuntimeSnapshot,
} from "../../src/player/contracts.js";
import {
  PlayerConversationAgent,
  PlayerPurposeAgent,
} from "../../src/player/agents.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import type { PlayerResponsesClient } from "../../src/player/responses.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("player agent response rounds", () => {
  it("returns a successful purpose commit on the sixth tool round", async () => {
    const responses = [
      ...Array.from({ length: 5 }, (_, index) =>
        functionCallResponse(`memory-${index}`, "search_memory", {
          query: "landmark",
        }),
      ),
      functionCallResponse(
        "last-round-commit",
        "commit_action_decision",
        actionArguments(),
      ),
    ];
    const committed: PlayerThoughtDecision[] = [];
    const fixture = openPurposeFixture(responses, (_snapshot, decision) => {
      committed.push(decision);
    });

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(result.accepted).toBe(true);
      expect(result.decision?.kind).toBe("act");
      expect(fixture.requests).toHaveLength(6);
      expect(committed).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it("continues after unknown tools and a rejected CAS instead of finishing", async () => {
    const mindRef: { current?: PlayerMindStore } = {};
    const responses: ScriptedResponse[] = [
      functionCallResponse("unknown", "not_a_registered_tool", {}),
      functionCallResponse(
        "rejected-goal",
        "commit_goal_state",
        emptyGoalStateArguments(),
      ),
      (_request, index) => {
        const mind = mindRef.current;
        if (index !== 2 || mind === undefined)
          throw new Error("TEST_REVISION_FIXTURE_MISSING");
        const current = mind.snapshot();
        const saved = mind.commitUnderstanding({
          expectedRevision: current.revision,
          facts: [{ summary: "A newer observed fact", source: "observed" }],
          uncertainties: [],
        });
        if (!saved.accepted) throw new Error("TEST_REVISION_CHANGE_REJECTED");
        return functionCallResponse(
          "stale-commit",
          "commit_action_decision",
          actionArguments(),
        );
      },
      terminalResponse("No action was committed."),
    ];
    const committed: PlayerThoughtDecision[] = [];
    const fixture = openPurposeFixture(responses, (_snapshot, decision) => {
      committed.push(decision);
    });
    mindRef.current = fixture.mind;

    try {
      const result = await fixture.agent.think({
        snapshot: fixture.mind.snapshot(),
        events: [],
      });

      expect(result.accepted).toBe(false);
      expect(committed).toHaveLength(0);
      expect(fixture.requests).toHaveLength(4);
      expect(JSON.stringify(fixture.requests[1])).toContain("UNKNOWN_TOOL");
      expect(JSON.stringify(fixture.requests[2])).toContain("NO_STATE_CHANGE");
      expect(JSON.stringify(fixture.requests[3])).toContain("STALE_REVISION");
    } finally {
      fixture.close();
    }
  });

  it("does not report completion when stop aborts immediately after commit", async () => {
    const controller = new AbortController();
    const mindRef: { current?: PlayerMindStore } = {};
    const fixture = openPurposeFixture(
      [
        functionCallResponse(
          "commit-before-stop",
          "commit_action_decision",
          actionArguments(),
        ),
      ],
      () => {
        const stopped = mindRef.current?.stop();
        if (stopped?.stopped !== true)
          throw new Error("TEST_STOP_LATCH_NOT_SET");
        controller.abort();
      },
    );
    mindRef.current = fixture.mind;

    try {
      await expect(
        fixture.agent.think({
          snapshot: fixture.mind.snapshot(),
          events: [],
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(fixture.mind.snapshot().stopped).toBe(true);
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it("keeps requesting a user-facing final answer after conversation tools", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "player-conversation-rounds-"),
    );
    temporaryDirectories.push(directory);
    const mind = PlayerMindStore.open(join(directory, "player.sqlite"));
    const requests: unknown[] = [];
    const responses = [
      functionCallResponse("status-check", "inspect_player_status", {}),
      terminalResponse(
        "I am exploring nearby and can help with the next step.",
      ),
    ];
    const client = scriptedClient(responses, requests);
    const messages: string[] = [];
    const conversation = new PlayerConversationAgent({
      client,
      apiKey: "test-only",
      model: "test-model",
      ownerUsername: "owner",
      mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      say: async (text) => {
        messages.push(text);
      },
      onProposal: () => undefined,
      onStop: async () => undefined,
      onResume: () => undefined,
    });

    try {
      const turn = conversation.nextTurn();
      await conversation.handleOwnerMessage({
        username: "owner",
        message: "What are you doing?",
        turn,
      });

      expect(messages).toEqual([
        "I am exploring nearby and can help with the next step.",
      ]);
      expect(requests).toHaveLength(2);
    } finally {
      mind.close();
    }
  });
});

type ScriptedResponse =
  Response | ((request: unknown, index: number) => Response);

interface PurposeFixture {
  readonly agent: PlayerPurposeAgent;
  readonly mind: PlayerMindStore;
  readonly requests: unknown[];
  close(): void;
}

function openPurposeFixture(
  responses: ScriptedResponse[],
  onCommitted: (
    snapshot: PlayerRuntimeSnapshot,
    decision: PlayerThoughtDecision,
  ) => void = () => undefined,
): PurposeFixture {
  const directory = mkdtempSync(join(tmpdir(), "player-agent-rounds-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "player.sqlite");
  const mind = PlayerMindStore.open(databasePath);
  const skills = McSkillRepository.open({
    databasePath,
    exchangeDirectory: join(directory, "skills"),
    allowedOperationNames: playerOperationNames,
  });
  const requests: unknown[] = [];
  const body = {
    observe: async () => {
      throw new Error("observation fixture unavailable");
    },
  } as unknown as PlayerBody;
  const client = scriptedClient(responses, requests);
  const memory = createMemoryPort();
  const agent = new PlayerPurposeAgent({
    client,
    apiKey: "test-only",
    model: "test-model",
    body,
    skills,
    mind,
    memory,
    ownerPlayerId: "owner-player",
    logger: pino({ level: "silent" }),
    onCommitted,
  });
  return {
    agent,
    mind,
    requests,
    close: () => {
      skills.close();
      mind.close();
    },
  };
}

function createMemoryPort(): PlayerMemoryPort {
  return {
    context: () => ({
      persona: "",
      ownerUsername: "owner",
      relationship: {},
      lifeState: {},
      recalled: [],
    }),
    recall: () => [],
    persistGoals: () => undefined,
    recordEpisode: () => undefined,
  };
}

function scriptedClient(
  responses: ScriptedResponse[],
  requests: unknown[],
): PlayerResponsesClient {
  return {
    responses: {
      create: async (request: unknown) => {
        const index = requests.push(request) - 1;
        const response = responses.shift();
        if (response === undefined)
          throw new Error("TEST_RESPONSE_QUEUE_EMPTY");
        return typeof response === "function"
          ? response(request, index)
          : response;
      },
    },
  } as unknown as PlayerResponsesClient;
}

function functionCallResponse(
  callId: string,
  name: string,
  argumentsValue: unknown,
): Response {
  return {
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: callId,
        name,
        arguments: JSON.stringify(argumentsValue),
      },
    ],
    output_text: "",
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Response;
}

function terminalResponse(outputText: string): Response {
  return {
    status: "completed",
    output: [],
    output_text: outputText,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Response;
}

function actionArguments(): Record<string, unknown> {
  return {
    kind: "act",
    purpose: "Look at a nearby landmark.",
    operationJson: JSON.stringify({
      kind: "look",
      target: { x: 1, y: 64, z: 1 },
    }),
    expectedOutcome: "The view points toward the landmark.",
    skillId: "",
    skillVersion: 0,
    reason: "A visible landmark can help orient the next decision.",
    wakeOn: [],
    wakeAt: "",
  };
}

function emptyGoalStateArguments(): Record<string, unknown> {
  return {
    proposalId: "",
    proposalDisposition: "none",
    resolution: "",
    goalId: "",
    goalTitle: "",
    goalStatus: "none",
    goalPriority: 1,
    changeReason: "",
    goalSource: "none",
  };
}
