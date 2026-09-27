import { describe, expect, it } from "vitest";

import {
  countCompletedGatherActions,
  confirmsSecondGatheredTarget,
  gatherMultiTargetRconSampleEvidence,
  gatherMultiTargetJudgmentKey,
  gatherMultiTargetPassEvidence,
  hasNewPostFollowupDigJudgment,
  hasNewPostFollowupDigJudgmentBeforeSecondDig,
  hasNewBirchGatherIntent,
  hasResolvedBirchGatherOwnerGoal,
  identifyFirstGatheredTarget,
  newBirchGatherProposalIds,
  parseGatherMultiTargetInventoryReplyDetailed,
  parseGatherMultiTargetInventoryReply,
  postFollowupGatherActionPairs,
  readGatherMultiTargetInventory,
  successfulGatherActionPairs,
} from "../e2e/gather-multi-target-acceptance.js";

const baseline = { oak_log: 0, birch_log: 0 } as const;

describe("multi-target gather E2E acceptance", () => {
  it("parses top-level target stacks regardless of field order and NBT suffix", () => {
    expect(
      parseGatherMultiTargetInventoryReply(
        'entity data: [{id:"minecraft:oak_log",count:2b,Slot:0b},{Count:3,id:"minecraft:birch_log",Slot:1b}]',
      ),
    ).toEqual({ oak_log: 2, birch_log: 3 });
  });

  it("classifies single and two-stack replies without retaining their text", async () => {
    let readCount = 0;
    const single = parseGatherMultiTargetInventoryReplyDetailed(
      'Entity data: [{id:"minecraft:oak_log",count:1}]',
    );
    const twoStack = await readGatherMultiTargetInventory(async () => {
      readCount += 1;
      return 'Entity data: [{id:"minecraft:oak_log",count:1,display:{Name:"PRIVATE_failed_RCON_SENTINEL"}},{Slot:1b,Count:1,id:"minecraft:birch_log"}]';
    });
    expect(single).toEqual({
      reason: "parsed",
      parseStage: "parsed",
      counts: { oak_log: 1, birch_log: 0 },
    });
    expect(twoStack).toEqual({
      reason: "parsed",
      parseStage: "parsed",
      counts: { oak_log: 1, birch_log: 1 },
    });
    expect(readCount).toBe(1);
    expect(JSON.stringify({ single, twoStack })).not.toContain(
      "PRIVATE_failed_RCON_SENTINEL",
    );
  });

  it("returns a fixed reason for every inventory read boundary", async () => {
    const readFailed = await readGatherMultiTargetInventory(async () => {
      throw new Error("PRIVATE_RCON_SENTINEL");
    });
    const commandRejected = await readGatherMultiTargetInventory(
      async () => "Unknown or incomplete command: PRIVATE_RCON_SENTINEL",
    );
    const markerMissing = parseGatherMultiTargetInventoryReplyDetailed(
      "PRIVATE_RCON_SENTINEL",
    );
    const structureInvalid = parseGatherMultiTargetInventoryReplyDetailed(
      "Entity data: [broken]",
    );
    const targetCountInvalid = parseGatherMultiTargetInventoryReplyDetailed(
      'Entity data: [{id:"minecraft:birch_log",count:"1"}]',
    );
    const rootInvalid = parseGatherMultiTargetInventoryReplyDetailed(
      'Entity data: {id:"minecraft:oak_log",count:1}',
    );
    const nestedTokenInvalid = parseGatherMultiTargetInventoryReplyDetailed(
      'Entity data: [{id:"minecraft:oak_log",count:1,display:{Name:}}]',
    );
    const trailingContent = parseGatherMultiTargetInventoryReplyDetailed(
      'Entity data: [{id:"minecraft:oak_log",count:1}] trailing',
    );
    const stackIdInvalid = parseGatherMultiTargetInventoryReplyDetailed(
      "Entity data: [{count:1}]",
    );
    const responseTruncatedPossible =
      parseGatherMultiTargetInventoryReplyDetailed(
        'Entity data: [{id:"minecraft:oak_log",count:1',
      );

    expect([
      readFailed.reason,
      commandRejected.reason,
      markerMissing.reason,
      structureInvalid.reason,
      targetCountInvalid.reason,
      rootInvalid.parseStage,
      nestedTokenInvalid.parseStage,
      trailingContent.parseStage,
      stackIdInvalid.parseStage,
      responseTruncatedPossible.parseStage,
    ]).toEqual([
      "read_failed",
      "command_rejected",
      "marker_missing",
      "structure_invalid",
      "target_count_invalid",
      "root_invalid",
      "nested_token_invalid",
      "trailing_content",
      "stack_id_invalid",
      "response_truncated_possible",
    ]);
    expect(readFailed.parseStage).toBe("not_parsed");
    expect(commandRejected.parseStage).toBe("not_parsed");
    expect(markerMissing.parseStage).toBe("marker_missing");
    expect(structureInvalid.parseStage).toBe("root_invalid");
    expect(targetCountInvalid.parseStage).toBe("target_count_invalid");
    expect(
      JSON.stringify({
        readFailed,
        commandRejected,
        markerMissing,
        structureInvalid,
        targetCountInvalid,
        rootInvalid,
        nestedTokenInvalid,
        trailingContent,
        stackIdInvalid,
        responseTruncatedPossible,
      }),
    ).not.toContain("PRIVATE_RCON_SENTINEL");
  });

  it("ignores target names in nested components and quoted text", () => {
    expect(
      parseGatherMultiTargetInventoryReply(
        `entity data: [{components:{"minecraft:custom_name":'{"text":"minecraft:birch_log, count:99"}'},id:"minecraft:oak_log",count:2},{id:"minecraft:stone",count:1,display:{Name:'oak_log minecraft:birch_log'}}]`,
      ),
    ).toEqual({ oak_log: 2, birch_log: 0 });
  });

  it("fails closed when a target stack count is absent, malformed, or ambiguous", () => {
    expect(
      parseGatherMultiTargetInventoryReply(
        'entity data: [{id:"minecraft:oak_log"}]',
      ),
    ).toBeUndefined();
    expect(
      parseGatherMultiTargetInventoryReply(
        'entity data: [{id:"minecraft:birch_log",count:many}]',
      ),
    ).toBeUndefined();
    expect(
      parseGatherMultiTargetInventoryReply(
        'entity data: [{id:"minecraft:oak_log",count:1,count:2}]',
      ),
    ).toBeUndefined();
  });

  it("fails closed for malformed inventory structure instead of returning zero", () => {
    expect(
      parseGatherMultiTargetInventoryReply(
        'entity data: [{id:"minecraft:oak_log",count:1',
      ),
    ).toBeUndefined();
    expect(
      parseGatherMultiTargetInventoryReply("command failed"),
    ).toBeUndefined();
  });

  it("includes the post-cleanup confirmation in pass evidence", () => {
    expect(
      gatherMultiTargetPassEvidence(
        {
          caseStarted: true,
          fixtureConfigured: true,
          freshBodyObservationConfirmed: true,
          initialOwnerRequestObserved: true,
          shortFollowupSent: true,
          followupOwnerIntentObserved: true,
          followupOwnerResolutionObserved: true,
          firstTargetServerAndBodyProgressObserved: true,
          postFollowupDigJudgmentObserved: true,
          postFollowupDigJudgmentBeforeSecondTargetObserved: true,
          secondTargetGatherPairObserved: true,
          secondTargetServerAndBodyProgressObserved: true,
          fixtureCleanupConfirmed: true,
          oakDropReadbackClass: "known_negative",
          birchDropReadbackClass: "known_negative",
        },
        2,
      ),
    ).toEqual({
      caseStarted: true,
      fixtureConfigured: true,
      freshBodyObservationConfirmed: true,
      initialOwnerRequestObserved: true,
      shortFollowupSent: true,
      followupOwnerIntentObserved: true,
      followupOwnerResolutionObserved: true,
      firstTargetServerAndBodyProgressObserved: true,
      postFollowupDigJudgmentObserved: true,
      postFollowupDigJudgmentBeforeSecondTargetObserved: true,
      secondTargetGatherPairObserved: true,
      secondTargetServerAndBodyProgressObserved: true,
      fixtureCleanupConfirmed: true,
      oakDropReadbackClass: "known_negative",
      birchDropReadbackClass: "known_negative",
      completedBodyGatherCount: 2,
    });
  });

  it("requires a new birch-target proposal or a linked birch goal", () => {
    const previousProposalIds = new Set(["older"]);
    expect(
      hasNewBirchGatherIntent({
        proposals: [
          { id: "older", title: "白樺を集める" },
          { id: "new", title: "白樺の原木を集める" },
        ],
        goals: [],
        previousProposalIds,
      }),
    ).toBe(true);
    expect(
      hasNewBirchGatherIntent({
        proposals: [{ id: "new", title: "gather follow-up" }],
        goals: [{ ownerProposalId: "new", title: "birch_log" }],
        previousProposalIds,
      }),
    ).toBe(true);
    expect(
      hasNewBirchGatherIntent({
        proposals: [{ id: "new", title: "oak_logを集める" }],
        goals: [{ ownerProposalId: "unrelated", title: "birch_log" }],
        previousProposalIds,
      }),
    ).toBe(false);
    expect(
      hasNewBirchGatherIntent({
        proposals: [{ id: "older", title: "birch_log" }],
        goals: [],
        previousProposalIds,
      }),
    ).toBe(false);
    expect(
      newBirchGatherProposalIds({
        proposals: [
          { id: "new", title: "birch_log" },
          { id: "other", title: "oak_log" },
        ],
        goals: [],
        previousProposalIds,
      }),
    ).toEqual(["new"]);
  });

  it("requires the same adopted proposal and its owner goal before pass", () => {
    const proposalIds = new Set(["followup"]);
    const valid = {
      proposals: [{ id: "followup", status: "adopted" }],
      judgments: [],
      goals: [
        {
          ownerProposalId: "followup",
          source: "owner",
          status: "active",
        },
      ],
      proposalIds,
    };
    expect(hasResolvedBirchGatherOwnerGoal(valid)).toBe(true);
    expect(
      hasResolvedBirchGatherOwnerGoal({
        ...valid,
        proposals: [{ id: "followup", status: "pending" }],
        judgments: [
          { proposalId: "followup", proposalDisposition: "compromised" },
        ],
      }),
    ).toBe(true);
    expect(
      hasResolvedBirchGatherOwnerGoal({
        ...valid,
        proposals: [{ id: "followup", status: "declined" }],
      }),
    ).toBe(false);
    expect(
      hasResolvedBirchGatherOwnerGoal({
        ...valid,
        goals: [
          {
            ownerProposalId: "different",
            source: "owner",
            status: "active",
          },
        ],
      }),
    ).toBe(false);
    expect(
      hasResolvedBirchGatherOwnerGoal({
        ...valid,
        goals: [
          {
            ownerProposalId: "followup",
            source: "persona",
            status: "active",
          },
        ],
      }),
    ).toBe(false);
    expect(
      hasResolvedBirchGatherOwnerGoal({
        ...valid,
        goals: [
          {
            ownerProposalId: "followup",
            source: "owner",
            status: "paused",
          },
        ],
      }),
    ).toBe(false);
  });

  it("pairs successful dig and later pickup outcomes without reusing pickups", () => {
    expect(
      countCompletedGatherActions([
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:01Z",
        },
        {
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:02Z",
        },
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:03Z",
        },
        {
          kind: "collect_item",
          status: "failed",
          observedAt: "2026-01-01T00:00:04Z",
        },
      ]),
    ).toBe(1);
    expect(
      countCompletedGatherActions([
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:01Z",
        },
        {
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:02Z",
        },
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:03Z",
        },
        {
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:04Z",
        },
      ]),
    ).toBe(2);
    expect(
      successfulGatherActionPairs([
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:01Z",
        },
        {
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:02Z",
        },
        {
          kind: "dig",
          status: "successful",
          observedAt: "2026-01-01T00:00:03Z",
        },
        {
          kind: "collect_item",
          status: "successful",
          observedAt: "2026-01-01T00:00:04Z",
        },
      ]),
    ).toEqual([
      {
        digAt: Date.parse("2026-01-01T00:00:01Z"),
        pickupAt: Date.parse("2026-01-01T00:00:02Z"),
      },
      {
        digAt: Date.parse("2026-01-01T00:00:03Z"),
        pickupAt: Date.parse("2026-01-01T00:00:04Z"),
      },
    ]);
  });

  it("requires one server-removed target, one retained target, and a Body gather", () => {
    expect(
      identifyFirstGatheredTarget(
        {
          blockPresent: { oak_log: false, birch_log: true },
          inventoryCount: { oak_log: 1, birch_log: 0 },
          completedGatherCount: 1,
        },
        baseline,
      ),
    ).toBe("oak_log");
    expect(
      identifyFirstGatheredTarget(
        {
          blockPresent: { oak_log: false, birch_log: true },
          inventoryCount: { oak_log: 1, birch_log: 0 },
          completedGatherCount: 0,
        },
        baseline,
      ),
    ).toBeUndefined();
    expect(
      identifyFirstGatheredTarget(
        {
          blockPresent: { oak_log: true, birch_log: false },
          inventoryCount: { oak_log: 0, birch_log: 1 },
          completedGatherCount: 1,
        },
        baseline,
      ),
    ).toBe("birch_log");
    expect(
      identifyFirstGatheredTarget(
        {
          blockPresent: { oak_log: false, birch_log: false },
          inventoryCount: { oak_log: 1, birch_log: 1 },
          completedGatherCount: 2,
        },
        baseline,
      ),
    ).toBeUndefined();
  });

  it("observes only a new dig judgment after follow-up", () => {
    const followupAt = "2026-01-01T00:00:02.500Z";
    const prior = {
      revision: 1,
      kind: "act",
      operationKind: "dig",
      decidedAt: "2026-01-01T00:00:02Z",
    } as const;
    const newDig = {
      revision: 2,
      kind: "act",
      operationKind: "dig",
      decidedAt: "2026-01-01T00:00:03Z",
    } as const;
    const priorKeys = new Set([gatherMultiTargetJudgmentKey(prior)]);

    expect(
      hasNewPostFollowupDigJudgment([prior, newDig], priorKeys, followupAt),
    ).toBe(true);
    expect(hasNewPostFollowupDigJudgment([prior], priorKeys, followupAt)).toBe(
      false,
    );
    expect(
      hasNewPostFollowupDigJudgment(
        [{ ...newDig, decidedAt: "2026-01-01T00:00:02Z" }],
        priorKeys,
        followupAt,
      ),
    ).toBe(false);
    expect(
      hasNewPostFollowupDigJudgment(
        [{ ...newDig, kind: "wait" }],
        priorKeys,
        followupAt,
      ),
    ).toBe(false);
    expect(hasNewPostFollowupDigJudgment([newDig], priorKeys, "invalid")).toBe(
      false,
    );
  });

  it("requires the new dig judgment to precede the second target dig", () => {
    const judgments = [
      {
        revision: 2,
        kind: "act",
        operationKind: "dig",
        decidedAt: "2026-01-01T00:00:03Z",
      },
    ];
    const input = {
      judgments,
      previousJudgmentKeys: new Set<string>(),
      followupSentAt: "2026-01-01T00:00:02.500Z",
    };
    expect(
      hasNewPostFollowupDigJudgmentBeforeSecondDig({
        ...input,
        secondDigAt: "2026-01-01T00:00:04Z",
      }),
    ).toBe(true);
    expect(
      hasNewPostFollowupDigJudgmentBeforeSecondDig({
        ...input,
        secondDigAt: "2026-01-01T00:00:03Z",
      }),
    ).toBe(false);
    expect(
      hasNewPostFollowupDigJudgmentBeforeSecondDig({
        ...input,
        secondDigAt: "2026-01-01T00:00:02Z",
      }),
    ).toBe(false);
    expect(
      hasNewPostFollowupDigJudgmentBeforeSecondDig({
        ...input,
        secondDigAt: undefined,
      }),
    ).toBe(false);
  });

  it("pairs only a new post-follow-up dig with its later pickup", () => {
    const outcomes = [
      {
        operationId: "first-dig",
        kind: "dig",
        status: "successful",
        observedAt: "2026-01-01T00:00:01Z",
      },
      {
        operationId: "first-pickup",
        kind: "collect_item",
        status: "successful",
        observedAt: "2026-01-01T00:00:02Z",
      },
      {
        operationId: "second-dig",
        kind: "dig",
        status: "successful",
        observedAt: "2026-01-01T00:00:03Z",
      },
      {
        operationId: "second-pickup",
        kind: "collect_item",
        status: "successful",
        observedAt: "2026-01-01T00:00:04Z",
      },
    ] as const;
    const input = {
      outcomes,
      previousOutcomeIds: new Set(["first-dig", "first-pickup"]),
      followupSentAt: "2026-01-01T00:00:02.500Z",
    };
    expect(postFollowupGatherActionPairs(input)).toEqual([
      {
        digAt: Date.parse("2026-01-01T00:00:03Z"),
        pickupAt: Date.parse("2026-01-01T00:00:04Z"),
      },
    ]);
    expect(
      postFollowupGatherActionPairs({
        ...input,
        previousOutcomeIds: new Set(),
        followupSentAt: "2026-01-01T00:00:03.500Z",
      }),
    ).toEqual([]);
    expect(
      postFollowupGatherActionPairs({
        ...input,
        outcomes: outcomes.slice(0, 3),
      }),
    ).toEqual([]);
    expect(
      postFollowupGatherActionPairs({
        ...input,
        outcomes: [outcomes[2], { ...outcomes[3], status: "failed" }],
      }),
    ).toEqual([]);
  });

  it("requires distinct post-follow-up judgment, gather pair, and server/Body evidence", () => {
    const sample = {
      blockPresent: { oak_log: false, birch_log: false },
      inventoryCount: { oak_log: 1, birch_log: 1 },
      completedGatherCount: 2,
    } as const;
    const valid = {
      sample,
      baseline,
      postFollowupDigJudgmentBeforeSecondTargetObserved: true,
      secondTargetGatherPairObserved: true,
    };
    expect(confirmsSecondGatheredTarget(valid)).toBe(true);
    expect(
      confirmsSecondGatheredTarget({
        ...valid,
        postFollowupDigJudgmentBeforeSecondTargetObserved: false,
      }),
    ).toBe(false);
    expect(
      confirmsSecondGatheredTarget({
        ...valid,
        secondTargetGatherPairObserved: false,
      }),
    ).toBe(false);
    expect(
      confirmsSecondGatheredTarget({
        ...valid,
        sample: { ...sample, inventoryCount: { oak_log: 1, birch_log: 0 } },
      }),
    ).toBe(false);
  });

  it("records separate baseline-relative RCON buckets without exact counts", () => {
    const sample = {
      blockPresent: { oak_log: false, birch_log: true },
      inventoryCount: { oak_log: 1, birch_log: 0 },
      completedGatherCount: 2,
    } as const;
    const predicateEvidence = gatherMultiTargetRconSampleEvidence(
      "postFollowupPredicate",
      sample,
      { oak_log: 0, birch_log: 0 },
      "fresh",
    );
    const finalEvidence = gatherMultiTargetRconSampleEvidence(
      "final",
      undefined,
      { oak_log: 0, birch_log: 0 },
      "unavailable",
    );

    expect(predicateEvidence).toEqual({
      gatherMultiTargetPostFollowupPredicateRconStatus: "fresh",
      gatherMultiTargetPostFollowupPredicateRconOakLogBlockPresent: false,
      gatherMultiTargetPostFollowupPredicateRconOakLogBaselineInventoryBucket:
        "zero",
      gatherMultiTargetPostFollowupPredicateRconOakLogCurrentInventoryBucket:
        "one_or_more",
      gatherMultiTargetPostFollowupPredicateRconOakLogInventoryDeltaBucket:
        "increased_by_one",
      gatherMultiTargetPostFollowupPredicateRconBirchLogBlockPresent: true,
      gatherMultiTargetPostFollowupPredicateRconBirchLogBaselineInventoryBucket:
        "zero",
      gatherMultiTargetPostFollowupPredicateRconBirchLogCurrentInventoryBucket:
        "zero",
      gatherMultiTargetPostFollowupPredicateRconBirchLogInventoryDeltaBucket:
        "unchanged",
    });
    expect(finalEvidence).toMatchObject({
      gatherMultiTargetFinalRconStatus: "unavailable",
      gatherMultiTargetFinalRconOakLogBlockPresent: "unknown",
      gatherMultiTargetFinalRconOakLogBaselineInventoryBucket: "zero",
      gatherMultiTargetFinalRconOakLogCurrentInventoryBucket: "unknown",
      gatherMultiTargetFinalRconOakLogInventoryDeltaBucket: "unknown",
    });
    const serialized = JSON.stringify({ predicateEvidence, finalEvidence });
    expect(Object.values(predicateEvidence)).not.toContain(1);
    expect(Object.values(predicateEvidence)).not.toContain(0);
    expect(serialized).not.toContain("completedGatherCount");
  });
});
