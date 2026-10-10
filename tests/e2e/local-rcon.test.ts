import { createServer, type Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { LocalRcon } from "./local-rcon.js";

type MockMode = "single" | "split" | "missing-terminator" | "peer-close";

function encodePacket(id: number, type: number, body: string): Buffer {
  const content = Buffer.from(body, "utf8");
  const packet = Buffer.alloc(content.length + 14);
  packet.writeInt32LE(content.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  content.copy(packet, 12);
  return packet;
}

async function startRconMock(mode: MockMode): Promise<{
  readonly port: number;
  readonly requests: string[];
  readonly close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readInt32LE(0);
        if (length < 10 || buffered.length < length + 4) return;
        const id = buffered.readInt32LE(4);
        const type = buffered.readInt32LE(8);
        const body = buffered.subarray(12, 4 + length - 2).toString("utf8");
        buffered = buffered.subarray(4 + length);
        if (type === 3) {
          socket.write(encodePacket(id, 2, ""));
          continue;
        }
        requests.push(body);
        if (body === "time query gametime") {
          if (mode === "missing-terminator") continue;
          if (mode === "peer-close") {
            socket.end();
            continue;
          }
          socket.write(encodePacket(id, 0, "terminal"));
          continue;
        }
        if (mode === "single") {
          socket.write(encodePacket(id, 0, "single"));
        } else if (mode === "split") {
          socket.write(encodePacket(id, 0, "part-one"));
          socket.write(encodePacket(id, 0, "part-two"));
        } else if (mode === "peer-close") {
          socket.write(encodePacket(id, 0, "partial"));
          socket.end();
        } else {
          socket.write(encodePacket(id, 0, "partial"));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("mock server did not bind a TCP port");
  return {
    port: address.port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe("LocalRcon", () => {
  it("authenticates and joins split command responses through the terminator", async () => {
    const mock = await startRconMock("split");
    const rcon = new LocalRcon(mock.port, "synthetic-password");
    try {
      await expect(rcon.command("list")).resolves.toBe("part-onepart-two");
      expect(mock.requests).toEqual(["list", "time query gametime"]);
    } finally {
      await rcon.close();
      await mock.close();
    }
  });

  it("returns a single packet before the separate terminator response", async () => {
    const mock = await startRconMock("single");
    const rcon = new LocalRcon(mock.port, "synthetic-password");
    try {
      await expect(rcon.command("list")).resolves.toBe("single");
    } finally {
      await rcon.close();
      await mock.close();
    }
  });

  it("rejects a partial reply when the peer closes before the terminator", async () => {
    const mock = await startRconMock("peer-close");
    const rcon = new LocalRcon(mock.port, "synthetic-password");
    try {
      await expect(rcon.command("list", 1_000)).rejects.toMatchObject({
        code: "RCON_CONNECTION_CLOSED",
      });
    } finally {
      await rcon.close();
      await mock.close();
    }
  });

  it("times out if the command response terminator never arrives", async () => {
    const mock = await startRconMock("missing-terminator");
    const rcon = new LocalRcon(mock.port, "synthetic-password");
    try {
      await expect(rcon.command("list", 100)).rejects.toMatchObject({
        code: "RCON_TIMEOUT",
      });
    } finally {
      await rcon.close();
      await mock.close();
    }
  });
});
