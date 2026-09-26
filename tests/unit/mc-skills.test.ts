import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  McSkillRepository,
  McSkillRepositoryError,
  type CreateMcSkillInput,
  type McSkillRepositoryOptions,
} from "../../src/mc-skills/index.js";

const allowedOperationNames = [
  "look",
  "control",
  "equip",
  "use",
  "attack",
  "dig",
  "place",
  "craft",
  "consume",
  "toss",
  "transfer",
  "fish",
  "sleep",
  "wake",
  "mount",
  "dismount",
  "move_vehicle",
  "elytra_fly",
  "trade",
  "enchant",
  "anvil",
  "write_book",
  "update_sign",
  "move_to",
  "move_relative",
  "open_window",
  "window_click",
  "window_transfer",
  "window_close",
];

const temporaryDirectories: string[] = [];
const repositories: McSkillRepository[] = [];

function createFixture(): {
  directory: string;
  options: McSkillRepositoryOptions;
} {
  const directory = mkdtempSync(join(tmpdir(), "mc-skill-repository-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    options: {
      databasePath: join(directory, "skills.sqlite"),
      exchangeDirectory: join(directory, "exchange"),
      allowedOperationNames,
    },
  };
}

function open(options: McSkillRepositoryOptions): McSkillRepository {
  const repository = McSkillRepository.open(options);
  repositories.push(repository);
  return repository;
}

function createDigSkill(
  repository: McSkillRepository,
  id = "sample-dig-skill",
) {
  return repository.createSkill({
    id,
    category: "gathering",
    title: "安全に鉱石を掘る",
    purpose: "必要な鉱石を安全な範囲で集める。",
    conditions: ["鉱石候補を観測した"],
    body: "足場と周囲を見てから掘り、所持品の変化を確かめる。",
    operationRefs: ["look", "dig"],
    expectedOutcome: "目的の鉱石が所持品に入る。",
    confidence: 0.2,
  });
}

function hypothesisInput(
  id?: string,
  title = "採掘結果から学んだ手順",
): CreateMcSkillInput {
  return {
    ...(id === undefined ? {} : { id }),
    category: "gathering",
    title,
    purpose: "観測した成功を次の採集判断へ活用する。",
    conditions: ["採掘対象と足場を観測した"],
    body: "対象を掘り、所持品の変化を確認して手順を調整する。",
    operationRefs: ["look", "dig"],
    expectedOutcome: "採掘対象の変化を観測できる。",
    confidence: 0.1,
  };
}

function trustedDigEvidence(
  repository: McSkillRepository,
  runId: string,
  overrides: Partial<
    Parameters<McSkillRepository["recordTrustedEvidence"]>[0]
  > = {},
) {
  return repository.recordTrustedEvidence({
    runId,
    operationName: "dig",
    inputSummary: "鉱石を1個採掘する",
    conditions: ["足場を確認済み"],
    expectedOutcome: "鉱石が所持品に増える",
    observedOutcome: "successful",
    observationSummary: "採掘後に所持品の増加を観測した",
    ...overrides,
  });
}

function updateMarkdownBody(filePath: string, body: string): void {
  const content = readFileSync(filePath, "utf8");
  const bodyMarker = "\n## 本文\n";
  const markerIndex = content.indexOf(bodyMarker);
  if (markerIndex < 0) throw new Error("Markdown body marker is missing");
  writeFileSync(
    filePath,
    `${content.slice(0, markerIndex)}${bodyMarker}${body}\n`,
    "utf8",
  );
}

function updateMetadata(
  filePath: string,
  update: (metadata: Record<string, unknown>) => void,
): void {
  const content = readFileSync(filePath, "utf8");
  const expression = /```mc-bot-skill\n([\s\S]*?)\n```/u;
  const match = expression.exec(content);
  if (match?.[1] === undefined) throw new Error("Metadata fence is missing");
  const metadata = JSON.parse(match[1]) as Record<string, unknown>;
  update(metadata);
  const replacement = `\`\`\`mc-bot-skill\n${JSON.stringify(metadata, null, 2)}\n\`\`\``;
  writeFileSync(filePath, content.replace(expression, replacement), "utf8");
}

function readMetadata(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, "utf8");
  const expression = /```mc-bot-skill\n([\s\S]*?)\n```/u;
  const match = expression.exec(content);
  if (match?.[1] === undefined) throw new Error("Metadata fence is missing");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function copyMarkdownWithSkillId(
  sourcePath: string,
  targetPath: string,
  skillId: string,
): void {
  const content = readFileSync(sourcePath, "utf8");
  const expression = /```mc-bot-skill\n([\s\S]*?)\n```/u;
  const match = expression.exec(content);
  if (match?.[1] === undefined) throw new Error("Metadata fence is missing");
  const metadata = JSON.parse(match[1]) as Record<string, unknown>;
  const skill = metadata.skill as Record<string, unknown>;
  skill.id = skillId;
  const marker = "\n## 本文\n";
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) throw new Error("Markdown body marker is missing");
  const body = content.slice(markerIndex + marker.length).replace(/\n$/u, "");
  metadata.baseDigest = createHash("sha256")
    .update(
      JSON.stringify({
        id: skill.id,
        category: skill.category,
        title: skill.title,
        purpose: skill.purpose,
        conditions: skill.conditions,
        body,
        operationRefs: skill.operationRefs,
        expectedOutcome: skill.expectedOutcome,
        confidence: skill.confidence,
      }),
      "utf8",
    )
    .digest("hex");
  const replacement = `\`\`\`mc-bot-skill\n${JSON.stringify(metadata, null, 2)}\n\`\`\``;
  writeFileSync(targetPath, content.replace(expression, replacement), "utf8");
}

afterEach(() => {
  while (repositories.length > 0) repositories.pop()?.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
  }
});

describe("McSkillRepository", () => {
  it("seeds Japanese summaries, loads content on demand, and survives restart beside existing tables", () => {
    const { options } = createFixture();
    const database = new Database(options.databasePath);
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations(version) VALUES (7); CREATE TABLE memory_marker (value TEXT NOT NULL); INSERT INTO memory_marker(value) VALUES ('kept');",
    );
    database.close();

    const repository = open(options);
    const summaries = repository.search();
    expect(summaries.map(({ category }) => category)).toEqual([
      "building",
      "combat",
      "crafting",
      "exploration",
      "gathering",
      "navigation",
      "survival",
    ]);
    expect(summaries[0]).not.toHaveProperty("body");
    const graphemeCount = (value: string): number =>
      Array.from(
        new Intl.Segmenter("ja-JP", { granularity: "grapheme" }).segment(value),
      ).length;
    expect(
      summaries.every(({ bodyPreview }) => graphemeCount(bodyPreview) <= 240),
    ).toBe(true);
    expect(
      summaries.find(({ id }) => id === "mc-skill-exploration")?.bodyPreview,
    ).toContain("遮る地形");
    const navigation = repository.get("mc-skill-navigation");
    expect(navigation.body).toContain("元の目的方向");
    expect(navigation.operationRefs).toEqual([
      "look",
      "move_relative",
      "move_to",
      "control",
    ]);
    expect(repository.get("mc-skill-exploration")).toMatchObject({
      operationRefs: ["look", "look_sweep", "move_relative", "move_to"],
    });
    expect(repository.get("mc-skill-exploration").body).toContain(
      "同じ移動の反復前にlook_sweep",
    );
    expect(repository.get("mc-skill-exploration").body).toContain(
      "下向きの-25度",
    );
    expect(repository.get("mc-skill-exploration").body).toContain(
      "上方は正のpitchDegrees",
    );
    const custom = createDigSkill(repository, "restart-skill");
    repository.close();

    const reopened = open(options);
    expect(reopened.get(custom.id)).toMatchObject({
      version: 1,
      title: "安全に鉱石を掘る",
      operationRefs: ["look", "dig"],
    });
    reopened.close();

    const inspected = new Database(options.databasePath);
    expect(
      inspected.prepare("SELECT version FROM schema_migrations").get(),
    ).toEqual({ version: 7 });
    expect(inspected.prepare("SELECT value FROM memory_marker").get()).toEqual({
      value: "kept",
    });
    expect(
      inspected
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mc_bot_skill_%'",
        )
        .all(),
    ).not.toHaveLength(0);
    inspected.close();
  });

  it("bounds searched Skill previews while retaining the full version for explicit reading", () => {
    const { options } = createFixture();
    const repository = open(options);
    const body = `${"探".repeat(239)}👩‍🚀${"続行".repeat(60)}`;
    const skill = repository.createSkill({
      ...hypothesisInput("long-preview-skill", "長文の探索"),
      body,
    });

    const preview = repository.search({ query: "長文の探索" })[0]?.bodyPreview;
    expect(preview).toBeDefined();
    expect(
      Array.from(
        new Intl.Segmenter("ja-JP", { granularity: "grapheme" }).segment(
          preview ?? "",
        ),
      ),
    ).toHaveLength(240);
    expect(preview?.endsWith("👩‍🚀")).toBe(true);
    expect(repository.get(skill.id).body).toBe(body);

    const emojiSkill = repository.createSkill({
      ...hypothesisInput("emoji-preview-skill", "絵文字の探索"),
      body: "👩‍🚀".repeat(200),
    });
    const emojiPreview = repository.search({ query: "絵文字の探索" })[0]
      ?.bodyPreview;
    expect(Buffer.byteLength(emojiPreview ?? "", "utf8")).toBeLessThanOrEqual(
      960,
    );
    expect(emojiPreview?.endsWith("👩‍🚀")).toBe(true);
    expect(repository.get(emojiSkill.id).body).toBe("👩‍🚀".repeat(200));
  });

  it("keeps claims unverified without receipts and deduplicates observed outcomes", () => {
    const { options } = createFixture();
    const repository = open(options);
    const skill = createDigSkill(repository, "learned-dig-skill");

    const unverifiedSuccess = repository.recordOutcome({
      skillId: skill.id,
      runId: "claim-only-run",
      proposedOutcome: "successful",
      summary: "Caller reported a success",
    });
    const unverifiedFailure = repository.recordOutcome({
      skillId: skill.id,
      runId: "claim-only-failure",
      proposedOutcome: "failed",
      summary: "Caller reported a failure",
    });
    expect(unverifiedSuccess).toMatchObject({
      status: "unverified",
      successHypothesis: false,
    });
    expect(unverifiedFailure).toMatchObject({
      status: "unverified",
      successHypothesis: false,
    });
    expect(repository.get(skill.id).nativeStatistics).toMatchObject({
      successful: 0,
      failed: 0,
      unverified: 2,
    });

    const firstReceipt = trustedDigEvidence(repository, "observed-success-1");
    const firstOutcome = repository.recordOutcome({
      skillId: skill.id,
      runId: firstReceipt.runId,
      proposedOutcome: "successful",
    });
    const duplicateOutcome = repository.recordOutcome({
      skillId: skill.id,
      runId: firstReceipt.runId,
      proposedOutcome: "successful",
    });
    expect(firstOutcome).toMatchObject({
      status: "successful",
      successHypothesis: true,
    });
    expect(duplicateOutcome).toEqual(firstOutcome);

    const secondReceipt = trustedDigEvidence(repository, "observed-success-2");
    const secondOutcome = repository.recordOutcome({
      skillId: skill.id,
      runId: secondReceipt.runId,
      proposedOutcome: "successful",
    });
    expect(secondOutcome).toMatchObject({
      status: "successful",
      successHypothesis: false,
    });
    expect(repository.listOutcomes(skill.id)).toHaveLength(4);
    expect(repository.getEvidence("observed-success-1")).toEqual(firstReceipt);
    expect(repository.get(skill.id).nativeStatistics).toMatchObject({
      successful: 2,
      failed: 0,
    });
  });

  it("connects pre-skill receipts only to a skill that references their operation and keeps cancellation separate", () => {
    const { options } = createFixture();
    const repository = open(options);
    const beforeCreation = trustedDigEvidence(
      repository,
      "novel-operation-run",
    );
    const learned = createDigSkill(repository, "skill-after-run");
    const learnedOutcome = repository.recordOutcome({
      skillId: learned.id,
      runId: beforeCreation.runId,
      proposedOutcome: "unverified",
    });
    expect(learnedOutcome).toMatchObject({
      status: "successful",
      successHypothesis: true,
    });

    const moveReceipt = repository.recordTrustedEvidence({
      runId: "cancelled-navigation-run",
      operationName: "move_to",
      inputSummary: "目的地へ移動する",
      conditions: ["経路を観測した"],
      expectedOutcome: "目的地付近へ到着する",
      observedOutcome: "cancelled",
      observationSummary: "停止指示で移動を取り消した",
      skillIdAtUse: "mc-skill-navigation",
      skillVersionAtUse: 1,
    });
    const cancelled = repository.recordOutcome({
      skillId: "mc-skill-navigation",
      runId: moveReceipt.runId,
      proposedOutcome: "successful",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(
      repository.get("mc-skill-navigation").nativeStatistics,
    ).toMatchObject({
      cancelled: 1,
      interrupted: 0,
    });

    const unrelated = createDigSkill(repository, "unrelated-skill");
    expect(() =>
      repository.recordOutcome({
        skillId: unrelated.id,
        runId: beforeCreation.runId,
        proposedOutcome: "successful",
      }),
    ).toThrow(McSkillRepositoryError);
    const withoutOperation = repository.createSkill({
      id: "missing-operation-skill",
      category: "gathering",
      title: "Operation mismatch",
      purpose: "Bound the receipt to matching operations.",
      conditions: ["An observed run exists"],
      body: "This skill does not reference dig.",
      operationRefs: ["look"],
      expectedOutcome: "A matching operation is required.",
      confidence: 0,
    });
    const secondNovelReceipt = trustedDigEvidence(
      repository,
      "novel-operation-run-2",
    );
    expect(() =>
      repository.recordOutcome({
        skillId: withoutOperation.id,
        runId: secondNovelReceipt.runId,
        proposedOutcome: "successful",
      }),
    ).toThrow(/operation/iu);
  });

  it("derives one immutable hypothesis from a seed success without recounting its outcome", () => {
    const { options } = createFixture();
    const repository = open(options);
    const seed = repository.get("mc-skill-gathering");
    expect(() =>
      repository.createHypothesisFromEvidence({
        runId: "model-claimed-success",
        input: hypothesisInput("untrusted-hypothesis"),
      }),
    ).toThrow(/trusted evidence receipt/iu);
    const receipt = trustedDigEvidence(repository, "seed-hypothesis-run", {
      skillIdAtUse: seed.id,
      skillVersionAtUse: seed.version,
    });
    repository.recordOutcome({
      skillId: seed.id,
      runId: receipt.runId,
      proposedOutcome: "successful",
    });
    const before = repository.get(seed.id).nativeStatistics;
    const input = hypothesisInput("derived-from-seed");
    const learned = repository.createHypothesisFromEvidence({
      runId: receipt.runId,
      input,
    });

    expect(learned).toMatchObject({
      skill: { id: "derived-from-seed", nativeStatistics: { successful: 0 } },
      evidenceLink: {
        runId: receipt.runId,
        receiptId: receipt.receiptId,
        skillId: "derived-from-seed",
        skillVersion: 1,
        nativeOutcomeRecorded: false,
      },
      idempotent: false,
    });
    expect(repository.get(seed.id).nativeStatistics).toEqual(before);
    expect(repository.getEvidence(receipt.runId)).toEqual(receipt);
    expect(repository.listDerivedHypotheses(learned.skill.id)).toEqual([
      learned.evidenceLink,
    ]);

    const duplicate = repository.createHypothesisFromEvidence({
      runId: receipt.runId,
      input,
    });
    expect(duplicate.idempotent).toBe(true);
    expect(duplicate.skill.id).toBe(learned.skill.id);
    expect(repository.listDerivedHypotheses(learned.skill.id)).toHaveLength(1);
    expect(() =>
      repository.createHypothesisFromEvidence({
        runId: receipt.runId,
        input: hypothesisInput("derived-from-seed", "別タイトルの別仮説"),
      }),
    ).toThrow(McSkillRepositoryError);
    expect(repository.search({ query: "別タイトルの別仮説" })).toHaveLength(0);
    expect(repository.get(seed.id).nativeStatistics).toEqual(before);
    expect(repository.get(learned.skill.id).nativeStatistics.successful).toBe(
      0,
    );

    const mismatchedReceipt = trustedDigEvidence(
      repository,
      "hypothesis-operation-mismatch",
      { skillIdAtUse: seed.id, skillVersionAtUse: seed.version },
    );
    expect(() =>
      repository.createHypothesisFromEvidence({
        runId: mismatchedReceipt.runId,
        input: {
          ...hypothesisInput("missing-operation"),
          operationRefs: ["look"],
        },
      }),
    ).toThrow(/operation observed in its trusted receipt/iu);
    expect(() => repository.get("missing-operation")).toThrow(
      McSkillRepositoryError,
    );

    const failedReceipt = trustedDigEvidence(
      repository,
      "failed-hypothesis-run",
      {
        observedOutcome: "failed",
      },
    );
    expect(() =>
      repository.createHypothesisFromEvidence({
        runId: failedReceipt.runId,
        input: hypothesisInput("failed-hypothesis"),
      }),
    ).toThrow(/observed successful receipt/iu);
    expect(() => repository.get("failed-hypothesis")).toThrow(
      McSkillRepositoryError,
    );
  });

  it("atomically records a first native success for a new hypothesis and keeps retries stable across restart", () => {
    const { options } = createFixture();
    const repository = open(options);
    const receipt = trustedDigEvidence(repository, "novel-hypothesis-run");
    const input = hypothesisInput();
    const learned = repository.createHypothesisFromEvidence({
      runId: receipt.runId,
      input,
    });
    expect(learned.idempotent).toBe(false);
    expect(learned.evidenceLink.nativeOutcomeRecorded).toBe(true);
    expect(learned.skill.nativeStatistics.successful).toBe(1);
    expect(repository.listOutcomes(learned.skill.id)).toMatchObject([
      {
        runId: receipt.runId,
        status: "successful",
        successHypothesis: true,
        evidenceReceiptId: receipt.receiptId,
      },
    ]);

    const sameRunRetry = repository.createHypothesisFromEvidence({
      runId: receipt.runId,
      input,
    });
    expect(sameRunRetry.idempotent).toBe(true);
    expect(sameRunRetry.skill.id).toBe(learned.skill.id);
    expect(repository.get(learned.skill.id).nativeStatistics.successful).toBe(
      1,
    );
    expect(() =>
      repository.createHypothesisFromEvidence({
        runId: receipt.runId,
        input: hypothesisInput(undefined, "再試行で別タイトル"),
      }),
    ).toThrow(McSkillRepositoryError);

    repository.close();
    const reopened = open(options);
    const persistedLink = reopened.listDerivedHypotheses(learned.skill.id);
    expect(persistedLink).toEqual([learned.evidenceLink]);
    expect(reopened.getEvidence(receipt.runId)).toEqual(receipt);
    expect(
      reopened.createHypothesisFromEvidence({ runId: receipt.runId, input })
        .idempotent,
    ).toBe(true);
    expect(reopened.get(learned.skill.id).nativeStatistics.successful).toBe(1);
  });

  it("rolls back the skill, revision, outcome, and attribution if atomic learning fails", () => {
    const { options } = createFixture();
    const repository = open(options);
    trustedDigEvidence(repository, "hypothesis-rollback-run");
    const blocker = new Database(options.databasePath);
    blocker.exec(`
      CREATE TRIGGER reject_hypothesis_outcome
      BEFORE INSERT ON mc_bot_skill_outcomes
      WHEN NEW.run_id = 'hypothesis-rollback-run'
      BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END;
    `);
    blocker.close();

    expect(() =>
      repository.createHypothesisFromEvidence({
        runId: "hypothesis-rollback-run",
        input: hypothesisInput("rollback-hypothesis"),
      }),
    ).toThrow(/injected outcome failure/iu);

    const inspected = new Database(options.databasePath);
    expect(
      inspected
        .prepare("SELECT COUNT(*) AS count FROM mc_bot_skills WHERE id = ?")
        .get("rollback-hypothesis"),
    ).toEqual({ count: 0 });
    expect(
      inspected
        .prepare(
          "SELECT COUNT(*) AS count FROM mc_bot_skill_revisions WHERE skill_id = ?",
        )
        .get("rollback-hypothesis"),
    ).toEqual({ count: 0 });
    expect(
      inspected
        .prepare(
          "SELECT COUNT(*) AS count FROM mc_bot_skill_outcomes WHERE run_id = ?",
        )
        .get("hypothesis-rollback-run"),
    ).toEqual({ count: 0 });
    expect(
      inspected
        .prepare(
          "SELECT COUNT(*) AS count FROM mc_bot_skill_derived_hypotheses WHERE run_id = ?",
        )
        .get("hypothesis-rollback-run"),
    ).toEqual({ count: 0 });
    inspected.close();
  });

  it("uses optimistic versions and preserves immutable text revisions", () => {
    const { options } = createFixture();
    const repository = open(options);
    const skill = repository.get("mc-skill-gathering");
    const revised = repository.revise({
      skillId: skill.id,
      expectedVersion: skill.version,
      changeKind: "weaken",
      changeNote: "実地確認が少ないため断定を弱める",
      patch: {
        body: "周囲を確認してから少量を採集し、観測結果に応じて続行を判断する。",
        confidence: 0.1,
      },
    });
    expect(revised.version).toBe(skill.version + 1);
    expect(
      repository.getHistory(skill.id).map(({ version }) => version),
    ).toEqual([1, 2]);
    expect(repository.getHistory(skill.id)[0]?.body).toBe(skill.body);
    expect(() =>
      repository.revise({
        skillId: skill.id,
        expectedVersion: skill.version,
        changeKind: "merge",
        changeNote: "stale edit",
        patch: { body: "stale" },
      }),
    ).toThrow(/version conflict/iu);
  });

  it("atomically links trusted successful and failed receipts to material revisions", () => {
    const { options } = createFixture();
    const repository = open(options);
    const skill = repository.get("mc-skill-gathering");
    const successful = trustedDigEvidence(repository, "revision-success-run", {
      skillIdAtUse: skill.id,
      skillVersionAtUse: skill.version,
    });
    const successInput = {
      runId: successful.runId,
      skillId: skill.id,
      expectedVersion: skill.version,
      changeKind: "revise" as const,
      changeNote: "採掘の前後で変化を確かめる",
      patch: {
        body: "採掘前に対象と足場を確かめ、採掘後は対象と所持品の変化を確認する。",
      },
    };
    const first = repository.reviseFromEvidence(successInput);
    expect(first).toMatchObject({
      skill: { id: skill.id, version: 2 },
      evidenceRevision: {
        runId: successful.runId,
        receiptId: successful.receiptId,
        operationName: "dig",
        observedOutcome: "successful",
        skillId: skill.id,
        skillVersionAtUse: 1,
        revisionVersion: 2,
      },
      idempotent: false,
    });
    expect(repository.getEvidenceRevision(successful.runId)).toEqual(
      first.evidenceRevision,
    );
    expect(repository.listEvidenceRevisions(skill.id)).toEqual([
      first.evidenceRevision,
    ]);

    const unrelatedReceipt = trustedDigEvidence(
      repository,
      "revision-wrong-pair-run",
      { skillIdAtUse: skill.id, skillVersionAtUse: skill.version },
    );
    const database = new Database(options.databasePath);
    expect(() =>
      database
        .prepare(
          "INSERT INTO mc_bot_skill_evidence_revisions (run_id, receipt_id, skill_id, skill_version_at_use, revision_version, definition_digest, request_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          unrelatedReceipt.runId,
          successful.receiptId,
          skill.id,
          skill.version,
          first.evidenceRevision.revisionVersion,
          "definition-digest",
          "request-digest",
          new Date().toISOString(),
        ),
    ).toThrow(/does not match trusted receipt/iu);
    database.close();

    const retry = repository.reviseFromEvidence(successInput);
    expect(retry.idempotent).toBe(true);
    expect(retry.evidenceRevision).toEqual(first.evidenceRevision);
    expect(repository.getHistory(skill.id)).toHaveLength(2);
    expect(() =>
      repository.reviseFromEvidence({
        ...successInput,
        patch: { body: "同じreceiptに別の内容を割り当てる。" },
      }),
    ).toThrow(McSkillRepositoryError);
    expect(repository.getHistory(skill.id)).toHaveLength(2);

    const failed = trustedDigEvidence(repository, "revision-failed-run", {
      observedOutcome: "failed",
      skillIdAtUse: skill.id,
      skillVersionAtUse: first.evidenceRevision.revisionVersion,
    });
    const second = repository.reviseFromEvidence({
      runId: failed.runId,
      skillId: skill.id,
      expectedVersion: first.evidenceRevision.revisionVersion,
      changeKind: "weaken",
      changeNote: "失敗を受け条件を見直す",
      patch: {
        conditions: ["採掘対象と足場を再確認できた"],
        confidence: 0.05,
      },
    });
    expect(second.evidenceRevision).toMatchObject({
      receiptId: failed.receiptId,
      observedOutcome: "failed",
      skillVersionAtUse: 2,
      revisionVersion: 3,
    });
  });

  it("rejects mismatched, stale, non-material, or operation-incompatible evidence revisions", () => {
    const { options } = createFixture();
    const repository = open(options);
    const skill = repository.get("mc-skill-gathering");
    const receipt = trustedDigEvidence(repository, "revision-mismatch-run", {
      skillIdAtUse: skill.id,
      skillVersionAtUse: skill.version,
    });
    const input = {
      runId: receipt.runId,
      skillId: skill.id,
      expectedVersion: skill.version,
      changeKind: "revise" as const,
      changeNote: "採掘手順を更新する",
      patch: { body: "採掘前に対象を見て、採掘後に所持品の変化を確認する。" },
    };

    expect(() =>
      repository.reviseFromEvidence({ ...input, skillId: "mc-skill-survival" }),
    ).toThrow(McSkillRepositoryError);
    expect(() =>
      repository.reviseFromEvidence({
        ...input,
        patch: { title: "タイトルだけの変更" },
      }),
    ).toThrow(/materially change/iu);
    expect(() =>
      repository.reviseFromEvidence({
        ...input,
        patch: { ...input.patch, operationRefs: ["look"] },
      }),
    ).toThrow(/observed operation reference/iu);
    expect(repository.get(skill.id).version).toBe(1);

    repository.revise({
      skillId: skill.id,
      expectedVersion: skill.version,
      changeKind: "revise",
      changeNote: "別の更新で版を進める",
      patch: { body: "別更新で採掘手順を見直す。" },
    });
    expect(() => repository.reviseFromEvidence(input)).toThrow(
      /version conflict/iu,
    );
    expect(repository.getEvidenceRevision(receipt.runId)).toBeUndefined();
  });

  it("rolls back the skill and immutable revision when evidence attribution fails", () => {
    const { options } = createFixture();
    const repository = open(options);
    const skill = repository.get("mc-skill-gathering");
    const receipt = trustedDigEvidence(repository, "revision-rollback-run", {
      skillIdAtUse: skill.id,
      skillVersionAtUse: skill.version,
    });
    const blocker = new Database(options.databasePath);
    blocker.exec(`
      CREATE TRIGGER reject_evidence_revision
      BEFORE INSERT ON mc_bot_skill_evidence_revisions
      WHEN NEW.run_id = 'revision-rollback-run'
      BEGIN SELECT RAISE(ABORT, 'injected attribution failure'); END;
    `);
    blocker.close();

    expect(() =>
      repository.reviseFromEvidence({
        runId: receipt.runId,
        skillId: skill.id,
        expectedVersion: skill.version,
        changeKind: "revise",
        changeNote: "atomic rollback check",
        patch: { body: "改訂と証跡は一緒に保存されなければならない。" },
      }),
    ).toThrow(/injected attribution failure/iu);
    expect(repository.get(skill.id).version).toBe(skill.version);
    expect(repository.getHistory(skill.id)).toHaveLength(1);
    expect(repository.getEvidenceRevision(receipt.runId)).toBeUndefined();
  });

  it("round-trips edited Markdown and provenance without inflating native experience", () => {
    const { directory, options } = createFixture();
    const source = open(options);
    const skill = createDigSkill(source, "portable-skill");
    const receipt = trustedDigEvidence(source, "portable-success", {
      skillIdAtUse: skill.id,
      skillVersionAtUse: skill.version,
    });
    source.recordOutcome({
      skillId: skill.id,
      runId: receipt.runId,
      proposedOutcome: "successful",
    });
    const exported = source.exportSkill(skill.id);
    expect(exported.content).toContain("```mc-bot-skill");
    expect(exported.content).toContain("## 本文");

    const recipient = open({
      ...options,
      databasePath: join(directory, "recipient.sqlite"),
    });
    const firstImport = recipient.importSkill(exported.fileName);
    expect(firstImport.idempotent).toBe(false);
    expect(firstImport.skill.nativeStatistics.successful).toBe(0);
    expect(firstImport.importedStatistics.successful).toBe(1);
    expect(firstImport.skill.importedStatistics).toHaveLength(1);

    updateMarkdownBody(
      exported.path,
      "採掘前に足場を確認し、目的の鉱石が増えた時だけ完了と記録する。",
    );
    const editedImport = recipient.importSkill(exported.fileName);
    expect(editedImport.skill.version).toBe(skill.version + 1);
    expect(editedImport.skill.body).toContain("増えた時だけ");
    expect(editedImport.skill.nativeStatistics.successful).toBe(0);
    expect(editedImport.skill.importedStatistics).toHaveLength(1);
    expect(recipient.importSkill(exported.fileName).idempotent).toBe(true);

    const invalidExport = source.exportSkill(skill.id, "invalid-operation.md");
    updateMetadata(invalidExport.path, (metadata) => {
      const skillMetadata = metadata.skill as Record<string, unknown>;
      skillMetadata.operationRefs = ["not_allowed"];
    });
    expect(() => recipient.importSkill(invalidExport.fileName)).toThrow(
      /Unknown operation reference/iu,
    );
  });

  it("preserves distinct repository origins through relays and keeps an origin stable after reopen", () => {
    const { directory, options } = createFixture();
    const origin = open(options);
    const skill = createDigSkill(origin, "origin-skill");
    const receipt = trustedDigEvidence(origin, "origin-run", {
      skillIdAtUse: skill.id,
      skillVersionAtUse: skill.version,
    });
    origin.recordOutcome({
      skillId: skill.id,
      runId: receipt.runId,
      proposedOutcome: "successful",
    });
    const originExport = origin.exportSkill(skill.id, "origin.md");
    const originMetadata = readMetadata(originExport.path);
    const originProvenance = originMetadata.provenance;

    const relayOptions = {
      ...options,
      databasePath: join(directory, "relay.sqlite"),
    };
    const relay = open(relayOptions);
    relay.importSkill("origin.md");
    const relaySkill = relay.get(skill.id);
    const relayReceipt = trustedDigEvidence(relay, "relay-native-run", {
      skillIdAtUse: relaySkill.id,
      skillVersionAtUse: relaySkill.version,
    });
    relay.recordOutcome({
      skillId: relaySkill.id,
      runId: relayReceipt.runId,
      proposedOutcome: "successful",
    });
    const relayExport = relay.exportSkill(skill.id, "relay.md");
    const relayMetadata = readMetadata(relayExport.path);
    const relayProvenance = relayMetadata.provenance;
    expect(relayProvenance).not.toBe(originProvenance);

    relay.close();
    const reopenedRelay = open(relayOptions);
    const reopenedExport = reopenedRelay.exportSkill(
      skill.id,
      "relay-reopened.md",
    );
    expect(readMetadata(reopenedExport.path).provenance).toBe(relayProvenance);

    const target = open({
      ...options,
      databasePath: join(directory, "target.sqlite"),
    });
    const first = target.importSkill("relay-reopened.md");
    expect(first.skill.nativeStatistics.successful).toBe(0);
    expect(first.skill.importedStatistics).toHaveLength(2);
    expect(first.skill.importedStatistics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceSkillId: skill.id,
          successful: 1,
          provenance: originProvenance,
        }),
        expect.objectContaining({
          sourceSkillId: skill.id,
          successful: 1,
          provenance: relayProvenance,
        }),
      ]),
    );
    expect(
      new Set(
        first.skill.importedStatistics.map(({ provenance }) => provenance),
      ).size,
    ).toBe(2);

    const copiedMarkdown = join(options.exchangeDirectory, "relay-copy.md");
    copyMarkdownWithSkillId(
      reopenedExport.path,
      copiedMarkdown,
      "relay-copy-skill",
    );
    target.importSkill("relay-copy.md");
    const second = target.get("relay-copy-skill");
    expect(second.nativeStatistics.successful).toBe(0);
    expect(second.importedStatistics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceSkillId: skill.id, successful: 1 }),
      ]),
    );
    expect(target.get(skill.id).importedStatistics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceSkillId: skill.id, successful: 1 }),
      ]),
    );
  });

  it("rejects traversal and symlink exchange entries", () => {
    const { directory, options } = createFixture();
    const repository = open(options);
    const skill = repository.get("mc-skill-navigation");
    expect(() => repository.exportSkill(skill.id, "../outside.md")).toThrow(
      McSkillRepositoryError,
    );
    expect(() => repository.importSkill("../outside.md")).toThrow(
      McSkillRepositoryError,
    );

    const outside = join(directory, "outside.md");
    writeFileSync(outside, "not a skill", "utf8");
    mkdirSync(options.exchangeDirectory, { recursive: true });
    const symlinkPath = join(options.exchangeDirectory, "linked.md");
    symlinkSync(outside, symlinkPath);
    expect(existsSync(outside)).toBe(true);
    expect(() => repository.importSkill("linked.md")).toThrow(
      McSkillRepositoryError,
    );
    expect(() => repository.exportSkill(skill.id, "linked.md")).toThrow(
      McSkillRepositoryError,
    );
    expect(readFileSync(outside, "utf8")).toBe("not a skill");

    const movedExchange = join(directory, "exchange-moved");
    renameSync(options.exchangeDirectory, movedExchange);
    symlinkSync(movedExchange, options.exchangeDirectory);
    expect(() =>
      repository.exportSkill(skill.id, "after-root-swap.md"),
    ).toThrow(McSkillRepositoryError);
  });
});
