import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Response } from "openai/resources/responses/responses.js";

import { McSkillRepository } from "../../src/mc-skills/index.js";
import {
  playerOperationNames,
  playerOperationSchema,
} from "../../src/minecraft/player-body-schema.js";
import type { PlayerBody } from "../../src/minecraft/player-body.js";
import type { PlayerMemoryPort } from "../../src/player/contracts.js";
import {
  playerOperationCatalog,
  playerOperationDescriptionTool,
  PlayerPurposeAgent,
} from "../../src/player/agents.js";
import { PlayerMindStore } from "../../src/player/mind-store.js";
import type { PlayerResponsesClient } from "../../src/player/responses.js";

const temporaryDirectories: string[] = [];

function completedResponse(output: unknown[] = []): unknown {
  return {
    status: "completed",
    output,
    output_text: "",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function describeOperationResponse(kind: string): unknown {
  return completedResponse([
    {
      type: "function_call",
      call_id: `describe-${kind}`,
      name: "describe_operation",
      arguments: JSON.stringify({ kind }),
    },
  ]);
}

function createPurposeAgent(responses: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), "player-operation-schema-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "player.sqlite");
  const mind = PlayerMindStore.open(databasePath);
  const skills = McSkillRepository.open({
    databasePath,
    exchangeDirectory: join(directory, "skills"),
    allowedOperationNames: playerOperationNames,
  });
  const requests: unknown[] = [];
  const client = {
    responses: {
      create: async (request: unknown) => {
        requests.push(request);
        const response = responses.shift();
        if (response === undefined)
          throw new Error("response fixture exhausted");
        return response;
      },
    },
  } as unknown as PlayerResponsesClient;
  const memory: PlayerMemoryPort = {
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
  const body = {
    observe: async () => {
      throw new Error("observation fixture unavailable");
    },
  } as unknown as PlayerBody;
  const agent = new PlayerPurposeAgent({
    client,
    apiKey: "",
    model: "gpt-6-luna",
    body,
    skills,
    mind,
    memory,
    ownerPlayerId: "owner-player",
    logger: pino({ level: "silent" }),
    onCommitted: () => undefined,
  });
  return {
    agent,
    mind,
    requests,
    close: () => {
      skills.close();
      mind.close();
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("on-demand player operation schemas", () => {
  it("discovers every operation and returns its exact execution schema branch", async () => {
    const parameters = z
      .record(z.string(), z.unknown())
      .parse(playerOperationDescriptionTool.definition.parameters);
    const properties = z
      .record(z.string(), z.unknown())
      .parse(parameters.properties);
    const kindSchema = z.record(z.string(), z.unknown()).parse(properties.kind);
    expect(kindSchema.enum).toEqual(playerOperationNames);
    expect(playerOperationDescriptionTool.definition.strict).toBe(true);

    const fullSchema = z.toJSONSchema(playerOperationSchema, {
      target: "draft-7",
    });
    const variants = z
      .array(z.record(z.string(), z.unknown()))
      .parse(fullSchema.oneOf);
    expect(variants).toHaveLength(playerOperationNames.length);

    for (const kind of playerOperationNames) {
      const expected = variants.find((variant) => {
        const variantProperties = z
          .record(z.string(), z.unknown())
          .parse(variant.properties);
        const variantKind = z
          .record(z.string(), z.unknown())
          .parse(variantProperties.kind);
        return variantKind.const === kind;
      });
      expect(expected).toBeDefined();
      const result = z
        .record(z.string(), z.unknown())
        .parse(await playerOperationDescriptionTool.execute({ kind }));
      expect(result.kind).toBe(kind);
      expect(result.schema).toEqual(expected);
      expect(result.description).toEqual(expect.any(String));
    }

    const returned = (await playerOperationDescriptionTool.execute({
      kind: "use",
    })) as { schema: Record<string, unknown> };
    returned.schema.properties = { injected: true };
    const reread = await playerOperationDescriptionTool.execute({
      kind: "use",
    });
    expect(reread).toMatchObject({ kind: "use" });
    expect(reread).not.toHaveProperty("schema.properties.injected");
  });

  it("sends a compact catalog and exposes schema discovery to the purpose agent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "player-operation-schema-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "player.sqlite");
    const mind = PlayerMindStore.open(databasePath);
    const skills = McSkillRepository.open({
      databasePath,
      exchangeDirectory: join(directory, "skills"),
      allowedOperationNames: playerOperationNames,
    });
    const requests: unknown[] = [];
    const response = {
      status: "completed",
      output: [],
      output_text: "",
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as Response;
    const client = {
      responses: {
        create: async (request: unknown) => {
          requests.push(request);
          return response;
        },
      },
    } as unknown as PlayerResponsesClient;
    const memory: PlayerMemoryPort = {
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
    const body = {
      observe: async () => {
        throw new Error("observation fixture unavailable");
      },
    } as unknown as PlayerBody;
    const agent = new PlayerPurposeAgent({
      client,
      apiKey: "",
      model: "gpt-6-luna",
      body,
      skills,
      mind,
      memory,
      ownerPlayerId: "owner-player",
      logger: pino({ level: "silent" }),
      onCommitted: () => undefined,
    });

    try {
      await agent.think({ snapshot: mind.snapshot(), events: [] });
      const request = z.record(z.string(), z.unknown()).parse(requests[0]);
      const instructions = z.string().parse(request.instructions);
      const tools = z
        .array(z.record(z.string(), z.unknown()))
        .parse(request.tools);
      const fullSchemaText = JSON.stringify(
        z.toJSONSchema(playerOperationSchema, { target: "draft-7" }),
      );

      expect(instructions).toContain(playerOperationCatalog);
      expect(instructions).toContain("describe_operation({kind})");
      expect(instructions).toContain(
        "提示済みの現行schemaは再利用してください。schemaが未提示、または引数が不明な操作はdescribe_operation({kind})で確認し、引数を省略せず",
      );
      expect(instructions.length).toBeLessThan(
        instructions.replace(playerOperationCatalog, fullSchemaText).length,
      );
      expect(tools.some(({ name }) => name === "describe_operation")).toBe(
        true,
      );
    } finally {
      skills.close();
      mind.close();
    }
  });

  it("reuses only the four most recently described canonical schemas within the character cap", async () => {
    const kinds = ["move_to", "look", "control", "equip", "use"] as const;
    const responses = kinds.flatMap((kind) => [
      describeOperationResponse(kind),
      completedResponse(),
    ]);
    responses.push(completedResponse());
    const { agent, mind, requests, close } = createPurposeAgent(responses);

    try {
      for (const _kind of kinds)
        await agent.think({ snapshot: mind.snapshot(), events: [] });
      await agent.think({ snapshot: mind.snapshot(), events: [] });

      const request = z.record(z.string(), z.unknown()).parse(requests[10]);
      const instructions = z.string().parse(request.instructions);
      const marker = "以前に確認した操作schema（現在の定義）:\n";
      const cacheStart = instructions.indexOf(marker);
      expect(cacheStart).toBeGreaterThanOrEqual(0);
      const entries: string[] = [];
      for (const line of instructions
        .slice(cacheStart + marker.length)
        .split("\n")) {
        try {
          z.record(z.string(), z.unknown()).parse(JSON.parse(line));
          entries.push(line);
        } catch {
          break;
        }
      }
      const cacheText = `${marker}${entries.join("\n")}`;
      expect(cacheText.length + 1).toBeLessThanOrEqual(4_096);

      expect(entries).toHaveLength(4);
      const entryKinds = entries.map((entry) => {
        const parsed = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(entry));
        return z.string().parse(parsed.kind);
      });
      expect(entryKinds).toEqual(kinds.slice(1));
      const tools = z
        .array(z.record(z.string(), z.unknown()))
        .parse(request.tools);
      expect(tools.some(({ name }) => name === "describe_operation")).toBe(
        true,
      );
    } finally {
      close();
    }
  });
});
