import { createConnection, type Socket } from "node:net";

const maxPacketBytes = 65_536;
const maxResponseBytes = maxPacketBytes - 10;
const maxResponsePackets = 64;
const responseTerminator = "time query gametime";

interface RconPacket {
  readonly id: number;
  readonly type: number;
  readonly body: string;
  readonly bodyBytes: number;
}

class LocalRconError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "LocalRconError";
  }
}

/** Small loopback-only RCON client for isolated copied-world acceptance runs. */
export class LocalRcon {
  readonly #sockets = new Set<Socket>();
  #closed = false;

  public constructor(
    private readonly port: number,
    private readonly password: string,
  ) {}

  public async command(command: string, timeoutMs = 5_000): Promise<string> {
    if (this.#closed) throw new LocalRconError("RCON_CLOSED");
    if (
      !Number.isInteger(this.port) ||
      this.port < 1 ||
      this.port > 65_535 ||
      this.password.length === 0 ||
      command.length === 0 ||
      Buffer.byteLength(command, "utf8") > maxPacketBytes - 10 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1
    ) {
      throw new LocalRconError("RCON_INVALID_REQUEST");
    }

    const socket = createConnection({ host: "127.0.0.1", port: this.port });
    socket.setNoDelay(true);
    this.#sockets.add(socket);

    let buffered = Buffer.alloc(0);
    let terminalError: LocalRconError | undefined;
    let receivedPacketCount = 0;
    const packets: RconPacket[] = [];
    const waiters: {
      readonly resolve: (packet: RconPacket) => void;
      readonly reject: (error: LocalRconError) => void;
    }[] = [];
    let nextId = 1;

    const fail = (code: string): LocalRconError => {
      terminalError ??= new LocalRconError(code);
      for (const waiter of waiters) waiter.reject(terminalError);
      waiters.length = 0;
      return terminalError;
    };
    const receivePacket = (packet: RconPacket): void => {
      const waiter = waiters.shift();
      if (waiter === undefined) packets.push(packet);
      else waiter.resolve(packet);
    };
    const readPacket = (): Promise<RconPacket> =>
      new Promise((resolve, reject) => {
        const packet = packets.shift();
        if (packet !== undefined) resolve(packet);
        else if (terminalError !== undefined) reject(terminalError);
        else waiters.push({ resolve, reject });
      });

    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readInt32LE(0);
        if (length < 10 || length > maxPacketBytes) {
          socket.destroy(fail("RCON_INVALID_PACKET"));
          return;
        }
        if (buffered.length < length + 4) return;
        receivedPacketCount += 1;
        if (receivedPacketCount > maxResponsePackets + 2) {
          socket.destroy(fail("RCON_RESPONSE_LIMIT_EXCEEDED"));
          return;
        }
        const id = buffered.readInt32LE(4);
        const type = buffered.readInt32LE(8);
        const body = buffered.subarray(12, 4 + length - 2);
        buffered = buffered.subarray(4 + length);
        receivePacket({
          id,
          type,
          body: body.toString("utf8"),
          bodyBytes: body.length,
        });
      }
    });
    socket.on("error", () =>
      fail(this.#closed ? "RCON_CLOSED" : "RCON_UNAVAILABLE"),
    );
    socket.on("close", () =>
      fail(this.#closed ? "RCON_CLOSED" : "RCON_CONNECTION_CLOSED"),
    );
    const timer = setTimeout(
      () => socket.destroy(fail("RCON_TIMEOUT")),
      timeoutMs,
    );

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", () => reject(fail("RCON_UNAVAILABLE")));
      });

      const authId = nextId++;
      socket.write(encodePacket(authId, 3, this.password));
      const authResponse = await readPacket();
      if (authResponse.id !== authId || authResponse.type !== 2)
        throw fail("RCON_AUTH_FAILED");

      const commandId = nextId++;
      const terminatorId = nextId++;
      socket.write(encodePacket(commandId, 2, command));
      const responseBodies: string[] = [];
      let responseBytes = 0;
      let responsePackets = 0;
      const appendResponse = (packet: RconPacket): void => {
        if (packet.id !== commandId)
          throw fail("RCON_UNEXPECTED_RESPONSE_PACKET");
        if (packet.type !== 0 && packet.type !== 2)
          throw fail("RCON_COMMAND_FAILED");
        responsePackets += 1;
        responseBytes += packet.bodyBytes;
        if (
          responsePackets > maxResponsePackets ||
          responseBytes > maxResponseBytes
        ) {
          throw fail("RCON_RESPONSE_LIMIT_EXCEEDED");
        }
        responseBodies.push(packet.body);
      };

      appendResponse(await readPacket());
      socket.write(encodePacket(terminatorId, 2, responseTerminator));
      let packet = await readPacket();
      while (packet.id !== terminatorId) {
        appendResponse(packet);
        packet = await readPacket();
      }
      if (packet.type !== 0 && packet.type !== 2)
        throw fail("RCON_TERMINATOR_FAILED");
      return responseBodies.join("");
    } catch (error) {
      if (error instanceof LocalRconError) throw error;
      throw fail("RCON_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
      socket.destroy();
      this.#sockets.delete(socket);
    }
  }

  public async close(): Promise<void> {
    this.#closed = true;
    for (const socket of this.#sockets)
      socket.destroy(new Error("RCON_CLOSED"));
    this.#sockets.clear();
  }
}

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
