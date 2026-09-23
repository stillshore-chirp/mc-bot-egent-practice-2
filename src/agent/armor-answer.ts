import type { GameStatus } from "../tools/contracts.js";

export type ArmorQuestionSubject = "bot" | "requester";

const armorName =
  /(?:防具|装備|ヘルメット|胸当て|チェストプレート|レギンス|ブーツ|兜|鎧)/u;
const armorItem = /(?:_helmet|_chestplate|_leggings|_boots)$/u;
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
  if (/(?:装備|着用|外|脱|着)して[?？]?$/u.test(text)) return null;
  if (
    /(?:装備|着用|外|脱|着)(?:し|して|せ)て?(?:も)?(?:いい|よい|大丈夫)/u.test(
      text,
    )
  )
    return null;
  if (!/(?:[?？]|ですか|ますか|教えて|どう|確認して|状態)/u.test(text))
    return null;
  if (/(?:私|わたし|俺|僕|自分|プレイヤー|利用者)の(?:防具|装備)/u.test(text))
    return "requester";
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
