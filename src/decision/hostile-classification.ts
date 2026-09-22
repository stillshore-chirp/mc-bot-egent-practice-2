interface EntityRegistry {
  readonly entitiesByName: Readonly<
    Record<string, { readonly category?: string } | undefined>
  >;
}

/** Versioned Minecraft data is primary; the protocol type covers new hostiles. */
export function isHostileEntity(
  name: string,
  type: string,
  registry: EntityRegistry,
): boolean {
  const category = registry.entitiesByName[name]?.category;
  return category === undefined
    ? type === "hostile"
    : category === "Hostile mobs";
}
