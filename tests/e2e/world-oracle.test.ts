import { describe, expect, it } from "vitest";

import {
  blockIs,
  classifyRconReply,
  cloneCommand,
  destinationRegion,
  forceloadCommand,
  parseCloneCount,
  parseScore,
  regionChunkChecks,
  regionsEqual,
  forceLoadRegion,
  classifyTickStatus,
  withFrozenTicks,
} from "./world-oracle.js";

function fakeTickRcon(
  commands: string[],
  freezeAccepted = true,
  unfreezeAccepted = true,
) {
  let frozen = false;
  return {
    command: async (command: string): Promise<string> => {
      commands.push(command);
      if (command === "tick freeze") {
        if (freezeAccepted) frozen = true;
        return "";
      }
      if (command === "tick unfreeze") {
        if (unfreezeAccepted) frozen = false;
        return "";
      }
      if (command === "tick query")
        return frozen ? "The game is frozen" : "The game is running normally";
      return "";
    },
  };
}

describe("world oracle command evidence", () => {
  it("uses only complete known status lines from tick query", () => {
    expect(classifyTickStatus("The game is frozen")).toBe("frozen");
    expect(
      classifyTickStatus(
        "The game is running normally\nTarget tick rate: 20 per second.",
      ),
    ).toBe("running");
    expect(
      classifyTickStatus(
        "The game is running, but can't keep up with the target tick rate\nAverage time per tick: 60ms",
      ),
    ).toBe("running");
    expect(classifyTickStatus("Unknown command")).toBe("unknown");
    expect(
      classifyTickStatus("The game is frozen\nThe game is running normally"),
    ).toBe("unknown");
    expect(classifyTickStatus("The game is now frozen")).toBe("unknown");
  });

  it("accepts the complete concatenated status and numeric tick-query payload", () => {
    const details =
      "Target tick rate: 20 per second.\n" +
      "Average time per tick: 1.25ms (Target: 50.00ms)" +
      "Percentiles: P50: 1.00ms P95: 2.50ms P99: 3.75ms. Sample: 100";

    expect(classifyTickStatus(`The game is frozen${details}`)).toBe("frozen");
    expect(classifyTickStatus(`The game is running normally${details}`)).toBe(
      "running",
    );
    expect(
      classifyTickStatus(
        `The game is running, but can't keep up with the target tick rate${details}`,
      ),
    ).toBe("running");
    expect(
      classifyTickStatus(
        "The game is frozenTarget tick rate: unknown per second.",
      ),
    ).toBe("unknown");
    expect(
      classifyTickStatus(
        `The game is frozen${details}\nThe game is running normally`,
      ),
    ).toBe("unknown");
  });

  it("unfreezes after the protected comparison succeeds", async () => {
    const commands: string[] = [];
    const phases: string[] = [];
    const rcon = fakeTickRcon(commands);
    const result = await withFrozenTicks(
      rcon,
      async () => {
        phases.push("comparison");
        return "equal";
      },
      (code): never => {
        throw new Error(code);
      },
      {
        onFrozen: () => phases.push("frozen"),
        onUnfreezeAttempt: () => phases.push("unfreeze_attempt"),
        onUnfrozen: () => phases.push("unfrozen"),
      },
    );
    expect(result).toBe("equal");
    expect(commands).toEqual([
      "tick freeze",
      "tick query",
      "tick unfreeze",
      "tick query",
    ]);
    expect(phases).toEqual([
      "frozen",
      "comparison",
      "unfreeze_attempt",
      "unfrozen",
    ]);
  });

  it("keeps callback failures from skipping the unfreeze command", async () => {
    const commands: string[] = [];
    const result = await withFrozenTicks(
      fakeTickRcon(commands),
      async () => "equal",
      (code): never => {
        throw new Error(code);
      },
      {
        onUnfreezeAttempt: () => {
          throw new Error("diagnostic callback failed");
        },
      },
    );
    expect(result).toBe("equal");
    expect(commands).toEqual([
      "tick freeze",
      "tick query",
      "tick unfreeze",
      "tick query",
    ]);
  });

  it("unfreezes when the strict comparison fails and preserves its failure", async () => {
    const commands: string[] = [];
    const rcon = fakeTickRcon(commands);
    await expect(
      withFrozenTicks(
        rcon,
        async () => {
          throw new Error("WORLD_ORACLE_INITIAL_BASELINE_MISMATCH");
        },
        (code): never => {
          throw new Error(code);
        },
      ),
    ).rejects.toThrow("WORLD_ORACLE_INITIAL_BASELINE_MISMATCH");
    expect(commands).toEqual([
      "tick freeze",
      "tick query",
      "tick unfreeze",
      "tick query",
    ]);
  });

  it("tries to unfreeze after a rejected freeze and after an unfreeze failure", async () => {
    const rejectedFreezeCommands: string[] = [];
    await expect(
      withFrozenTicks(
        {
          ...fakeTickRcon(rejectedFreezeCommands, false),
        },
        async () => "unused",
        (code): never => {
          throw new Error(code);
        },
      ),
    ).rejects.toThrow("WORLD_ORACLE_TICK_FREEZE_NOT_CONFIRMED");
    expect(rejectedFreezeCommands).toEqual([
      "tick freeze",
      "tick query",
      "tick unfreeze",
      "tick query",
    ]);

    const unfreezeFailureCommands: string[] = [];
    const failedOperationStates: boolean[] = [];
    await expect(
      withFrozenTicks(
        {
          ...fakeTickRcon(unfreezeFailureCommands, true, false),
        },
        async () => {
          throw new Error("comparison failed");
        },
        (code): never => {
          throw new Error(code);
        },
        {
          onUnfreezeFailure: (operationFailed) =>
            failedOperationStates.push(operationFailed),
        },
      ),
    ).rejects.toThrow("WORLD_ORACLE_TICK_UNFREEZE_NOT_CONFIRMED");
    expect(unfreezeFailureCommands).toEqual([
      "tick freeze",
      "tick query",
      "tick unfreeze",
      "tick query",
    ]);
    expect(failedOperationStates).toEqual([true]);
  });

  it("uses the explicit replace mask before force mode", () => {
    expect(
      cloneCommand(
        {
          minX: 1,
          minY: 2,
          minZ: 3,
          maxX: 4,
          maxY: 5,
          maxZ: 6,
        },
        { x: 10, y: 11, z: 12 },
      ),
    ).toBe("clone 1 2 3 4 5 6 10 11 12 replace force");
  });

  it("requests the complete region and derives its destination bounds", () => {
    const region = {
      minX: -12,
      minY: 63,
      minZ: -12,
      maxX: 12,
      maxY: 72,
      maxZ: 12,
    };
    expect(forceloadCommand(region)).toBe("forceload add -12 -12 12 12");
    expect(destinationRegion(region, { x: 1000, y: 63, z: 1000 })).toEqual({
      minX: 1000,
      minY: 63,
      minZ: 1000,
      maxX: 1024,
      maxY: 72,
      maxZ: 1024,
    });
    expect(regionChunkChecks(region)).toHaveLength(4);
  });

  it("classifies known command failures before success-shaped text", () => {
    expect(classifyRconReply("Incorrect argument for command")).toBe("syntax");
    expect(classifyRconReply("Position is not loaded")).toBe("unloaded");
    expect(classifyRconReply("Marked 4 chunks to be force loaded")).toBe(
      "success",
    );
    expect(classifyRconReply("Marked 0 chunks to be force loaded")).toBe(
      "success",
    );
    expect(
      classifyRconReply(
        "Marked 3 chunks in example:dimension from [0, 0] to [31, 31] to be force loaded",
      ),
    ).toBe("success");
    expect(
      classifyRconReply(
        "Marked chunk [-8, 8] in example:dimension to be force loaded",
      ),
    ).toBe("success");
    expect(
      classifyRconReply(
        "Chunk at [-8, 8] in example:dimension is marked for force loading",
      ),
    ).toBe("success");
    expect(classifyRconReply("No chunks were marked for force loading")).toBe(
      "error",
    );
    expect(classifyRconReply("#fixture has 4 [fixture_obj]")).toBe("success");
    expect(classifyRconReply("Cloned 2500 blocks")).toBe("success");
    expect(classifyRconReply("Filled 9 blocks")).toBe("success");
    expect(classifyRconReply("No blocks filled")).toBe("success");
    expect(classifyRconReply("No blocks were filled")).toBe("success");
    expect(classifyRconReply("RCON transport error")).toBe("error");
  });

  it("requires parseable exact clone and scoreboard readbacks", () => {
    expect(parseCloneCount("Successfully cloned 18 block(s)")).toBe(18);
    expect(parseCloneCount("Cloned 2500 blocks")).toBe(2500);
    expect(parseCloneCount("Incorrect argument for command")).toBeUndefined();
    expect(parseScore("Score #fixture is 1", "#fixture", "fixture_obj")).toBe(
      1,
    );
    expect(
      parseScore("#fixture has 4 [fixture_obj]", "#fixture", "fixture_obj"),
    ).toBe(4);
    expect(
      parseScore("#other has 4 [fixture_obj]", "#fixture", "fixture_obj"),
    ).toBeUndefined();
    expect(parseScore("RCON transport error")).toBeUndefined();
  });

  it("distinguishes block absence from rejected RCON predicates", async () => {
    const fail = (code: string): never => {
      throw new Error(code);
    };
    const replies = ["Set #oracle to 0", "", "#oracle has 0 [ai_e2e]"];
    const rcon = { command: async () => replies.shift() ?? "" };
    await expect(
      blockIs(rcon, { x: 1, y: 2, z: 3 }, "stone", fail),
    ).resolves.toBe(false);

    const rejected = ["Set #oracle to 0", "Incorrect argument for command"];
    await expect(
      blockIs(
        { command: async () => rejected.shift() ?? "" },
        { x: 1, y: 2, z: 3 },
        "stone",
        fail,
      ),
    ).rejects.toThrow("WORLD_ORACLE_BLOCK_CHECK_REJECTED");

    const unloaded = ["Set #oracle to 0", "Position is not loaded"];
    await expect(
      blockIs(
        { command: async () => unloaded.shift() ?? "" },
        { x: 1, y: 2, z: 3 },
        "stone",
        fail,
      ),
    ).rejects.toThrow("WORLD_ORACLE_BLOCK_CHECK_REJECTED");

    const invalidScore = ["Set #oracle to 0", "", "Score #oracle is 2"];
    await expect(
      blockIs(
        { command: async () => invalidScore.shift() ?? "" },
        { x: 1, y: 2, z: 3 },
        "stone",
        fail,
      ),
    ).rejects.toThrow("WORLD_ORACLE_BLOCK_READBACK_INVALID");
  });

  it("returns equality from a strict scoreboard readback", async () => {
    const fail = (code: string): never => {
      throw new Error(code);
    };
    const equalReplies = [
      "Set #oracle to 0",
      "Set #oracle to 1",
      "#oracle has 1 [ai_e2e]",
    ];
    const unequalReplies = ["Set #oracle to 0", "", "#oracle has 0 [ai_e2e]"];
    const region = {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: 0,
      maxY: 0,
      maxZ: 0,
    };
    const destination = { x: 1, y: 1, z: 1 };
    await expect(
      regionsEqual(
        { command: async () => equalReplies.shift() ?? "" },
        region,
        destination,
        fail,
      ),
    ).resolves.toBe(true);
    await expect(
      regionsEqual(
        { command: async () => unequalReplies.shift() ?? "" },
        region,
        destination,
        fail,
      ),
    ).resolves.toBe(false);

    const invalidScoreReplies = [
      "Set #oracle to 0",
      "Set #oracle to 1",
      "#oracle has 2 [ai_e2e]",
    ];
    await expect(
      regionsEqual(
        { command: async () => invalidScoreReplies.shift() ?? "" },
        region,
        destination,
        fail,
      ),
    ).rejects.toThrow("WORLD_ORACLE_COMPARE_READBACK_INVALID");
  });

  it("verifies already-marked chunks before treating forceload as idempotent", async () => {
    const fail = (code: string): never => {
      throw new Error(code);
    };
    const commands: string[] = [];
    const rcon = {
      command: async (command: string) => {
        commands.push(command);
        if (command.startsWith("forceload add"))
          return "No chunks were marked for force loading";
        if (command.startsWith("forceload query"))
          return "Chunk at [-8, 8] in example:dimension is marked for force loading";
        if (command.startsWith("scoreboard players set"))
          return "Set [ai_e2e] for #oracle to 0";
        if (command.startsWith("execute if loaded"))
          return "Added 1 to [ai_e2e] for #oracle (now 1)";
        if (command.startsWith("scoreboard players get"))
          return "#oracle has 4 [ai_e2e]";
        return "Unknown command";
      },
    };
    await expect(
      forceLoadRegion(
        rcon,
        { minX: -1, minY: 63, minZ: -1, maxX: 1, maxY: 64, maxZ: 1 },
        fail,
      ),
    ).resolves.toBeUndefined();
    expect(
      commands.filter((command) => command.startsWith("forceload query")),
    ).toHaveLength(4);

    await expect(
      forceLoadRegion(
        {
          command: async (command: string) =>
            command.startsWith("forceload add")
              ? "No chunks were marked for force loading"
              : "Chunk at [-8, 8] in example:dimension is not marked for force loading",
        },
        { minX: -1, minY: 63, minZ: -1, maxX: 1, maxY: 64, maxZ: 1 },
        fail,
      ),
    ).rejects.toThrow("WORLD_ORACLE_CHUNK_NOT_FORCELOADED");
  });
});
