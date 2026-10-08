import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  PlayerActionPlan,
  PlayerGoal,
  PlayerGoalChange,
  PlayerThoughtDecision,
} from "../../src/player/contracts.js";
import {
  playerGoalStateSignature,
  PlayerMindStore,
} from "../../src/player/mind-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("owner proposal goals", () => {
  it("signs the complete active and paused goal state deterministically", () => {
    const active: PlayerGoal = {
      id: "owner-active",
      ownerProposalId: "proposal-active",
      title: "Find a safe route",
      status: "active",
      priority: 4,
      changeReason: "Reach the village without entering danger.",
      source: "owner",
      updatedAt: "2026-10-09T00:00:00.000Z",
    };
    const paused: PlayerGoal = {
      id: "owner-paused",
      title: "Repair the shelter",
      status: "paused",
      priority: 2,
      changeReason: "Resume after the route is safe.",
      source: "owner",
      updatedAt: "2026-10-09T00:00:01.000Z",
    };
    const goals = [active, paused];
    const signature = playerGoalStateSignature(goals);

    expect(playerGoalStateSignature([...goals].reverse())).toBe(signature);
    expect(playerGoalStateSignature([active])).not.toBe(signature);
    expect(
      playerGoalStateSignature([
        active,
        paused,
        {
          ...active,
          id: "owner-new",
          ownerProposalId: undefined,
        },
      ]),
    ).not.toBe(signature);
    for (const changed of [
      { ...active, title: "Take the northern route" },
      { ...active, status: "paused" as const },
      { ...active, priority: 5 },
      { ...active, changeReason: "Conditions changed after sunset." },
      { ...active, ownerProposalId: "proposal-updated" },
    ])
      expect(playerGoalStateSignature([changed, paused])).not.toBe(signature);
    expect(
      playerGoalStateSignature([
        ...goals,
        {
          ...active,
          id: "persona-goal",
          ownerProposalId: undefined,
          source: "persona",
        },
      ]),
    ).not.toBe(signature);
    expect(
      playerGoalStateSignature([
        ...goals,
        {
          ...active,
          id: "completed-goal",
          status: "completed",
          source: "persona",
        },
      ]),
    ).toBe(signature);
  });

  it("stamps the plan after atomic goal updates and leaves standalone updates stale", () => {
    const { mind } = openMind();
    const plan: PlayerActionPlan = {
      id: "owner-plan",
      purpose: "Find a safe route.",
      goalId: "owner-route",
      steps: [
        {
          sequence: 0,
          operation: { kind: "look", target: { x: 0, y: 64, z: 1 } },
          expectedOutcome: "Inspect the route.",
          status: "pending",
        },
      ],
    };
    try {
      const created = mind.commitGoalState({
        expectedRevision: mind.snapshot().revision,
        goal: {
          id: "owner-route",
          title: "Find a safe route",
          status: "active",
          priority: 3,
          changeReason: "Reach the village safely.",
          source: "owner",
        },
      });
      expect(created.accepted).toBe(true);

      const committed = mind.commitThought({
        expectedRevision: created.snapshot.revision,
        decision: action("owner-plan-step"),
        actionPlan: plan,
        goal: {
          id: "owner-route",
          title: "Find a safe route before sunset",
          status: "active",
          priority: 4,
          changeReason: "Avoid the exposed road before night.",
          source: "owner",
        },
      });
      expect(committed.accepted).toBe(true);
      const savedSignature = committed.snapshot.actionPlan?.goalStateSignature;
      expect(savedSignature).toBe(
        playerGoalStateSignature(committed.snapshot.goals),
      );

      const standaloneUpdate = mind.commitGoalState({
        expectedRevision: committed.snapshot.revision,
        goal: {
          id: "owner-route",
          title: "Find a safe route before sunset",
          status: "active",
          priority: 5,
          changeReason: "Avoid the exposed road and watch for hostiles.",
          source: "owner",
        },
      });
      expect(standaloneUpdate.accepted).toBe(true);
      expect(standaloneUpdate.snapshot.actionPlan?.goalStateSignature).toBe(
        savedSignature,
      );
      expect(savedSignature).not.toBe(
        playerGoalStateSignature(standaloneUpdate.snapshot.goals),
      );
    } finally {
      mind.close();
    }
  });

  it.each([
    ["commitThought", "adopted"],
    ["commitGoalState", "compromised"],
  ] as const)(
    "persists a linked owner goal through %s for %s proposals",
    (path, disposition) => {
      const { databasePath, mind } = openMind();
      const proposal = mind.addProposal({
        title: `Visit the village for ${path}`,
        reason: "The owner asked to meet nearby residents.",
        priority: 4,
      });

      try {
        const result = resolve(mind, proposal.id, disposition, path);
        expect(result.accepted).toBe(true);
        const saved = mind.snapshot();
        expect(
          saved.proposals.find(({ id }) => id === proposal.id)?.status,
        ).toBe(disposition);
        expect(saved.goals).toContainEqual(
          expect.objectContaining({
            ownerProposalId: proposal.id,
            title: proposal.title,
            source: "owner",
            status: "active",
            changeReason: proposal.reason,
          }),
        );
      } finally {
        mind.close();
      }

      const reopened = PlayerMindStore.open(databasePath);
      try {
        expect(
          reopened
            .snapshot()
            .goals.some((goal) => goal.ownerProposalId === proposal.id),
        ).toBe(true);
      } finally {
        reopened.close();
      }
    },
  );

  it("reuses an unlinked owner goal and keeps a same-title self goal separate", () => {
    const { mind } = openMind();
    try {
      const proposal = mind.addProposal({
        title: "Find a safe path to the village",
        reason: "The owner wants to meet nearby residents.",
      });
      const selfGoal = goal({
        title: proposal.title,
        source: "self",
        id: "self-lookahead",
      });
      const ownerGoal = goal({
        title: proposal.title,
        source: "owner",
        id: "owner-existing",
      });
      let result = mind.commitGoalState({
        expectedRevision: mind.snapshot().revision,
        goal: selfGoal,
      });
      expect(result.accepted).toBe(true);
      result = mind.commitGoalState({
        expectedRevision: result.snapshot.revision,
        goal: ownerGoal,
      });
      expect(result.accepted).toBe(true);

      result = mind.commitGoalState({
        expectedRevision: result.snapshot.revision,
        proposalResolution: {
          proposalId: proposal.id,
          disposition: "adopted",
          resolution: "Proceed while keeping the meeting goal.",
        },
      });
      expect(result.accepted).toBe(true);
      const sameTitle = mind
        .snapshot()
        .goals.filter((entry) => entry.title === proposal.title);
      expect(sameTitle).toHaveLength(2);
      expect(sameTitle.find((entry) => entry.source === "self")?.id).toBe(
        "self-lookahead",
      );
      expect(sameTitle.find((entry) => entry.source === "owner")).toMatchObject(
        { id: "owner-existing", ownerProposalId: proposal.id },
      );
    } finally {
      mind.close();
    }
  });

  it.each(["commitThought", "commitGoalState"] as const)(
    "links a differently worded compromise goal through %s without duplicating owner intent",
    (path) => {
      const { mind } = openMind();
      try {
        const proposal = mind.addProposal({
          title: "Find a path to the village",
          reason: "The owner wants to reach the village.",
        });
        const compromisedGoal = goal({
          title: "Survey a safe route before entering the village",
          source: "owner",
        });
        const proposalResolution = {
          proposalId: proposal.id,
          disposition: "compromised" as const,
          resolution: "Survey first, then approach the village.",
        };
        const result =
          path === "commitThought"
            ? mind.commitThought({
                expectedRevision: mind.snapshot().revision,
                decision: action("survey-route"),
                goal: compromisedGoal,
                proposalResolution,
              })
            : mind.commitGoalState({
                expectedRevision: mind.snapshot().revision,
                goal: compromisedGoal,
                proposalResolution,
              });

        expect(result.accepted).toBe(true);
        expect(
          result.snapshot.goals.filter(({ source }) => source === "owner"),
        ).toHaveLength(1);
        expect(result.snapshot.goals).toContainEqual(
          expect.objectContaining({
            ownerProposalId: proposal.id,
            title: compromisedGoal.title,
            status: "active",
            source: "owner",
          }),
        );
        expect(result.snapshot.proposals).toContainEqual(
          expect.objectContaining({ id: proposal.id, status: "compromised" }),
        );
      } finally {
        mind.close();
      }
    },
  );

  it("keeps different proposal links and honors an explicit terminal linked goal", () => {
    const { mind } = openMind();
    try {
      const first = mind.addProposal({
        title: "Explore the eastern village",
        reason: "First owner intent.",
      });
      const second = mind.addProposal({
        title: first.title,
        reason: "A separate owner request with the same title.",
      });
      let result = mind.commitGoalState({
        expectedRevision: mind.snapshot().revision,
        proposalResolution: {
          proposalId: first.id,
          disposition: "adopted",
          resolution: "Keep this as the first linked goal.",
        },
      });
      expect(result.accepted).toBe(true);
      const firstGoal = result.snapshot.goals.find(
        (entry) => entry.ownerProposalId === first.id,
      );
      expect(firstGoal).toBeDefined();
      if (firstGoal === undefined) throw new Error("first linked goal missing");

      result = mind.commitGoalState({
        expectedRevision: result.snapshot.revision,
        goal: {
          id: firstGoal.id,
          title: firstGoal.title,
          status: "completed",
          priority: firstGoal.priority,
          changeReason: "Do not retarget this existing proposal link.",
          source: "owner",
        },
        proposalResolution: {
          proposalId: second.id,
          disposition: "compromised",
          resolution: "Preserve both owner requests independently.",
        },
      });
      expect(result.accepted).toBe(true);
      expect(result.snapshot.goals).toContainEqual(
        expect.objectContaining({
          id: firstGoal.id,
          ownerProposalId: first.id,
          status: "completed",
        }),
      );
      expect(result.snapshot.goals).toContainEqual(
        expect.objectContaining({
          ownerProposalId: second.id,
          title: second.title,
          status: "active",
        }),
      );

      const third = mind.addProposal({
        title: "Complete this linked owner goal",
        reason: "The owner explicitly asks to close it immediately.",
      });
      result = mind.commitGoalState({
        expectedRevision: mind.snapshot().revision,
        goal: goal({
          title: third.title,
          source: "owner",
          status: "completed",
        }),
        proposalResolution: {
          proposalId: third.id,
          disposition: "adopted",
          resolution: "The owner requested completion in the same update.",
        },
      });
      expect(result.accepted).toBe(true);
      expect(result.snapshot.goals).toContainEqual(
        expect.objectContaining({
          ownerProposalId: third.id,
          title: third.title,
          status: "completed",
        }),
      );
    } finally {
      mind.close();
    }
  });

  it.each(["commitThought", "commitGoalState"] as const)(
    "updates an explicitly selected live goal across proposal IDs through %s",
    (path) => {
      const { mind } = openMind();
      try {
        const first = mind.addProposal({
          title: "Collect 4 oak logs",
          reason: "The owner wants oak logs for a build.",
        });
        const firstResult = resolve(
          mind,
          first.id,
          "adopted",
          "commitGoalState",
        );
        expect(firstResult.accepted).toBe(true);
        const originalGoal = firstResult.snapshot.goals.find(
          (entry) => entry.ownerProposalId === first.id,
        );
        expect(originalGoal).toBeDefined();
        if (originalGoal === undefined)
          throw new Error("first linked goal missing");

        const second = mind.addProposal({
          title: "Collect 8 oak logs",
          reason: "The owner updated the requested quantity.",
        });
        const goal = {
          id: originalGoal.id,
          title: second.title,
          status: "active" as const,
          priority: originalGoal.priority,
          changeReason: second.reason,
          source: "owner" as const,
        };
        const proposalResolution = {
          proposalId: second.id,
          disposition: "adopted" as const,
          resolution: "Update the existing collection goal.",
        };
        const result =
          path === "commitThought"
            ? mind.commitThought({
                expectedRevision: mind.snapshot().revision,
                decision: action("update-oak-log-quantity"),
                goal,
                proposalResolution,
              })
            : mind.commitGoalState({
                expectedRevision: mind.snapshot().revision,
                goal,
                proposalResolution,
              });

        expect(result.accepted).toBe(true);
        expect(result.snapshot.goals).toHaveLength(1);
        expect(result.snapshot.goals[0]).toMatchObject({
          id: originalGoal.id,
          ownerProposalId: first.id,
          title: second.title,
          status: "active",
          changeReason: second.reason,
        });
        expect(result.snapshot.proposals).toContainEqual(
          expect.objectContaining({ id: second.id, status: "adopted" }),
        );
      } finally {
        mind.close();
      }
    },
  );

  it("preserves a self intermediate goal alongside the linked owner goal", () => {
    const { mind } = openMind();
    try {
      const proposal = mind.addProposal({
        title: "Bring supplies to the village",
        reason: "The owner wants supplies delivered.",
      });
      const result = mind.commitThought({
        expectedRevision: mind.snapshot().revision,
        decision: action("self-intermediate"),
        goal: goal({
          id: "look-for-supplies",
          title: "Find supplies before traveling",
          source: "self",
        }),
        proposalResolution: {
          proposalId: proposal.id,
          disposition: "compromised",
          resolution: "Gather supplies first, then travel.",
        },
      });
      expect(result.accepted).toBe(true);
      expect(result.snapshot.goals).toContainEqual(
        expect.objectContaining({ id: "look-for-supplies", source: "self" }),
      );
      expect(result.snapshot.goals).toContainEqual(
        expect.objectContaining({
          ownerProposalId: proposal.id,
          title: proposal.title,
          source: "owner",
        }),
      );
    } finally {
      mind.close();
    }
  });

  it("declines without creating a linked goal", () => {
    const { mind } = openMind();
    try {
      const proposal = mind.addProposal({
        title: "Build a tower",
        reason: "The owner proposed a tower.",
      });
      const result = mind.commitThought({
        expectedRevision: mind.snapshot().revision,
        decision: action("decline-owner-goal"),
        proposalResolution: {
          proposalId: proposal.id,
          disposition: "declined",
          resolution: "This is not a useful goal now.",
        },
      });
      expect(result.accepted).toBe(true);
      expect(
        result.snapshot.goals.some(
          (entry) => entry.ownerProposalId === proposal.id,
        ),
      ).toBe(false);
      expect(
        result.snapshot.proposals.find(({ id }) => id === proposal.id)?.status,
      ).toBe("declined");
      const retry = mind.commitThought({
        expectedRevision: result.snapshot.revision,
        decision: action("do-not-resurrect-declined-proposal"),
        proposalResolution: {
          proposalId: proposal.id,
          disposition: "adopted",
          resolution: "A resolved proposal must not be reopened implicitly.",
        },
      });
      expect(retry).toMatchObject({
        accepted: false,
        rejectionCode: "PROPOSAL_NOT_PENDING",
      });
      expect(retry.snapshot.goals).toHaveLength(0);
    } finally {
      mind.close();
    }
  });

  it("evicts an old unlinked proposal while retaining paused linked proposals", () => {
    const { mind } = openMind();
    try {
      const linked = mind.addProposal({
        title: "Keep the paused owner goal",
        reason: "This proposal remains actionable later.",
      });
      let result = mind.commitGoalState({
        expectedRevision: mind.snapshot().revision,
        proposalResolution: {
          proposalId: linked.id,
          disposition: "adopted",
          resolution: "The goal is paused for later.",
        },
      });
      expect(result.accepted).toBe(true);
      const linkedGoal = result.snapshot.goals.find(
        (entry) => entry.ownerProposalId === linked.id,
      );
      expect(linkedGoal).toBeDefined();
      if (linkedGoal === undefined) throw new Error("linked goal missing");
      result = mind.commitGoalState({
        expectedRevision: result.snapshot.revision,
        goal: {
          id: linkedGoal.id,
          title: linkedGoal.title,
          status: "paused",
          priority: linkedGoal.priority,
          changeReason: "Pause while preserving the owner intent.",
          source: "owner",
        },
      });
      expect(result.accepted).toBe(true);

      const unlinked: string[] = [];
      for (let index = 0; index < 59; index += 1) {
        unlinked.push(
          mind.addProposal({
            title: `Unlinked proposal ${index}`,
            reason: "Eligible for bounded eviction.",
          }).id,
        );
      }
      expect(mind.snapshot().proposals).toHaveLength(60);
      const added = mind.addProposal({
        title: "Newest proposal",
        reason: "The oldest unlinked record may be replaced.",
      });
      const saved = mind.snapshot();
      expect(saved.proposals.some(({ id }) => id === linked.id)).toBe(true);
      expect(saved.proposals.some(({ id }) => id === unlinked[0])).toBe(false);
      expect(saved.proposals.some(({ id }) => id === added.id)).toBe(true);
      expect(saved.goals).toContainEqual(
        expect.objectContaining({
          id: linkedGoal.id,
          ownerProposalId: linked.id,
          status: "paused",
        }),
      );
    } finally {
      mind.close();
    }
  });

  it("can evict an old terminal-linked proposal before active linked proposals", () => {
    const { mind } = openMind();
    try {
      const terminal = mind.addProposal({
        title: "Completed owner intent",
        reason: "This completed link can age out.",
      });
      let result = resolve(mind, terminal.id, "adopted", "commitGoalState");
      expect(result.accepted).toBe(true);
      const terminalGoal = result.snapshot.goals.find(
        (entry) => entry.ownerProposalId === terminal.id,
      );
      expect(terminalGoal).toBeDefined();
      if (terminalGoal === undefined) throw new Error("terminal goal missing");
      result = mind.commitGoalState({
        expectedRevision: result.snapshot.revision,
        goal: {
          id: terminalGoal.id,
          title: terminalGoal.title,
          status: "completed",
          priority: terminalGoal.priority,
          changeReason: "The owner intent is complete.",
          source: "owner",
        },
      });
      expect(result.accepted).toBe(true);

      const activeIds: string[] = [];
      for (let index = 0; index < 59; index += 1) {
        const proposal = mind.addProposal({
          title: `Active owner intent ${index}`,
          reason: "This linked goal must remain actionable.",
        });
        activeIds.push(proposal.id);
        result = resolve(mind, proposal.id, "adopted", "commitGoalState");
        expect(result.accepted).toBe(true);
      }
      expect(mind.snapshot().proposals).toHaveLength(60);
      const added = mind.addProposal({
        title: "New owner intent",
        reason: "The terminal link is the oldest eligible row.",
      });
      const saved = mind.snapshot();
      expect(saved.proposals.some(({ id }) => id === terminal.id)).toBe(false);
      expect(saved.proposals.some(({ id }) => id === added.id)).toBe(true);
      for (const proposalId of activeIds)
        expect(saved.proposals.some(({ id }) => id === proposalId)).toBe(true);
      expect(saved.goals).toContainEqual(
        expect.objectContaining({
          id: terminalGoal.id,
          ownerProposalId: terminal.id,
          status: "completed",
        }),
      );
    } finally {
      mind.close();
    }
  });

  it("rejects proposal creation atomically when every row has an active link", () => {
    const { mind } = openMind();
    try {
      for (let index = 0; index < 60; index += 1) {
        const proposal = mind.addProposal({
          title: `Protected owner goal ${index}`,
          reason: `Keep proposal row ${index} for its active goal.`,
        });
        const result = resolve(mind, proposal.id, "adopted", "commitThought");
        expect(result.accepted).toBe(true);
      }
      const before = mind.snapshot();
      const eventsBefore = mind.pendingEvents(64);
      expect(() =>
        mind.addProposal({
          title: "Capacity rejection",
          reason: "This request cannot displace a live owner goal.",
        }),
      ).toThrow("PLAYER_PROPOSAL_CAPACITY");
      const after = mind.snapshot();
      expect(after.revision).toBe(before.revision);
      expect(after.proposals).toEqual(before.proposals);
      expect(after.goals).toEqual(before.goals);
      expect(mind.pendingEvents(64)).toEqual(eventsBefore);

      const selfGoalAtCapacity = mind.commitGoalState({
        expectedRevision: after.revision,
        goal: goal({
          title: "Self goal at active-link capacity",
          source: "self",
        }),
      });
      expect(selfGoalAtCapacity).toMatchObject({
        accepted: false,
        rejectionCode: "GOAL_CAPACITY",
      });
      expect(mind.snapshot().goals).toEqual(before.goals);
    } finally {
      mind.close();
    }
  });

  it("rolls back stale, stopped, and invalid proposal resolutions", () => {
    const { mind } = openMind();
    try {
      const proposal = mind.addProposal({
        title: "Wait for a better time",
        reason: "The owner wants a later visit.",
      });
      const stale = mind.commitThought({
        expectedRevision: mind.snapshot().revision - 1,
        decision: action("stale-owner-resolution"),
        proposalResolution: {
          proposalId: proposal.id,
          disposition: "adopted",
          resolution: "This stale update must not create the goal.",
        },
      });
      expect(stale).toMatchObject({
        accepted: false,
        rejectionCode: "CAS_STALE",
      });
      expect(
        mind.snapshot().proposals.find(({ id }) => id === proposal.id)?.status,
      ).toBe("pending");
      expect(mind.snapshot().goals).toHaveLength(0);

      const invalidProposal = mind.commitThought({
        expectedRevision: mind.snapshot().revision,
        decision: action("invalid-owner-resolution"),
        proposalResolution: {
          proposalId: `${proposal.id}-missing`,
          disposition: "adopted",
          resolution: "An unrelated proposal must not create a goal.",
        },
      });
      expect(invalidProposal).toMatchObject({
        accepted: false,
        rejectionCode: "PROPOSAL_NOT_PENDING",
      });
      expect(
        mind.snapshot().proposals.find(({ id }) => id === proposal.id)?.status,
      ).toBe("pending");
      expect(mind.snapshot().goals).toHaveLength(0);

      const stopped = mind.stop();
      if (stopped === undefined) throw new Error("stop latch was not set");
      const stopRejected = mind.commitThought({
        expectedRevision: stopped.revision,
        decision: action("stopped-owner-resolution"),
        proposalResolution: {
          proposalId: proposal.id,
          disposition: "compromised",
          resolution: "This stopped update must not create the goal.",
        },
      });
      expect(stopRejected).toMatchObject({
        accepted: false,
        rejectionCode: "STOPPED",
      });
      expect(
        mind.snapshot().proposals.find(({ id }) => id === proposal.id)?.status,
      ).toBe("pending");
      expect(mind.snapshot().goals).toHaveLength(0);
    } finally {
      mind.close();
    }
  });
});

function resolve(
  mind: PlayerMindStore,
  proposalId: string,
  disposition: "adopted" | "compromised" | "declined",
  path: "commitThought" | "commitGoalState",
) {
  const input = {
    proposalId,
    disposition,
    resolution: `Resolution for ${proposalId}.`,
  } as const;
  return path === "commitThought"
    ? mind.commitThought({
        expectedRevision: mind.snapshot().revision,
        decision: action(`resolve-${proposalId}`),
        proposalResolution: input,
      })
    : mind.commitGoalState({
        expectedRevision: mind.snapshot().revision,
        proposalResolution: input,
      });
}

function goal(
  input: Pick<PlayerGoalChange, "title" | "source"> &
    Partial<Pick<PlayerGoalChange, "id" | "status">>,
): PlayerGoalChange {
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    title: input.title,
    status: input.status ?? "active",
    priority: 3,
    changeReason: "A useful test goal.",
    source: input.source,
  };
}

function action(operationId: string): PlayerThoughtDecision {
  return {
    kind: "act",
    purpose: "test purpose",
    operation: { kind: "look", target: { x: 0, y: 64, z: 1 } },
    operationId,
    expectedOutcome: "observe the nearby path",
    wakeOn: ["body_outcome"],
  };
}

function openMind(): { databasePath: string; mind: PlayerMindStore } {
  const directory = mkdtempSync(join(tmpdir(), "owner-goals-test-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "player.sqlite");
  return { databasePath, mind: PlayerMindStore.open(databasePath) };
}
