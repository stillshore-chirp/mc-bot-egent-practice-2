import type { ToolContext } from "../tools/contracts.js";

export function buildCapabilityContext(limits: ToolContext["limits"]): string {
  return [
    "利用できる操作: Minecraftの現在状態・周囲の観測、日本語チャットの送信、認可済み利用者への安全距離追従、停止、上限距離内の移動、保護条件に従う原木の収集と帰還、構造化記憶の保存・検索、登録済み拠点と指定チェストへの原木収納です。",
    `移動距離の上限は${String(limits.maxMoveDistance)}ブロック、原木収集数の上限は${String(limits.maxGatherCount)}個です。追従・帰還には設定された安全距離を使います。`,
    "提供していない操作: 建築、任意ブロックの設置や破壊、サーバー管理、shell・ファイル操作、利用者の未観測の体調や状態の断定です。",
    "提供していない操作を頼まれたら、できないことを短く明言し、実行済みと扱わず、目的に近い利用可能な操作があれば一つだけ提案してください。",
  ].join("\n");
}
