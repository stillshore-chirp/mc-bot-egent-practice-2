import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { Response } from "openai/resources/responses/responses.js";

import { McSkillRepository } from "../../src/mc-skills/index.js";
import { playerOperationNames } from "../../src/minecraft/player-body-schema.js";
import type {
  PlayerBody,
  PlayerBodyObservation,
} from "../../src/minecraft/player-body.js";
import {
  PlayerConversationAgent,
  PlayerPurposeAgent,
} from "../../src/player/agents.js";
import type {
  PlayerMemoryPort,
  PlayerRuntimeEvent,
} from "../../src/player/contracts.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import { PlayerRuntime } from "../../src/player/runtime.js";
import type { PlayerResponsesClient } from "../../src/player/responses.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("player skill learning", () => {
  it("reviews a new trusted success before action and retries from the saved learning state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "player-learning-review-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory: join(directory, "exchange"),
      allowedOperationNames: playerOperationNames,
    });
    const mind = PlayerMindStore.open(databasePath);
    const runId = "learning-review-one-success";
    const outcomeEvent = recordTrustedSuccessfulOutcome(mind, skills, runId);
    const requests: unknown[] = [];
    const client = scriptedClient([
      (request) => {
        requests.push(request);
        return functionCallResponse(
          "review-success",
          "propose_skill_learning",
          learningArguments(
            runId,
            "Reach a landmark using an observed route",
            "dig",
          ),
        );
      },
      (request) => {
        requests.push(request);
        return functionCallResponse(
          "action-after-review",
          "commit_action_decision",
          waitArguments(),
        );
      },
    ]);
    const committed: string[] = [];
    const agent = new PlayerPurposeAgent({
      client,
      apiKey: "test-only",
      model: "gpt-6-luna",
      body: observationOnlyBody(),
      skills,
      mind,
      memory: createMemoryPort(),
      ownerPlayerId: "owner-player",
      logger: pino({ level: "silent" }),
      onCommitted: (_snapshot, decision) => committed.push(decision.kind),
    });

    const first = await agent.think({
      snapshot: mind.snapshot(),
      events: [outcomeEvent],
    });
    expect(first.accepted).toBe(false);
    expect(mind.snapshot().learningReferences).toHaveLength(1);
    expect(mind.snapshot().counters.learningUpdates).toBe(1);
    expect(requestToolNames(requests[0])).toEqual(["propose_skill_learning"]);
    expect(mind.pendingEvents()).toHaveLength(1);

    const retry = await agent.think({
      snapshot: mind.snapshot(),
      events: mind.pendingEvents(),
    });
    expect(retry.accepted).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requestToolNames(requests[1])).toContain("commit_action_decision");
    expect(committed).toEqual(["wait"]);
    expect(mind.pendingEvents()).toHaveLength(0);
    expect(mind.snapshot().counters.learningUpdates).toBe(1);

    skills.close();
    mind.close();
  });

  it("lets a non-reusable success skip learning and does not review the same run repeatedly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "player-learning-skip-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory: join(directory, "exchange"),
      allowedOperationNames: playerOperationNames,
    });
    const mind = PlayerMindStore.open(databasePath);
    const outcomeEvent = recordTrustedSuccessfulOutcome(
      mind,
      skills,
      "learning-review-skip-once",
    );
    const requests: unknown[] = [];
    const client = scriptedClient([
      (request) => {
        requests.push(request);
        return textResponse("review-skipped", "No reusable method was found.");
      },
      (request) => {
        requests.push(request);
        return functionCallResponse(
          "action-after-skip",
          "commit_action_decision",
          waitArguments(),
        );
      },
      (request) => {
        requests.push(request);
        return functionCallResponse(
          "same-run-retry",
          "commit_action_decision",
          waitArguments(),
        );
      },
    ]);
    const agent = new PlayerPurposeAgent({
      client,
      apiKey: "test-only",
      model: "gpt-6-luna",
      body: observationOnlyBody(),
      skills,
      mind,
      memory: createMemoryPort(),
      ownerPlayerId: "owner-player",
      logger: pino({ level: "silent" }),
      onCommitted: () => undefined,
    });

    const first = await agent.think({
      snapshot: mind.snapshot(),
      events: [outcomeEvent],
    });
    expect(first.accepted).toBe(true);
    expect(requestToolNames(requests[0])).toEqual(["propose_skill_learning"]);
    expect(requestToolNames(requests[1])).toContain("commit_action_decision");
    expect(mind.snapshot().counters.learningUpdates).toBe(0);

    const retry = await agent.think({
      snapshot: mind.snapshot(),
      events: [outcomeEvent],
    });
    expect(retry.accepted).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requestToolNames(requests[2])).toContain("commit_action_decision");
    expect(mind.snapshot().counters.learningUpdates).toBe(0);

    skills.close();
    mind.close();
  });

  it("supplies bounded current hypotheses that reference the successful operation", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "player-learning-related-hypotheses-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory: join(directory, "exchange"),
      allowedOperationNames: playerOperationNames,
    });
    const mind = PlayerMindStore.open(databasePath);
    const usedSkill = createLearningTestSkill(
      skills,
      "learning-used-skill",
      "Used operation method",
      "gathering",
    );
    const duplicateTitle = "A reusable operation method";
    const relatedSkills = [
      createLearningTestSkill(
        skills,
        "learning-related-duplicate-a",
        duplicateTitle,
      ),
      createLearningTestSkill(
        skills,
        "learning-related-duplicate-b",
        duplicateTitle,
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        createLearningTestSkill(
          skills,
          `learning-related-${index}`,
          `${String.fromCharCode(66 + index)} related operation method`,
        ),
      ),
    ];
    const revisedCandidate = relatedSkills[2];
    if (revisedCandidate === undefined)
      throw new Error("related candidate is missing");
    const revised = skills.revise({
      skillId: revisedCandidate.id,
      expectedVersion: revisedCandidate.version,
      changeKind: "revise",
      changeNote: "Keep only the current version in learning context.",
      patch: { confidence: 0.72 },
    });

    const runId = "learning-related-hypothesis-current-run";
    const observedAt = new Date().toISOString();
    const expectedOutcome = "The selected block is removed from view.";
    skills.recordTrustedEvidence({
      runId,
      operationName: "dig",
      inputSummary: "operation=dig against a visible target",
      conditions: ["The selected target is visible and within reach."],
      expectedOutcome,
      observedOutcome: "successful",
      observationSummary: "The next observation confirmed the block change.",
      skillIdAtUse: usedSkill.id,
      skillVersionAtUse: usedSkill.version,
      observedAt,
    });
    mind.recordOutcome({
      evidence: {
        operationId: runId,
        kind: "dig",
        status: "successful",
        summary: "The observed result matched the expected outcome.",
        expectedOutcome,
        skillId: usedSkill.id,
        skillVersion: usedSkill.version,
        observedAt,
      },
    });
    const outcomeEvent = mind.enqueueEvent(
      "body_outcome",
      "A successful body outcome needs purpose review.",
    );
    const requests: unknown[] = [];
    const agent = new PlayerPurposeAgent({
      client: scriptedClient([
        (request) => {
          requests.push(request);
          return textResponse("review-skip", "No new method needs saving.");
        },
        (request) => {
          requests.push(request);
          return functionCallResponse(
            "action-after-related-review",
            "commit_action_decision",
            waitArguments(),
          );
        },
      ]),
      apiKey: "test-only",
      model: "gpt-6-luna",
      body: observationOnlyBody(),
      skills,
      mind,
      memory: createMemoryPort(),
      ownerPlayerId: "owner-player",
      logger: pino({ level: "silent" }),
      onCommitted: () => undefined,
    });

    const result = await agent.think({
      snapshot: mind.snapshot(),
      events: [outcomeEvent],
    });
    expect(result.accepted).toBe(true);

    const learningInput = requestUserPayload(requests[0]);
    const usedHypothesis = recordOf(learningInput.usedHypothesis);
    expect(usedHypothesis).toMatchObject({
      id: usedSkill.id,
      version: usedSkill.version,
    });
    const candidates = learningInput.relatedHypotheses;
    expect(Array.isArray(candidates)).toBe(true);
    if (!Array.isArray(candidates))
      throw new Error("related hypotheses were not supplied");
    expect(candidates).toHaveLength(6);
    const candidateRecords = candidates.map((candidate) => recordOf(candidate));
    expect(candidateRecords.every((candidate) => candidate !== undefined)).toBe(
      true,
    );
    const candidateTitles = candidateRecords.map(
      (candidate) => candidate?.title,
    );
    expect(new Set(candidateTitles).size).toBe(6);
    expect(
      candidateTitles.filter((title) => title === duplicateTitle),
    ).toHaveLength(1);
    expect(candidateTitles).not.toContain(usedSkill.title);
    expect(
      candidateRecords.every(
        (candidate) =>
          Array.isArray(candidate?.operationRefs) &&
          candidate.operationRefs.includes("dig"),
      ),
    ).toBe(true);
    expect(
      candidateRecords.filter(
        (candidate) => candidate?.title === revisedCandidate.title,
      ),
    ).toEqual([
      expect.objectContaining({
        title: revisedCandidate.title,
        version: revised.version,
      }),
    ]);

    skills.close();
    mind.close();
  });

  it("requires a trusted receipt and avoids review on stale or stopped state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "player-learning-guard-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory: join(directory, "exchange"),
      allowedOperationNames: playerOperationNames,
    });
    const mind = PlayerMindStore.open(databasePath);
    const observedAt = new Date().toISOString();
    mind.recordOutcome({
      evidence: {
        operationId: "runtime-success-without-receipt",
        kind: "dig",
        status: "successful",
        summary: "The runtime recorded a success without a trusted receipt.",
        observedAt,
      },
    });
    const outcomeEvent = mind.enqueueEvent(
      "body_outcome",
      "A body outcome needs review.",
    );
    const requests: unknown[] = [];
    const agent = new PlayerPurposeAgent({
      client: scriptedClient([
        (request) => {
          requests.push(request);
          return functionCallResponse(
            "action-after-missing-receipt",
            "commit_action_decision",
            waitArguments(),
          );
        },
        (request) => {
          requests.push(request);
          return functionCallResponse(
            "action-after-stale-snapshot",
            "commit_action_decision",
            waitArguments(),
          );
        },
      ]),
      apiKey: "test-only",
      model: "gpt-6-luna",
      body: observationOnlyBody(),
      skills,
      mind,
      memory: createMemoryPort(),
      ownerPlayerId: "owner-player",
      logger: pino({ level: "silent" }),
      onCommitted: () => undefined,
    });

    const withoutReceipt = await agent.think({
      snapshot: mind.snapshot(),
      events: [outcomeEvent],
    });
    expect(withoutReceipt.accepted).toBe(true);
    expect(requestToolNames(requests[0])).toContain("commit_action_decision");

    const staleEvent = recordTrustedSuccessfulOutcome(
      mind,
      skills,
      "learning-review-stale-outcome",
    );
    const staleSnapshot = mind.snapshot();
    mind.recordOutcome({
      evidence: {
        operationId: "newer-runtime-outcome",
        kind: "dig",
        status: "failed",
        summary: "A newer outcome replaced the old success.",
        observedAt: new Date(Date.now() + 1).toISOString(),
      },
    });
    const currentSnapshot = mind.snapshot();
    const stale = await agent.think({
      snapshot: staleSnapshot,
      events: [staleEvent],
    });
    expect(stale.accepted).toBe(false);
    expect(requests).toHaveLength(1);

    mind.stop();
    const stopped = await agent.think({
      snapshot: currentSnapshot,
      events: [staleEvent],
    });
    expect(stopped.accepted).toBe(false);
    expect(requests).toHaveLength(1);

    skills.close();
    mind.close();
  });

  it("turns an owner chat proposal into a reasoned body operation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "player-proposal-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const exchangeDirectory = join(directory, "exchange");
    const mind = PlayerMindStore.open(databasePath);
    const skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory,
      allowedOperationNames: playerOperationNames,
    });
    const memory = createMemoryPort();
    const observationBody = observationOnlyBody();
    const executed: string[] = [];
    const body: PlayerBody = {
      ...observationBody,
      execute: async (operation, signal) => {
        executed.push(operation.kind);
        await new Promise((resolve) => setTimeout(resolve, 15));
        const before = await observationBody.observe();
        const after = await observationBody.observe();
        return {
          operationId: `observed-${executed.length}`,
          operation,
          status: signal?.aborted === true ? "interrupted" : "successful",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          before,
          after,
          recoveryRequired: false,
          detail:
            "The ordinary player action completed against the observed state.",
        };
      },
    };
    const runtimeRef: { current?: PlayerRuntime } = {};
    const conversation = new PlayerConversationAgent({
      client: scriptedClient([
        functionCallResponse("proposal-1", "propose_goal_change", {
          title: "Explore the nearby forest clearing",
          reason: "The area may have useful resources and paths to learn.",
          priority: 4,
        }),
        textResponse(
          "proposal-final",
          "I will weigh that against my current goals.",
        ),
      ]),
      apiKey: "test-only",
      model: "gpt-6-luna",
      ownerUsername: "owner",
      mind,
      memory,
      logger: pino({ level: "silent" }),
      say: async () => undefined,
      onProposal: () => runtimeRef.current?.onOwnerProposal(),
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    const purpose = new PlayerPurposeAgent({
      client: scriptedClient([
        proposalResolutionResponse,
        functionCallResponse(
          "decision-1",
          "commit_action_decision",
          actionArguments(),
        ),
        textResponse(
          "decision-final",
          "The nearby route is a useful first step.",
        ),
        functionCallResponse(
          "outcome-wait-1",
          "commit_action_decision",
          waitArguments(),
        ),
        textResponse("outcome-wait-final", "I will wait for another change."),
      ]),
      apiKey: "test-only",
      model: "gpt-6-luna",
      body,
      skills,
      mind,
      memory,
      ownerPlayerId: "owner-player",
      logger: pino({ level: "silent" }),
      onCommitted: (snapshot, decision) =>
        runtimeRef.current?.handleCommittedDecision(snapshot, decision),
    });
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
      runtime.receiveChat(
        "owner",
        "Could you explore the nearby forest clearing?",
      );
      await waitFor(() => executed.length === 1);
      await waitFor(() => mind.snapshot().lastOutcome !== undefined);

      const proposal = mind.snapshot().proposals[0];
      expect(proposal?.status).toBe("adopted");
      expect(proposal?.resolution).toContain("reassess");
      expect(executed).toEqual(["move_to"]);
      expect(
        mind
          .snapshot()
          .recentJudgments.some(
            ({ operationKind }) => operationKind === "move_to",
          ),
      ).toBe(true);
      expect(mind.snapshot().lastOutcome?.status).toBe("successful");
    } finally {
      await runtime.shutdown();
      skills.close();
      mind.close();
    }
  });

  it("carries an owner proposal through the agent Markdown export and import tools", async () => {
    const directory = mkdtempSync(join(tmpdir(), "player-markdown-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const exchangeDirectory = join(directory, "exchange");
    const mind = PlayerMindStore.open(databasePath);
    const skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory,
      allowedOperationNames: playerOperationNames,
    });
    const seed = skills.search({ limit: 1 })[0];
    if (seed === undefined) throw new Error("seed skill is missing");
    const historyBefore = skills.getHistory(seed.id).length;
    const fileName = "owner-edited-skill.md";
    const exportedPath = join(exchangeDirectory, fileName);
    const editedTitle = `${seed.title} reviewed by owner`;
    const editedBody =
      "Check the visible situation, choose a suitable step, and verify its result from the next observation.";
    const sayMessages: string[] = [];
    const observationBody = observationOnlyBody();
    const runtimeRef: { current?: PlayerRuntime } = {};
    const conversation = new PlayerConversationAgent({
      client: scriptedClient([
        functionCallResponse("markdown-proposal", "propose_goal_change", {
          title: "Review a stored Minecraft skill",
          reason: "I want to inspect and improve one reusable skill.",
          priority: 3,
        }),
        textResponse("markdown-conversation-final", "I will review that goal."),
      ]),
      apiKey: "test-only",
      model: "gpt-6-luna",
      ownerUsername: "owner",
      mind,
      memory: createMemoryPort(),
      logger: pino({ level: "silent" }),
      say: async (text) => {
        sayMessages.push(text);
      },
      onProposal: () => runtimeRef.current?.onOwnerProposal(),
      onStop: async () => undefined,
      onResume: () => undefined,
    });
    const purpose = new PlayerPurposeAgent({
      client: scriptedClient([
        proposalResolutionResponse,
        functionCallResponse("markdown-export", "export_skill_markdown", {
          skillId: seed.id,
          fileName,
        }),
        (request) => {
          const exported = recordOf(toolOutput(request, "markdown-export"));
          expect(exported?.ok).toBe(true);
          expect(exported?.path).toBe(realpathSync(exportedPath));
          const originalMarkdown = readFileSync(exportedPath, "utf8");
          expect(exported?.content).toBe(originalMarkdown);
          editExportedSkillMarkdown(exportedPath, editedTitle, editedBody);
          return functionCallResponse(
            "markdown-import-first",
            "import_skill_markdown",
            { fileName },
          );
        },
        (request) => {
          expect(toolOutput(request, "markdown-import-first")).toMatchObject({
            ok: true,
            id: seed.id,
            title: editedTitle,
            trustedInstructions: false,
          });
          const imported = skills.get(seed.id);
          expect(imported.title).toBe(editedTitle);
          expect(imported.body).toBe(editedBody);
          expect(imported.version).toBe(seed.version + 1);
          expect(skills.getHistory(seed.id)).toHaveLength(historyBefore + 1);
          return functionCallResponse(
            "markdown-import-repeat",
            "import_skill_markdown",
            { fileName },
          );
        },
        (request) => {
          expect(toolOutput(request, "markdown-import-repeat")).toMatchObject({
            ok: true,
            id: seed.id,
            title: editedTitle,
            trustedInstructions: false,
          });
          const repeated = skills.get(seed.id);
          expect(repeated.version).toBe(seed.version + 1);
          expect(repeated.body).toBe(editedBody);
          expect(skills.getHistory(seed.id)).toHaveLength(historyBefore + 1);
          return functionCallResponse(
            "markdown-wait",
            "commit_action_decision",
            {
              ...waitArguments(),
              reason:
                "The edited skill was imported and verified; wait for a new world change.",
            },
          );
        },
        (request) => {
          expect(recordOf(toolOutput(request, "markdown-wait"))?.ok).toBe(true);
          return textResponse(
            "markdown-purpose-final",
            "The edited skill is saved for future use.",
          );
        },
      ]),
      apiKey: "test-only",
      model: "gpt-6-luna",
      body: observationBody,
      skills,
      mind,
      memory: createMemoryPort(),
      ownerPlayerId: "owner-player",
      logger: pino({ level: "silent" }),
      onCommitted: (snapshot, decision) =>
        runtimeRef.current?.handleCommittedDecision(snapshot, decision),
    });
    const runtime = new PlayerRuntime({
      ownerUsername: "owner",
      playerId: "owner-player",
      body: observationBody,
      mind,
      memory: createMemoryPort(),
      skills,
      conversation,
      purpose,
      logger: pino({ level: "silent" }),
      say: async () => undefined,
    });
    runtimeRef.current = runtime;

    try {
      runtime.receiveChat(
        "owner",
        "Please review a stored skill and make its guidance clearer.",
      );
      await waitFor(
        () =>
          sayMessages.length === 1 &&
          !runtime.busy &&
          mind.snapshot().wait?.reason ===
            "The edited skill was imported and verified; wait for a new world change.",
      );

      expect(mind.snapshot().proposals[0]?.status).toBe("adopted");
      const searchResults = skills.search({ query: editedTitle, limit: 4 });
      expect(searchResults.some((skill) => skill.id === seed.id)).toBe(true);
      expect(skills.get(seed.id)).toMatchObject({
        title: editedTitle,
        body: editedBody,
        version: seed.version + 1,
      });
      expect(
        mind
          .snapshot()
          .skillActivity.filter(
            (activity) =>
              activity.skillId === seed.id && activity.kind === "exported",
          ),
      ).toHaveLength(1);
      expect(
        mind
          .snapshot()
          .skillActivity.filter(
            (activity) =>
              activity.skillId === seed.id && activity.kind === "imported",
          ),
      ).toHaveLength(2);
    } finally {
      await runtime.shutdown();
      skills.close();
      mind.close();
    }
  });

  it("creates a durable hypothesis from a trusted seed receipt without recounting the seed run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "player-learning-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const exchangeDirectory = join(directory, "exchange");
    let mind = PlayerMindStore.open(databasePath);
    let skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory,
      allowedOperationNames: playerOperationNames,
    });
    const seed = skills.search({ limit: 1 })[0];
    if (seed === undefined) throw new Error("seed skill is missing");
    const operationName = seed.operationRefs[0];
    if (operationName === undefined)
      throw new Error("seed operation reference is missing");
    const modelOperationRef = operationName === "dig" ? "look" : "dig";
    const runId = "learning-run-observed-success";
    const seedStatisticsBefore = skills.get(seed.id).nativeStatistics;
    skills.recordTrustedEvidence({
      runId,
      operationName,
      inputSummary: `operation=${operationName}`,
      conditions: ["dimension:overworld", "time:day"],
      expectedOutcome: "reach the selected landmark",
      observedOutcome: "successful",
      observationSummary: "The game observation confirmed the expected change.",
      skillIdAtUse: seed.id,
      skillVersionAtUse: seed.version,
      observedAt: new Date().toISOString(),
    });

    const title = "Reach a landmark using an observed route";
    const modelCreateArguments = learningArguments(
      runId,
      title,
      operationName,
      modelOperationRef,
    );
    modelCreateArguments.skillId = "model-provided-untrusted-target";
    modelCreateArguments.expectedVersion = seed.version + 7;
    const client = scriptedClient([
      functionCallResponse(
        "learn-1",
        "propose_skill_learning",
        modelCreateArguments,
      ),
      (request) => {
        expect(toolOutput(request, "learn-1")).toMatchObject({
          ok: true,
          outcome: "successful",
          idempotent: false,
          derivedFromSkillId: seed.id,
        });
        return functionCallResponse(
          "learn-2",
          "commit_action_decision",
          waitArguments(),
        );
      },
      functionCallResponse(
        "retry-1",
        "propose_skill_learning",
        learningArguments(runId, title, operationName),
      ),
      (request) => {
        expect(toolOutput(request, "retry-1")).toMatchObject({
          ok: true,
          outcome: "successful",
          idempotent: true,
          derivedFromSkillId: seed.id,
        });
        return functionCallResponse(
          "retry-2",
          "commit_action_decision",
          waitArguments(),
        );
      },
    ]);
    const committed: string[] = [];
    const agent = new PlayerPurposeAgent({
      client,
      apiKey: "test-only",
      model: "gpt-6-luna",
      body: observationOnlyBody(),
      skills,
      mind,
      memory: createMemoryPort(),
      ownerPlayerId: "owner-player",
      logger: pino({ level: "silent" }),
      onCommitted: (_snapshot, decision) => committed.push(decision.kind),
    });

    const first = await agent.think({ snapshot: mind.snapshot(), events: [] });
    expect(first.accepted).toBe(true);
    const created = skills.search({ query: title, limit: 4 })[0];
    expect(created).toBeDefined();
    if (created === undefined) throw new Error("hypothesis was not created");
    expect(created.operationRefs).toEqual([operationName]);
    expect(skills.listDerivedHypotheses(created.id)).toHaveLength(1);
    expect(skills.listDerivedHypotheses(created.id)[0]?.runId).toBe(runId);
    expect(
      skills.listDerivedHypotheses(created.id)[0]?.nativeOutcomeRecorded,
    ).toBe(false);
    expect(skills.get(seed.id).nativeStatistics).toEqual(seedStatisticsBefore);
    expect(mind.snapshot().learningReferences).toHaveLength(1);
    expect(mind.snapshot().counters.learningUpdates).toBe(1);

    const replay = await agent.think({ snapshot: mind.snapshot(), events: [] });
    expect(replay.accepted).toBe(true);
    expect(skills.search({ query: title, limit: 4 })).toHaveLength(1);
    expect(skills.listDerivedHypotheses(created.id)).toHaveLength(1);
    expect(mind.snapshot().learningReferences).toHaveLength(1);
    expect(mind.snapshot().counters.learningUpdates).toBe(1);
    expect(committed).toEqual(["wait", "wait"]);

    skills.close();
    mind.close();
    skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory,
      allowedOperationNames: playerOperationNames,
    });
    mind = PlayerMindStore.open(databasePath);
    expect(skills.get(created.id).title).toBe(title);
    expect(skills.listDerivedHypotheses(created.id)[0]?.runId).toBe(runId);
    expect(skills.get(seed.id).nativeStatistics).toEqual(seedStatisticsBefore);
    expect(mind.snapshot().learningReferences).toHaveLength(1);
    expect(mind.snapshot().counters.learningUpdates).toBe(1);
    skills.close();
    mind.close();
  });

  it("rejects create from a failed skill-use receipt even when model target fields are set", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "player-learning-invalid-create-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory: join(directory, "exchange"),
      allowedOperationNames: playerOperationNames,
    });
    const mind = PlayerMindStore.open(databasePath);
    const seed = skills.search({ limit: 1 })[0];
    if (seed === undefined) throw new Error("seed skill is missing");
    const operationName = seed.operationRefs[0];
    if (operationName === undefined)
      throw new Error("seed operation reference is missing");
    const runId = "learning-failed-used-skill-receipt";
    skills.recordTrustedEvidence({
      runId,
      operationName,
      inputSummary: `operation=${operationName}`,
      conditions: ["dimension:overworld", "time:day"],
      expectedOutcome: "reach the selected landmark",
      observedOutcome: "failed",
      observationSummary: "The observed action did not reach the landmark.",
      skillIdAtUse: seed.id,
      skillVersionAtUse: seed.version,
      observedAt: new Date().toISOString(),
    });
    const title = "Failed receipt must not create a new hypothesis";
    const modelCreateArguments = learningArguments(runId, title, operationName);
    modelCreateArguments.skillId = seed.id;
    modelCreateArguments.expectedVersion = seed.version;
    const client = scriptedClient([
      functionCallResponse(
        "invalid-create",
        "propose_skill_learning",
        modelCreateArguments,
      ),
      (request) => {
        expect(toolOutput(request, "invalid-create")).toMatchObject({
          ok: false,
          code: "CREATE_REQUIRES_SUCCESSFUL_RECEIPT",
        });
        return functionCallResponse(
          "invalid-create-wait",
          "commit_action_decision",
          waitArguments(),
        );
      },
    ]);
    const agent = new PlayerPurposeAgent({
      client,
      apiKey: "test-only",
      model: "gpt-6-luna",
      body: observationOnlyBody(),
      skills,
      mind,
      memory: createMemoryPort(),
      ownerPlayerId: "owner-player",
      logger: pino({ level: "silent" }),
      onCommitted: () => undefined,
    });

    try {
      const result = await agent.think({
        snapshot: mind.snapshot(),
        events: [],
      });
      expect(result.accepted).toBe(true);
      expect(
        skills
          .search({ query: title, limit: 4 })
          .some((skill) => skill.title === title),
      ).toBe(false);
      expect(mind.snapshot().learningReferences).toHaveLength(0);
      expect(mind.snapshot().counters.learningUpdates).toBe(0);
    } finally {
      skills.close();
      mind.close();
    }
  });
});

function learningArguments(
  runId: string,
  title: string,
  operationName: string,
  modelOperationRef = operationName,
): Record<string, unknown> {
  return {
    runId,
    mode: "create",
    skillId: "",
    expectedVersion: 0,
    category: "navigation",
    title,
    purpose: "reach a chosen landmark using the current visible route",
    conditions: ["A landmark is selected and a route is visible."],
    body: "Compare the visible route to the landmark, select a suitable path, and verify arrival from the next body observation.",
    operationRefs: [modelOperationRef],
    expectedOutcome: "The next observation confirms arrival at the landmark.",
    confidence: 0.65,
    changeKind: "revise",
    changeNote:
      "Created from one trusted observed success; the next use can validate it.",
  };
}

function recordTrustedSuccessfulOutcome(
  mind: PlayerMindStore,
  skills: McSkillRepository,
  runId: string,
): PlayerRuntimeEvent {
  const observedAt = new Date().toISOString();
  const expectedOutcome = "The selected block is removed from view.";
  skills.recordTrustedEvidence({
    runId,
    operationName: "dig",
    inputSummary: "operation=dig against the selected visible block",
    conditions: ["The target block is visible and within reach."],
    expectedOutcome,
    observedOutcome: "successful",
    observationSummary: "The next body observation confirmed the block change.",
    observedAt,
  });
  mind.recordOutcome({
    evidence: {
      operationId: runId,
      kind: "dig",
      status: "successful",
      summary: "The body observation confirmed the expected change.",
      expectedOutcome,
      observedAt,
    },
  });
  return mind.enqueueEvent(
    "body_outcome",
    "A successful body outcome needs purpose review.",
  );
}

function requestToolNames(request: unknown): string[] {
  const tools = recordOf(request)?.tools;
  if (!Array.isArray(tools))
    throw new Error("Responses request does not contain tools");
  return tools
    .map((tool) => recordOf(tool)?.name)
    .filter((name): name is string => typeof name === "string");
}

function waitArguments(): Record<string, unknown> {
  return {
    kind: "wait",
    purpose: "wait for the next meaningful world change",
    operationJson: "",
    expectedOutcome: "",
    skillId: "",
    skillVersion: 0,
    reason: "Wait for the next meaningful world change before acting.",
    wakeOn: ["state_changed"],
    wakeAt: "",
  };
}

function actionArguments(): Record<string, unknown> {
  return {
    kind: "act",
    purpose: "Explore the visible route to the nearby clearing.",
    operationJson: JSON.stringify({
      kind: "move_to",
      position: { x: 8, y: 64, z: 3 },
      range: 1,
    }),
    expectedOutcome:
      "The next body observation shows progress toward the clearing.",
    skillId: "",
    skillVersion: 0,
    reason: "",
    wakeOn: ["body_outcome"],
    wakeAt: "",
  };
}

type ScriptedResponse = Response | ((request: unknown) => Response);

function scriptedClient(responses: ScriptedResponse[]): PlayerResponsesClient {
  return {
    responses: {
      create: async (request: unknown) => {
        const response = responses.shift();
        if (response === undefined)
          throw new Error("proposal test response queue is empty");
        return typeof response === "function" ? response(request) : response;
      },
    },
  } as unknown as PlayerResponsesClient;
}

function proposalResolutionResponse(request: unknown): Response {
  const runtime = recordOf(requestUserPayload(request).runtime);
  const proposals = runtime?.proposals;
  if (!Array.isArray(proposals))
    throw new Error("owner proposals were not supplied");
  const proposal: unknown = proposals.find(
    (candidate: unknown) => recordOf(candidate)?.status === "pending",
  );
  const proposalId = recordOf(proposal)?.id;
  if (typeof proposalId !== "string")
    throw new Error("pending owner proposal was not supplied");
  return functionCallResponse("resolution-1", "commit_goal_state", {
    proposalId,
    proposalDisposition: "adopted",
    resolution: "Explore the nearby clearing first, then reassess.",
    goalId: "",
    goalTitle: "",
    goalStatus: "none",
    goalPriority: 3,
    changeReason: "",
    goalSource: "none",
  });
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function requestUserPayload(request: unknown): Record<string, unknown> {
  const messages = recordOf(request)?.input;
  if (!Array.isArray(messages))
    throw new Error("purpose request does not contain messages");
  const userMessage = messages
    .map(recordOf)
    .find(
      (message) =>
        message?.role === "user" && typeof message.content === "string",
    );
  if (typeof userMessage?.content !== "string")
    throw new Error("purpose request does not contain user content");
  const payload = recordOf(JSON.parse(userMessage.content));
  if (payload === undefined)
    throw new Error("purpose user content is not an object");
  return payload;
}

function createLearningTestSkill(
  skills: McSkillRepository,
  id: string,
  title: string,
  category: "combat" | "gathering" = "combat",
) {
  return skills.createSkill({
    id,
    category,
    title,
    purpose: `Reusable method: ${title}.`,
    conditions: ["A target is visible."],
    body: "Check the observed outcome after the operation.",
    operationRefs: ["dig"],
    expectedOutcome: `The next observation confirms ${title}.`,
    confidence: 0.6,
  });
}

function toolOutput(request: unknown, responseId: string): unknown {
  const requestRecord = recordOf(request);
  const messages = requestRecord?.input;
  if (!Array.isArray(messages))
    throw new Error("purpose request is not a message list");
  const output = messages
    .map(recordOf)
    .find(
      (item) =>
        item?.type === "function_call_output" &&
        item.call_id === `${responseId}-call`,
    );
  if (typeof output?.output !== "string")
    throw new Error(`tool output was not found: ${responseId}`);
  return JSON.parse(output.output) as unknown;
}

function editExportedSkillMarkdown(
  path: string,
  title: string,
  body: string,
): void {
  const markdown = readFileSync(path, "utf8");
  const match =
    /^# [^\n]+\n\n```mc-bot-skill\n([\s\S]*?)\n```\n\n## 本文\n[\s\S]*?\n?$/u.exec(
      markdown,
    );
  if (match?.[1] === undefined)
    throw new Error("exported skill Markdown has an unexpected format");
  const metadata: unknown = JSON.parse(match[1]);
  const metadataRecord = recordOf(metadata);
  const skillRecord = recordOf(metadataRecord?.skill);
  if (metadataRecord === undefined || skillRecord === undefined)
    throw new Error("exported skill metadata is invalid");
  metadataRecord.skill = { ...skillRecord, title };
  writeFileSync(
    path,
    [
      `# ${title}`,
      "",
      "```mc-bot-skill",
      JSON.stringify(metadataRecord, null, 2),
      "```",
      "",
      "## 本文",
      body,
      "",
    ].join("\n"),
    "utf8",
  );
}

function functionCallResponse(
  id: string,
  name: string,
  argumentsValue: Record<string, unknown>,
): Response {
  return {
    id,
    status: "completed",
    output: [
      {
        type: "function_call",
        id: `${id}-item`,
        call_id: `${id}-call`,
        name,
        arguments: JSON.stringify(argumentsValue),
        status: "completed",
      },
    ],
    output_text: "",
    usage: { input_tokens: 80, output_tokens: 10, total_tokens: 90 },
  } as unknown as Response;
}

function textResponse(id: string, outputText: string): Response {
  return {
    id,
    status: "completed",
    output: [],
    output_text: outputText,
    usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
  } as unknown as Response;
}

function observationOnlyBody(): PlayerBody {
  const observe = async (): Promise<PlayerBodyObservation> => ({
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
  });
  return {
    observe,
    execute: async () => {
      throw new Error("body execution is not part of this learning test");
    },
    stop: async () => undefined,
    knowledge: (query) => ({
      source: "minecraft_registry",
      gameVersion: "test",
      registryVersion: "test",
      observedAt: new Date().toISOString(),
      query,
      facts: [],
      inferences: [],
      truncated: false,
    }),
    onEvent: () => () => undefined,
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
