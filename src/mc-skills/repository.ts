import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import {
  mcSkillCategories,
  mcSkillOutcomeStatuses,
  type CreateMcSkillHypothesisInput,
  type CreateMcSkillHypothesisResult,
  type CreateMcSkillInput,
  type ExportedMcSkillResult,
  type ImportedMcSkillResult,
  type ImportedMcSkillStatistics,
  type McSkillCategory,
  type McSkillDefinition,
  type McSkillHypothesisEvidenceLink,
  type McSkillOutcome,
  type McSkillOutcomeStatus,
  type McSkillRecord,
  type McSkillRepositoryOptions,
  type McSkillRevision,
  type McSkillStatistics,
  type McSkillSummary,
  type RecordMcSkillOutcomeInput,
  type RecordTrustedMcSkillEvidenceInput,
  type ReviseMcSkillInput,
  type SearchMcSkillsOptions,
  type TrustedMcSkillEvidenceReceipt,
} from "./types.js";

const EXCHANGE_SCHEMA_VERSION = 1;
const MAX_SEARCH_LIMIT = 100;
const MAX_SKILL_PAYLOAD_BYTES = 48 * 1024;
const MAX_EXCHANGE_FILE_BYTES = 64 * 1024;
const MAX_EVIDENCE_PAYLOAD_BYTES = 16 * 1024;

const skillRecordSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
    category: z.enum(mcSkillCategories),
    title: z.string().trim().min(1),
    purpose: z.string().trim().min(1),
    conditions: z.array(z.string().trim().min(1)).readonly(),
    body: z.string().trim().min(1),
    operationRefs: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u))
      .readonly(),
    expectedOutcome: z.string().trim().min(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const exchangeMetadataSchema = z
  .object({
    kind: z.literal("mc-bot-skill"),
    schemaVersion: z.literal(EXCHANGE_SCHEMA_VERSION),
    sourceVersion: z.number().int().positive(),
    baseDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    skill: skillRecordSchema,
    statistics: z.object({
      native: z.object({
        successful: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        interrupted: z.number().int().nonnegative(),
        cancelled: z.number().int().nonnegative(),
        unverified: z.number().int().nonnegative(),
      }),
      imported: z
        .array(
          z.object({
            sourceSkillId: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
            sourceVersion: z.number().int().positive(),
            successful: z.number().int().nonnegative(),
            failed: z.number().int().nonnegative(),
            interrupted: z.number().int().nonnegative(),
            cancelled: z.number().int().nonnegative(),
            unverified: z.number().int().nonnegative(),
            provenance: z.string().trim().min(1),
          }),
        )
        .readonly(),
    }),
    provenance: z.string().trim().min(1),
  })
  .strict();

type ExchangeMetadata = z.infer<typeof exchangeMetadataSchema>;

interface SkillRow {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly purpose: string;
  readonly conditions_json: string;
  readonly body: string;
  readonly operation_refs_json: string;
  readonly expected_outcome: string;
  readonly confidence: number;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RevisionRow {
  readonly skill_id: string;
  readonly category: string;
  readonly title: string;
  readonly purpose: string;
  readonly conditions_json: string;
  readonly body: string;
  readonly operation_refs_json: string;
  readonly expected_outcome: string;
  readonly confidence: number;
  readonly version: number;
  readonly created_at: string;
  readonly change_kind: string;
  readonly change_note: string;
}

interface EvidenceRow {
  readonly receipt_id: string;
  readonly run_id: string;
  readonly operation_name: string;
  readonly input_summary: string;
  readonly conditions_json: string;
  readonly expected_outcome: string;
  readonly observed_outcome: string;
  readonly observation_summary: string;
  readonly skill_id_at_use: string | null;
  readonly skill_version_at_use: number | null;
  readonly observed_at: string;
  readonly fingerprint: string;
}

interface OutcomeRow {
  readonly skill_id: string;
  readonly run_id: string;
  readonly proposed_outcome: string;
  readonly status: string;
  readonly summary: string;
  readonly evidence_receipt_id: string | null;
  readonly skill_version_at_use: number | null;
  readonly success_hypothesis: number;
  readonly recorded_at: string;
}

interface ImportRow {
  readonly source_key: string;
  readonly skill_id: string;
  readonly source_skill_id: string;
  readonly successful: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly cancelled: number;
  readonly unverified: number;
  readonly source_version: number;
  readonly provenance: string;
}

interface ImportReceiptRow {
  readonly import_key: string;
  readonly skill_id: string;
  readonly fingerprint: string;
}

interface DerivedHypothesisRow {
  readonly run_id: string;
  readonly receipt_id: string;
  readonly skill_id: string;
  readonly skill_version: number;
  readonly definition_digest: string;
  readonly native_outcome_recorded: number;
  readonly created_at: string;
}

interface OutcomeCountRow {
  readonly status: string;
  readonly count: number;
}

export class McSkillRepositoryError extends Error {
  public constructor(
    public readonly code:
      | "VALIDATION"
      | "NOT_FOUND"
      | "VERSION_CONFLICT"
      | "ID_CONFLICT"
      | "OUTCOME_CONFLICT"
      | "EVIDENCE_CONFLICT"
      | "UNSAFE_EXCHANGE_PATH"
      | "IMPORT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "McSkillRepositoryError";
  }
}

const initialSkills: readonly McSkillDefinition[] = [
  {
    id: "mc-skill-survival",
    category: "survival",
    title: "状況に合わせて生存を続ける",
    purpose: "体力、空腹、酸素、装備を見て目的と行動の釣り合いを決める。",
    conditions: ["危険地形、敵、空腹、低体力、水中のいずれかがある"],
    body: "現在の目的と体力・空腹・酸素・装備・周囲を見て、回復、装備変更、経路調整などから釣り合う行動を選ぶ。観測結果に合わせて次の行動を見直す。",
    operationRefs: ["look", "move_to", "use", "equip", "control"],
    expectedOutcome:
      "目的とBotの状態の釣り合いを取り、観測結果に沿って次の行動を選ぶ。",
    confidence: 0,
  },
  {
    id: "mc-skill-exploration",
    category: "exploration",
    title: "周囲を調べて探索する",
    purpose: "目的地や資源候補を調べ、探索範囲を状況に合わせて決める。",
    conditions: ["未知の場所や資源候補を調べる"],
    body: "探索の目的、持ち物、帰路の見通し、周囲の危険を調べる。得られる価値と負担を比べ、続行、迂回、範囲縮小、帰還などを観測に合わせて選ぶ。",
    operationRefs: ["look", "move_to"],
    expectedOutcome: "探索の価値と帰路の見通しを観測し、次の選択肢を判断する。",
    confidence: 0,
  },
  {
    id: "mc-skill-combat",
    category: "combat",
    title: "状況を見て戦い方を選ぶ",
    purpose: "敵の脅威と自分の状態を見て、目的に合う対応を選ぶ。",
    conditions: ["敵対Mobが近くにいる"],
    body: "戦う目的、相手の脅威、体力、装備、周囲を見て、攻撃、距離調整、回避、装備変更などを選ぶ。結果と危険の変化を観測し、続け方や規模を柔軟に見直す。",
    operationRefs: ["look", "move_to", "equip", "attack", "control"],
    expectedOutcome:
      "戦闘の目的、危険、現在の状態に合う行動を観測結果で確かめる。",
    confidence: 0,
  },
  {
    id: "mc-skill-gathering",
    category: "gathering",
    title: "必要な資源を集める",
    purpose: "必要量と周囲の状況を見て資源を集める。",
    conditions: ["作業に必要な資源が不足している"],
    body: "集める目的、必要量、場所の状況や周囲への影響を見て、資源や採集規模を選ぶ。所持品と環境の変化を観測し、必要なら別の資源や手順へ切り替える。",
    operationRefs: ["look", "move_to", "dig", "use"],
    expectedOutcome: "目的と周囲に合わせて資源を集め、結果を観測で確かめる。",
    confidence: 0,
  },
  {
    id: "mc-skill-crafting",
    category: "crafting",
    title: "必要な道具を作る",
    purpose: "材料と完成品を確認し、必要な数だけクラフトする。",
    conditions: ["必要な道具や素材を作成できる"],
    body: "目的の品、レシピ、材料、作業台の状況を確認して手順を選ぶ。材料が足りない場合は別の作り方や先に集める案も検討し、作成後に所持品を観測する。",
    operationRefs: ["look", "craft", "open_window"],
    expectedOutcome: "目的の品が所持品に入り、材料消費が確認できる。",
    confidence: 0,
  },
  {
    id: "mc-skill-building",
    category: "building",
    title: "計画に沿って建築する",
    purpose: "範囲と資材を確認し、既存環境への影響を踏まえて建築する。",
    conditions: ["建築や改修の目的がある"],
    body: "建築の目的、計画範囲、資材、既存の建物や地形への影響を確かめて配置を選ぶ。設置ごとの変化を見て計画を調整し、目的と影響の釣り合いを取り直す。",
    operationRefs: ["look", "move_to", "place", "control"],
    expectedOutcome: "計画と現在の環境に合わせて設置し、変化を観測で確かめる。",
    confidence: 0,
  },
  {
    id: "mc-skill-navigation",
    category: "navigation",
    title: "状況に合わせて目的地へ移動する",
    purpose: "目的地への経路を選び、到着を観測で確かめる。",
    conditions: ["目的地が明確で移動が必要"],
    body: "目的地、経路、地形、周囲の脅威を見て移動方法を選ぶ。進み方や目的との釣り合いを観測に合わせて見直し、到着または次の選択肢を確かめる。",
    operationRefs: ["look", "move_to", "control"],
    expectedOutcome: "目的地への到着や次の選択肢を観測で確認する。",
    confidence: 0,
  },
];

const schemaSql = `
  CREATE TABLE IF NOT EXISTS mc_bot_skills (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('survival', 'exploration', 'combat', 'gathering', 'crafting', 'building', 'navigation')),
    title TEXT NOT NULL,
    purpose TEXT NOT NULL,
    conditions_json TEXT NOT NULL,
    body TEXT NOT NULL,
    operation_refs_json TEXT NOT NULL,
    expected_outcome TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mc_bot_skill_revisions (
    skill_id TEXT NOT NULL REFERENCES mc_bot_skills(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL CHECK (version > 0),
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    purpose TEXT NOT NULL,
    conditions_json TEXT NOT NULL,
    body TEXT NOT NULL,
    operation_refs_json TEXT NOT NULL,
    expected_outcome TEXT NOT NULL,
    confidence REAL NOT NULL,
    change_kind TEXT NOT NULL CHECK (change_kind IN ('create', 'revise', 'merge', 'weaken', 'import')),
    change_note TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (skill_id, version)
  );
  CREATE TRIGGER IF NOT EXISTS mc_bot_skill_revisions_no_update
    BEFORE UPDATE ON mc_bot_skill_revisions BEGIN
      SELECT RAISE(ABORT, 'skill revisions are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS mc_bot_skill_revisions_no_delete
    BEFORE DELETE ON mc_bot_skill_revisions BEGIN
      SELECT RAISE(ABORT, 'skill revisions are immutable');
    END;
  CREATE TABLE IF NOT EXISTS mc_bot_skill_evidence_receipts (
    receipt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    operation_name TEXT NOT NULL,
    input_summary TEXT NOT NULL,
    conditions_json TEXT NOT NULL,
    expected_outcome TEXT NOT NULL,
    observed_outcome TEXT NOT NULL CHECK (observed_outcome IN ('successful', 'failed', 'interrupted', 'cancelled', 'unverified')),
    observation_summary TEXT NOT NULL,
    skill_id_at_use TEXT,
    skill_version_at_use INTEGER,
    observed_at TEXT NOT NULL,
    fingerprint TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS mc_bot_skill_receipts_no_update
    BEFORE UPDATE ON mc_bot_skill_evidence_receipts BEGIN
      SELECT RAISE(ABORT, 'skill evidence receipts are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS mc_bot_skill_receipts_no_delete
    BEFORE DELETE ON mc_bot_skill_evidence_receipts BEGIN
      SELECT RAISE(ABORT, 'skill evidence receipts are immutable');
    END;
  CREATE TABLE IF NOT EXISTS mc_bot_skill_derived_hypotheses (
    run_id TEXT PRIMARY KEY REFERENCES mc_bot_skill_evidence_receipts(run_id) ON DELETE RESTRICT,
    receipt_id TEXT NOT NULL UNIQUE REFERENCES mc_bot_skill_evidence_receipts(receipt_id) ON DELETE RESTRICT,
    skill_id TEXT NOT NULL REFERENCES mc_bot_skills(id) ON DELETE RESTRICT,
    skill_version INTEGER NOT NULL CHECK (skill_version > 0),
    definition_digest TEXT NOT NULL,
    native_outcome_recorded INTEGER NOT NULL CHECK (native_outcome_recorded IN (0, 1)),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mc_bot_skill_derived_hypotheses_skill_idx
    ON mc_bot_skill_derived_hypotheses(skill_id, created_at DESC);
  CREATE TRIGGER IF NOT EXISTS mc_bot_skill_derived_hypotheses_no_update
    BEFORE UPDATE ON mc_bot_skill_derived_hypotheses BEGIN
      SELECT RAISE(ABORT, 'derived skill hypotheses are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS mc_bot_skill_derived_hypotheses_no_delete
    BEFORE DELETE ON mc_bot_skill_derived_hypotheses BEGIN
      SELECT RAISE(ABORT, 'derived skill hypotheses are immutable');
    END;
  CREATE TABLE IF NOT EXISTS mc_bot_skill_outcomes (
    skill_id TEXT NOT NULL REFERENCES mc_bot_skills(id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL UNIQUE,
    proposed_outcome TEXT NOT NULL CHECK (proposed_outcome IN ('successful', 'failed', 'interrupted', 'cancelled', 'unverified')),
    status TEXT NOT NULL CHECK (status IN ('successful', 'failed', 'interrupted', 'cancelled', 'unverified')),
    summary TEXT NOT NULL,
    evidence_receipt_id TEXT REFERENCES mc_bot_skill_evidence_receipts(receipt_id) ON DELETE RESTRICT,
    skill_version_at_use INTEGER,
    success_hypothesis INTEGER NOT NULL CHECK (success_hypothesis IN (0, 1)),
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mc_bot_skill_outcomes_status_idx
    ON mc_bot_skill_outcomes(skill_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS mc_bot_skill_one_success_hypothesis_idx
    ON mc_bot_skill_outcomes(skill_id) WHERE success_hypothesis = 1;
  CREATE TABLE IF NOT EXISTS mc_bot_skill_import_statistics (
    source_key TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES mc_bot_skills(id) ON DELETE RESTRICT,
    source_skill_id TEXT NOT NULL,
    source_version INTEGER NOT NULL,
    successful INTEGER NOT NULL,
    failed INTEGER NOT NULL,
    interrupted INTEGER NOT NULL,
    cancelled INTEGER NOT NULL,
    unverified INTEGER NOT NULL,
    provenance TEXT NOT NULL,
    imported_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mc_bot_skill_import_statistics_skill_idx
    ON mc_bot_skill_import_statistics(skill_id, imported_at DESC);
  CREATE TABLE IF NOT EXISTS mc_bot_skill_import_receipts (
    import_key TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES mc_bot_skills(id) ON DELETE RESTRICT,
    fingerprint TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mc_bot_skill_repository_metadata (
    metadata_key TEXT PRIMARY KEY,
    metadata_value TEXT NOT NULL
  );
`;

export class McSkillRepository {
  private readonly database: Database.Database;
  private readonly exchangeDirectory: string;
  private readonly allowedOperationNames: ReadonlySet<string>;
  private readonly repositoryOrigin: string;

  private constructor(options: McSkillRepositoryOptions) {
    this.allowedOperationNames = new Set(options.allowedOperationNames);
    for (const operation of this.allowedOperationNames) {
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(operation)) {
        throw validationError(
          "Allowed operation names must use tool-name syntax",
        );
      }
    }
    mkdirSync(options.exchangeDirectory, { recursive: true });
    const exchangeStat = lstatSync(options.exchangeDirectory);
    if (!exchangeStat.isDirectory() || exchangeStat.isSymbolicLink()) {
      throw new McSkillRepositoryError(
        "UNSAFE_EXCHANGE_PATH",
        "The exchange directory must be a real directory",
      );
    }
    this.exchangeDirectory = realpathSync(options.exchangeDirectory);
    if (options.databasePath !== ":memory:") {
      mkdirSync(dirname(options.databasePath), { recursive: true });
    }
    this.database = new Database(options.databasePath, { timeout: 5_000 });
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    if (options.databasePath !== ":memory:") {
      this.database.pragma("journal_mode = WAL");
    }
    this.seedInitialSkills();
    this.repositoryOrigin = this.ensureRepositoryOrigin();
  }

  public static open(options: McSkillRepositoryOptions): McSkillRepository {
    return new McSkillRepository(options);
  }

  public close(): void {
    if (this.database.open) this.database.close();
  }

  public search(options: SearchMcSkillsOptions = {}): McSkillSummary[] {
    const query = options.query?.trim().toLocaleLowerCase("ja-JP");
    const categories = options.categories;
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      throw validationError(
        `Search limit must be from 1 to ${MAX_SEARCH_LIMIT}`,
      );
    }
    if (categories?.some((category) => !mcSkillCategories.includes(category))) {
      throw validationError("Search includes an unknown skill category");
    }
    const rows = this.database
      .prepare<[], SkillRow>(
        "SELECT * FROM mc_bot_skills ORDER BY category, title",
      )
      .all();
    return rows
      .filter((row) => {
        if (
          categories !== undefined &&
          !categories.includes(row.category as McSkillCategory)
        ) {
          return false;
        }
        if (query === undefined || query.length === 0) return true;
        return [row.title, row.purpose, row.expected_outcome, row.category]
          .join("\n")
          .toLocaleLowerCase("ja-JP")
          .includes(query);
      })
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        category: row.category as McSkillCategory,
        title: row.title,
        summary: row.purpose,
        operationRefs: parseStringArray(row.operation_refs_json),
        confidence: row.confidence,
        version: row.version,
        successfulRuns: this.statistics(row.id).successful,
      }));
  }

  public get(skillId: string): McSkillRecord {
    const row = this.skillRow(skillId);
    return {
      ...definitionFromRow(row),
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nativeStatistics: this.statistics(skillId),
      importedStatistics: this.importedStatistics(skillId),
    };
  }

  public getHistory(skillId: string): McSkillRevision[] {
    this.skillRow(skillId);
    return this.database
      .prepare<[string], RevisionRow>(
        "SELECT r.* FROM mc_bot_skill_revisions r WHERE r.skill_id = ? ORDER BY r.version",
      )
      .all(skillId)
      .map((row) => ({
        ...definitionFromRevisionRow(row),
        version: row.version,
        changeKind: row.change_kind as McSkillRevision["changeKind"],
        changeNote: row.change_note,
        createdAt: row.created_at,
      }));
  }

  public createSkill(input: CreateMcSkillInput): McSkillRecord {
    const skill = normalizeSkill({ ...input, id: input.id ?? randomUUID() });
    this.validateOperationRefs(skill.operationRefs);
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      if (this.findSkillRow(skill.id) !== undefined) {
        throw new McSkillRepositoryError(
          "ID_CONFLICT",
          "A skill with this id already exists",
        );
      }
      this.insertSkill(skill, 1, now, now);
      this.insertRevision(skill, 1, "create", "初回登録", now);
    });
    transaction.immediate();
    return this.get(skill.id);
  }

  /**
   * Creates a hypothesis from a stored successful receipt. A learning facade
   * may call this with a model proposal; this method revalidates the receipt,
   * operation reference, and run-level idempotency inside one transaction.
   */
  public createHypothesisFromEvidence(
    input: CreateMcSkillHypothesisInput,
  ): CreateMcSkillHypothesisResult {
    const runId = shortText(input.runId, "runId");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(runId)) {
      throw validationError("runId must be an opaque alphanumeric identifier");
    }
    const transaction = this.database.transaction(() => {
      const receipt = this.database
        .prepare<[string], EvidenceRow>(
          "SELECT * FROM mc_bot_skill_evidence_receipts WHERE run_id = ?",
        )
        .get(runId);
      if (receipt === undefined) {
        throw new McSkillRepositoryError(
          "NOT_FOUND",
          "A trusted evidence receipt for this run was not found",
        );
      }
      if (receipt.observed_outcome !== "successful") {
        throw validationError(
          "Only an observed successful receipt can create a skill hypothesis",
        );
      }
      this.validateReceiptSkillVersion(receipt);

      const existingLink = this.database
        .prepare<[string], DerivedHypothesisRow>(
          "SELECT * FROM mc_bot_skill_derived_hypotheses WHERE run_id = ?",
        )
        .get(runId);
      const existingOutcome = this.database
        .prepare<[string], OutcomeRow>(
          "SELECT * FROM mc_bot_skill_outcomes WHERE run_id = ?",
        )
        .get(runId);
      const expectedOutcomeSkillId =
        receipt.skill_id_at_use ?? existingLink?.skill_id;
      const existingOutcomeMatchesReceipt =
        existingOutcome?.status === "successful" &&
        existingOutcome.evidence_receipt_id === receipt.receipt_id &&
        (expectedOutcomeSkillId === undefined ||
          existingOutcome.skill_id === expectedOutcomeSkillId);
      const reusableOutcome =
        existingLink === undefined &&
        receipt.skill_id_at_use === null &&
        existingOutcomeMatchesReceipt;
      if (
        (existingOutcome !== undefined && !existingOutcomeMatchesReceipt) ||
        (existingLink?.native_outcome_recorded === 1 &&
          !existingOutcomeMatchesReceipt)
      ) {
        throw new McSkillRepositoryError(
          "OUTCOME_CONFLICT",
          "The successful receipt already has a different native outcome attribution",
        );
      }

      const skillId =
        input.input.id ??
        existingLink?.skill_id ??
        (reusableOutcome ? existingOutcome.skill_id : undefined) ??
        randomUUID();
      const skill = normalizeSkill({ ...input.input, id: skillId });
      this.validateOperationRefs(skill.operationRefs);
      if (!skill.operationRefs.includes(receipt.operation_name)) {
        throw validationError(
          "The hypothesis must reference the operation observed in its trusted receipt",
        );
      }
      const skillDigest = definitionDigest(skill);

      if (existingLink !== undefined) {
        if (
          existingLink.skill_id !== skill.id ||
          existingLink.definition_digest !== skillDigest
        ) {
          throw new McSkillRepositoryError(
            "OUTCOME_CONFLICT",
            "This run already produced a different skill hypothesis",
          );
        }
        return {
          skill: this.get(existingLink.skill_id),
          evidenceLink: derivedHypothesisFromRow(existingLink),
          idempotent: true,
        };
      }

      const skillVersion = 1;
      let nativeOutcomeRecorded = false;
      const now = new Date().toISOString();
      if (reusableOutcome) {
        const initialRevision = this.database
          .prepare<[string], RevisionRow>(
            "SELECT * FROM mc_bot_skill_revisions WHERE skill_id = ? AND version = 1",
          )
          .get(skill.id);
        if (
          initialRevision === undefined ||
          definitionDigest(definitionFromRevisionRow(initialRevision)) !==
            skillDigest
        ) {
          throw new McSkillRepositoryError(
            "OUTCOME_CONFLICT",
            "The existing native outcome belongs to a different skill definition",
          );
        }
      } else {
        if (this.findSkillRow(skill.id) !== undefined) {
          throw new McSkillRepositoryError(
            "ID_CONFLICT",
            "A skill with this id already exists",
          );
        }
        this.insertSkill(skill, skillVersion, now, now);
        this.insertRevision(
          skill,
          skillVersion,
          "create",
          "観測済みの成功から仮説を作成",
          now,
        );
        if (receipt.skill_id_at_use === null) {
          this.insertHypothesisNativeOutcome(skill, receipt, now);
          nativeOutcomeRecorded = true;
        }
      }

      this.database
        .prepare(
          "INSERT INTO mc_bot_skill_derived_hypotheses (run_id, receipt_id, skill_id, skill_version, definition_digest, native_outcome_recorded, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          runId,
          receipt.receipt_id,
          skill.id,
          skillVersion,
          skillDigest,
          nativeOutcomeRecorded ? 1 : 0,
          now,
        );
      const storedLink = this.database
        .prepare<[string], DerivedHypothesisRow>(
          "SELECT * FROM mc_bot_skill_derived_hypotheses WHERE run_id = ?",
        )
        .get(runId);
      if (storedLink === undefined) {
        throw new Error("Derived skill hypothesis did not persist");
      }
      return {
        skill: this.get(skill.id),
        evidenceLink: derivedHypothesisFromRow(storedLink),
        idempotent: false,
      };
    });
    return transaction.immediate();
  }

  public revise(input: ReviseMcSkillInput): McSkillRecord {
    const transaction = this.database.transaction(() => {
      const current = this.skillRow(input.skillId);
      if (current.version !== input.expectedVersion) {
        throw versionConflict(input.expectedVersion, current.version);
      }
      if (Object.keys(input.patch).length === 0) {
        throw validationError("A revision must change at least one field");
      }
      const candidate = normalizeSkill({
        ...definitionFromRow(current),
        ...input.patch,
        id: current.id,
      });
      this.validateOperationRefs(candidate.operationRefs);
      const note = shortText(input.changeNote, "changeNote");
      const now = new Date().toISOString();
      const nextVersion = current.version + 1;
      const result = this.database
        .prepare(
          "UPDATE mc_bot_skills SET category = ?, title = ?, purpose = ?, conditions_json = ?, body = ?, operation_refs_json = ?, expected_outcome = ?, confidence = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
        )
        .run(
          candidate.category,
          candidate.title,
          candidate.purpose,
          JSON.stringify(candidate.conditions),
          candidate.body,
          JSON.stringify(candidate.operationRefs),
          candidate.expectedOutcome,
          candidate.confidence,
          nextVersion,
          now,
          candidate.id,
          current.version,
        );
      if (result.changes !== 1) {
        const observed = this.skillRow(candidate.id).version;
        throw versionConflict(input.expectedVersion, observed);
      }
      this.insertRevision(candidate, nextVersion, input.changeKind, note, now);
    });
    transaction.immediate();
    return this.get(input.skillId);
  }

  /**
   * Only game-observation/verification code may call this writer. Never issue
   * a trusted receipt from GPT/model input or expose this method as a GPT tool.
   * Model-proposed outcomes use recordOutcome instead.
   */
  public recordTrustedEvidence(
    input: RecordTrustedMcSkillEvidenceInput,
  ): TrustedMcSkillEvidenceReceipt {
    let normalized = normalizeEvidence(input, this.allowedOperationNames);
    if (normalized.skillIdAtUse !== undefined) {
      const currentSkill = this.skillRow(normalized.skillIdAtUse);
      const skillVersionAtUse =
        normalized.skillVersionAtUse ?? currentSkill.version;
      if (skillVersionAtUse < 1 || skillVersionAtUse > currentSkill.version) {
        throw validationError(
          "skillVersionAtUse must identify an existing skill revision",
        );
      }
      normalized = { ...normalized, skillVersionAtUse };
    }
    const fingerprint = digest(JSON.stringify(normalized));
    const existing = this.database
      .prepare<[string], EvidenceRow>(
        "SELECT * FROM mc_bot_skill_evidence_receipts WHERE run_id = ?",
      )
      .get(normalized.runId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new McSkillRepositoryError(
          "EVIDENCE_CONFLICT",
          "A different trusted receipt already exists for this run",
        );
      }
      return evidenceFromRow(existing);
    }
    const receiptId = randomUUID();
    const receipt: TrustedMcSkillEvidenceReceipt = {
      ...normalized,
      receiptId,
      observedAt: normalized.observedAt ?? new Date().toISOString(),
    };
    this.database
      .prepare(
        "INSERT INTO mc_bot_skill_evidence_receipts (receipt_id, run_id, operation_name, input_summary, conditions_json, expected_outcome, observed_outcome, observation_summary, skill_id_at_use, skill_version_at_use, observed_at, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        receipt.receiptId,
        receipt.runId,
        receipt.operationName,
        receipt.inputSummary,
        JSON.stringify(receipt.conditions),
        receipt.expectedOutcome,
        receipt.observedOutcome,
        receipt.observationSummary,
        receipt.skillIdAtUse ?? null,
        receipt.skillVersionAtUse ?? null,
        receipt.observedAt,
        fingerprint,
      );
    return receipt;
  }

  public recordOutcome(input: RecordMcSkillOutcomeInput): McSkillOutcome {
    const normalized = normalizeOutcomeInput(input);
    const transaction = this.database.transaction(() => {
      const skill = this.skillRow(normalized.skillId);
      const existing = this.database
        .prepare<[string], OutcomeRow>(
          "SELECT * FROM mc_bot_skill_outcomes WHERE run_id = ?",
        )
        .get(normalized.runId);
      if (existing !== undefined) {
        if (
          existing.skill_id !== normalized.skillId ||
          existing.proposed_outcome !== normalized.proposedOutcome ||
          existing.summary !== normalized.summary
        ) {
          throw new McSkillRepositoryError(
            "OUTCOME_CONFLICT",
            "A different outcome already exists for this run",
          );
        }
        return outcomeFromRow(existing);
      }
      const receipt = this.database
        .prepare<[string], EvidenceRow>(
          "SELECT * FROM mc_bot_skill_evidence_receipts WHERE run_id = ?",
        )
        .get(normalized.runId);
      if (
        receipt?.skill_id_at_use !== null &&
        receipt?.skill_id_at_use !== undefined &&
        receipt.skill_id_at_use !== normalized.skillId
      ) {
        throw new McSkillRepositoryError(
          "OUTCOME_CONFLICT",
          "The trusted receipt belongs to a different skill version",
        );
      }
      if (
        receipt?.skill_id_at_use === null &&
        !parseStringArray(skill.operation_refs_json).includes(
          receipt.operation_name,
        )
      ) {
        throw new McSkillRepositoryError(
          "VALIDATION",
          "A learned skill must reference the trusted operation that produced it",
        );
      }
      if (
        receipt?.skill_id_at_use === normalized.skillId &&
        receipt.skill_version_at_use !== null
      ) {
        const usedRevision = this.database
          .prepare<[string, number], { readonly operation_refs_json: string }>(
            "SELECT operation_refs_json FROM mc_bot_skill_revisions WHERE skill_id = ? AND version = ?",
          )
          .get(normalized.skillId, receipt.skill_version_at_use);
        if (
          usedRevision === undefined ||
          !parseStringArray(usedRevision.operation_refs_json).includes(
            receipt.operation_name,
          )
        ) {
          throw new McSkillRepositoryError(
            "OUTCOME_CONFLICT",
            "The trusted receipt operation is absent from the referenced skill revision",
          );
        }
      }
      const status = (receipt?.observed_outcome ??
        "unverified") as McSkillOutcomeStatus;
      const successHypothesis =
        receipt?.observed_outcome === "successful" &&
        this.database
          .prepare<[string], { readonly count: number }>(
            "SELECT COUNT(*) AS count FROM mc_bot_skill_outcomes WHERE skill_id = ? AND success_hypothesis = 1",
          )
          .get(normalized.skillId)?.count === 0;
      const recordedAt = normalized.recordedAt ?? new Date().toISOString();
      this.database
        .prepare(
          "INSERT INTO mc_bot_skill_outcomes (skill_id, run_id, proposed_outcome, status, summary, evidence_receipt_id, skill_version_at_use, success_hypothesis, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          normalized.skillId,
          normalized.runId,
          normalized.proposedOutcome,
          status,
          normalized.summary,
          receipt?.receipt_id ?? null,
          receipt?.skill_id_at_use === normalized.skillId
            ? receipt.skill_version_at_use
            : null,
          successHypothesis ? 1 : 0,
          recordedAt,
        );
      const row = this.database
        .prepare<[string], OutcomeRow>(
          "SELECT * FROM mc_bot_skill_outcomes WHERE run_id = ?",
        )
        .get(normalized.runId);
      if (row === undefined) throw new Error("Outcome insert did not persist");
      return outcomeFromRow(row);
    });
    return transaction.immediate();
  }

  public getEvidence(runId: string): TrustedMcSkillEvidenceReceipt | undefined {
    const row = this.database
      .prepare<[string], EvidenceRow>(
        "SELECT * FROM mc_bot_skill_evidence_receipts WHERE run_id = ?",
      )
      .get(runId);
    return row === undefined ? undefined : evidenceFromRow(row);
  }

  public listDerivedHypotheses(
    skillId: string,
    limit = 50,
  ): McSkillHypothesisEvidenceLink[] {
    this.skillRow(skillId);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      throw validationError(
        `Hypothesis limit must be from 1 to ${MAX_SEARCH_LIMIT}`,
      );
    }
    return this.database
      .prepare<[string, number], DerivedHypothesisRow>(
        "SELECT * FROM mc_bot_skill_derived_hypotheses WHERE skill_id = ? ORDER BY created_at DESC, run_id DESC LIMIT ?",
      )
      .all(skillId, limit)
      .map(derivedHypothesisFromRow);
  }

  public listOutcomes(skillId: string, limit = 50): McSkillOutcome[] {
    this.skillRow(skillId);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      throw validationError(
        `Outcome limit must be from 1 to ${MAX_SEARCH_LIMIT}`,
      );
    }
    return this.database
      .prepare<[string, number], OutcomeRow>(
        "SELECT * FROM mc_bot_skill_outcomes WHERE skill_id = ? ORDER BY recorded_at DESC, run_id DESC LIMIT ?",
      )
      .all(skillId, limit)
      .map(outcomeFromRow);
  }

  public exportSkill(
    skillId: string,
    requestedFileName?: string,
  ): ExportedMcSkillResult {
    const skill = this.get(skillId);
    const fileName = safeFileName(requestedFileName ?? `${skill.id}.md`);
    const content = formatExchangeDocument(
      skill,
      nativeStatisticsFromRecord(skill),
      this.repositoryOrigin,
    );
    const target = this.exchangePath(fileName, true);
    const temporaryPath = resolve(
      this.exchangeDirectory,
      `.mc-skill-${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      this.assertExchangeDirectory();
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, content, { encoding: "utf8" });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.assertExchangeDirectory();
      renameSync(temporaryPath, target);
      this.assertContainedRegularFile(target);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      if (error instanceof McSkillRepositoryError) throw error;
      throw new McSkillRepositoryError(
        "UNSAFE_EXCHANGE_PATH",
        "Could not safely write the exchange file",
      );
    }
    return { fileName, path: target, content };
  }

  public importSkill(fileName: string): ImportedMcSkillResult {
    const target = this.exchangePath(fileName, false);
    let content: string;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const fileStat = fstatSync(descriptor);
      if (!fileStat.isFile()) {
        throw new McSkillRepositoryError(
          "UNSAFE_EXCHANGE_PATH",
          "The exchange entry must be a file",
        );
      }
      if (fileStat.size > MAX_EXCHANGE_FILE_BYTES) {
        throw new McSkillRepositoryError(
          "IMPORT_INVALID",
          "The exchange file exceeds its resource limit",
        );
      }
      content = readFileSync(descriptor, "utf8");
    } catch (error) {
      if (error instanceof McSkillRepositoryError) throw error;
      throw new McSkillRepositoryError(
        "UNSAFE_EXCHANGE_PATH",
        "Could not safely read the exchange file",
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    const parsed = parseExchangeDocument(content);
    this.validateOperationRefs(parsed.metadata.skill.operationRefs);
    const metadata = parsed.metadata;
    const fingerprint = digest(JSON.stringify(metadata));
    const importKey = `${metadata.skill.id}:${metadata.sourceVersion}`;
    const transaction = this.database.transaction(() => {
      const previousImport = this.database
        .prepare<[string], ImportReceiptRow>(
          "SELECT * FROM mc_bot_skill_import_receipts WHERE import_key = ?",
        )
        .get(importKey);
      if (previousImport?.fingerprint === fingerprint) {
        const existingSkill = this.get(metadata.skill.id);
        return {
          skill: existingSkill,
          idempotent: true,
          importedStatistics: {
            sourceSkillId: metadata.skill.id,
            sourceVersion: metadata.sourceVersion,
            ...metadata.statistics.native,
            provenance: metadata.provenance,
          },
        };
      }
      const current = this.findSkillRow(metadata.skill.id);
      if (current === undefined) {
        const imported = normalizeSkill(metadata.skill);
        const now = new Date().toISOString();
        this.insertSkill(imported, metadata.sourceVersion, now, now);
        this.insertRevision(
          imported,
          metadata.sourceVersion,
          "import",
          `Markdown import from ${metadata.provenance}`,
          now,
        );
      } else {
        if (current.version !== metadata.sourceVersion) {
          throw versionConflict(metadata.sourceVersion, current.version);
        }
        const currentDefinition = definitionFromRow(current);
        if (definitionDigest(currentDefinition) !== metadata.baseDigest) {
          throw new McSkillRepositoryError(
            "VERSION_CONFLICT",
            "The imported base does not match the current skill revision",
          );
        }
        const incoming = normalizeSkill(metadata.skill);
        if (
          definitionDigest(currentDefinition) !== definitionDigest(incoming)
        ) {
          const now = new Date().toISOString();
          const nextVersion = current.version + 1;
          this.updateSkill(incoming, current.version, nextVersion, now);
          this.insertRevision(
            incoming,
            nextVersion,
            "import",
            `Markdown import from ${metadata.provenance}`,
            now,
          );
        }
      }
      this.upsertImportedStatistics(
        importedStatisticsKey(
          metadata.skill.id,
          metadata.skill.id,
          metadata.sourceVersion,
          metadata.provenance,
        ),
        metadata.skill.id,
        metadata.skill.id,
        metadata.sourceVersion,
        metadata.statistics.native,
        metadata.provenance,
      );
      for (const imported of metadata.statistics.imported) {
        this.upsertImportedStatistics(
          importedStatisticsKey(
            metadata.skill.id,
            imported.sourceSkillId,
            imported.sourceVersion,
            imported.provenance,
          ),
          metadata.skill.id,
          imported.sourceSkillId,
          imported.sourceVersion,
          imported,
          imported.provenance,
        );
      }
      const importRow = this.database
        .prepare<[string], ImportRow>(
          "SELECT * FROM mc_bot_skill_import_statistics WHERE source_key = ?",
        )
        .get(
          importedStatisticsKey(
            metadata.skill.id,
            metadata.skill.id,
            metadata.sourceVersion,
            metadata.provenance,
          ),
        );
      if (importRow === undefined)
        throw new Error("Skill import statistics did not persist");
      this.database
        .prepare(
          "INSERT INTO mc_bot_skill_import_receipts (import_key, skill_id, fingerprint) VALUES (?, ?, ?) ON CONFLICT(import_key) DO UPDATE SET fingerprint = excluded.fingerprint",
        )
        .run(importKey, metadata.skill.id, fingerprint);
      return {
        skill: this.get(metadata.skill.id),
        idempotent: false,
        importedStatistics: importedStatisticsFromRow(importRow),
      };
    });
    try {
      return transaction.immediate();
    } catch (error) {
      if (error instanceof McSkillRepositoryError) throw error;
      if (isUniqueConstraintError(error)) {
        throw new McSkillRepositoryError(
          "ID_CONFLICT",
          "The imported skill or run identity conflicts with an existing record",
        );
      }
      throw error;
    }
  }

  private seedInitialSkills(): void {
    this.database.exec(schemaSql);
    const transaction = this.database.transaction(() => {
      for (const seed of initialSkills) {
        if (this.findSkillRow(seed.id) !== undefined) continue;
        const now = new Date().toISOString();
        this.insertSkill(seed, 1, now, now);
        this.insertRevision(seed, 1, "create", "初期Skill", now);
      }
    });
    transaction.immediate();
  }

  private ensureRepositoryOrigin(): string {
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          "INSERT OR IGNORE INTO mc_bot_skill_repository_metadata (metadata_key, metadata_value) VALUES ('repository_origin', ?)",
        )
        .run(randomUUID());
      const row = this.database
        .prepare<[], { readonly metadata_value: string }>(
          "SELECT metadata_value FROM mc_bot_skill_repository_metadata WHERE metadata_key = 'repository_origin'",
        )
        .get();
      if (
        row === undefined ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
          row.metadata_value,
        )
      ) {
        throw new Error("Skill repository origin metadata is invalid");
      }
      return row.metadata_value;
    });
    return transaction.immediate();
  }

  private upsertImportedStatistics(
    sourceKey: string,
    skillId: string,
    sourceSkillId: string,
    sourceVersion: number,
    statistics: McSkillStatistics,
    provenance: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO mc_bot_skill_import_statistics (source_key, skill_id, source_skill_id, source_version, successful, failed, interrupted, cancelled, unverified, provenance, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_key) DO UPDATE SET successful = excluded.successful, failed = excluded.failed, interrupted = excluded.interrupted, cancelled = excluded.cancelled, unverified = excluded.unverified, provenance = excluded.provenance, imported_at = excluded.imported_at",
      )
      .run(
        sourceKey,
        skillId,
        sourceSkillId,
        sourceVersion,
        statistics.successful,
        statistics.failed,
        statistics.interrupted,
        statistics.cancelled,
        statistics.unverified,
        provenance,
        new Date().toISOString(),
      );
  }

  private insertSkill(
    skill: McSkillDefinition,
    version: number,
    createdAt: string,
    updatedAt: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO mc_bot_skills (id, category, title, purpose, conditions_json, body, operation_refs_json, expected_outcome, confidence, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        skill.id,
        skill.category,
        skill.title,
        skill.purpose,
        JSON.stringify(skill.conditions),
        skill.body,
        JSON.stringify(skill.operationRefs),
        skill.expectedOutcome,
        skill.confidence,
        version,
        createdAt,
        updatedAt,
      );
  }

  private insertRevision(
    skill: McSkillDefinition,
    version: number,
    changeKind: McSkillRevision["changeKind"],
    changeNote: string,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO mc_bot_skill_revisions (skill_id, version, category, title, purpose, conditions_json, body, operation_refs_json, expected_outcome, confidence, change_kind, change_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        skill.id,
        version,
        skill.category,
        skill.title,
        skill.purpose,
        JSON.stringify(skill.conditions),
        skill.body,
        JSON.stringify(skill.operationRefs),
        skill.expectedOutcome,
        skill.confidence,
        changeKind,
        changeNote,
        createdAt,
      );
  }

  private updateSkill(
    skill: McSkillDefinition,
    expectedVersion: number,
    version: number,
    updatedAt: string,
  ): void {
    const update = this.database
      .prepare(
        "UPDATE mc_bot_skills SET category = ?, title = ?, purpose = ?, conditions_json = ?, body = ?, operation_refs_json = ?, expected_outcome = ?, confidence = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?",
      )
      .run(
        skill.category,
        skill.title,
        skill.purpose,
        JSON.stringify(skill.conditions),
        skill.body,
        JSON.stringify(skill.operationRefs),
        skill.expectedOutcome,
        skill.confidence,
        version,
        updatedAt,
        skill.id,
        expectedVersion,
      );
    if (update.changes !== 1) {
      const observed = this.skillRow(skill.id).version;
      throw versionConflict(expectedVersion, observed);
    }
  }

  private skillRow(skillId: string): SkillRow {
    const row = this.findSkillRow(skillId);
    if (row === undefined) {
      throw new McSkillRepositoryError(
        "NOT_FOUND",
        `Skill ${skillId} was not found`,
      );
    }
    return row;
  }

  private findSkillRow(skillId: string): SkillRow | undefined {
    return this.database
      .prepare<[string], SkillRow>("SELECT * FROM mc_bot_skills WHERE id = ?")
      .get(skillId);
  }

  private statistics(skillId: string): McSkillStatistics {
    const counts = this.database
      .prepare<[string], OutcomeCountRow>(
        "SELECT status, COUNT(*) AS count FROM mc_bot_skill_outcomes WHERE skill_id = ? GROUP BY status",
      )
      .all(skillId);
    const values = new Map(counts.map(({ status, count }) => [status, count]));
    return {
      successful: values.get("successful") ?? 0,
      failed: values.get("failed") ?? 0,
      interrupted: values.get("interrupted") ?? 0,
      cancelled: values.get("cancelled") ?? 0,
      unverified: values.get("unverified") ?? 0,
    };
  }

  private importedStatistics(skillId: string): ImportedMcSkillStatistics[] {
    return this.database
      .prepare<[string], ImportRow>(
        "SELECT * FROM mc_bot_skill_import_statistics WHERE skill_id = ? ORDER BY imported_at, source_key",
      )
      .all(skillId)
      .map(importedStatisticsFromRow);
  }

  private validateOperationRefs(operationRefs: readonly string[]): void {
    const unknown = operationRefs.filter(
      (name) => !this.allowedOperationNames.has(name),
    );
    if (unknown.length > 0) {
      throw validationError(`Unknown operation reference: ${unknown[0]}`);
    }
  }

  private validateReceiptSkillVersion(receipt: EvidenceRow): void {
    if (receipt.skill_id_at_use === null) return;
    if (receipt.skill_version_at_use === null) {
      throw new McSkillRepositoryError(
        "OUTCOME_CONFLICT",
        "The trusted receipt does not identify the skill version used",
      );
    }
    const revision = this.database
      .prepare<[string, number], { readonly operation_refs_json: string }>(
        "SELECT operation_refs_json FROM mc_bot_skill_revisions WHERE skill_id = ? AND version = ?",
      )
      .get(receipt.skill_id_at_use, receipt.skill_version_at_use);
    if (
      revision === undefined ||
      !parseStringArray(revision.operation_refs_json).includes(
        receipt.operation_name,
      )
    ) {
      throw new McSkillRepositoryError(
        "OUTCOME_CONFLICT",
        "The trusted operation is absent from the referenced skill revision",
      );
    }
  }

  private insertHypothesisNativeOutcome(
    skill: McSkillDefinition,
    receipt: EvidenceRow,
    recordedAt: string,
  ): void {
    this.database
      .prepare(
        "INSERT INTO mc_bot_skill_outcomes (skill_id, run_id, proposed_outcome, status, summary, evidence_receipt_id, skill_version_at_use, success_hypothesis, recorded_at) VALUES (?, ?, 'successful', 'successful', ?, ?, NULL, 1, ?)",
      )
      .run(
        skill.id,
        receipt.run_id,
        "観測済み成功から初回Skill仮説を作成",
        receipt.receipt_id,
        recordedAt,
      );
  }

  private exchangePath(fileName: string, allowMissing: boolean): string {
    this.assertExchangeDirectory();
    const safeName = safeFileName(fileName);
    const target = resolve(this.exchangeDirectory, safeName);
    if (dirname(target) !== this.exchangeDirectory) {
      throw new McSkillRepositoryError(
        "UNSAFE_EXCHANGE_PATH",
        "Exchange path escapes its directory",
      );
    }
    try {
      const entry = lstatSync(target);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new McSkillRepositoryError(
          "UNSAFE_EXCHANGE_PATH",
          "Exchange entries must be regular files without symlinks",
        );
      }
      this.assertContainedRegularFile(target);
    } catch (error) {
      if (error instanceof McSkillRepositoryError) throw error;
      if (isNodeError(error) && error.code === "ENOENT" && allowMissing)
        return target;
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new McSkillRepositoryError(
          "NOT_FOUND",
          "The exchange file was not found",
        );
      }
      throw new McSkillRepositoryError(
        "UNSAFE_EXCHANGE_PATH",
        "Could not inspect the exchange path",
      );
    }
    return target;
  }

  private assertExchangeDirectory(): void {
    try {
      const currentPath = realpathSync(this.exchangeDirectory);
      if (
        currentPath !== this.exchangeDirectory ||
        !statSync(currentPath).isDirectory()
      ) {
        throw new McSkillRepositoryError(
          "UNSAFE_EXCHANGE_PATH",
          "The configured exchange directory changed after it was opened",
        );
      }
    } catch (error) {
      if (error instanceof McSkillRepositoryError) throw error;
      throw new McSkillRepositoryError(
        "UNSAFE_EXCHANGE_PATH",
        "The configured exchange directory is no longer available",
      );
    }
  }

  private assertContainedRegularFile(target: string): void {
    const entry = lstatSync(target);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new McSkillRepositoryError(
        "UNSAFE_EXCHANGE_PATH",
        "Exchange entries must be regular files without symlinks",
      );
    }
    const canonical = realpathSync(target);
    const pathFromRoot = relative(this.exchangeDirectory, canonical);
    if (
      pathFromRoot === "" ||
      pathFromRoot === ".." ||
      pathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathFromRoot)
    ) {
      throw new McSkillRepositoryError(
        "UNSAFE_EXCHANGE_PATH",
        "Exchange file escapes its directory",
      );
    }
    if (!statSync(canonical).isFile()) {
      throw new McSkillRepositoryError(
        "UNSAFE_EXCHANGE_PATH",
        "Exchange entry is not a regular file",
      );
    }
  }
}

function normalizeSkill(skill: McSkillDefinition): McSkillDefinition {
  const parsed = skillRecordSchema.safeParse({
    id: skill.id,
    category: skill.category,
    title: skill.title,
    purpose: skill.purpose,
    conditions: [...skill.conditions],
    body: skill.body,
    operationRefs: [...new Set(skill.operationRefs)],
    expectedOutcome: skill.expectedOutcome,
    confidence: skill.confidence,
  });
  if (!parsed.success) {
    throw validationError("Skill fields do not match the supported schema");
  }
  if (
    /[\r\n]/u.test(parsed.data.title) ||
    Buffer.byteLength(JSON.stringify(parsed.data), "utf8") >
      MAX_SKILL_PAYLOAD_BYTES
  ) {
    throw validationError(
      "Skill content exceeds its resource limit or has a multi-line title",
    );
  }
  return parsed.data;
}

function normalizeEvidence(
  input: RecordTrustedMcSkillEvidenceInput,
  allowedOperationNames: ReadonlySet<string>,
): RecordTrustedMcSkillEvidenceInput {
  const runId = shortText(input.runId, "runId");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(runId)) {
    throw validationError("runId must be an opaque alphanumeric identifier");
  }
  if (!allowedOperationNames.has(input.operationName)) {
    throw validationError(
      "Evidence operation is not in the configured allowlist",
    );
  }
  if (
    input.skillVersionAtUse !== undefined &&
    input.skillIdAtUse === undefined
  ) {
    throw validationError("skillVersionAtUse requires skillIdAtUse");
  }
  if (
    input.skillVersionAtUse !== undefined &&
    !Number.isInteger(input.skillVersionAtUse)
  ) {
    throw validationError("skillVersionAtUse must be an integer");
  }
  const normalized: RecordTrustedMcSkillEvidenceInput = {
    runId,
    operationName: input.operationName,
    inputSummary: shortText(input.inputSummary, "inputSummary"),
    conditions: normalizeConditions(input.conditions),
    expectedOutcome: shortText(input.expectedOutcome, "expectedOutcome"),
    observedOutcome: enumValue(
      input.observedOutcome,
      mcSkillOutcomeStatuses,
      "observedOutcome",
    ),
    observationSummary: shortText(
      input.observationSummary,
      "observationSummary",
    ),
    ...(input.skillIdAtUse === undefined
      ? {}
      : { skillIdAtUse: input.skillIdAtUse }),
    ...(input.skillVersionAtUse === undefined
      ? {}
      : { skillVersionAtUse: input.skillVersionAtUse }),
    ...(input.observedAt === undefined
      ? {}
      : { observedAt: isoDate(input.observedAt, "observedAt") }),
  };
  if (
    Buffer.byteLength(JSON.stringify(normalized), "utf8") >
    MAX_EVIDENCE_PAYLOAD_BYTES
  ) {
    throw validationError("Evidence content exceeds its resource limit");
  }
  return normalized;
}

function normalizeOutcomeInput(
  input: RecordMcSkillOutcomeInput,
): RecordMcSkillOutcomeInput & { readonly summary: string } {
  const runId = shortText(input.runId, "runId");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(runId)) {
    throw validationError("runId must be an opaque alphanumeric identifier");
  }
  const normalized = {
    skillId: input.skillId,
    runId,
    proposedOutcome: enumValue(
      input.proposedOutcome,
      mcSkillOutcomeStatuses,
      "proposedOutcome",
    ),
    summary:
      input.summary === undefined ? "" : shortText(input.summary, "summary"),
    ...(input.recordedAt === undefined
      ? {}
      : { recordedAt: isoDate(input.recordedAt, "recordedAt") }),
  };
  if (
    Buffer.byteLength(JSON.stringify(normalized), "utf8") >
    MAX_EVIDENCE_PAYLOAD_BYTES
  ) {
    throw validationError("Outcome content exceeds its resource limit");
  }
  return normalized;
}

function normalizeConditions(conditions: readonly string[]): string[] {
  if (!Array.isArray(conditions))
    throw validationError("conditions must be an array");
  return conditions.map((condition: unknown) => {
    if (typeof condition !== "string") {
      throw validationError("condition must be text");
    }
    return shortText(condition, "condition");
  });
}

function shortText(value: string, field: string): string {
  if (typeof value !== "string") throw validationError(`${field} must be text`);
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw validationError(`${field} must contain text`);
  }
  return normalized;
}

function isoDate(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw validationError(`${field} must be a date`);
  return parsed.toISOString();
}

function enumValue<T extends readonly string[]>(
  value: string,
  allowed: T,
  field: string,
): T[number] {
  const matched = allowed.find((candidate) => candidate === value);
  if (matched === undefined) throw validationError(`${field} is not supported`);
  return matched;
}

function definitionFromRow(row: SkillRow): McSkillDefinition {
  return {
    id: row.id,
    category: row.category as McSkillCategory,
    title: row.title,
    purpose: row.purpose,
    conditions: parseStringArray(row.conditions_json),
    body: row.body,
    operationRefs: parseStringArray(row.operation_refs_json),
    expectedOutcome: row.expected_outcome,
    confidence: row.confidence,
  };
}

function definitionFromRevisionRow(row: RevisionRow): McSkillDefinition {
  return {
    id: row.skill_id,
    category: row.category as McSkillCategory,
    title: row.title,
    purpose: row.purpose,
    conditions: parseStringArray(row.conditions_json),
    body: row.body,
    operationRefs: parseStringArray(row.operation_refs_json),
    expectedOutcome: row.expected_outcome,
    confidence: row.confidence,
  };
}

function parseStringArray(source: string): string[] {
  const parsed: unknown = JSON.parse(source);
  return z.array(z.string()).parse(parsed);
}

function outcomeFromRow(row: OutcomeRow): McSkillOutcome {
  return {
    skillId: row.skill_id,
    runId: row.run_id,
    proposedOutcome: row.proposed_outcome as McSkillOutcomeStatus,
    status: row.status as McSkillOutcomeStatus,
    summary: row.summary,
    ...(row.evidence_receipt_id === null
      ? {}
      : { evidenceReceiptId: row.evidence_receipt_id }),
    ...(row.skill_version_at_use === null
      ? {}
      : { skillVersionAtUse: row.skill_version_at_use }),
    successHypothesis: row.success_hypothesis === 1,
    recordedAt: row.recorded_at,
  };
}

function derivedHypothesisFromRow(
  row: DerivedHypothesisRow,
): McSkillHypothesisEvidenceLink {
  return {
    runId: row.run_id,
    receiptId: row.receipt_id,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    nativeOutcomeRecorded: row.native_outcome_recorded === 1,
    createdAt: row.created_at,
  };
}

function evidenceFromRow(row: EvidenceRow): TrustedMcSkillEvidenceReceipt {
  return {
    receiptId: row.receipt_id,
    runId: row.run_id,
    operationName: row.operation_name,
    inputSummary: row.input_summary,
    conditions: parseStringArray(row.conditions_json),
    expectedOutcome: row.expected_outcome,
    observedOutcome: row.observed_outcome as McSkillOutcomeStatus,
    observationSummary: row.observation_summary,
    ...(row.skill_id_at_use === null
      ? {}
      : { skillIdAtUse: row.skill_id_at_use }),
    ...(row.skill_version_at_use === null
      ? {}
      : { skillVersionAtUse: row.skill_version_at_use }),
    observedAt: row.observed_at,
  };
}

function importedStatisticsFromRow(row: ImportRow): ImportedMcSkillStatistics {
  return {
    sourceSkillId: row.source_skill_id,
    sourceVersion: row.source_version,
    successful: row.successful,
    failed: row.failed,
    interrupted: row.interrupted,
    cancelled: row.cancelled,
    unverified: row.unverified,
    provenance: row.provenance,
  };
}

function nativeStatisticsFromRecord(skill: McSkillRecord): McSkillStatistics {
  return skill.nativeStatistics;
}

function definitionDigest(definition: McSkillDefinition): string {
  return digest(JSON.stringify(definition));
}

function importedStatisticsKey(
  targetSkillId: string,
  sourceSkillId: string,
  sourceVersion: number,
  provenance: string,
): string {
  return digest(
    JSON.stringify([targetSkillId, sourceSkillId, sourceVersion, provenance]),
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function formatExchangeDocument(
  skill: McSkillRecord,
  statistics: McSkillStatistics,
  repositoryOrigin: string,
): string {
  const definition: McSkillDefinition = {
    id: skill.id,
    category: skill.category,
    title: skill.title,
    purpose: skill.purpose,
    conditions: skill.conditions,
    body: skill.body,
    operationRefs: skill.operationRefs,
    expectedOutcome: skill.expectedOutcome,
    confidence: skill.confidence,
  };
  const metadata: ExchangeMetadata = {
    kind: "mc-bot-skill",
    schemaVersion: EXCHANGE_SCHEMA_VERSION,
    sourceVersion: skill.version,
    baseDigest: definitionDigest(definition),
    skill: definition,
    statistics: { native: statistics, imported: skill.importedStatistics },
    provenance: `mc-bot-skill repository:${repositoryOrigin}`,
  };
  const { body: _body, ...metadataSkill } = definition;
  const serializedMetadata = { ...metadata, skill: metadataSkill };
  const content = [
    `# ${skill.title}`,
    "",
    "```mc-bot-skill",
    JSON.stringify(serializedMetadata, null, 2),
    "```",
    "",
    "## 本文",
    skill.body,
    "",
  ].join("\n");
  if (Buffer.byteLength(content, "utf8") > MAX_EXCHANGE_FILE_BYTES) {
    throw validationError("The skill export exceeds its resource limit");
  }
  return content;
}

function parseExchangeDocument(content: string): {
  metadata: ExchangeMetadata;
} {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const match =
    /^# ([^\n]+)\n\n```mc-bot-skill\n([\s\S]*?)\n```\n\n## 本文\n([\s\S]*?)\n?$/u.exec(
      normalized,
    );
  if (match === null) {
    throw new McSkillRepositoryError(
      "IMPORT_INVALID",
      "Markdown must contain one mc-bot-skill metadata fence and a body section",
    );
  }
  if (match[2] === undefined || match[3] === undefined) {
    throw new McSkillRepositoryError(
      "IMPORT_INVALID",
      "Markdown must contain one mc-bot-skill metadata fence and a body section",
    );
  }
  let rawMetadata: unknown;
  try {
    rawMetadata = JSON.parse(match[2]);
  } catch {
    throw new McSkillRepositoryError(
      "IMPORT_INVALID",
      "Skill metadata is not valid JSON",
    );
  }
  const body = match[3].replace(/\n$/u, "");
  const metadataWithBody =
    rawMetadata !== null &&
    typeof rawMetadata === "object" &&
    !Array.isArray(rawMetadata)
      ? {
          ...(rawMetadata as Record<string, unknown>),
          skill: {
            ...((rawMetadata as Record<string, unknown>).skill as Record<
              string,
              unknown
            >),
            body,
          },
        }
      : rawMetadata;
  const parsed = exchangeMetadataSchema.safeParse(metadataWithBody);
  if (!parsed.success || parsed.data.skill.title !== match[1]) {
    throw new McSkillRepositoryError(
      "IMPORT_INVALID",
      "Skill metadata, heading, schema version, or body is invalid",
    );
  }
  return { metadata: parsed.data };
}

function safeFileName(fileName: string): string {
  if (
    typeof fileName !== "string" ||
    fileName.length < 4 ||
    fileName.length > 160 ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    // eslint-disable-next-line no-control-regex -- Reject control characters in exchanged filenames.
    /[\u0000-\u001f\u007f]/u.test(fileName) ||
    !fileName.toLocaleLowerCase("en-US").endsWith(".md") ||
    fileName !== fileName.trim()
  ) {
    throw new McSkillRepositoryError(
      "UNSAFE_EXCHANGE_PATH",
      "Use a plain Markdown filename inside the configured exchange directory",
    );
  }
  return fileName;
}

function validationError(message: string): McSkillRepositoryError {
  return new McSkillRepositoryError("VALIDATION", message);
}

function versionConflict(
  expected: number,
  actual: number,
): McSkillRepositoryError {
  return new McSkillRepositoryError(
    "VERSION_CONFLICT",
    `Skill version conflict: expected ${expected}, current ${actual}`,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("UNIQUE constraint failed")
  );
}
