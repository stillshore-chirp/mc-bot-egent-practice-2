import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PersonaValidationError,
  buildPersonaContext,
  loadPersona,
  personaCoreSchema,
} from "../../src/persona/persona.js";

const temporaryDirectories: string[] = [];

function writePersona(content: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "mc-companion-persona-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "persona.json");
  writeFileSync(path, JSON.stringify(content), "utf8");
  return path;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("persona", () => {
  const core = {
    version: 1,
    name: "Mori",
    speakingStyle: "落ち着いた、簡潔な日本語で話す。",
    values: ["観測した事実を大切にする", "利用者との約束を守る"],
    operatingPrinciples: [
      "停止指示を最優先する",
      "Minecraftの観測状態で結果を確認する",
    ],
    prohibitions: ["未確認の成功を報告しない", "秘密情報を保存しない"],
  };

  it("loads the strict versioned PersonaCore JSON contract", () => {
    const loaded = loadPersona(writePersona(core));

    expect(loaded).toEqual(core);
    expect(personaCoreSchema.safeParse({ ...core, extra: true }).success).toBe(
      false,
    );
  });

  it("builds persona context from selected structured memory only", () => {
    const context = buildPersonaContext(core, {
      playerName: "Builder",
      relationshipSummary: "一緒に拠点を整備している。",
      facts: [
        {
          subject: "Builder",
          predicate: "favorite_wood",
          value: "oak",
          source: "player_stated",
        },
      ],
      locations: [
        {
          name: "Oak grove",
          purpose: "wood gathering",
          dimension: "minecraft:overworld",
          x: 12,
          y: 70,
          z: -8,
        },
      ],
      commitments: [
        { description: "Return after gathering logs", status: "active" },
      ],
      currentTask: {
        kind: "gather_resource",
        phase: "moving",
        status: "running",
      },
    });

    expect(context).toContain("あなたはMoriです。");
    expect(context).toContain("favorite_wood");
    expect(context).toContain("現在の作業: gather_resource / moving (running)");
    expect(context).toContain("確認していないMinecraft上の結果");
  });

  it("rejects malformed or credential-bearing persona files", () => {
    expect(() => loadPersona(writePersona({ name: "Mori" }))).toThrow(
      PersonaValidationError,
    );
    expect(() =>
      loadPersona(
        writePersona({
          ...core,
          speakingStyle: "Authorization: Bearer redacted-test-credential",
        }),
      ),
    ).toThrow(PersonaValidationError);
  });
});
