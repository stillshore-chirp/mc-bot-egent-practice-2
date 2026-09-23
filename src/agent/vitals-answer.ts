import type { GameStatus } from "../tools/contracts.js";

type Vital = "health" | "food" | "oxygen" | "water";

const requesterWords =
  /(?:私|わたし|僕|ぼく|俺|自分|こっち|プレイヤー|利用者|ユーザー)/u;
const botWords = /(?:あなた|君|きみ|Bot|ボット|そっち|お前)/iu;
const actionWords =
  /(?:集め|採取|掘|移動|来て|追従|戻|探|収納|建築|作っ|始め|続け|再開|使っ|置い|取っ|倒|攻撃|助け|回復|食べ|飲ん|治し|守っ)/u;

export interface VitalsQuestion {
  readonly bot: boolean;
  readonly requester: boolean;
  readonly vitals: readonly Vital[];
}

/** Route direct vital questions to observed Bot data and an explicit owner unknown. */
export function classifyVitalsQuestion(message: string): VitalsQuestion | null {
  const normalized = message.trim();
  const questionMark = normalized.search(/[?？]/u);
  if (
    questionMark >= 0 &&
    !/^[。！!]*$/u.test(normalized.slice(questionMark + 1).trim())
  )
    return null;
  if (
    questionMark < 0 &&
    !/(?:ですか|でしょうか|かな|教えて|どう|大丈夫|よね)[。！!]*$/u.test(
      normalized,
    )
  )
    return null;
  if (actionWords.test(normalized)) return null;
  const genitiveSubject =
    /([^\s、。？！?]+)の(?:体力|HP|ヘルス|空腹|満腹|食料ゲージ|酸素|呼吸|水中状態)/iu.exec(
      normalized,
    )?.[1];
  if (genitiveSubject !== undefined) {
    const nearestSubject = genitiveSubject.split("の").at(-1) ?? "";
    if (!requesterWords.test(nearestSubject) && !botWords.test(nearestSubject))
      return null;
  }
  const vitals: Vital[] = [];
  if (/(?:体力|HP|ヘルス)/iu.test(normalized)) vitals.push("health");
  if (/(?:空腹|満腹|食料ゲージ)/u.test(normalized)) vitals.push("food");
  if (
    /(?:酸素|呼吸|溺れ|息(?=[はがをも、。？！?\s]|切れ|でき|苦し))/u.test(
      normalized,
    )
  )
    vitals.push("oxygen");
  if (/(?:水中|水の中|泳い|溺れ)/u.test(normalized)) vitals.push("water");
  if (vitals.length === 0) return null;
  const requester = requesterWords.test(normalized);
  const bot = botWords.test(normalized);
  if (!requester && !bot) return null;
  return {
    requester,
    bot,
    vitals,
  };
}

export function renderVitalsAnswer(
  question: VitalsQuestion,
  status: GameStatus | undefined,
): string {
  const statements: string[] = [];
  if (question.bot) {
    if (status === undefined || !status.connected || !status.spawned) {
      statements.push("Bot自身の状態は現在確認できません。");
    } else {
      const observed: string[] = [];
      if (question.vitals.includes("health"))
        observed.push(`体力は${String(status.health)}/20`);
      if (question.vitals.includes("food"))
        observed.push(`満腹度は${String(status.food)}/20`);
      if (question.vitals.includes("water"))
        observed.push(status.inWater ? "水中にいます" : "水中にはいません");
      if (question.vitals.includes("oxygen")) {
        observed.push(
          !status.inWater
            ? "地上にいて酸素低下は観測していません"
            : status.oxygen === null || status.oxygenState === "unknown"
              ? "酸素は確認できません"
              : `酸素は${String(status.oxygen)}/20`,
        );
      }
      statements.push(`Bot自身の観測では、${observed.join("、")}。`);
    }
  }
  if (question.requester) {
    const labels = question.vitals.map((vital) =>
      vital === "health"
        ? "体力"
        : vital === "food"
          ? "満腹度"
          : vital === "oxygen"
            ? "酸素"
            : "水中状態",
    );
    statements.push(`あなたの${labels.join("・")}は観測できていません。`);
  }
  return statements.join("").trim();
}
