import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  PlayerBody,
  PlayerBodyEvent,
  PlayerBodyObservation,
  PlayerKnowledge,
  PlayerOperation,
  PlayerOperationResult,
} from "../../src/minecraft/player-body.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import {
  PlayerRuntime,
  type PlayerConversationPort,
  type PlayerMemoryPort,
  type PlayerPurposePort,
} from "../../src/player/runtime.js";
import { createPlayerTool } from "../../src/player/responses.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("integrated player runtime", () => {
  it("keeps conversation independent and settles a body action before replacing it", async () => {
    const directory = temporaryDirectory();
    const mind = PlayerMindStore.open(join(directory, "player.sqlite"));
    const body = new DeferredBody();
    const memory = createMemoryPort();
    const actions = [action("action-one"), action("action-two")];
    let runtime: PlayerRuntime | undefined;
    let thoughtCount = 0;
    let conversationCount = 0;
    const conversation: PlayerConversationPort = {
      nextTurn: () => 1,
      handleOwnerMessage: async () => {
        conversationCount += 1;
      },
    };
    const purpose: PlayerPurposePort = {
      think: async ({ snapshot }) => {
        thoughtCount += 1;
        const decision = actions.shift();
        if (decision === undefined) return { accepted: false };
        const saved = mind.commitThought({
          expectedRevision: snapshot.revision,
          decision,
        });
        if (saved.accepted)
          runtime?.handleCommittedDecision(saved.snapshot, decision);
        return {
          accepted: saved.accepted,
          ...(saved.accepted ? { decision } : {}),
        };
      },
    };
    runtime = new PlayerRuntime({
      ownerUsername: "owner",
      playerId: "owner-player",
      body,
      mind,
      memory,
      skills: {} as never,
      conversation,
      purpose,
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });

    try {
      await runtime.start();
      await waitFor(() => body.started.length === 1);
      expect(thoughtCount).toBe(1);
      const actionRevision = runtime.snapshot.actionRevision;

      body.emit({
        type: "state_changed",
        reason: "entities",
        at: new Date().toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      runtime.receiveChat("owner", "What are you working on?");
      await waitFor(() => conversationCount === 1);

      expect(runtime.snapshot.actionRevision).toBe(actionRevision);
      expect(body.stopCalls).toBe(0);
      expect(thoughtCount).toBe(1);

      mind.addProposal({
        title: "Meet me at the cabin",
        reason: "Let's talk there",
        priority: 4,
      });
      runtime.onOwnerProposal();
      await waitFor(() => body.started.length === 2);
      expect(body.started).toEqual(["look", "look"]);
      expect(body.maxConcurrent).toBe(1);
      expect(body.results.map((result) => result.status)).toContain(
        "interrupted",
      );
      expect(runtime.snapshot.activeOperation?.operationId).toBe("action-two");

      mind.stop();
      await runtime.stopNow();
      await runtime.shutdown();
      expect(runtime.snapshot.stopped).toBe(true);
      expect(body.maxConcurrent).toBe(1);
    } finally {
      await runtime.shutdown();
      mind.close();
    }
  });

  it("persists stop across restart and rejects a stale action thought", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const firstMind = PlayerMindStore.open(databasePath);
    const stopped = firstMind.stop();
    if (stopped === undefined) throw new Error("stop latch was not persisted");
    const stale = firstMind.commitThought({
      expectedRevision: stopped.revision - 1,
      decision: action("stale-action"),
    });
    expect(stale.accepted).toBe(false);
    firstMind.close();

    const mind = PlayerMindStore.open(databasePath);
    const body = new DeferredBody();
    let thoughtCount = 0;
    const runtime = new PlayerRuntime({
      ownerUsername: "owner",
      playerId: "owner-player",
      body,
      mind,
      memory: createMemoryPort(),
      skills: {} as never,
      conversation: {
        nextTurn: () => 1,
        handleOwnerMessage: async () => undefined,
      },
      purpose: {
        think: async () => {
          thoughtCount += 1;
          return { accepted: false };
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });
    try {
      await runtime.start();
      expect(runtime.snapshot.stopped).toBe(true);
      expect(body.started).toHaveLength(0);
      expect(thoughtCount).toBe(0);
      expect(mind.resume(stopped.stopGeneration - 1)).toBeUndefined();
    } finally {
      await runtime.shutdown();
      mind.close();
    }
  });

  it("coalesces vital event bursts while retaining the latest damage signal", () => {
    const directory = temporaryDirectory();
    const mind = PlayerMindStore.open(join(directory, "player.sqlite"));
    try {
      mind.enqueueEvent("state_changed", "meaningful change: vitals health=18");
      mind.enqueueEvent("state_changed", "meaningful change: vitals health=16");
      const vitalEvents = mind
        .pendingEvents(64)
        .filter(
          ({ kind, summary }) =>
            kind === "state_changed" && summary.includes("vitals"),
        );
      expect(vitalEvents).toHaveLength(1);
      expect(vitalEvents[0]?.summary).toContain("health=16");
    } finally {
      mind.close();
    }
  });

  it("normalizes every Responses function-tool object to strict required fields", async () => {
    const tool = createPlayerTool({
      name: "inspect",
      description: "test tool",
      schema: z
        .object({
          label: z.string(),
          decision: z.discriminatedUnion("kind", [
            z
              .object({
                kind: z.literal("act"),
                operation: z
                  .object({
                    kind: z.literal("look"),
                    yaw: z.number().optional(),
                  })
                  .strict(),
              })
              .strict(),
            z.object({ kind: z.literal("wait"), reason: z.string() }).strict(),
          ]),
        })
        .strict(),
      execute: (input) => input,
    });
    const parameters = tool.definition.parameters as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };

    expect(tool.definition.strict).toBe(true);
    expect(parameters.type).toBe("object");
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.required.sort()).toEqual(["decision", "label"]);
    expect(Object.keys(parameters.properties).sort()).toEqual([
      "decision",
      "label",
    ]);
    expect(JSON.stringify(parameters)).not.toContain("oneOf");
    expect(JSON.stringify(parameters)).not.toContain("default");
    assertStrictObjectNodes(parameters);
    await expect(
      tool.execute({
        label: "local parser permits an omitted optional value",
        decision: { kind: "act", operation: { kind: "look" } },
      }),
    ).resolves.toEqual({
      label: "local parser permits an omitted optional value",
      decision: { kind: "act", operation: { kind: "look" } },
    });
  });
});

class DeferredBody implements PlayerBody {
  readonly started: string[] = [];
  readonly results: PlayerOperationResult[] = [];
  #listeners = new Set<(event: PlayerBodyEvent) => void>();
  #active = 0;
  maxConcurrent = 0;
  stopCalls = 0;

  public async observe(): Promise<PlayerBodyObservation> {
    return observation();
  }

  public execute(
    operation: PlayerOperation,
    signal?: AbortSignal,
  ): Promise<PlayerOperationResult> {
    this.started.push(operation.kind);
    this.#active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#active);
    const operationId = `body-${this.started.length}`;
    const startedAt = new Date().toISOString();
    this.emit({
      type: "operation_started",
      at: startedAt,
      operationId,
      operation: operation.kind,
    });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (status: PlayerOperationResult["status"]): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.#active -= 1;
        const result: PlayerOperationResult = {
          operationId,
          operation,
          status,
          startedAt,
          completedAt: new Date().toISOString(),
          before: null,
          after: null,
          recoveryRequired: false,
        };
        this.results.push(result);
        resolve(result);
      };
      const onAbort = (): void => {
        setTimeout(() => finish("interrupted"), 15);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  public async stop(): Promise<void> {
    this.stopCalls += 1;
  }
  public knowledge(query: string): PlayerKnowledge {
    return { query, results: [] } as unknown as PlayerKnowledge;
  }

  public onEvent(listener: (event: PlayerBodyEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public emit(event: PlayerBodyEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function action(
  operationId: string,
): Extract<
  import("../../src/player/contracts.js").PlayerThoughtDecision,
  { kind: "act" }
> {
  return {
    kind: "act",
    purpose: "test purpose",
    operation: { kind: "look" } as PlayerOperation,
    operationId,
    expectedOutcome: "observe a changed view",
    wakeOn: ["body_outcome"],
  };
}

function observation(): PlayerBodyObservation {
  return {
    observedAt: new Date().toISOString(),
    dimension: "overworld",
    time: { day: 1, timeOfDay: 5_000, isDay: true, raining: false },
    self: {
      username: "bot",
      position: { x: 0, y: 64, z: 0, dimension: "overworld" },
      yaw: 0,
      pitch: 0,
      velocity: { x: 0, y: 0, z: 0 },
      health: 20,
      food: 20,
      saturation: 5,
      oxygen: 20,
      inWater: false,
      inLava: false,
      onFire: false,
      suffocating: false,
      sleeping: false,
      mountedEntityId: null,
      gameMode: "survival",
      inventory: [],
      equipment: {},
    },
    perception: {
      fov: { horizontalDegrees: 110, verticalDegrees: 80 },
      range: 16,
      blocks: [],
      entities: [],
      candidateSearchMayBeTruncated: false,
    },
    window: null,
  } as unknown as PlayerBodyObservation;
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

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "player-runtime-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function assertStrictObjectNodes(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) assertStrictObjectNodes(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const value = node as Record<string, unknown>;
  if (value.type === "object") {
    const properties = value.properties as Record<string, unknown> | undefined;
    expect(value.additionalProperties).toBe(false);
    expect([...((value.required as string[]) ?? [])].sort()).toEqual(
      Object.keys(properties ?? {}).sort(),
    );
  }
  for (const nested of Object.values(value)) assertStrictObjectNodes(nested);
}
