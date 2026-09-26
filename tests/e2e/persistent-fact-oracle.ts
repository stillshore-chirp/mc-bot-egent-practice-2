function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasPersistedOwnerFact(
  payloadJson: string,
  expectedContent: string,
): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(payload) || !Array.isArray(payload.stateFacts)) return false;
  return payload.stateFacts.some(
    (note) =>
      isRecord(note) &&
      note.kind === "fact" &&
      note.source === "owner" &&
      typeof note.summary === "string" &&
      note.summary.includes(expectedContent),
  );
}
