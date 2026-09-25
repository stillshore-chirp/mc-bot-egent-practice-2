import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
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
  semanticSignatures,
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
  it("keeps ordinary breathing and water transitions from invalidating a thought", () => {
    const base = observation();
    const signature = (changes: Partial<PlayerBodyObservation["self"]>) =>
      semanticSignatures({
        ...base,
        self: { ...base.self, ...changes },
      });
    const dry = signature({ inWater: false, oxygen: 20 });
    const dryUnknown = signature({ inWater: false, oxygen: null });
    const wet = signature({ inWater: true, oxygen: 20 });
    const wetBreathing = signature({ inWater: true, oxygen: 19 });
    const wetLow = signature({ inWater: true, oxygen: 5 });

    expect(dryUnknown.vitals).toBe(dry.vitals);
    expect(wet.vitals).toBe(dry.vitals);
    expect(wetBreathing.vitals).toBe(wet.vitals);
    expect(wetBreathing.environment).toBe(wet.environment);
    expect(wet.environment).not.toBe(dry.environment);
    expect(wetLow.vitals).not.toBe(wet.vitals);
    expect(signature({ health: 19 }).vitals).not.toBe(dry.vitals);
  });

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

  it("returns fixed reasons for each atomic thought rejection", () => {
    const directory = temporaryDirectory();
    const mind = PlayerMindStore.open(join(directory, "player.sqlite"));
    try {
      const initial = mind.snapshot();
      const stale = mind.commitThought({
        expectedRevision: initial.revision - 1,
        decision: action("stale-reason"),
      });
      expect(stale).toMatchObject({
        accepted: false,
        rejectionCode: "CAS_STALE",
      });

      const noActiveOperation = mind.commitThought({
        expectedRevision: initial.revision,
        decision: { kind: "continue", reason: "continue current work" },
      });
      expect(noActiveOperation).toMatchObject({
        accepted: false,
        rejectionCode: "NO_ACTIVE_OPERATION",
      });

      const proposal = mind.addProposal({
        title: "A test proposal",
        reason: "Used to check atomic resolution validation.",
      });
      const invalidProposal = mind.commitThought({
        expectedRevision: mind.snapshot().revision,
        decision: action("proposal-reason"),
        proposalResolution: {
          proposalId: `${proposal.id}-missing`,
          disposition: "adopted",
          resolution: "This proposal is not pending.",
        },
      });
      expect(invalidProposal).toMatchObject({
        accepted: false,
        rejectionCode: "PROPOSAL_NOT_PENDING",
      });

      const stopped = mind.stop();
      if (stopped === undefined) throw new Error("stop latch was not set");
      const stoppedCommit = mind.commitThought({
        expectedRevision: stopped.revision,
        decision: action("stopped-reason"),
      });
      expect(stoppedCommit).toMatchObject({
        accepted: false,
        rejectionCode: "STOPPED",
      });
    } finally {
      mind.close();
    }
  });

  it("wakes once after completion for semantic goal, action, and outcome progress", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    try {
      const complete = (expectedRevision: number) =>
        mind.commitThought({
          expectedRevision,
          decision: {
            kind: "complete",
            purpose: "purpose finished",
            reason: "no unfinished work remains",
            wakeOn: ["body_outcome"],
          },
        });
      const goal = {
        id: "goal-one",
        title: "Explore the nearby forest",
        status: "active" as const,
        priority: 3,
        changeReason: "A useful first destination",
        source: "self" as const,
      };

      let saved = mind.commitGoalState({
        expectedRevision: mind.snapshot().revision,
        goal,
      });
      expect(saved.accepted).toBe(true);
      saved = complete(saved.snapshot.revision);
      expect(saved.accepted).toBe(true);
      expect(mind.purposeCompletionWakeState().sequence).toBe(1);
      expect(
        mind
          .pendingEvents(64)
          .filter(({ summary }) =>
            summary.includes("目的完了後の自律目的を再評価"),
          ),
      ).toHaveLength(1);

      saved = mind.commitGoalState({
        expectedRevision: saved.snapshot.revision,
        goal: { ...goal, changeReason: "The same goal remains useful" },
      });
      expect(saved.accepted).toBe(true);
      saved = complete(saved.snapshot.revision);
      expect(saved.accepted).toBe(true);
      expect(mind.purposeCompletionWakeState().sequence).toBe(1);

      saved = mind.commitGoalState({
        expectedRevision: saved.snapshot.revision,
        goal: { ...goal, status: "completed", changeReason: "Reached it" },
      });
      expect(saved.accepted).toBe(true);
      saved = complete(saved.snapshot.revision);
      expect(saved.accepted).toBe(true);
      expect(mind.purposeCompletionWakeState().sequence).toBe(2);

      const actionDecision = action("progress-action");
      saved = mind.commitThought({
        expectedRevision: saved.snapshot.revision,
        decision: actionDecision,
      });
      expect(saved.accepted).toBe(true);
      expect(mind.snapshot().recentJudgments.at(-1)).toMatchObject({
        kind: "act",
        summary: "目的に沿って look を開始",
      });
      mind.recordOutcome({
        evidence: {
          operationId: actionDecision.operationId,
          kind: "look",
          status: "failed",
          summary: "The view did not change",
          observedAt: new Date().toISOString(),
        },
      });
      saved = complete(mind.snapshot().revision);
      expect(saved.accepted).toBe(true);
      expect(mind.purposeCompletionWakeState().sequence).toBe(3);
      expect(mind.snapshot()).not.toHaveProperty("purposeProgressRevision");
    } finally {
      mind.close();
    }

    const reopened = PlayerMindStore.open(databasePath);
    try {
      expect(reopened.purposeCompletionWakeState().sequence).toBe(3);
      expect(reopened.purposeCompletionWakeState().pendingEvent).toBeDefined();
    } finally {
      reopened.close();
    }
  });

  it("records bodyStartedAt only after the matching body-start event", () => {
    const directory = temporaryDirectory();
    const mind = PlayerMindStore.open(join(directory, "player.sqlite"));
    try {
      const committed = mind.commitThought({
        expectedRevision: mind.snapshot().revision,
        decision: action("body-start-time"),
      });
      expect(committed.accepted).toBe(true);
      const active = committed.snapshot.activeOperation;
      if (active === undefined) throw new Error("active operation missing");
      expect(active.startedAt).toBeDefined();
      expect(active.bodyStartedAt).toBeUndefined();

      const startedAt = "2026-09-25T03:00:00.000Z";
      mind.markOperationStarted("different-operation", startedAt);
      expect(mind.snapshot().activeOperation?.bodyStartedAt).toBeUndefined();
      mind.markOperationStarted(active.operationId, startedAt);

      expect(mind.snapshot().activeOperation).toMatchObject({
        operationId: active.operationId,
        startedAt,
        bodyStartedAt: startedAt,
      });
    } finally {
      mind.close();
    }
  });

  it("loads persisted active operations without the optional body start time", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const committed = mind.commitThought({
      expectedRevision: mind.snapshot().revision,
      decision: action("old-active-operation-shape"),
    });
    expect(committed.accepted).toBe(true);
    const active = committed.snapshot.activeOperation;
    if (active === undefined) throw new Error("active operation missing");
    mind.markOperationStarted(active.operationId, "2026-09-25T03:00:00.000Z");
    mind.close();

    const database = new Database(databasePath);
    try {
      const row = database
        .prepare<[], { readonly payload_json: string }>(
          "SELECT payload_json FROM player_runtime_state WHERE singleton_id = 1",
        )
        .get();
      if (row === undefined) throw new Error("runtime state missing");
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const oldActive = payload.activeOperation as
        Record<string, unknown> | undefined;
      if (oldActive === undefined)
        throw new Error("active operation not persisted");
      delete oldActive.bodyStartedAt;
      database
        .prepare(
          "UPDATE player_runtime_state SET payload_json = ? WHERE singleton_id = 1",
        )
        .run(JSON.stringify(payload));
    } finally {
      database.close();
    }

    const reopened = PlayerMindStore.open(databasePath);
    try {
      expect(reopened.snapshot().activeOperation).toMatchObject({
        operationId: active.operationId,
        startedAt: "2026-09-25T03:00:00.000Z",
        expectedOutcome: "observe a changed view",
      });
      expect(
        reopened.snapshot().activeOperation?.bodyStartedAt,
      ).toBeUndefined();
      const recovered = reopened.recoverInterruptedOperation();
      expect(recovered).toMatchObject({
        status: "unverified",
        expectedOutcome: "observe a changed view",
      });
      expect(reopened.snapshot().lastOutcome).toMatchObject({
        status: "unverified",
        expectedOutcome: "observe a changed view",
      });
    } finally {
      reopened.close();
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

  it("single-flights slow purpose thoughts and follows queued events once", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    const runtimeRef: { current?: PlayerRuntime } = {};
    let releaseFirstThought: (() => void) | undefined;
    const firstThoughtGate = new Promise<void>((resolve) => {
      releaseFirstThought = resolve;
    });
    let thoughtCount = 0;
    let activeThoughts = 0;
    let maxActiveThoughts = 0;
    let firstSignal: AbortSignal | undefined;
    let followupEvents: readonly { kind: string; summary: string }[] = [];
    let followupSnapshot: ReturnType<PlayerMindStore["snapshot"]> | undefined;
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
        think: async ({ snapshot, events, signal }) => {
          thoughtCount += 1;
          activeThoughts += 1;
          maxActiveThoughts = Math.max(maxActiveThoughts, activeThoughts);
          try {
            if (thoughtCount === 1) {
              firstSignal = signal;
              const decision = action("slow-action");
              const saved = mind.commitThought({
                expectedRevision: snapshot.revision,
                decision,
              });
              if (saved.accepted)
                runtimeRef.current?.handleCommittedDecision(
                  saved.snapshot,
                  decision,
                );
              await firstThoughtGate;
              return { accepted: saved.accepted, decision };
            }
            followupEvents = events;
            followupSnapshot = snapshot;
            return { accepted: false };
          } finally {
            activeThoughts -= 1;
          }
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });
    runtimeRef.current = runtime;

    try {
      await runtime.start();
      await waitFor(() => body.started.length === 1);
      expect(thoughtCount).toBe(1);

      const hurt = observation();
      body.setObservation({
        ...hurt,
        self: { ...hurt.self, health: 15 },
      });
      body.emit({
        type: "state_changed",
        reason: "vitals",
        at: new Date().toISOString(),
      });
      await waitFor(() =>
        mind
          .pendingEvents(64)
          .some(({ summary }) => summary.includes("vitals")),
      );

      const night = observation();
      body.setObservation({
        ...night,
        time: { ...night.time, timeOfDay: 16_000, isDay: false },
      });
      body.emit({
        type: "state_changed",
        reason: "time",
        at: new Date().toISOString(),
      });
      await waitFor(() =>
        mind.pendingEvents(64).some(({ summary }) => summary.includes("time")),
      );

      body.emit({
        type: "operation_stalled",
        operationId: "body-1",
        operation: "look",
        elapsedMs: 30_000,
        at: new Date().toISOString(),
      });
      body.completeActive("successful");
      await waitFor(() => body.results.length === 1);
      expect(firstSignal?.aborted).toBe(false);
      expect(thoughtCount).toBe(1);
      expect(releaseFirstThought).toBeDefined();
      releaseFirstThought?.();

      await waitFor(() => thoughtCount === 2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(maxActiveThoughts).toBe(1);
      expect(thoughtCount).toBe(2);
      expect(followupEvents.map(({ kind }) => kind)).toEqual(
        expect.arrayContaining([
          "state_changed",
          "operation_stalled",
          "body_outcome",
        ]),
      );
      expect(followupSnapshot?.lastOutcome?.status).toBe("successful");
      expect(followupSnapshot?.lastOutcome?.expectedOutcome).toBe(
        "observe a changed view",
      );
      expect(followupSnapshot?.lastOutcome?.summary).toContain(
        "期待したstep=observe a changed view",
      );
      expect(followupSnapshot?.lastObservation?.timeOfDay).toBe(16_000);
    } finally {
      releaseFirstThought?.();
      await runtime.shutdown();
      skills.close();
      mind.close();
    }
  });

  it("restarts an uncommitted thought after a body outcome with fresh evidence", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    const runtimeRef: { current?: PlayerRuntime } = {};
    let thoughtCount = 0;
    let pendingSignal: AbortSignal | undefined;
    let resumedOutcome: string | undefined;
    let resumedEventKinds: readonly string[] = [];
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
        think: async ({ snapshot, events, signal }) => {
          thoughtCount += 1;
          if (thoughtCount === 1) {
            const decision = action("begin observation");
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
          if (thoughtCount === 2) {
            pendingSignal = signal;
            await new Promise<void>((resolve) => {
              if (signal?.aborted) resolve();
              else
                signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
            return { accepted: false };
          }
          resumedOutcome = snapshot.lastOutcome?.status;
          resumedEventKinds = events.map(({ kind }) => kind);
          return { accepted: true };
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });
    runtimeRef.current = runtime;

    try {
      await runtime.start();
      await waitFor(() => body.started.length === 1);
      body.emit({
        type: "operation_stalled",
        operationId: "body-1",
        operation: "look",
        elapsedMs: 30_000,
        at: new Date().toISOString(),
      });
      await waitFor(() => thoughtCount === 2);
      expect(pendingSignal?.aborted).toBe(false);

      body.completeActive("failed");
      await waitFor(() => pendingSignal?.aborted === true);
      await waitFor(() => thoughtCount === 3);
      expect(resumedOutcome).toBe("failed");
      expect(resumedEventKinds).toContain("body_outcome");
    } finally {
      await runtime.shutdown();
      skills.close();
      mind.close();
    }
  });

  it("retains observed movement delta for the next purpose decision", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    const before = observation();
    body.setResultObservations(before, {
      ...before,
      observedAt: new Date().toISOString(),
      self: {
        ...before.self,
        position: { x: 3.2, y: 64, z: -1.4, dimension: "overworld" },
      },
    });
    const runtimeRef: { current?: PlayerRuntime } = {};
    let followupSummary: string | undefined;
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
        think: async ({ snapshot }) => {
          thoughtCount += 1;
          if (thoughtCount > 1) {
            followupSummary = snapshot.lastOutcome?.summary;
            return { accepted: true };
          }
          const decision: Extract<PlayerThoughtDecision, { kind: "act" }> = {
            ...action("move-east"),
            operation: {
              kind: "move_to",
              position: { x: 4, y: 64, z: 0 },
              range: 1,
            },
            expectedOutcome:
              "move toward an unknown destination; 観測した移動差分=Δx:999.0,Δy:0.0,Δz:0.0,距離:999.0",
          };
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
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });
    runtimeRef.current = runtime;

    try {
      await runtime.start();
      await waitFor(() => body.started[0] === "move_to");
      body.completeActive("successful");
      await waitFor(() => followupSummary !== undefined);
      expect(followupSummary).toContain("Δx:3.2");
      expect(followupSummary).toContain("Δz:-1.4");
      expect(followupSummary).toContain("距離:3.5");
      expect(mind.snapshot().lastOutcome?.movementDelta).toEqual({
        x: 3.2,
        y: 0,
        z: -1.4,
      });
      expect(mind.snapshot().recentOutcomes.at(-1)?.movementDelta).toEqual({
        x: 3.2,
        y: 0,
        z: -1.4,
      });
    } finally {
      await runtime.shutdown();
      skills.close();
      mind.close();
    }

    const reopened = PlayerMindStore.open(databasePath);
    try {
      expect(reopened.snapshot().recentOutcomes.at(-1)?.movementDelta).toEqual({
        x: 3.2,
        y: 0,
        z: -1.4,
      });
    } finally {
      reopened.close();
    }
  });

  it.each(["successful", "failed"] as const)(
    "starts a fresh purpose thought after a %s body outcome and one completion",
    async (outcome) => {
      const directory = temporaryDirectory();
      const databasePath = join(directory, "player.sqlite");
      const mind = PlayerMindStore.open(databasePath);
      const skills = openSkills(databasePath, directory);
      const body = new DeferredBody();
      const runtimeRef: { current?: PlayerRuntime } = {};
      let thoughtCount = 0;
      let activeThoughts = 0;
      let maxActiveThoughts = 0;
      let finalEvents: readonly { kind: string; summary: string }[] = [];
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
          think: async ({ snapshot, events }) => {
            thoughtCount += 1;
            activeThoughts += 1;
            maxActiveThoughts = Math.max(maxActiveThoughts, activeThoughts);
            try {
              if (thoughtCount === 1) {
                const decision = action("outcome-action");
                const saved = mind.commitThought({
                  expectedRevision: snapshot.revision,
                  decision,
                });
                if (saved.accepted)
                  runtimeRef.current?.handleCommittedDecision(
                    saved.snapshot,
                    decision,
                  );
                if (saved.accepted)
                  mind.consumeEvents(events.map(({ id }) => id));
                return { accepted: saved.accepted, decision };
              }
              if (thoughtCount === 2) {
                expect(snapshot.lastOutcome?.status).toBe(outcome);
                const decision: PlayerThoughtDecision = {
                  kind: "complete",
                  purpose: "the current activity is complete",
                  reason: "choose another purpose after observing the result",
                  wakeOn: ["body_outcome"],
                };
                const saved = mind.commitThought({
                  expectedRevision: snapshot.revision,
                  decision,
                });
                if (saved.accepted)
                  runtimeRef.current?.handleCommittedDecision(
                    saved.snapshot,
                    decision,
                  );
                if (saved.accepted)
                  mind.consumeEvents(events.map(({ id }) => id));
                return { accepted: saved.accepted, decision };
              }
              finalEvents = events;
              mind.consumeEvents(events.map(({ id }) => id));
              return { accepted: true };
            } finally {
              activeThoughts -= 1;
            }
          },
        },
        logger: pino({ level: "silent" }),
        say: async () => undefined,
      });
      runtimeRef.current = runtime;

      try {
        await runtime.start();
        await waitFor(() => body.started.length === 1);
        body.completeActive(outcome);
        await waitFor(() => thoughtCount === 3);

        expect(finalEvents).toContainEqual(
          expect.objectContaining({
            kind: "manual",
            summary: "目的完了後の自律目的を再評価",
          }),
        );
        expect(maxActiveThoughts).toBe(1);
        expect(mind.purposeCompletionWakeState().sequence).toBe(1);
        expect(mind.purposeCompletionWakeState().pendingEvent).toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(thoughtCount).toBe(3);
      } finally {
        await runtime.shutdown();
        skills.close();
        mind.close();
      }
    },
  );

  it("prioritizes an unconsumed completion wake after restart over its wait gate", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const firstMind = PlayerMindStore.open(databasePath);
    const committed = firstMind.commitThought({
      expectedRevision: firstMind.snapshot().revision,
      decision: {
        kind: "complete",
        purpose: "finished before restart",
        reason: "wait for a body outcome",
        wakeOn: ["body_outcome"],
      },
    });
    expect(committed.accepted).toBe(true);
    firstMind.close();

    const firstRestartMind = PlayerMindStore.open(databasePath);
    const firstRestartSkills = openSkills(databasePath, directory);
    const firstBody = new DeferredBody();
    let firstThoughtCount = 0;
    let firstThoughtActive = false;
    let releaseFirstThought: (() => void) | undefined;
    const firstThoughtGate = new Promise<void>((resolve) => {
      releaseFirstThought = resolve;
    });
    const firstRuntime = new PlayerRuntime({
      ownerUsername: "owner",
      playerId: "owner-player",
      body: firstBody,
      mind: firstRestartMind,
      memory: createMemoryPort(),
      skills: firstRestartSkills,
      conversation: {
        nextTurn: () => 1,
        handleOwnerMessage: async () => undefined,
      },
      purpose: {
        think: async () => {
          firstThoughtCount += 1;
          firstThoughtActive = true;
          try {
            await firstThoughtGate;
            return { accepted: false };
          } finally {
            firstThoughtActive = false;
          }
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });
    try {
      await firstRuntime.start();
      await waitFor(() => firstThoughtCount === 1);
      expect(firstRuntime.snapshot.wait?.wakeOn).toEqual(["body_outcome"]);
      await firstRuntime.shutdown();
      releaseFirstThought?.();
      await waitFor(() => !firstThoughtActive);
      expect(
        firstRestartMind.purposeCompletionWakeState().pendingEvent,
      ).toBeDefined();
    } finally {
      releaseFirstThought?.();
      await firstRuntime.shutdown();
      firstRestartSkills.close();
      firstRestartMind.close();
    }

    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    let thoughtCount = 0;
    let eventKinds: readonly string[] = [];
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
        think: async ({ events }) => {
          thoughtCount += 1;
          eventKinds = events.map(({ kind }) => kind);
          mind.consumeEvents(events.map(({ id }) => id));
          return { accepted: true };
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });
    try {
      await runtime.start();
      await waitFor(() => thoughtCount === 1);
      expect(runtime.snapshot.wait?.wakeOn).toEqual(["body_outcome"]);
      expect(eventKinds).toContain("manual");
      expect(mind.purposeCompletionWakeState().pendingEvent).toBeUndefined();
    } finally {
      await runtime.shutdown();
      skills.close();
      mind.close();
    }
  });

  it("keeps a completion wake durable through stop and restart until explicit resume", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const firstMind = PlayerMindStore.open(databasePath);
    const completed = firstMind.commitThought({
      expectedRevision: firstMind.snapshot().revision,
      decision: {
        kind: "complete",
        purpose: "finished",
        reason: "wait for relevant changes",
        wakeOn: ["body_outcome"],
      },
    });
    expect(completed.accepted).toBe(true);
    const stopped = firstMind.stop();
    if (stopped === undefined) throw new Error("stop latch was not persisted");
    firstMind.close();

    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    let thoughtCount = 0;
    let seenEvents: readonly { kind: string; summary: string }[] = [];
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
        think: async ({ events }) => {
          thoughtCount += 1;
          seenEvents = events;
          mind.consumeEvents(events.map(({ id }) => id));
          return { accepted: true };
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });

    try {
      await runtime.start();
      expect(runtime.snapshot.stopped).toBe(true);
      expect(thoughtCount).toBe(0);
      expect(mind.purposeCompletionWakeState().pendingEvent).toBeDefined();

      const resumed = mind.resume(stopped.stopGeneration);
      expect(resumed).toBeDefined();
      runtime.onResume();
      await waitFor(() => thoughtCount === 1);
      expect(seenEvents).toContainEqual(
        expect.objectContaining({
          kind: "manual",
          summary: "目的完了後の自律目的を再評価",
        }),
      );
      expect(mind.purposeCompletionWakeState().pendingEvent).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(thoughtCount).toBe(1);
    } finally {
      await runtime.shutdown();
      skills.close();
      mind.close();
    }
  });

  it("preempts a slow thought for an owner proposal and waits for settlement", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    let releaseFirstThought: (() => void) | undefined;
    const firstThoughtGate = new Promise<void>((resolve) => {
      releaseFirstThought = resolve;
    });
    let thoughtCount = 0;
    let activeThoughts = 0;
    let maxActiveThoughts = 0;
    let firstSignal: AbortSignal | undefined;
    let followupKinds: readonly string[] = [];
    const runtime = new PlayerRuntime({
      ownerUsername: "owner",
      playerId: "owner-player",
      body: new DeferredBody(),
      mind,
      memory: createMemoryPort(),
      skills,
      conversation: {
        nextTurn: () => 1,
        handleOwnerMessage: async () => undefined,
      },
      purpose: {
        think: async ({ events, signal }) => {
          thoughtCount += 1;
          activeThoughts += 1;
          maxActiveThoughts = Math.max(maxActiveThoughts, activeThoughts);
          try {
            if (thoughtCount === 1) {
              firstSignal = signal;
              await firstThoughtGate;
              return { accepted: false };
            }
            followupKinds = events.map(({ kind }) => kind);
            return { accepted: false };
          } finally {
            activeThoughts -= 1;
          }
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });

    try {
      await runtime.start();
      await waitFor(() => thoughtCount === 1);
      mind.addProposal({ title: "Visit the village", reason: "Meet there" });
      runtime.onOwnerProposal();

      expect(firstSignal?.aborted).toBe(true);
      expect(thoughtCount).toBe(1);
      expect(maxActiveThoughts).toBe(1);
      releaseFirstThought?.();

      await waitFor(() => thoughtCount === 2);
      expect(maxActiveThoughts).toBe(1);
      expect(followupKinds).toContain("owner_proposal");
    } finally {
      releaseFirstThought?.();
      await runtime.shutdown();
      skills.close();
      mind.close();
    }
  });

  it("preempts an uncommitted thought when a state event advances the revision", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    let releaseFirstThought: (() => void) | undefined;
    const firstThoughtGate = new Promise<void>((resolve) => {
      releaseFirstThought = resolve;
    });
    let thoughtCount = 0;
    let activeThoughts = 0;
    let maxActiveThoughts = 0;
    let firstSignal: AbortSignal | undefined;
    let followupKinds: readonly string[] = [];
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
        think: async ({ events, signal }) => {
          thoughtCount += 1;
          activeThoughts += 1;
          maxActiveThoughts = Math.max(maxActiveThoughts, activeThoughts);
          try {
            if (thoughtCount === 1) {
              firstSignal = signal;
              await firstThoughtGate;
              return { accepted: false };
            }
            followupKinds = events.map(({ kind }) => kind);
            return { accepted: true };
          } finally {
            activeThoughts -= 1;
          }
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });

    try {
      await runtime.start();
      await waitFor(() => thoughtCount === 1);
      const hurt = observation();
      body.setObservation({
        ...hurt,
        self: { ...hurt.self, health: 15 },
      });
      body.emit({
        type: "state_changed",
        reason: "vitals",
        at: new Date().toISOString(),
      });
      await waitFor(() =>
        mind.pendingEvents(64).some(({ kind }) => kind === "state_changed"),
      );
      expect(firstSignal?.aborted).toBe(true);
      expect(thoughtCount).toBe(1);
      releaseFirstThought?.();
      await waitFor(() => thoughtCount === 2);
      expect(maxActiveThoughts).toBe(1);
      expect(followupKinds).toContain("state_changed");
    } finally {
      releaseFirstThought?.();
      await runtime.shutdown();
      skills.close();
      mind.close();
    }
  });

  it("keeps an ordinary observation queued without invalidating an in-flight decision", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    let releaseFirstThought: (() => void) | undefined;
    const firstThoughtGate = new Promise<void>((resolve) => {
      releaseFirstThought = resolve;
    });
    let thoughtCount = 0;
    let firstSignal: AbortSignal | undefined;
    let firstCommitAccepted = false;
    let followupKinds: readonly string[] = [];
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
        think: async ({ snapshot, events, signal }) => {
          thoughtCount += 1;
          if (thoughtCount === 1) {
            firstSignal = signal;
            await firstThoughtGate;
            const decision = {
              kind: "wait" as const,
              purpose: "observe surroundings",
              reason: "wait for a meaningful change",
              wakeOn: ["state_changed" as const],
            };
            const saved = mind.commitThought({
              expectedRevision: snapshot.revision,
              decision,
            });
            firstCommitAccepted = saved.accepted;
            if (saved.accepted) mind.consumeEvents(events.map(({ id }) => id));
            return { accepted: saved.accepted, decision };
          }
          followupKinds = events.map(({ kind }) => kind);
          return { accepted: true };
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });

    try {
      await runtime.start();
      await waitFor(() => thoughtCount === 1);
      const revision = mind.snapshot().revision;
      const before = observation();
      body.setObservation({
        ...before,
        time: { ...before.time, timeOfDay: 16_000, isDay: false },
      });
      body.emit({
        type: "state_changed",
        reason: "time",
        at: new Date().toISOString(),
      });
      await waitFor(() =>
        mind.pendingEvents(64).some(({ kind }) => kind === "state_changed"),
      );
      expect(mind.snapshot().revision).toBe(revision);
      expect(firstSignal?.aborted).toBe(false);
      expect(thoughtCount).toBe(1);

      releaseFirstThought?.();
      await waitFor(() => thoughtCount === 2);
      expect(firstCommitAccepted).toBe(true);
      expect(followupKinds).toContain("state_changed");
    } finally {
      releaseFirstThought?.();
      await runtime.shutdown();
      skills.close();
      mind.close();
    }
  });

  it("clears queued thought wakes on stop and does not restart after settlement", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    let releaseThought: (() => void) | undefined;
    const thoughtGate = new Promise<void>((resolve) => {
      releaseThought = resolve;
    });
    let thoughtCount = 0;
    let signal: AbortSignal | undefined;
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
        think: async (input) => {
          thoughtCount += 1;
          signal = input.signal;
          await thoughtGate;
          return { accepted: false };
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });

    try {
      await runtime.start();
      await waitFor(() => thoughtCount === 1);
      body.emit({
        type: "operation_stalled",
        operationId: "body-1",
        operation: "look",
        elapsedMs: 30_000,
        at: new Date().toISOString(),
      });
      expect(mind.snapshot().pendingEventKinds).toContain("operation_stalled");

      mind.stop();
      await runtime.stopNow();
      expect(signal?.aborted).toBe(true);
      releaseThought?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      body.emit({ type: "reconnected", at: new Date().toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(thoughtCount).toBe(1);
      expect(runtime.snapshot.stopped).toBe(true);
    } finally {
      releaseThought?.();
      await runtime.shutdown();
      skills.close();
      mind.close();
    }
  });

  it("dispatches an accepted pending wake once despite a newer wait gate", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const skills = openSkills(databasePath, directory);
    const body = new DeferredBody();
    let releaseFirstThought: (() => void) | undefined;
    const firstThoughtGate = new Promise<void>((resolve) => {
      releaseFirstThought = resolve;
    });
    let thoughtCount = 0;
    let followupWaitKinds: readonly string[] = [];
    let followupEventKinds: readonly string[] = [];
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
        think: async ({ snapshot, events }) => {
          thoughtCount += 1;
          if (thoughtCount === 1) {
            await firstThoughtGate;
            return { accepted: true };
          }
          followupWaitKinds = snapshot.wait?.wakeOn ?? [];
          followupEventKinds = events.map(({ kind }) => kind);
          return { accepted: true };
        },
      },
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });

    try {
      await runtime.start();
      await waitFor(() => thoughtCount === 1);
      body.emit({
        type: "operation_stalled",
        operationId: "body-1",
        operation: "look",
        elapsedMs: 30_000,
        at: new Date().toISOString(),
      });
      const latest = mind.snapshot();
      const newWait = mind.commitThought({
        expectedRevision: latest.revision,
        decision: {
          kind: "wait",
          purpose: "wait for the action result",
          reason: "only reevaluate on a body outcome",
          wakeOn: ["body_outcome"],
        },
      });
      expect(newWait.accepted).toBe(true);

      releaseFirstThought?.();
      await waitFor(() => thoughtCount === 2);
      expect(followupWaitKinds).toEqual(["body_outcome"]);
      expect(followupEventKinds).toContain("operation_stalled");

      body.emit({ type: "bot_death", at: new Date().toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(thoughtCount).toBe(2);
    } finally {
      releaseFirstThought?.();
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
      const revision = mind.snapshot().revision;
      mind.enqueueEvent("state_changed", "meaningful change: vitals health=18");
      mind.enqueueEvent(
        "state_changed",
        "meaningful change: vitals health=16",
        {
          invalidateDecision: false,
        },
      );
      expect(mind.snapshot().revision).toBe(revision + 2);
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

  it("persists a deferred observation event without advancing decision CAS", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const revision = mind.snapshot().revision;
    mind.enqueueEvent("state_changed", "ordinary world change", {
      invalidateDecision: false,
    });
    expect(mind.snapshot().revision).toBe(revision);
    mind.close();

    const reopened = PlayerMindStore.open(databasePath);
    try {
      expect(reopened.snapshot().revision).toBe(revision);
      expect(
        reopened.pendingEvents(64).some(({ kind }) => kind === "state_changed"),
      ).toBe(true);
    } finally {
      reopened.close();
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
  #finishActive:
    ((status: PlayerOperationResult["status"]) => void) | undefined;
  #observation = observation();
  #resultBefore: PlayerBodyObservation | null = null;
  #resultAfter: PlayerBodyObservation | null = null;
  maxConcurrent = 0;
  stopCalls = 0;

  public requireRecoveryOnNextResult(): void {
    this.#recoveryOnNextResult = true;
  }

  public async observe(): Promise<PlayerBodyObservation> {
    return this.#observation;
  }

  public setObservation(value: PlayerBodyObservation): void {
    this.#observation = value;
  }

  public setResultObservations(
    before: PlayerBodyObservation,
    after: PlayerBodyObservation,
  ): void {
    this.#resultBefore = before;
    this.#resultAfter = after;
  }

  public completeActive(status: PlayerOperationResult["status"]): void {
    this.#finishActive?.(status);
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
          before: this.#resultBefore,
          after: this.#resultAfter,
          recoveryRequired,
        };
        if (this.#finishActive === finish) this.#finishActive = undefined;
        this.results.push(result);
        resolve(result);
      };
      this.#finishActive = finish;
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
      placementCandidateLimit: 24,
      omittedPlacementCandidates: 0,
      placementCandidatesMayBeTruncated: false,
      placementCandidates: [],
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
