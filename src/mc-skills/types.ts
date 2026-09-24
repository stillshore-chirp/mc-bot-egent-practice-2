export const mcSkillCategories = [
  "survival",
  "exploration",
  "combat",
  "gathering",
  "crafting",
  "building",
  "navigation",
] as const;
export type McSkillCategory = (typeof mcSkillCategories)[number];

export const mcSkillOutcomeStatuses = [
  "successful",
  "failed",
  "interrupted",
  "cancelled",
  "unverified",
] as const;
export type McSkillOutcomeStatus = (typeof mcSkillOutcomeStatuses)[number];

export interface McSkillDefinition {
  readonly id: string;
  readonly category: McSkillCategory;
  readonly title: string;
  readonly purpose: string;
  readonly conditions: readonly string[];
  readonly body: string;
  readonly operationRefs: readonly string[];
  readonly expectedOutcome: string;
  readonly confidence: number;
}

export interface McSkillRecord extends McSkillDefinition {
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nativeStatistics: McSkillStatistics;
  readonly importedStatistics: readonly ImportedMcSkillStatistics[];
}

export interface McSkillSummary {
  readonly id: string;
  readonly category: McSkillCategory;
  readonly title: string;
  readonly summary: string;
  readonly operationRefs: readonly string[];
  readonly confidence: number;
  readonly version: number;
  readonly successfulRuns: number;
}

export interface McSkillStatistics {
  readonly successful: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly cancelled: number;
  readonly unverified: number;
}

export interface ImportedMcSkillStatistics extends McSkillStatistics {
  readonly sourceSkillId: string;
  readonly sourceVersion: number;
  readonly provenance: string;
}

export interface CreateMcSkillInput extends Omit<McSkillDefinition, "id"> {
  readonly id?: string;
}

export interface CreateMcSkillHypothesisInput {
  readonly runId: string;
  readonly input: CreateMcSkillInput;
}

export interface McSkillHypothesisEvidenceLink {
  readonly runId: string;
  readonly receiptId: string;
  readonly skillId: string;
  readonly skillVersion: number;
  /** True only when this call atomically recorded the run as the new skill's first native success. */
  readonly nativeOutcomeRecorded: boolean;
  readonly createdAt: string;
}

export interface CreateMcSkillHypothesisResult {
  readonly skill: McSkillRecord;
  readonly evidenceLink: McSkillHypothesisEvidenceLink;
  readonly idempotent: boolean;
}

export interface ReviseMcSkillInput {
  readonly skillId: string;
  readonly expectedVersion: number;
  readonly changeKind: "revise" | "merge" | "weaken";
  readonly changeNote: string;
  readonly patch: Partial<Omit<McSkillDefinition, "id">>;
}

export interface McSkillRevision extends McSkillDefinition {
  readonly version: number;
  readonly changeKind: "create" | "revise" | "merge" | "weaken" | "import";
  readonly changeNote: string;
  readonly createdAt: string;
}

export interface RecordTrustedMcSkillEvidenceInput {
  readonly runId: string;
  readonly operationName: string;
  readonly inputSummary: string;
  readonly conditions: readonly string[];
  readonly expectedOutcome: string;
  readonly observedOutcome: McSkillOutcomeStatus;
  readonly observationSummary: string;
  readonly skillIdAtUse?: string;
  readonly skillVersionAtUse?: number;
  readonly observedAt?: string;
}

export interface TrustedMcSkillEvidenceReceipt extends RecordTrustedMcSkillEvidenceInput {
  readonly receiptId: string;
  readonly observedAt: string;
}

export interface RecordMcSkillOutcomeInput {
  readonly skillId: string;
  readonly runId: string;
  /** This is an untrusted proposal unless a matching trusted receipt exists. */
  readonly proposedOutcome: McSkillOutcomeStatus;
  readonly summary?: string;
  readonly recordedAt?: string;
}

export interface McSkillOutcome {
  readonly skillId: string;
  readonly runId: string;
  readonly proposedOutcome: McSkillOutcomeStatus;
  readonly status: McSkillOutcomeStatus;
  readonly summary: string;
  readonly evidenceReceiptId?: string;
  readonly skillVersionAtUse?: number;
  readonly successHypothesis: boolean;
  readonly recordedAt: string;
}

export interface McSkillRepositoryOptions {
  readonly databasePath: string;
  readonly exchangeDirectory: string;
  /** Names of operations that imports may reference. */
  readonly allowedOperationNames: readonly string[];
}

export interface SearchMcSkillsOptions {
  readonly query?: string;
  readonly categories?: readonly McSkillCategory[];
  readonly limit?: number;
}

export interface ExportedMcSkillResult {
  readonly fileName: string;
  readonly path: string;
  readonly content: string;
}

export interface ImportedMcSkillResult {
  readonly skill: McSkillRecord;
  readonly idempotent: boolean;
  readonly importedStatistics: ImportedMcSkillStatistics;
}
