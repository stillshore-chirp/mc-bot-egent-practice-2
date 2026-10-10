import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CompanionStore } from "../../src/player/store.js";
import type {
  CompanionOutcomeInput,
  MemoryUpdate,
} from "../../src/player/contracts.js";
import { playerOperationSchema } from "../../src/minecraft/player-body-schema.js";

const directories: string[] = [];
const fixedNow = () => "2026-10-10T00:00:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function freshDatabase(): {
  readonly directory: string;
  readonly path: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "companion-store-test-"));
  directories.push(directory);
  return { directory, path: join(directory, "companion.sqlite3") };
}

const look = playerOperationSchema.parse({ kind: "look_sweep" });
const move = playerOperationSchema.parse({
  kind: "move_to",
  position: { x: 4, y: 64, z: 8 },
  range: 1,
});

function outcome(
  overrides: Partial<CompanionOutcomeInput> = {},
): CompanionOutcomeInput {
  return {
    operationId: "op-1",
    operation: look,
    status: "successful",
    summary: "The target area was visible.",
    expectedOutcome: "The area is checked.",
    observedAt: fixedNow(),
    ...overrides,
  };
}

describe("CompanionStore", () => {
  it("persists owner stop, gates resume by generation, and rejects writes while stopped", () => {
    const { path } = freshDatabase();
    let store = CompanionStore.open(path, { now: fixedNow });
    const goal = {
      title: "Explore the nearby forest",
      successCondition: "Map a safe path home.",
      source: "owner" as const,
    };
    store.save({ goal, interests: ["探索"] });

    const stopped = store.stop();
    expect(stopped.stopped).toBe(true);
    expect(stopped.stopGeneration).toBe(1);
    expect(stopped.goal).toEqual(goal);
    expect(stopped.plan).toBeNull();
    expect(() => store.save({ goal: null })).toThrow(
      expect.objectContaining({ code: "STOPPED" }),
    );
    store.close();

    store = CompanionStore.open(path, { now: fixedNow });
    expect(store.snapshot().stopped).toBe(true);
    expect(() => store.resume(0)).toThrow(
      expect.objectContaining({ code: "STOP_GENERATION_MISMATCH" }),
    );
    const resumed = store.resume(1);
    expect(resumed.stopped).toBe(false);
    expect(resumed.stopGeneration).toBe(2);
    expect(resumed.goal).toEqual(goal);
    expect(resumed.plan).toBeNull();
    store.close();
  });

  it("returns the latest 24 messages in chronological order by default", () => {
    const { path } = freshDatabase();
    const store = CompanionStore.open(path, { now: fixedNow });
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "owner" : "companion",
      text: `synthetic-message-${index + 1}`,
    }));

    for (const message of messages) {
      store.recordMessage(message.role, message.text);
    }

    expect(store.recentMessages()).toHaveLength(24);
    expect(
      store.recentMessages().map(({ role, text }) => ({ role, text })),
    ).toEqual(messages.slice(6));
    store.close();
  });

  it("advances only the successful matching plan head and clears a failed plan", () => {
    const { path } = freshDatabase();
    const store = CompanionStore.open(path, { now: fixedNow });
    const firstExpected = "The area is checked.";
    const secondExpected = "The destination is reached.";
    const plan = {
      purpose: "Reach the forest edge safely.",
      steps: [
        { operation: look, expectedOutcome: firstExpected },
        { operation: move, expectedOutcome: secondExpected },
      ],
    };
    store.save({
      plan,
      activeOperation: {
        operationId: "op-1",
        operation: look,
        expectedOutcome: firstExpected,
      },
    });

    const advanced = store.recordOutcome(outcome());
    expect(advanced.activeOperation).toBeNull();
    expect(advanced.plan).toEqual({
      purpose: plan.purpose,
      steps: [{ operation: move, expectedOutcome: secondExpected }],
    });
    expect(advanced.lastOutcome?.status).toBe("successful");

    store.save({
      activeOperation: {
        operationId: "op-2",
        operation: move,
        expectedOutcome: secondExpected,
      },
    });
    const failed = store.recordOutcome(
      outcome({
        operationId: "op-2",
        operation: move,
        status: "failed",
        summary: "The route was blocked.",
        expectedOutcome: secondExpected,
      }),
    );
    expect(failed.plan).toBeNull();
    expect(failed.activeOperation).toBeNull();
    expect(failed.lastOutcome?.status).toBe("failed");
    store.close();
  });

  it("keeps a newer active operation when a stale result arrives, but clears its plan", () => {
    const { path } = freshDatabase();
    const store = CompanionStore.open(path, { now: fixedNow });
    store.save({
      plan: {
        purpose: "Inspect the route.",
        steps: [{ operation: look, expectedOutcome: "The route is visible." }],
      },
      activeOperation: {
        operationId: "current-op",
        operation: look,
        expectedOutcome: "The route is visible.",
      },
    });

    const snapshot = store.recordOutcome(outcome({ operationId: "stale-op" }));
    expect(snapshot.plan).toBeNull();
    expect(snapshot.activeOperation?.operationId).toBe("current-op");
    expect(snapshot.lastOutcome).toBeNull();
    store.close();
  });

  it("verifies owner quotes, recalls Japanese text, and keeps a short message journal", () => {
    const { path } = freshDatabase();
    const store = CompanionStore.open(path, { now: fixedNow });
    const ownerMessage =
      "前に言った通り、建築より探索が好きです。遠くへ行く前は計画を共有してください。";
    const [ownerMemory, inferredMemory] = store.remember(
      [
        {
          kind: "preference",
          content: "建築より探索を好み、遠くへ行く前に計画共有を望む。",
          importance: 5,
          ownerQuote: "建築より探索が好きです。",
        },
        {
          kind: "episode",
          content: "The owner may enjoy distant exploration.",
          importance: 2,
          ownerQuote: "The owner wants a castle.",
        },
      ],
      { ownerMessage },
    );
    expect(ownerMemory?.source).toBe("player_stated");
    expect(inferredMemory?.source).toBe("bot_inferred");

    const recalled = store.recall(ownerMessage, 5);
    expect(recalled[0]?.id).toBe(ownerMemory?.id);
    expect(recalled.some(({ id }) => id === inferredMemory?.id)).toBe(true);

    store.recordMessage("owner", ownerMessage);
    store.recordMessage("companion", "わかりました。計画を共有します。");
    expect(store.recentMessages(2).map(({ role }) => role)).toEqual([
      "owner",
      "companion",
    ]);
    store.close();
  });

  it("finds a rare old memory among a large recent set with a bounded recall pool", () => {
    const { path } = freshDatabase();
    const store = CompanionStore.open(path, { now: fixedNow });
    const updates: MemoryUpdate[] = [
      ...Array.from({ length: 300 }, (_, index) => ({
        kind: "episode" as const,
        content: `A routine forest walk note ${index}.`,
        importance: 1,
        ownerQuote: null,
      })),
      {
        kind: "preference",
        content: "The owner prefers a violet route through the ancient grove.",
        importance: 4,
        ownerQuote: null,
      },
    ];
    for (let index = 0; index < updates.length; index += 20) {
      store.remember(updates.slice(index, index + 20));
    }

    expect(
      store
        .recall("violet preference ancient grove", 5)
        .some(({ content }) => content.includes("violet route")),
    ).toBe(true);
    store.close();
  });

  it("imports legacy memories additively, preserves stop and retractions, and is idempotent", () => {
    const { path } = freshDatabase();
    const legacy = new Database(path);
    createLegacyFixture(legacy);
    const originalCounts = legacyCounts(legacy);
    legacy.close();

    let store = CompanionStore.open(path, {
      now: fixedNow,
      ownerUsername: "Owner",
    });
    const snapshot = store.snapshot();
    expect(snapshot.stopped).toBe(true);
    expect(snapshot.stopGeneration).toBe(7);
    expect(snapshot.goal).toEqual({
      title: "Find a safe route home",
      successCondition: "Return before night.",
      source: "owner",
    });
    expect(snapshot.plan).toBeNull();
    expect(snapshot.activeOperation).toBeNull();
    expect(snapshot.lastOutcome?.status).toBe("unverified");
    expect(snapshot.relationshipSummary).toBe(
      "The owner values cautious exploration.",
    );
    expect(snapshot.interests).toEqual(["探索", "洞窟"]);

    const rows = readImportedRows(path);
    expect(
      rows.filter((row) => row.kind === "fact").map((row) => row.status),
    ).toEqual(expect.arrayContaining(["active", "superseded", "retracted"]));
    expect(
      rows.some((row) => row.content.includes("other-player-private-fact")),
    ).toBe(false);
    expect(
      rows
        .filter((row) => row.kind === "skill_lesson")
        .map((row) => row.status),
    ).toEqual(expect.arrayContaining(["archived", "active"]));
    expect(
      store
        .recall("retracted unique legacy fact", 20)
        .some(({ content }) =>
          content.includes("retracted unique legacy fact"),
        ),
    ).toBe(false);
    expect(
      store
        .recall("current latest navigation lesson", 20)
        .some(
          ({ kind, status }) => kind === "skill_lesson" && status === "active",
        ),
    ).toBe(true);
    const countBeforeReopen = rows.length;
    store.close();

    store = CompanionStore.open(path, {
      now: fixedNow,
      ownerUsername: "Owner",
    });
    expect(readImportedRows(path)).toHaveLength(countBeforeReopen);
    expect(store.snapshot().stopped).toBe(true);
    store.close();

    const verify = new Database(path, { readonly: true });
    expect(legacyCounts(verify)).toEqual(originalCounts);
    const importedActive = verify
      .prepare<[], { readonly count: number }>(
        "SELECT COUNT(*) AS count FROM companion_memories WHERE status = 'active'",
      )
      .get()?.count;
    expect(importedActive).toBeGreaterThan(0);
    verify.close();
  });

  it("fails closed on corrupt legacy stop state without changing the source row", () => {
    const { path } = freshDatabase();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE player_runtime_state(singleton_id INTEGER PRIMARY KEY, payload_json TEXT, updated_at TEXT);
    `);
    legacy
      .prepare("INSERT INTO player_runtime_state VALUES(1, ?, ?)")
      .run("not-json", fixedNow());
    legacy.close();

    expect(() => CompanionStore.open(path, { now: fixedNow })).toThrow(
      expect.objectContaining({ code: "LEGACY_STATE_INVALID" }),
    );
    const verify = new Database(path, { readonly: true });
    expect(
      verify
        .prepare<[], { readonly payload_json: string }>(
          "SELECT payload_json FROM player_runtime_state WHERE singleton_id = 1",
        )
        .get()?.payload_json,
    ).toBe("not-json");
    verify.close();
  });

  it("quarantines unsafe legacy state, memory, metadata, and outcomes", () => {
    const { path } = freshDatabase();
    const credentialMarker = "API_KEY=legacy-test-placeholder";
    const legacy = new Database(path);
    createLegacyFixture(legacy);
    legacy
      .prepare("UPDATE facts SET value_json = ? WHERE id = 'fact-active'")
      .run(JSON.stringify(`Owner preference ${credentialMarker}`));
    legacy
      .prepare("INSERT INTO facts VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "fact-metadata-only",
        "owner-id",
        "owner",
        "likes",
        JSON.stringify("cautious paths"),
        "player_stated",
        "active",
        "metadata-only",
        null,
        credentialMarker,
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
      );
    legacy
      .prepare(
        "UPDATE relationships SET state_json = ? WHERE player_id = 'owner-id'",
      )
      .run(JSON.stringify({ summary: `Relationship ${credentialMarker}` }));
    legacy
      .prepare(
        "UPDATE life_states SET current_interests_json = ? WHERE singleton_id = 1",
      )
      .run(JSON.stringify(["探索", credentialMarker]));
    const oldStateRow = legacy
      .prepare<[], { readonly payload_json: string }>(
        "SELECT payload_json FROM player_runtime_state WHERE singleton_id = 1",
      )
      .get();
    if (oldStateRow === undefined)
      throw new Error("Legacy fixture runtime state missing.");
    const oldState = JSON.parse(oldStateRow.payload_json) as {
      goals: { title: string }[];
      activeOperation: { expectedOutcome: string };
    };
    const activeGoal = oldState.goals[0];
    if (activeGoal === undefined)
      throw new Error("Legacy fixture goal missing.");
    activeGoal.title = `Find route ${credentialMarker}`;
    oldState.activeOperation.expectedOutcome = credentialMarker;
    legacy
      .prepare(
        "UPDATE player_runtime_state SET payload_json = ? WHERE singleton_id = 1",
      )
      .run(JSON.stringify(oldState));
    const originalFact = legacy
      .prepare<[], { readonly value_json: string }>(
        "SELECT value_json FROM facts WHERE id = 'fact-active'",
      )
      .get()?.value_json;
    legacy.close();

    const store = CompanionStore.open(path, {
      now: fixedNow,
      ownerUsername: "Owner",
    });
    const snapshot = store.snapshot();
    expect(snapshot.goal).toBeNull();
    expect(snapshot.relationshipSummary).toBe("");
    expect(snapshot.interests).toEqual(["探索"]);
    expect(snapshot.lastOutcome).toBeNull();
    const verify = new Database(path, { readonly: true });
    const containsMarker = (rows: readonly object[]) =>
      rows.some((row) => JSON.stringify(row).includes(credentialMarker));
    const memoryCredentialFlags = verify
      .prepare<
        [],
        {
          readonly kind: string;
          readonly status: string;
          readonly content: string;
          readonly metadata_json: string;
        }
      >("SELECT kind, status, content, metadata_json FROM companion_memories")
      .all()
      .map(({ kind, status, content, metadata_json }) => ({
        kind,
        status,
        content: content.includes(credentialMarker),
        metadata: metadata_json.includes(credentialMarker),
      }))
      .filter(({ content, metadata }) => content || metadata);
    expect(memoryCredentialFlags, "memory content or metadata").toEqual([]);
    expect(
      containsMarker(
        verify
          .prepare<
            [],
            { readonly content: string; readonly payload_json: string }
          >("SELECT content, payload_json FROM companion_journal")
          .all(),
      ),
      "journal content or payload",
    ).toBe(false);
    expect(
      containsMarker(
        verify
          .prepare<[], { readonly payload_json: string }>(
            "SELECT payload_json FROM companion_runtime_state",
          )
          .all(),
      ),
      "runtime snapshot",
    ).toBe(false);
    expect(
      verify
        .prepare<[], { readonly status: string; readonly content: string }>(
          "SELECT status, content FROM companion_memories WHERE legacy_source_key = 'legacy:facts:id:fact-active'",
        )
        .get(),
    ).toEqual({
      status: "archived",
      content: "Legacy content quarantined for credential safety.",
    });
    const metadataOnlyMemory = verify
      .prepare<
        [],
        {
          readonly status: string;
          readonly content: string;
          readonly metadata_json: string;
        }
      >(
        "SELECT status, content, metadata_json FROM companion_memories WHERE legacy_source_key = 'legacy:facts:id:fact-metadata-only'",
      )
      .get();
    expect(metadataOnlyMemory?.status).toBe("active");
    expect(metadataOnlyMemory?.content).toContain("cautious paths");
    expect(metadataOnlyMemory?.metadata_json).toContain(
      '"legacyCredentialRedacted":true',
    );
    expect(metadataOnlyMemory?.metadata_json).not.toContain(credentialMarker);
    expect(
      verify
        .prepare<[], { readonly value_json: string }>(
          "SELECT value_json FROM facts WHERE id = 'fact-active'",
        )
        .get()?.value_json,
    ).toBe(originalFact);
    verify.close();
    store.close();
  });

  it("records a pending operation as unverified on reopen without replay", () => {
    const { path } = freshDatabase();
    let store = CompanionStore.open(path, { now: fixedNow });
    const goal = {
      title: "Check the nearby path",
      successCondition: "The route is observed safely.",
      source: "owner" as const,
    };
    store.save({
      goal,
      plan: {
        purpose: "Observe before moving.",
        steps: [{ operation: look, expectedOutcome: "The path is visible." }],
      },
      waitUntil: "2026-10-10T00:01:00.000Z",
      activeOperation: {
        operationId: "restart-op-1",
        operation: look,
        expectedOutcome: "The path is visible.",
      },
    });
    const stateDatabase = new Database(path);
    const stateRow = stateDatabase
      .prepare<[], { readonly payload_json: string }>(
        "SELECT payload_json FROM companion_runtime_state WHERE singleton_id = 1",
      )
      .get();
    if (stateRow === undefined) throw new Error("Runtime state row missing.");
    const state = JSON.parse(stateRow.payload_json) as {
      stopped: boolean;
      stopGeneration: number;
    };
    state.stopped = true;
    state.stopGeneration = 3;
    stateDatabase
      .prepare(
        "UPDATE companion_runtime_state SET payload_json = ? WHERE singleton_id = 1",
      )
      .run(JSON.stringify(state));
    stateDatabase.close();
    store.close();

    store = CompanionStore.open(path, { now: fixedNow });
    const recovered = store.snapshot();
    expect(recovered.stopped).toBe(true);
    expect(recovered.stopGeneration).toBe(3);
    expect(recovered.goal).toEqual(goal);
    expect(recovered.plan).toBeNull();
    expect(recovered.waitUntil).toBeNull();
    expect(recovered.activeOperation).toBeNull();
    expect(recovered.lastOutcome).toMatchObject({
      operationId: "restart-op-1",
      status: "unverified",
    });
    store.close();

    store = CompanionStore.open(path, { now: fixedNow });
    expect(store.snapshot().lastOutcome?.status).toBe("unverified");
    const verify = new Database(path, { readonly: true });
    expect(
      verify
        .prepare<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM companion_journal WHERE event_key LIKE 'restart-recovery:%'",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      verify
        .prepare<[], { readonly count: number }>(
          "SELECT COUNT(*) AS count FROM companion_memories WHERE legacy_source_key LIKE 'restart-recovery:%'",
        )
        .get()?.count,
    ).toBe(1);
    verify.close();
    store.close();
  });
});

function createLegacyFixture(database: Database.Database): void {
  database.exec(`
    CREATE TABLE players(id TEXT PRIMARY KEY, external_name TEXT NOT NULL);
    CREATE TABLE facts(id TEXT PRIMARY KEY, player_id TEXT, subject TEXT, predicate TEXT, value_json TEXT, source TEXT, status TEXT, dedupe_key TEXT, superseded_by_id TEXT, retraction_reason TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE relationships(player_id TEXT PRIMARY KEY, trust INTEGER, intimacy INTEGER, state_json TEXT, updated_at TEXT);
    CREATE TABLE episodes(id TEXT PRIMARY KEY, player_id TEXT, summary TEXT, importance INTEGER, source TEXT, details_json TEXT, observed_at TEXT, created_at TEXT);
    CREATE TABLE life_states(singleton_id INTEGER PRIMARY KEY, current_interests_json TEXT, long_term_goals_json TEXT, home_base_json TEXT, possessions_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE world_memories(id TEXT PRIMARY KEY, kind TEXT, name TEXT, description TEXT, dimension TEXT, x REAL, y REAL, z REAL, source TEXT, status TEXT, dedupe_key TEXT, superseded_by_id TEXT, retraction_reason TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE behavior_memories(id TEXT PRIMARY KEY, player_id TEXT, category TEXT, slot TEXT, value TEXT, summary TEXT, source TEXT, confidence TEXT, scope TEXT, support_count INTEGER, status TEXT, superseded_by_id TEXT, retraction_reason TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE player_runtime_state(singleton_id INTEGER PRIMARY KEY, payload_json TEXT, updated_at TEXT);
    CREATE TABLE mc_bot_skills(id TEXT PRIMARY KEY, category TEXT, title TEXT, purpose TEXT, conditions_json TEXT, body TEXT, operation_refs_json TEXT, expected_outcome TEXT, confidence REAL, version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE mc_bot_skill_revisions(skill_id TEXT, version INTEGER, category TEXT, title TEXT, purpose TEXT, conditions_json TEXT, body TEXT, operation_refs_json TEXT, expected_outcome TEXT, confidence REAL, change_kind TEXT, change_note TEXT, created_at TEXT, PRIMARY KEY(skill_id, version));
    CREATE TABLE mc_bot_skill_outcomes(skill_id TEXT, run_id TEXT, proposed_outcome TEXT, status TEXT, summary TEXT, evidence_receipt_id TEXT, skill_version_at_use INTEGER, success_hypothesis INTEGER, recorded_at TEXT);

    INSERT INTO players VALUES('owner-id', 'Owner');
    INSERT INTO players VALUES('visitor-id', 'Visitor');
    INSERT INTO relationships VALUES('owner-id', 80, 40, '{"summary":"The owner values cautious exploration."}', '2026-10-01T00:00:00.000Z');
    INSERT INTO relationships VALUES('visitor-id', 20, 10, '{"summary":"Other relationship."}', '2026-10-01T00:00:00.000Z');
    INSERT INTO facts VALUES('fact-active', 'owner-id', 'owner', 'prefers', '"short plans"', 'player_stated', 'active', 'active', NULL, NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO facts VALUES('fact-old', 'owner-id', 'owner', 'preferred', '"old plan"', 'player_stated', 'superseded', 'old', 'fact-active', NULL, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO facts VALUES('fact-forgotten', 'owner-id', 'owner', 'retracted', '"retracted unique legacy fact"', 'player_stated', 'retracted', 'forgotten', NULL, 'owner corrected it', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    INSERT INTO facts VALUES('fact-other', 'visitor-id', 'visitor', 'has', '"other-player-private-fact"', 'player_stated', 'active', 'other', NULL, NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO episodes VALUES('episode-1', 'owner-id', 'Observed a safe forest route.', 4, 'minecraft_observed', '{"event":"route"}', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z');
    INSERT INTO life_states VALUES(1, '["探索","洞窟"]', '["Find a safe route home"]', NULL, '[]', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO world_memories VALUES('world-1', 'hazard', 'lava ravine', 'A lava ravine blocks the eastern path.', 'overworld', 12, 63, 4, 'minecraft_observed', 'active', 'lava', NULL, NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO behavior_memories VALUES('behavior-1', 'owner-id', 'planning', 'owner_preference_planning', 'share before distant travel', 'The owner wants a short plan first.', 'owner_explicit', 'explicit', 'owner_global', 1, 'active', NULL, NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO mc_bot_skills VALUES('nav', 'navigation', 'current latest navigation lesson', 'Find and verify a safe route.', '[]', 'Use observed paths.', '["look","move_to"]', 'Arrive safely.', 0.7, 2, '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO mc_bot_skill_revisions VALUES('nav', 1, 'navigation', 'old navigation lesson', 'Older purpose.', '[]', 'Older body.', '["look"]', 'Older expected result.', 0.2, 'create', 'initial', '2026-09-01T00:00:00.000Z');
    INSERT INTO mc_bot_skill_revisions VALUES('nav', 2, 'navigation', 'current latest navigation lesson', 'Find and verify a safe route.', '[]', 'Use observed paths.', '["look","move_to"]', 'Arrive safely.', 0.7, 'revise', 'verified improvement', '2026-10-01T00:00:00.000Z');
    INSERT INTO mc_bot_skill_outcomes VALUES('nav', 'run-1', 'successful', 'successful', 'Reached the ridge safely.', 'receipt-1', 2, 1, '2026-10-02T00:00:00.000Z');
  `);
  const legacyState = {
    stopped: true,
    stopGeneration: 7,
    goals: [
      {
        id: "goal-1",
        title: "Find a safe route home",
        status: "active",
        source: "owner",
        priority: 5,
        changeReason: "Return before night.",
        updatedAt: "2026-10-02T00:00:00.000Z",
      },
      {
        id: "goal-2",
        title: "A paused goal",
        status: "paused",
        source: "self",
        priority: 2,
        changeReason: "Wait for daylight.",
        updatedAt: "2026-10-02T00:00:00.000Z",
      },
    ],
    actionPlan: {
      id: "plan-1",
      purpose: "Inspect the forest route.",
      steps: [
        {
          sequence: 0,
          operation: { kind: "look_sweep" },
          expectedOutcome: "The route is checked.",
          status: "pending",
        },
      ],
    },
    activeOperation: {
      operationId: "old-op-1",
      kind: "look_sweep",
      actionRevision: 2,
      startedAt: "2026-10-03T00:00:00.000Z",
      expectedOutcome: "The route is checked.",
    },
    recentOutcomes: [],
    stateFacts: [],
    uncertainties: [],
    proposals: [],
    lastOutcome: null,
  };
  database
    .prepare("INSERT INTO player_runtime_state VALUES(1, ?, ?)")
    .run(JSON.stringify(legacyState), "2026-10-03T00:00:00.000Z");
}

function legacyCounts(database: Database.Database): Record<string, number> {
  const tables = [
    "players",
    "facts",
    "relationships",
    "episodes",
    "life_states",
    "world_memories",
    "behavior_memories",
    "player_runtime_state",
    "mc_bot_skills",
    "mc_bot_skill_revisions",
    "mc_bot_skill_outcomes",
  ];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      database
        .prepare<[], { readonly count: number }>(
          `SELECT COUNT(*) AS count FROM "${table}"`,
        )
        .get()?.count ?? 0,
    ]),
  );
}

function readImportedRows(
  path: string,
): { kind: string; status: string; content: string }[] {
  const database = new Database(path, { readonly: true });
  try {
    return database
      .prepare<
        [],
        {
          readonly kind: string;
          readonly status: string;
          readonly content: string;
        }
      >(
        "SELECT kind, status, content FROM companion_memories ORDER BY kind, memory_id",
      )
      .all();
  } finally {
    database.close();
  }
}
