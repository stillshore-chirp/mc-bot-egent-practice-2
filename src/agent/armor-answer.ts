import type { GameStatus } from "../tools/contracts.js";

export type ArmorQuestionSubject = "bot" | "requester";

const armorName =
  /(?:防具|ヘルメット|胸当て|チェストプレート|レギンス|ブーツ|兜|鎧)/u;
const armorItem = /(?:_helmet|_chestplate|_leggings|_boots)$/u;

export function hasWearableCarriedArmor(
  status: GameStatus | undefined,
): boolean {
  if (
    status === undefined ||
    !status.connected ||
    !status.spawned ||
    status.armor === null ||
    status.armor === undefined
  )
    return false;
  const slots = [
    ["head", "_helmet"],
    ["torso", "_chestplate"],
    ["legs", "_leggings"],
    ["feet", "_boots"],
  ] as const;
  return slots.some(
    ([slot, suffix]) =>
      status.armor?.[slot] === null &&
      Object.entries(status.inventory).some(
        ([item, count]) => item.endsWith(suffix) && count > 0,
      ),
  );
}

/** A short suggestion can refer to the armor in the immediately prior reply. */
export function isContextualArmorEquipSuggestion(message: string): boolean {
  const text = message.trim();
  if (
    text.length > 40 ||
    /[「」『』“”]|(?:ないで|なくていい|やめて|脱いで|外して|私|わたし|俺|僕|村人|他のプレイヤー|もし|仮に|どうなる|どう思う|着られる|できる)/u.test(
      text,
    )
  )
    return false;
  return /^(?:(?:じゃあ|なら)[、，,\s]*)?(?:(?:それ(?:を)?|その防具(?:を)?|手持ちの防具(?:を)?)[、，,\s]*)?(?:(?:身に)?着(?:たら|れば|てみたら|てみて|よう|て)|(?:身に)?着け(?:たら|れば|てみたら|てみて|よう|て)|装備し(?:たら|てみたら|てみて|よう|て)|(?:つけ|付け)(?:たら|てみたら|てみて|よう|て))(?:どう)?[?？。！!]*$/u.test(
    text,
  );
}

/** A direct request to equip the bot's own carried armor, never a question. */
export function isArmorEquipRequest(message: string): boolean {
  const text = message.trim();
  return (
    armorName.test(text) &&
    !/[?？]/u.test(text) &&
    !/(?:ないで|なくていい|いらない|禁止|やめて|脱いで|外して|取り外して|してもいい|していい|着てもいい)/u.test(
      text,
    ) &&
    !/(?:私|わたし|俺|僕|プレイヤー|利用者|村人|他のプレイヤー)(?:の|は|が|に|へ)/u.test(
      text,
    ) &&
    /(?:装備し(?:て|ろ|なさい)|着用し(?:て|ろ)|(?:つけ|付け)(?:て|ろ)(?:みて|みな)?|着て)(?:ください|下さい|くれ|みて|みな|ね|よ)?[。！!]*$/u.test(
      text,
    )
  );
}
const materialNames: Readonly<Record<string, string>> = {
  leather: "革",
  chainmail: "チェーン",
  iron: "鉄",
  golden: "金",
  diamond: "ダイヤモンド",
  netherite: "ネザライト",
};
const partNames: Readonly<Record<string, string>> = {
  helmet: "ヘルメット",
  chestplate: "チェストプレート",
  leggings: "レギンス",
  boots: "ブーツ",
};

/** Only a direct equipment-status question enters the factual fast path. */
export function classifyArmorQuestion(
  message: string,
): ArmorQuestionSubject | null {
  const text = message.trim();
  if (!armorName.test(text)) return null;
  if (
    /(?:集め|採取|掘|移動|来て|追従|戻|探|収納|建築|作っ|始め|続け|再開|使っ|置い|取っ|倒|攻撃|助け|回復|食べ|飲|治し|守っ)/u.test(
      text,
    )
  )
    return null;
  if (
    /(?:(?:装備|着用)し(?:て|ないで|ろ|なさい)|(?:着て|着ないで|脱いで|外して|取り外して))(?:ください|下さい|くれ)?[?？。！!]*$/u.test(
      text,
    ) ||
    /(?:脱がないで|外さないで)[?？。！!]*$|(?:着て|脱いで)(?:も)?(?:いい|よい|大丈夫)/u.test(
      text,
    ) ||
    /(?:(?:装備|着用)して|着て|脱いで|外して|取り外して)[、，]/u.test(text)
  )
    return null;
  if (
    /(?:装備|着用|外|脱|着)(?:し|して|せ)て?(?:も)?(?:いい|よい|大丈夫)/u.test(
      text,
    )
  )
    return null;
  if (!/(?:[?？]|ですか|ますか|教えて|どう|確認して|状態)/u.test(text))
    return null;
  if (
    /(?:私|わたし|俺|僕|自分|プレイヤー|利用者)(?:の|は|が|って|には)/u.test(
      text,
    )
  )
    return "requester";
  if (
    /(?:村人|他人|友達|敵|他のプレイヤー|ほかのプレイヤー|彼|彼女)(?:の|は|が|って|には)/u.test(
      text,
    ) ||
    (/[A-Za-z][A-Za-z0-9_]{0,31}(?:の|は|が)(?:防具|ヘルメット|胸当て|チェストプレート|レギンス|ブーツ)/u.test(
      text,
    ) &&
      !/(?:Bot|bot)(?:の|は|が)/u.test(text))
  )
    return null;
  const possessive =
    /([^\s、。？！?]{1,24})の(?:防具|ヘルメット|胸当て|チェストプレート|レギンス|ブーツ|兜|鎧)/u.exec(
      text,
    )?.[1];
  if (
    possessive !== undefined &&
    !/^(?:今|現在|Bot|bot|ボット|あなた|君|きみ|そっち|手持ち|所持品)$/u.test(
      possessive,
    )
  )
    return null;
  return "bot";
}

function itemLabel(name: string): string {
  if (name === "turtle_helmet") return "カメの甲羅";
  const parts = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/u.exec(name);
  if (parts === null) return name.replaceAll("_", " ");
  const material = materialNames[parts[1] ?? ""];
  const part = partNames[parts[2] ?? ""];
  return material !== undefined && part !== undefined
    ? `${material}の${part}`
    : name.replaceAll("_", " ");
}

export function renderArmorAnswer(
  subject: ArmorQuestionSubject,
  status: GameStatus | undefined,
): string {
  if (subject === "requester")
    return "あなたの防具の所持・装備状態は観測できていません。";
  if (status === undefined || !status.connected || !status.spawned)
    return "Bot自身の防具の所持・装備状態は現在確認できません。";

  const carried = Object.entries(status.inventory)
    .filter(([name, count]) => armorItem.test(name) && count > 0)
    .map(([name, count]) => `${itemLabel(name)}${count}個`);
  const carriedText =
    carried.length === 0
      ? "所持品に防具はありません。"
      : `所持品の防具は${carried.join("、")}です。`;
  if (status.armor === null || status.armor === undefined)
    return `Bot自身の装備スロットは未確認です。${carriedText}`;

  const slots = [
    ["頭", status.armor.head],
    ["胴", status.armor.torso],
    ["脚", status.armor.legs],
    ["足", status.armor.feet],
  ] as const;
  const equipped = slots
    .map(
      ([label, item]) =>
        `${label}は${item === null ? "未装備" : itemLabel(item)}`,
    )
    .join("、");
  return `Bot自身の装備は${equipped}です。${carriedText}`;
}
