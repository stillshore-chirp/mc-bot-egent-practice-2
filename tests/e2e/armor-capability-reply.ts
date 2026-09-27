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
const uiOpenOperation = /\bopen_window\b/iu;
const uiTransferOperation = /\bwindow_transfer\b/iu;
const uiOpenAffirmative =
  /(?:開け|開き|開く|使えます|利用できます|利用可能|可能|can\s+open|opens?\b|available)/iu;
const uiTransferAffirmative =
  /(?:移せ(?:ます|る)|移し(?:ます)?|移します|移す|移動|移送|転送|使えます|利用できます|利用可能|可能|can\s+(?:transfer|move)|transfers?\b|moves?\b|available)/iu;
const uiOperationDenial =
  /(?:できません|できない|使えません|使えない|利用できません|利用できない|開けません|開けない|移せません|移せない|移動できません|移送できません|転送できません|利用不可|操作不可|not available|unavailable|cannot|can't)/iu;
const furnaceUiDenied =
  /(?:炉|かまど|furnace).{0,24}(?:画面|ui|screen|interface|open_window|window_transfer).{0,24}(?:できません|できない|使えません|使えない|利用できません|利用できない|開けません|開けない|移せません|移せない|利用不可|操作不可|not available|unavailable|cannot|can't)|(?:画面|ui|screen|interface|open_window|window_transfer).{0,24}(?:炉|かまど|furnace).{0,24}(?:できません|できない|使えません|使えない|利用できません|利用できない|開けません|開けない|移せません|移せない|利用不可|操作不可|not available|unavailable|cannot|can't)/iu;
const visibleBlockInterface =
  /(?:視界内|見える|見えている|到達可能|visible|reachable).{0,28}(?:ブロック|block).{0,28}(?:画面|ui|screen|interface)/iu;

function mentionsAvailableOperation(text: string, pattern: RegExp): boolean {
  const match = pattern.exec(text);
  if (match === null) return false;
  const afterOperation = text.slice(
    match.index + match[0].length,
    match.index + match[0].length + 40,
  );
  return !directDenial.test(afterOperation);
}

function mentionsAffirmativeUiOperation(
  text: string,
  operation: RegExp,
  affirmative: RegExp,
): boolean {
  const match = operation.exec(text);
  const matchedOperation = match?.[0];
  if (match === null || matchedOperation === undefined) return false;
  const afterOperation =
    text
      .slice(match.index + matchedOperation.length)
      .split(/[。.!?！？;；,，、]/u, 1)[0] ?? "";
  return (
    !uiOperationDenial.test(afterOperation) && affirmative.test(afterOperation)
  );
}

export function classifyArmorCapabilityReply(
  reply: string,
): ArmorCapabilityReplyClassification {
  const text = reply.toLocaleLowerCase("ja-JP");
  const digAndEquipAvailable =
    mentionsAvailableOperation(text, /\bdig\b|採掘|掘/u) &&
    mentionsAvailableOperation(text, /\bequip\b|装備/u);
  const sentences = text.split(/[。.!?！？\n]+/u);
  const furnaceUiAvailable =
    !furnaceUiDenied.test(text) &&
    sentences.some(
      (sentence) =>
        (/(?:かまど|炉|furnace)/u.test(sentence) ||
          visibleBlockInterface.test(sentence)) &&
        mentionsAffirmativeUiOperation(
          sentence,
          uiOpenOperation,
          uiOpenAffirmative,
        ) &&
        mentionsAffirmativeUiOperation(
          sentence,
          uiTransferOperation,
          uiTransferAffirmative,
        ),
    );
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
