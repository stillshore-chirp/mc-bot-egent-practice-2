import { readFileSync } from "node:fs";

import { z } from "zod";

import type { JsonValue } from "../memory/types.js";

const MAX_PERSONA_TEXT = 1_000;
const SECRET_LABEL =
  /(?:^|[\s_:=,-])(api[\s_-]?key|authorization|bearer|password|private[\s_-]?key|secret)(?:$|[\s_:=,-])/iu;
const SECRET_VALUE =
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u;

const personaText = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PERSONA_TEXT)
  .refine((value) => !SECRET_LABEL.test(value) && !SECRET_VALUE.test(value), {
    message: "must not contain credentials or secrets",
  });

export const personaCoreSchema = z
  .object({
    version: z.union([
      z.string().trim().min(1).max(80),
      z.number().int().positive(),
    ]),
    name: personaText.max(80),
    speakingStyle: personaText,
    values: z.array(personaText.max(240)).min(1).max(20),
    operatingPrinciples: z.array(personaText.max(400)).min(1).max(30),
    prohibitions: z.array(personaText.max(400)).min(1).max(30),
  })
  .strict();

export type PersonaCore = z.infer<typeof personaCoreSchema>;

export interface PersonaFactContext {
  readonly subject: string;
  readonly predicate: string;
  readonly value: JsonValue;
  readonly source:
    "player_stated" | "minecraft_observed" | "bot_inferred" | "system";
}

export interface PersonaLocationContext {
  readonly name: string;
  readonly purpose: string;
  readonly dimension: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PersonaCommitmentContext {
  readonly description: string;
  readonly status: "active" | "completed" | "cancelled";
}

export interface PersonaTaskContext {
  readonly kind: string;
  readonly phase: string;
  readonly status:
    "queued" | "running" | "suspended" | "completed" | "failed" | "cancelled";
}

/**
 * This intentionally has no message, transcript, or arbitrary prompt field.
 * Conversation input is handled by the agent layer; persona context receives
 * only selected structured state.
 */
export interface PersonaContext {
  readonly playerName?: string;
  readonly relationshipSummary?: string;
  readonly facts?: readonly PersonaFactContext[];
  readonly locations?: readonly PersonaLocationContext[];
  readonly commitments?: readonly PersonaCommitmentContext[];
  readonly currentTask?: PersonaTaskContext;
}

export class PersonaValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PersonaValidationError";
  }
}

export function loadPersona(path: string): PersonaCore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new PersonaValidationError(
      "Persona JSON could not be read or parsed.",
    );
  }
  const result = personaCoreSchema.safeParse(parsed);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => (issue.path.length === 0 ? "root" : issue.path.join(".")))
      .join(", ");
    throw new PersonaValidationError(
      "Persona JSON does not match the required schema: " + fields,
    );
  }
  return result.data;
}

export function buildPersonaContext(
  core: PersonaCore,
  context: PersonaContext = {},
): string {
  const lines = [
    "あなたは" + core.name + "です。",
    "話し方: " + core.speakingStyle,
    "価値観:",
    ...bulletLines(core.values),
    "基本方針:",
    ...bulletLines(core.operatingPrinciples),
    "禁止事項:",
    ...bulletLines(core.prohibitions),
    "実行していない行動や確認していないMinecraft上の結果を、完了済みとして発言しないでください。",
    "停止・安全・権限の境界は会話の推論で迂回しないでください。",
  ];

  if (context.playerName !== undefined) {
    lines.push(
      "現在対話している利用者: " +
        contextText(context.playerName, "player name", 80),
    );
  }
  if (context.relationshipSummary !== undefined) {
    lines.push(
      "関係状態: " +
        contextText(context.relationshipSummary, "relationship summary", 400),
    );
  }
  appendFacts(lines, context.facts);
  appendLocations(lines, context.locations);
  appendCommitments(lines, context.commitments);
  appendTask(lines, context.currentTask);
  return lines.join("\n");
}

function bulletLines(items: readonly string[]): string[] {
  return items.map((item) => "- " + item);
}

function appendFacts(
  lines: string[],
  facts: readonly PersonaFactContext[] | undefined,
): void {
  if (facts === undefined || facts.length === 0) {
    return;
  }
  lines.push("関連する記憶:");
  for (const fact of facts.slice(0, 12)) {
    lines.push(
      "- " +
        contextText(fact.subject, "fact subject", 240) +
        " / " +
        contextText(fact.predicate, "fact predicate", 160) +
        ": " +
        jsonText(fact.value) +
        " (" +
        fact.source +
        ")",
    );
  }
}

function appendLocations(
  lines: string[],
  locations: readonly PersonaLocationContext[] | undefined,
): void {
  if (locations === undefined || locations.length === 0) {
    return;
  }
  lines.push("関連する場所:");
  for (const location of locations.slice(0, 8)) {
    lines.push(
      "- " +
        contextText(location.name, "location name", 160) +
        ": " +
        contextText(location.purpose, "location purpose", 400) +
        " [" +
        contextText(location.dimension, "location dimension", 120) +
        " " +
        String(location.x) +
        ", " +
        String(location.y) +
        ", " +
        String(location.z) +
        "]",
    );
  }
}

function appendCommitments(
  lines: string[],
  commitments: readonly PersonaCommitmentContext[] | undefined,
): void {
  if (commitments === undefined || commitments.length === 0) {
    return;
  }
  lines.push("約束:");
  for (const commitment of commitments.slice(0, 8)) {
    lines.push(
      "- " +
        contextText(commitment.description, "commitment description", 600) +
        " (" +
        commitment.status +
        ")",
    );
  }
}

function appendTask(
  lines: string[],
  currentTask: PersonaTaskContext | undefined,
): void {
  if (currentTask === undefined) {
    return;
  }
  lines.push(
    "現在の作業: " +
      contextText(currentTask.kind, "task kind", 120) +
      " / " +
      contextText(currentTask.phase, "task phase", 120) +
      " (" +
      currentTask.status +
      ")",
  );
}

function contextText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new PersonaValidationError(label + " is invalid.");
  }
  if (SECRET_LABEL.test(normalized) || SECRET_VALUE.test(normalized)) {
    throw new PersonaValidationError(label + " contains a secret.");
  }
  return normalized;
}

function jsonText(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return contextText(value, "fact value", MAX_PERSONA_TEXT);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(jsonText).join(", ");
  }
  return Object.entries(value)
    .map(
      ([key, item]) =>
        contextText(key, "fact key", 120) + ": " + jsonText(item),
    )
    .join(", ");
}
