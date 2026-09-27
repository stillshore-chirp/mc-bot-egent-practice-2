export interface ArmorCapabilityReplyClassification {
  readonly digAndEquipAvailable: boolean;
  readonly furnaceUiAvailable: boolean;
  readonly dedicatedSmeltStatementObserved: boolean;
  readonly dedicatedSmeltReportedUnavailable: boolean;
}

const smeltUnavailable =
  /(?:\bsmelt\b|専用の?精錬操作|精錬操作).{0,40}(?:ない|ありません|未提供|未登録|存在しない)|(?:ない|ありません|未提供|未登録|存在しない).{0,40}(?:\bsmelt\b|専用の?精錬操作|精錬操作)/iu;
const directDenial =
  /^(?:(?:[\s、,:：]{0,3})(?:(?:は|を|が)\s*)?(?:できません|できない|使えません|使えない|ありません|ないです|ない|未提供|未登録|存在しない|不可)|(?:\s{0,3})(?:(?:is|are)\s+)?(?:not\s+available|unavailable|cannot|can't|doesn't exist))/iu;
const furnaceUiOperation =
  /\bopen_window\b|\bwindow_(?:click|transfer)\b|画面.{0,8}(?:開|移)|UI.{0,8}(?:開|移)/u;

function mentionsAvailableOperation(text: string, pattern: RegExp): boolean {
  const match = pattern.exec(text);
  if (match === null) return false;
  const afterOperation = text.slice(
    match.index + match[0].length,
    match.index + match[0].length + 40,
  );
  return !directDenial.test(afterOperation);
}

export function classifyArmorCapabilityReply(
  reply: string,
): ArmorCapabilityReplyClassification {
  const text = reply.toLocaleLowerCase("ja-JP");
  const digAndEquipAvailable =
    mentionsAvailableOperation(text, /\bdig\b|採掘|掘/u) &&
    mentionsAvailableOperation(text, /\bequip\b|装備/u);
  const furnaceUiAvailable =
    /かまど|炉|furnace/u.test(text) &&
    mentionsAvailableOperation(text, furnaceUiOperation);
  const dedicatedSmeltStatementObserved =
    /\bsmelt\b|専用の?精錬操作|精錬操作/u.test(text);
  const dedicatedSmeltReportedUnavailable =
    dedicatedSmeltStatementObserved && smeltUnavailable.test(text);

  return {
    digAndEquipAvailable,
    furnaceUiAvailable,
    dedicatedSmeltStatementObserved,
    dedicatedSmeltReportedUnavailable,
  };
}

export function accuratelyReportsIronHelmetEquipped(reply: string): boolean {
  const text = reply.toLocaleLowerCase("ja-JP");
  const itemMentioned =
    /鉄(?:の)?(?:ヘルメット|兜)|\biron[ _-]?helmet\b|\bhelmet\b/u.test(text);
  const completedEquip =
    /(?:装備|装着|着用)(?:操作)?は(?:成功|完了)と判定|(?:装備|装着|着用)(?:完了|済み|し(?:ました|た|て(?:い?ます|いる|あります)))|(?:身に着け|着け)(?:ました|た|て(?:い?ます|いる))|(?:かぶ|被)(?:りました|った|って(?:い?ます|いる))|\b(?:equipped|put on)\b/u.test(
      text,
    );
  const negatedOrUnverified =
    /(?:できません|できなかった|失敗|未確認|まだ|試し(?:て|ます)|確認中|cannot|can't|failed|not yet|trying to)/u.test(
      text,
    );
  return itemMentioned && completedEquip && !negatedOrUnverified;
}

export function hasAccurateIronHelmetCompletionNotice(
  candidates: readonly string[],
): boolean {
  return candidates.some(accuratelyReportsIronHelmetEquipped);
}
