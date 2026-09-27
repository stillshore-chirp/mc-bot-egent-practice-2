export interface RconResponsePacket {
  readonly id: number;
  readonly type: number;
  readonly body: string;
}

const MAX_RCON_RESPONSE_PACKETS = 32;

/** Join a bounded command response through its empty-command terminator packet. */
export async function readRconCommandResponse(
  readNextPacket: () => Promise<RconResponsePacket>,
  commandId: number,
  terminatorId: number,
): Promise<string> {
  let body = "";
  let responsePacketCount = 0;
  while (responsePacketCount <= MAX_RCON_RESPONSE_PACKETS) {
    const packet = await readNextPacket();
    if (packet.id === terminatorId) {
      if (
        (packet.type !== 0 && packet.type !== 2) ||
        responsePacketCount === 0
      ) {
        throw new Error("RCON_INVALID_RESPONSE");
      }
      return body;
    }
    if (responsePacketCount >= MAX_RCON_RESPONSE_PACKETS)
      throw new Error("RCON_RESPONSE_PACKET_LIMIT");
    if (packet.id !== commandId || (packet.type !== 0 && packet.type !== 2)) {
      throw new Error("RCON_INVALID_RESPONSE");
    }
    body += packet.body;
    responsePacketCount += 1;
  }
  throw new Error("RCON_RESPONSE_PACKET_LIMIT");
}
