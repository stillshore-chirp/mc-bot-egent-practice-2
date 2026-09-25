import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Response } from "openai/resources/responses/responses.js";
import type { Logger } from "pino";

import {
  createPlayerTool,
  playerResponseCompactionThreshold,
  projectSafePlayerAgentActivityTail,
  runPlayerAgent,
  type PlayerResponsesClient,
} from "../../src/player/responses.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";

describe("Responses server-side compaction", () => {
  it("persists requests whose token usage was not returned", async () => {
    const mind = PlayerMindStore.open(":memory:");
    const requestError = new Error("TEST_REQUEST_INTERRUPTED");
    const client = {
      responses: { create: async () => Promise.reject(requestError) },
    } as unknown as PlayerResponsesClient;

    await expect(
      runPlayerAgent({
        client,
        model: "test-model",
        instructions: "Instructions.",
        input: "Input.",
        tools: [],
        logger: silentLogger(),
        onCall: (metrics) =>
          mind.recordCall({
            inputTokens: metrics.inputTokens,
            outputTokens: metrics.outputTokens,
            latencyMs: metrics.latencyMs,
            ...(metrics.usageUnknown === true ? { usageUnknown: true } : {}),
          }),
      }),
    ).rejects.toBe(requestError);

    expect(mind.snapshot().counters).toMatchObject({
      llmCalls: 1,
      usageUnknownCalls: 1,
      inputTokens: 0,
      outputTokens: 0,
    });
    mind.close();
  });

  it("projects a bounded content-free activity tail for failure evidence", () => {
    const unsafeActivities = Array.from({ length: 70 }, (_, index) => ({
      runSequence: index + 1,
      role: "purpose",
      round: 1,
      responseStatus: "completed",
      processingStatus: "complete",
      inputTokens: 7,
      outputTokens: 2,
      latencyMs: 30,
      requestInputChars: 900,
      initialInputChars: 120,
      instructionsChars: 400,
      toolSchemaChars: 200,
      initialObservationChars: 180,
      responseOutputChars: 75,
      functionCallCount: 1,
      compactionItemPresent: false,
      prompt: "private prompt sentinel",
      toolCalls: [
        {
          name: "search_memory",
          resultClass: "ok",
          outputChars: 24,
          arguments: "private argument sentinel",
          output: "private output sentinel",
        },
        {
          name: "commit_action_decision",
          resultClass: "rejected",
          resultCode: index === 69 ? "CAS_STALE" : "private-code-sentinel",
          staleChangedComponents:
            index === 69
              ? ["knowledge_state", "private-component-sentinel"]
              : ["private-component-sentinel"],
          outputChars: 40,
        },
      ],
    }));

    const projected = projectSafePlayerAgentActivityTail(unsafeActivities);

    expect(projected).toHaveLength(64);
    expect(projected[0]?.runSequence).toBe(7);
    expect(projected.at(-1)?.runSequence).toBe(70);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("private prompt sentinel");
    expect(serialized).not.toContain("private argument sentinel");
    expect(serialized).not.toContain("private output sentinel");
    expect(serialized).not.toContain("private-code-sentinel");
    expect(serialized).not.toContain("private-component-sentinel");
    expect(serialized).not.toContain("arguments");
    expect(serialized).not.toContain("prompt");
    expect(projected.at(-1)?.toolCalls[1]).toMatchObject({
      resultCode: "CAS_STALE",
      staleChangedComponents: ["knowledge_state"],
    });
  });

  it("keeps the owner-fact tool name while excluding its content", () => {
    const projected = projectSafePlayerAgentActivityTail([
      {
        runSequence: 1,
        role: "conversation",
        round: 1,
        responseStatus: "completed",
        processingStatus: "complete",
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        requestInputChars: 1,
        initialInputChars: 1,
        instructionsChars: 1,
        toolSchemaChars: 1,
        initialObservationChars: 0,
        responseOutputChars: 1,
        functionCallCount: 1,
        compactionItemPresent: false,
        toolCalls: [
          {
            name: "remember_owner_fact",
            resultClass: "ok",
            outputChars: 42,
            summary: "private owner fact sentinel",
            arguments: "private tool arguments sentinel",
          },
        ],
      },
    ]);

    expect(projected[0]?.toolCalls).toEqual([
      { name: "remember_owner_fact", resultClass: "ok", outputChars: 42 },
    ]);
    expect(JSON.stringify(projected)).not.toContain(
      "private owner fact sentinel",
    );
    expect(JSON.stringify(projected)).not.toContain(
      "private tool arguments sentinel",
    );
  });

  it("retains only allowlisted learning rejection codes in private activity", async () => {
    const activities: unknown[] = [];
    const tool = createPlayerTool({
      name: "propose_skill_learning",
      description: "Record a hypothesis from trusted evidence.",
      schema: z.object({ kind: z.enum(["known", "unknown"]) }).strict(),
      execute: ({ kind }) => ({
        ok: false,
        code:
          kind === "known" ? "SIMILAR_SKILL_EXISTS" : "private-code-sentinel",
        privateDetail: "private output sentinel",
      }),
    });

    await runPlayerAgent({
      client: scriptedClient(
        [
          outputResponse([
            {
              type: "function_call",
              call_id: "private-call-id",
              name: "propose_skill_learning",
              arguments: JSON.stringify({ kind: "known" }),
            },
            {
              type: "function_call",
              call_id: "private-call-id-2",
              name: "propose_skill_learning",
              arguments: JSON.stringify({ kind: "unknown" }),
            },
          ]),
          terminalResponse("Done."),
        ],
        [],
      ),
      model: "test-model",
      instructions: "Instructions.",
      input: "Private conversation sentinel.",
      tools: [tool],
      logger: silentLogger(),
      onRoundActivity: (activity) => activities.push(activity),
    });

    expect(activities[0]).toMatchObject({
      toolCalls: [
        {
          name: "propose_skill_learning",
          resultClass: "rejected",
          resultCode: "SIMILAR_SKILL_EXISTS",
        },
        { name: "propose_skill_learning", resultClass: "rejected" },
      ],
    });
    const projected = projectSafePlayerAgentActivityTail(activities);
    expect(projected[0]?.toolCalls).toMatchObject([
      {
        resultCode: "SIMILAR_SKILL_EXISTS",
      },
      {
        resultClass: "rejected",
      },
    ]);

    const mind = PlayerMindStore.open(":memory:");
    try {
      const activity = projected[0];
      if (activity === undefined) throw new Error("activity was not projected");
      const snapshot = mind.recordAgentActivity(activity);
      const serialized = JSON.stringify(snapshot.recentAgentActivity);
      expect(serialized).toContain("SIMILAR_SKILL_EXISTS");
      expect(serialized).not.toContain("private-code-sentinel");
      expect(serialized).not.toContain("private output sentinel");
      expect(serialized).not.toContain("Private conversation sentinel");
      expect(serialized).not.toContain("private-call-id");
    } finally {
      mind.close();
    }
  });

  it("records only allowlisted action rejection reasons", async () => {
    const activities: unknown[] = [];
    const tool = createPlayerTool({
      name: "commit_action_decision",
      description: "Test action commit.",
      schema: z.object({ reason: z.enum(["known", "unknown"]) }).strict(),
      execute: ({ reason }) =>
        reason === "known"
          ? { ok: false, code: "STALE_REVISION", rejectionCode: "CAS_STALE" }
          : {
              ok: false,
              code: "private-code-sentinel",
              rejectionCode: "private-code-sentinel",
            },
    });

    await runPlayerAgent({
      client: scriptedClient(
        [
          outputResponse([
            {
              type: "function_call",
              call_id: "call-known",
              name: "commit_action_decision",
              arguments: JSON.stringify({ reason: "known" }),
            },
            {
              type: "function_call",
              call_id: "call-unknown",
              name: "commit_action_decision",
              arguments: JSON.stringify({ reason: "unknown" }),
            },
          ]),
          terminalResponse("Done."),
        ],
        [],
      ),
      model: "test-model",
      instructions: "Instructions.",
      input: "Input.",
      tools: [tool],
      logger: silentLogger(),
      onRoundActivity: (activity) => activities.push(activity),
    });

    expect(activities[0]).toMatchObject({
      toolCalls: [
        { resultClass: "rejected", resultCode: "CAS_STALE" },
        { resultClass: "rejected" },
      ],
    });
    expect(JSON.stringify(activities)).not.toContain("private-code-sentinel");
  });

  it("marks a budget abort after response receipt without inventing tool results", async () => {
    const activities: unknown[] = [];
    const controller = new AbortController();
    const budgetError = new Error("TEST_BUDGET_EXHAUSTED");
    let executedTools = 0;
    const tool = createPlayerTool({
      name: "search_memory",
      description: "Search test memory.",
      schema: z.object({ query: z.string() }).strict(),
      execute: () => {
        executedTools += 1;
        return { ok: true };
      },
    });

    await expect(
      runPlayerAgent({
        client: scriptedClient(
          [
            outputResponse([
              {
                type: "function_call",
                call_id: "private-call-id",
                name: "search_memory",
                arguments: JSON.stringify({ query: "private query" }),
              },
            ]),
          ],
          [],
        ),
        model: "test-model",
        instructions: "Instructions.",
        input: "Input.",
        tools: [tool],
        logger: silentLogger(),
        signal: controller.signal,
        onCall: () => controller.abort(budgetError),
        onRoundActivity: (activity) => activities.push(activity),
      }),
    ).rejects.toBe(budgetError);

    expect(executedTools).toBe(0);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      responseStatus: "completed",
      processingStatus: "interrupted",
      functionCallCount: 1,
      toolCalls: [],
    });
    expect(JSON.stringify(activities)).not.toContain("private-call-id");
    expect(JSON.stringify(activities)).not.toContain("private query");
  });

  it("retains only the completed tool result when cancellation arrives mid-tool", async () => {
    const activities: unknown[] = [];
    const controller = new AbortController();
    const budgetError = new Error("TEST_BUDGET_EXHAUSTED");
    const tool = createPlayerTool({
      name: "search_memory",
      description: "Search test memory.",
      schema: z.object({ query: z.string() }).strict(),
      execute: () => {
        controller.abort(budgetError);
        return { ok: true, privateValue: "result sentinel" };
      },
    });

    await expect(
      runPlayerAgent({
        client: scriptedClient(
          [
            outputResponse([
              {
                type: "function_call",
                call_id: "private-call-id",
                name: "search_memory",
                arguments: JSON.stringify({ query: "private query" }),
              },
            ]),
          ],
          [],
        ),
        model: "test-model",
        instructions: "Instructions.",
        input: "Input.",
        tools: [tool],
        logger: silentLogger(),
        signal: controller.signal,
        onRoundActivity: (activity) => activities.push(activity),
      }),
    ).rejects.toBe(budgetError);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      processingStatus: "interrupted",
      functionCallCount: 1,
      toolCalls: [{ name: "search_memory", resultClass: "ok" }],
    });
    expect(JSON.stringify(activities)).not.toContain("result sentinel");
    expect(JSON.stringify(activities)).not.toContain("private-call-id");
  });

  it("emits content-free round activity for tool and terminal responses", async () => {
    const activities: unknown[] = [];
    const requests: unknown[] = [];
    const argumentSecret = "private-argument-sentinel";
    const resultSecret = "private-result-sentinel";
    const terminalSecret = "private-terminal-sentinel";

    await runPlayerAgent({
      client: scriptedClient(
        [
          outputResponse([
            {
              type: "function_call",
              call_id: "private-call-id",
              name: "search_memory",
              arguments: JSON.stringify({ query: argumentSecret }),
            },
          ]),
          terminalResponse(terminalSecret),
        ],
        requests,
      ),
      model: "test-model",
      instructions: "private-instructions",
      input: "private-initial-input",
      initialObservationChars: 123,
      role: "conversation",
      tools: [
        createPlayerTool({
          name: "search_memory",
          description: "Search test memory.",
          schema: z.object({ query: z.string() }).strict(),
          execute: () => ({ ok: true, value: resultSecret }),
        }),
      ],
      logger: silentLogger(),
      onRoundActivity: (activity) => activities.push(activity),
    });

    expect(activities).toHaveLength(2);
    const toolRound = z.record(z.string(), z.unknown()).parse(activities[0]);
    const terminalRound = z
      .record(z.string(), z.unknown())
      .parse(activities[1]);
    expect(toolRound).toMatchObject({
      role: "conversation",
      round: 1,
      responseStatus: "completed",
      initialInputChars: "private-initial-input".length,
      instructionsChars: "private-instructions".length,
      initialObservationChars: 123,
      functionCallCount: 1,
      compactionItemPresent: false,
      toolCalls: [{ name: "search_memory", resultClass: "ok" }],
    });
    expect(toolRound.requestInputChars).toBeGreaterThan(0);
    expect(toolRound.toolSchemaChars).toBeGreaterThan(0);
    expect(toolRound.responseOutputChars).toBeGreaterThan(0);
    expect(terminalRound.round).toBe(2);
    expect(terminalRound.runSequence).toBe(toolRound.runSequence);
    expect(terminalRound.requestInputChars).toBeGreaterThan(
      toolRound.requestInputChars as number,
    );
    const serialized = JSON.stringify(activities);
    expect(serialized).not.toContain(argumentSecret);
    expect(serialized).not.toContain(resultSecret);
    expect(serialized).not.toContain(terminalSecret);
    expect(serialized).not.toContain("private-call-id");
    expect(serialized).not.toContain("private-instructions");
  });

  it("marks compaction and unknown tools with fixed safe classifications", async () => {
    const activities: unknown[] = [];
    const opaque = "opaque-private-compaction-value";
    await runPlayerAgent({
      client: scriptedClient(
        [
          outputResponse([
            {
              type: "compaction",
              id: "private-compaction-id",
              encrypted_content: opaque,
            },
            {
              type: "function_call",
              call_id: "private-call-id",
              name: "unregistered_private_tool",
              arguments: JSON.stringify({ secret: "private-argument" }),
            },
          ]),
          terminalResponse("done"),
        ],
        [],
      ),
      model: "test-model",
      instructions: "Keep system state.",
      input: "Start.",
      tools: [],
      logger: silentLogger(),
      onRoundActivity: (activity) => activities.push(activity),
    });

    const activity = activities[0] as Record<string, unknown>;
    expect(activity).toMatchObject({
      compactionItemPresent: true,
      functionCallCount: 1,
      toolCalls: [{ name: "unknown", resultClass: "unknown" }],
    });
    const serialized = JSON.stringify(activities);
    expect(serialized).not.toContain(opaque);
    expect(serialized).not.toContain("private-compaction-id");
    expect(serialized).not.toContain("private-call-id");
    expect(serialized).not.toContain("private-argument");
  });

  it("keeps the full tool transcript when no compaction item is returned", async () => {
    const requests: unknown[] = [];
    const tool = recordTool();
    const result = await runPlayerAgent({
      client: scriptedClient(
        [
          functionCallResponse("call-a", "one"),
          functionCallResponse("call-b", "two"),
          terminalResponse("done"),
        ],
        requests,
      ),
      model: "test-model",
      instructions: "Keep the system instruction.",
      input: "Start.",
      tools: [tool],
      logger: silentLogger(),
    });

    expect(result.calls).toBe(3);
    expect(requests.map((request) => requestItems(request).length)).toEqual([
      1, 3, 5,
    ]);
    expect(requests.map(contextManagement)).toEqual(
      requests.map(() => [
        {
          type: "compaction",
          compact_threshold: playerResponseCompactionThreshold,
        },
      ]),
    );
    expect(requests.map((request) => requestField(request).store)).toEqual([
      false,
      false,
      false,
    ]);
    expect(requests.every((request) => !containsCompaction(request))).toBe(
      true,
    );
  });

  it("prunes earlier input after a compaction and keeps fixed prompt fields", async () => {
    const requests: unknown[] = [];
    const logs: string[] = [];
    const tool = recordTool();
    const opaque = "opaque-compaction-payload-test-sentinel";
    await runPlayerAgent({
      client: scriptedClient(
        [
          functionCallResponse("call-before", "one"),
          outputResponse([
            { type: "compaction", id: "compact-1", encrypted_content: opaque },
            functionCall("call-after", "two"),
          ]),
          terminalResponse("done"),
        ],
        requests,
      ),
      model: "test-model",
      instructions: "Retain these instructions on every round.",
      input: "Start.",
      tools: [tool],
      logger: captureLogger(logs),
    });

    expect(requests.map((request) => requestItems(request).length)).toEqual([
      1, 3, 3,
    ]);
    const nextInput = requestItems(requests[2]);
    expect(itemType(nextInput[0])).toBe("compaction");
    expect(itemType(nextInput[1])).toBe("function_call");
    expect(itemType(nextInput[2])).toBe("function_call_output");
    expect(callId(nextInput[1])).toBe("call-after");
    expect(callId(nextInput[2])).toBe("call-after");
    expect(nextInput[0]).toMatchObject({ encrypted_content: opaque });
    expect(
      requests.map(requestField).map((request) => request.instructions),
    ).toEqual([
      "Retain these instructions on every round.",
      "Retain these instructions on every round.",
      "Retain these instructions on every round.",
    ]);
    expect(requests.map((request) => requestField(request).tools)).toEqual([
      requestField(requests[0]).tools,
      requestField(requests[0]).tools,
      requestField(requests[0]).tools,
    ]);
    expect(logs.join("\n")).not.toContain(opaque);
  });

  it("retains a tool call that crosses the compaction boundary until its output", async () => {
    const requests: unknown[] = [];
    await runPlayerAgent({
      client: scriptedClient(
        [
          functionCallResponse("call-old", "one"),
          outputResponse([
            functionCall("call-crossing", "two"),
            {
              type: "compaction",
              id: "compact-crossing",
              encrypted_content: "opaque-crossing-payload",
            },
          ]),
          terminalResponse("done"),
        ],
        requests,
      ),
      model: "test-model",
      instructions: "Keep system state.",
      input: "Start.",
      tools: [recordTool()],
      logger: silentLogger(),
    });

    const nextInput = requestItems(requests[2]);
    expect(nextInput.map(itemType)).toEqual([
      "function_call",
      "compaction",
      "function_call_output",
    ]);
    expect(callId(nextInput[0])).toBe("call-crossing");
    expect(callId(nextInput[2])).toBe("call-crossing");
  });
});

function recordTool() {
  return createPlayerTool({
    name: "record",
    description: "Record a value for this test.",
    schema: z.object({ value: z.string() }).strict(),
    execute: ({ value }) => ({ ok: true, value }),
  });
}

function scriptedClient(
  responses: Response[],
  requests: unknown[],
): PlayerResponsesClient {
  return {
    responses: {
      create: async (request: unknown) => {
        requests.push(structuredClone(request));
        const response = responses.shift();
        if (response === undefined)
          throw new Error("TEST_RESPONSE_QUEUE_EMPTY");
        return response;
      },
    },
  } as unknown as PlayerResponsesClient;
}

function functionCallResponse(callId: string, value: string): Response {
  return outputResponse([functionCall(callId, value)]);
}

function functionCall(callId: string, value: string): Record<string, unknown> {
  return {
    type: "function_call",
    call_id: callId,
    name: "record",
    arguments: JSON.stringify({ value }),
  };
}

function outputResponse(items: unknown[], outputText = ""): Response {
  return {
    status: "completed",
    output: items,
    output_text: outputText,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Response;
}

function terminalResponse(outputText: string): Response {
  return outputResponse([], outputText);
}

function silentLogger(): Logger {
  return { info: () => undefined } as unknown as Logger;
}

function captureLogger(logs: string[]): Logger {
  return {
    info: (fields: unknown) => logs.push(JSON.stringify(fields)),
  } as unknown as Logger;
}

function requestField(request: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(request);
}

function requestItems(request: unknown): unknown[] {
  return z.array(z.unknown()).parse(requestField(request).input);
}

function contextManagement(request: unknown): unknown {
  return requestField(request).context_management;
}

function containsCompaction(request: unknown): boolean {
  return requestItems(request).some((item) => itemType(item) === "compaction");
}

function itemType(item: unknown): unknown {
  return requestField(item).type;
}

function callId(item: unknown): unknown {
  return requestField(item).call_id;
}
