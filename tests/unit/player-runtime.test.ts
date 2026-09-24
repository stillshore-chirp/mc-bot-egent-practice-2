import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { McSkillRepository } from "../../src/mc-skills/index.js";
import type {
  PlayerBody,
  PlayerBodyEvent,
  PlayerBodyObservation,
  PlayerKnowledge,
  PlayerOperation,
  PlayerOperationResult,
} from "../../src/minecraft/player-body.js";
import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";
import type {
  PlayerMemoryPort,
  PlayerThoughtDecision,
} from "../../src/player/contracts.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import {
  PlayerRuntime,
  type PlayerConversationPort,
  type PlayerPurposePort,
} from "../../src/player/runtime.js";
import {
  createPlayerTool,
  type PlayerAgentRoundActivity,
} from "../../src/player/responses.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("integrated player runtime", () => {
  it("persists only the bounded safe activity tail across restart", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    let mind = PlayerMindStore.open(databasePath);
    for (let runSequence = 1; runSequence <= 66; runSequence += 1) {
      mind.recordAgentActivity(agentActivity(runSequence));
    }
    const rejected = {
      ...agentActivity(67),
      prompt: "private prompt sentinel",
    } as PlayerAgentRoundActivity;
    expect(() => mind.recordAgentActivity(rejected)).toThrow();
    mind.close();

    mind = PlayerMindStore.open(databasePath);
    try {
      const activity = mind.snapshot().recentAgentActivity;
      expect(activity).toHaveLength(64);
      expect(activity[0]?.runSequence).toBe(3);
      expect(activity.at(-1)?.runSequence).toBe(66);
      expect(JSON.stringify(activity)).not.toContain("private prompt sentinel");
    } finally {
      mind.close();
    }
  });

  it("keeps conversation independent and settles a body action before replacing it", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    const memory = createMemoryPort();
    const actions = [action("action-one"), action("action-two")];
    const runtimeRef: { current?: PlayerRuntime } = {};
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
          runtimeRef.current?.handleCommittedDecision(saved.snapshot, decision);
        return {
          accepted: saved.accepted,
          ...(saved.accepted ? { decision } : {}),
        };
      },
    };
    const runtime = new PlayerRuntime({
      ownerUsername: "owner",
      playerId: "owner-player",
      body,
      mind,
      memory,
      skills,
      conversation,
      purpose,
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });
    runtimeRef.current = runtime;

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
      skills.close();
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
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    let thoughtCount = 0;
    const runtime = new PlayerRuntime({
      ownerUsername: "owner",
      playerId: "owner-player",
      body,
      mind,
      memory: createMemoryPort(),
      skills,
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
      skills.close();
      mind.close();
    }
  });

  it("deduplicates recovery events and results and keeps stop latched after reconnect", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    body.requireRecoveryOnNextResult();
    const runtimeRef: { current?: PlayerRuntime } = {};
    let thoughtCount = 0;
    const reconnectRequests: string[] = [];
    const runtime = new PlayerRuntime({
      ownerUsername: "owner",
      playerId: "owner-player",
      body,
      mind,
      memory: createMemoryPort(),
      skills,
      conversation: {
        nextTurn: () => 1,
        handleOwnerMessage: async () => undefined,
      },
      purpose: {
        think: async ({ snapshot }) => {
          thoughtCount += 1;
          if (thoughtCount === 1) {
            const decision = action("recovery-action");
            const saved = mind.commitThought({
              expectedRevision: snapshot.revision,
              decision,
            });
            if (saved.accepted)
              runtimeRef.current?.handleCommittedDecision(
                saved.snapshot,
                decision,
              );
            return { accepted: saved.accepted, decision };
          }
          return { accepted: false };
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
      requestReconnect: (reason) => {
        reconnectRequests.push(reason);
      },
    });
    runtimeRef.current = runtime;

    try {
      await runtime.start();
      await waitFor(
        () =>
          body.results.length === 1 &&
          runtime.snapshot.activeOperation === undefined &&
          runtime.snapshot.wait?.wakeOn.includes("reconnected") === true,
      );
      expect(reconnectRequests).toEqual(["player-operation-recovery"]);
      expect(body.results[0]?.recoveryRequired).toBe(true);
      expect(body.results[0]?.operationId).toBe("body-1");

      const stopped = mind.stop();
      if (stopped === undefined)
        throw new Error("stop latch was not persisted");
      await runtime.stopNow();
      const thoughtCountAtStop = thoughtCount;
      body.emit({ type: "reconnected", at: new Date().toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(thoughtCount).toBe(thoughtCountAtStop);
      expect(runtime.snapshot.stopped).toBe(true);
      expect(reconnectRequests).toHaveLength(1);

      await runtime.shutdown();
      mind.close();
      const restarted = PlayerMindStore.open(databasePath);
      try {
        expect(restarted.snapshot().stopped).toBe(true);
      } finally {
        restarted.close();
      }
    } finally {
      await runtime.shutdown();
      skills.close();
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
  #recoveryOnNextResult = false;
  maxConcurrent = 0;
  stopCalls = 0;

  public requireRecoveryOnNextResult(): void {
    this.#recoveryOnNextResult = true;
  }

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
    const recoveryRequired = this.#recoveryOnNextResult;
    this.#recoveryOnNextResult = false;
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
          recoveryRequired,
        };
        this.results.push(result);
        resolve(result);
      };
      const onAbort = (): void => {
        setTimeout(() => finish("interrupted"), 15);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      if (recoveryRequired) {
        this.emit({
          type: "operation_recovery_required",
          at: startedAt,
          operationId,
          operation: operation.kind,
          detail: "The native action remains unresolved until reconnection.",
        });
        this.emit({ type: "reconnected", at: new Date().toISOString() });
        setTimeout(() => finish("interrupted"), 15);
      }
    });
  }

  public async stop(): Promise<void> {
    this.stopCalls += 1;
  }
  public knowledge(query: string): PlayerKnowledge {
    return {
      source: "minecraft_registry",
      gameVersion: "test",
      registryVersion: "test",
      observedAt: new Date().toISOString(),
      query,
      facts: [],
      inferences: [],
      truncated: false,
    };
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
): Extract<PlayerThoughtDecision, { kind: "act" }> {
  return {
    kind: "act",
    purpose: "test purpose",
    operation: { kind: "look", target: { x: 0, y: 64, z: 1 } },
    operationId,
    expectedOutcome: "observe a changed view",
    wakeOn: ["body_outcome"],
  };
}

function observation(): PlayerBodyObservation {
  return {
    observedAt: new Date().toISOString(),
    source: "minecraft",
    gameVersion: "test",
    dimension: "overworld",
    time: { day: 1, timeOfDay: 5_000, isDay: true, raining: false },
    self: {
      username: "bot",
      position: { x: 0, y: 64, z: 0, dimension: "overworld" },
      eyeHeight: 1.62,
      yaw: 0,
      pitch: 0,
      velocity: { x: 0, y: 0, z: 0 },
      health: 20,
      food: 20,
      foodSaturation: 5,
      oxygen: 20,
      inWater: false,
      inLava: false,
      onFire: false,
      suffocating: false,
      sleeping: false,
      mountedEntityId: null,
      gameMode: "survival",
      experience: { level: 0, points: 0, progress: 0 },
      inventory: [],
      equipment: {},
    },
    perception: {
      horizontalFieldOfViewDegrees: 110,
      verticalFieldOfViewDegrees: 80,
      maxDistance: 16,
      coverage: "visible_subset",
      blockCountLimit: 96,
      entityCountLimit: 48,
      blockCandidateLimit: 192,
      entityCandidateLimit: 128,
      omittedBlockCandidates: 0,
      omittedEntityCandidates: 0,
      candidateSearchMayBeTruncated: false,
      blocks: [],
      entities: [],
    },
    window: null,
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

function openSkills(
  databasePath: string,
  directory: string,
): McSkillRepository {
  return McSkillRepository.open({
    databasePath,
    exchangeDirectory: join(directory, "skills"),
    allowedOperationNames: playerOperationNames,
  });
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "player-runtime-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function agentActivity(runSequence: number): PlayerAgentRoundActivity {
  return {
    runSequence,
    role: "purpose",
    round: 1,
    responseStatus: "completed",
    processingStatus: "complete",
    inputTokens: 8,
    outputTokens: 2,
    latencyMs: 25,
    requestInputChars: 800,
    initialInputChars: 100,
    instructionsChars: 400,
    toolSchemaChars: 200,
    initialObservationChars: 175,
    responseOutputChars: 70,
    functionCallCount: 1,
    compactionItemPresent: false,
    toolCalls: [{ name: "observe_body", resultClass: "ok", outputChars: 70 }],
  };
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
    const properties = z
      .record(z.string(), z.unknown())
      .parse(value.properties);
    const required = z.array(z.string()).parse(value.required);
    expect(value.additionalProperties).toBe(false);
    expect([...required].sort()).toEqual(Object.keys(properties).sort());
  }
  for (const nested of Object.values(value)) assertStrictObjectNodes(nested);
}
