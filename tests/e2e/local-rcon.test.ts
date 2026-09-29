import { createServer, type Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { LocalRcon } from "./ai-player-live.js";

interface RequestPacket {
  readonly id: number;
  readonly type: number;
  readonly body: string;
}

type MockMode = "single" | "split" | "missing-terminator" | "peer-close";

function encodePacket(id: number, type: number, body: string): Buffer {
  const content = Buffer.from(body, "utf8");
  const packet = Buffer.alloc(content.length + 14);
  packet.writeInt32LE(content.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  content.copy(packet, 12);
  packet.writeUInt8(0, packet.length - 2);
  packet.writeUInt8(0, packet.length - 1);
  return packet;
}

async function startRconMock(mode: MockMode): Promise<{
  readonly port: number;
  readonly requests: RequestPacket[];
  readonly close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const requests: RequestPacket[] = [];
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
        requests.push({ id, type, body });
        if (requests.length !== 2) continue;
        const [command, terminator] = requests;
        if (command === undefined || terminator === undefined) continue;
        if (mode === "single") {
          socket.write(encodePacket(command.id, 0, "single-response"));
        } else if (mode === "split") {
          socket.write(encodePacket(command.id, 0, "part-one"));
          socket.write(encodePacket(command.id, 0, "part-two"));
        } else if (mode === "peer-close") {
          socket.write(encodePacket(command.id, 0, "partial"));
          socket.end();
          continue;
        } else {
          socket.write(encodePacket(command.id, 0, "partial"));
          continue;
        }
        socket.write(encodePacket(terminator.id, 0, "terminal-response"));
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

describe("LocalRcon response completion", () => {
  it("returns a single packet before the separate terminator response", async () => {
    const mock = await startRconMock("single");
    try {
      await expect(
        new LocalRcon(mock.port, "synthetic-password").command("list"),
      ).resolves.toBe("single-response");
      expect(mock.requests.map(({ body }) => body)).toEqual([
        "list",
        "time query gametime",
      ]);
    } finally {
      await mock.close();
    }
  });

  it("joins split packets until the separate terminator response", async () => {
    const mock = await startRconMock("split");
    try {
      await expect(
        new LocalRcon(mock.port, "synthetic-password").command("list"),
      ).resolves.toBe("part-onepart-two");
      expect(mock.requests.map(({ body }) => body)).toEqual([
        "list",
        "time query gametime",
      ]);
    } finally {
      await mock.close();
    }
  });

  it("keeps a reply without its terminator incomplete at the timeout", async () => {
    const mock = await startRconMock("missing-terminator");
    try {
      await expect(
        new LocalRcon(mock.port, "synthetic-password").command("list", 100),
      ).rejects.toMatchObject({ code: "RCON_TIMEOUT" });
      expect(mock.requests.map(({ body }) => body)).toEqual([
        "list",
        "time query gametime",
      ]);
    } finally {
      await mock.close();
    }
  });

  it("rejects a partial reply when the peer closes before the terminator", async () => {
    const mock = await startRconMock("peer-close");
    try {
      await expect(
        new LocalRcon(mock.port, "synthetic-password").command("list", 1_000),
      ).rejects.toMatchObject({ code: "RCON_CONNECTION_CLOSED" });
    } finally {
      await mock.close();
    }
  });
});
