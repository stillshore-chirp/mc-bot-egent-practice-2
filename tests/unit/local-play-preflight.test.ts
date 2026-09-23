import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import nbt from "prismarine-nbt";
import { afterEach, describe, expect, it } from "vitest";

import { inspectLocalPlay } from "../../scripts/local-play-preflight.js";

const ownerUuid = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];

async function fixture(
  options: {
    mode?: string;
    difficulty?: string;
    bind?: string;
    ownerMode?: number;
    opLevel?: number;
  } = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-play-check-"));
  directories.push(directory);
  await writeFile(
    join(directory, "server.properties"),
    [
      `gamemode=${options.mode ?? "survival"}`,
      `difficulty=${options.difficulty ?? "normal"}`,
      `server-ip=${options.bind ?? "127.0.0.1"}`,
      "server-port=25565",
      "force-gamemode=false",
      "level-name=world",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "usercache.json"),
    JSON.stringify([{ name: "ExampleOwner", uuid: ownerUuid }]),
  );
  await writeFile(
    join(directory, "ops.json"),
    JSON.stringify(
      options.opLevel === undefined
        ? []
        : [{ name: "ExampleOwner", uuid: ownerUuid, level: options.opLevel }],
    ),
  );
  if (options.ownerMode !== undefined) {
    await mkdir(join(directory, "world", "playerdata"), { recursive: true });
    await writeFile(
      join(directory, "world", "playerdata", `${ownerUuid}.dat`),
      nbt.writeUncompressed({
        type: "compound",
        name: "",
        value: { playerGameType: { type: "int", value: options.ownerMode } },
      }),
    );
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("local play preflight", () => {
  it("distinguishes server defaults from the owner's saved mode and OP permission", async () => {
    const directory = await fixture({ ownerMode: 1, opLevel: 4 });
    const report = await inspectLocalPlay(
      directory,
      "OWNER_USERNAME=ExampleOwner\nMINECRAFT_HOST=localhost\n",
      "survival",
      "normal",
    );
    expect(report).toMatchObject({
      localOnly: true,
      portMatches: true,
      defaultMode: "survival",
      difficulty: "normal",
      savedOwnerMode: "creative",
      ownerOpLevel: 4,
      modeMatches: true,
      savedOwnerModeMatches: false,
      difficultyMatches: true,
    });
    expect(JSON.stringify(report)).not.toContain("ExampleOwner");
    expect(JSON.stringify(report)).not.toContain(ownerUuid);
  });

  it("flags peaceful survival and a non-local bind without exposing identities", async () => {
    const directory = await fixture({ difficulty: "peaceful", bind: "" });
    const report = await inspectLocalPlay(
      directory,
      "OWNER_USERNAME=ExampleOwner\nMINECRAFT_HOST=127.0.0.1\n",
      "survival",
      "normal",
    );
    expect(report).toMatchObject({
      localOnly: false,
      difficultyMatches: false,
      peacefulSurvival: true,
      savedOwnerMode: "unknown",
      savedOwnerModeMatches: true,
      ownerOpLevel: null,
    });
  });
});
