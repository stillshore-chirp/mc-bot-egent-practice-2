import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Response } from "openai/resources/responses/responses.js";
import type { Logger } from "pino";

import {
  createPlayerTool,
  playerResponseCompactionThreshold,
  runPlayerAgent,
  type PlayerResponsesClient,
} from "../../src/player/responses.js";

describe("Responses server-side compaction", () => {
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
