import { describe, expect, it } from "vitest";

import { readRconCommandResponse } from "../e2e/rcon-command-response.js";

describe("bounded RCON command response reader", () => {
  it("joins command packets and excludes the empty-command terminator", async () => {
    const packets = [
      { id: 4, type: 0, body: "Entity data: [{id:" },
      { id: 4, type: 0, body: '"minecraft:birch_log",count:1}]' },
      { id: 5, type: 0, body: "" },
    ];
    const response = await readRconCommandResponse(
      async () => {
        const packet = packets.shift();
        if (packet === undefined) throw new Error("fixture exhausted");
        return packet;
      },
      4,
      5,
    );

    expect(response).toBe('Entity data: [{id:"minecraft:birch_log",count:1}]');
  });

  it("fails closed when the stream cannot be joined to the command", async () => {
    await expect(
      readRconCommandResponse(
        async () => ({ id: 99, type: 0, body: "PRIVATE_RESPONSE" }),
        4,
        5,
      ),
    ).rejects.toThrow("RCON_INVALID_RESPONSE");
    await expect(
      readRconCommandResponse(async () => ({ id: 5, type: 0, body: "" }), 4, 5),
    ).rejects.toThrow("RCON_INVALID_RESPONSE");
    await expect(
      readRconCommandResponse(
        async () => ({ id: 4, type: 7, body: "PRIVATE_RESPONSE" }),
        4,
        5,
      ),
    ).rejects.toThrow("RCON_INVALID_RESPONSE");
  });

  it("bounds the number of accepted response packets", async () => {
    let packetsRead = 0;
    await expect(
      readRconCommandResponse(
        async () => {
          packetsRead += 1;
          return { id: 4, type: 0, body: "fragment" };
        },
        4,
        5,
      ),
    ).rejects.toThrow("RCON_RESPONSE_PACKET_LIMIT");
    expect(packetsRead).toBe(33);
  });
});
