interface EntityRegistry {
  readonly entitiesByName: Readonly<
    Record<
      string,
      { readonly type?: string; readonly category?: string } | undefined
    >
  >;
}

/** Registry type is authoritative; legacy mob adapters can fall back to category. */
export function isHostileEntity(
  name: string,
  type: string,
  registry: EntityRegistry,
): boolean {
  if (type === "player") return false;
  const entity = registry.entitiesByName[name];
  if (entity === undefined) return type === "hostile";
  if (entity.type === "hostile") return true;
  if (type !== "mob" && type !== "hostile") return false;
  if (entity.type !== undefined && entity.type !== "mob") return false;
  return entity.category === "Hostile mobs";
}
