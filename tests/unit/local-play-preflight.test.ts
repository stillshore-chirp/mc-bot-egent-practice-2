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
    port?: string;
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
      `server-port=${options.port ?? "25565"}`,
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

  it("accepts equivalent loopback addresses and numeric port spellings", async () => {
    const directory = await fixture({ bind: "0:0:0:0:0:0:0:1" });
    const report = await inspectLocalPlay(
      directory,
      "OWNER_USERNAME=ExampleOwner\nMINECRAFT_HOST=::1\nMINECRAFT_PORT=025565\n",
      "survival",
      "normal",
    );
    expect(report.localOnly).toBe(true);
    expect(report.portMatches).toBe(true);

    const ipv4Directory = await fixture({ bind: "127.0.0.2" });
    const ipv4Report = await inspectLocalPlay(
      ipv4Directory,
      "OWNER_USERNAME=ExampleOwner\nMINECRAFT_HOST=127.0.0.3\nMINECRAFT_PORT=25565.0\n",
      "survival",
      "normal",
    );
    expect(ipv4Report.localOnly).toBe(true);
    expect(ipv4Report.portMatches).toBe(true);
  });

  it("explains peaceful when the actual default is survival despite another expected mode", async () => {
    const directory = await fixture({ difficulty: "peaceful" });
    const report = await inspectLocalPlay(
      directory,
      "OWNER_USERNAME=ExampleOwner\nMINECRAFT_HOST=localhost\n",
      "creative",
      "peaceful",
    );
    expect(report.peacefulSurvival).toBe(true);
    expect(report.modeMatches).toBe(false);
  });
});
