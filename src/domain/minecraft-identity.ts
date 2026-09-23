/** Minecraft player names are case-insensitive when used as chat identities. */
export function sameMinecraftIdentity(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
