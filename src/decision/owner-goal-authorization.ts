import type { SafeChoiceAuthorization } from "./safe-choice.js";

export interface OwnerGoalAuthorizationInput {
  readonly message: string;
  readonly requesterUsername: string;
  readonly authorizedOwnerUsername: string;
  readonly requestKind: "owner_message" | "runtime_reassessment";
  readonly maxCount: number;
  readonly pendingGoal?: PendingOwnerGoal;
  readonly nowMs?: number;
}

export interface PendingOwnerGoal {
  readonly ownerUsername: string;
  readonly goal: string;
  readonly label: string;
  readonly allowedResources: readonly string[];
  readonly targetItem: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly remainingTurns: number;
}

export type OwnerGoalAuthorizationDecision =
  | {
      readonly outcome: "authorized";
      readonly authorization: Extract<
        SafeChoiceAuthorization,
        { kind: "owner_bounded_resource" }
      >;
    }
  | {
      readonly outcome: "clarify";
      readonly question: string;
      readonly pendingGoal?: PendingOwnerGoal;
    }
  | { readonly outcome: "none" };

export const ownerGoalPendingTtlMs = 5 * 60_000;

interface ResourceGoal {
  readonly label: string;
  readonly aliases: readonly string[];
  readonly allowedResources: readonly string[];
  readonly targetItem: string;
}

const resourceGoals: readonly ResourceGoal[] = [
  {
    label: "原木",
    aliases: ["原木", "木材", "log", "logs", "wood"],
    allowedResources: [
      "oak_log",
      "spruce_log",
      "birch_log",
      "jungle_log",
      "acacia_log",
      "dark_oak_log",
      "mangrove_log",
      "cherry_log",
      "pale_oak_log",
      "crimson_stem",
      "warped_stem",
    ],
    targetItem: "*",
  },
  {
    label: "鉄インゴット",
    aliases: ["鉄インゴット", "iron ingot", "iron_ingot"],
    allowedResources: ["iron_ore", "deepslate_iron_ore"],
    targetItem: "iron_ingot",
  },
  {
    label: "鉄",
    aliases: ["鉄鉱石", "鉄", "raw iron", "raw_iron", "iron ore", "iron"],
    allowedResources: ["iron_ore", "deepslate_iron_ore"],
    targetItem: "raw_iron",
  },
  {
    label: "石炭",
    aliases: ["石炭鉱石", "石炭", "coal ore", "coal_ore", "coal"],
    allowedResources: ["coal_ore", "deepslate_coal_ore"],
    targetItem: "coal",
  },
  {
    label: "銅",
    aliases: [
      "銅鉱石",
      "銅",
      "raw copper",
      "raw_copper",
      "copper ore",
      "copper",
    ],
    allowedResources: ["copper_ore", "deepslate_copper_ore"],
    targetItem: "raw_copper",
  },
  {
    label: "オークの原木",
    aliases: ["オークの原木", "オーク", "oak_log", "oak log"],
    allowedResources: ["oak_log"],
    targetItem: "oak_log",
  },
  {
    label: "トウヒの原木",
    aliases: ["トウヒの原木", "トウヒ", "spruce_log", "spruce log"],
    allowedResources: ["spruce_log"],
    targetItem: "spruce_log",
  },
  {
    label: "シラカバの原木",
    aliases: [
      "シラカバの原木",
      "シラカバ",
      "白樺の原木",
      "白樺",
      "birch_log",
      "birch log",
    ],
    allowedResources: ["birch_log"],
    targetItem: "birch_log",
  },
  {
    label: "ジャングルの原木",
    aliases: ["ジャングルの原木", "ジャングル", "jungle_log", "jungle log"],
    allowedResources: ["jungle_log"],
    targetItem: "jungle_log",
  },
  {
    label: "アカシアの原木",
    aliases: ["アカシアの原木", "アカシア", "acacia_log", "acacia log"],
    allowedResources: ["acacia_log"],
    targetItem: "acacia_log",
  },
  {
    label: "ダークオークの原木",
    aliases: [
      "ダークオークの原木",
      "ダークオーク",
      "dark_oak_log",
      "dark oak log",
    ],
    allowedResources: ["dark_oak_log"],
    targetItem: "dark_oak_log",
  },
  {
    label: "マングローブの原木",
    aliases: [
      "マングローブの原木",
      "マングローブ",
      "mangrove_log",
      "mangrove log",
    ],
    allowedResources: ["mangrove_log"],
    targetItem: "mangrove_log",
  },
  {
    label: "サクラの原木",
    aliases: [
      "サクラの原木",
      "桜の原木",
      "サクラ",
      "桜",
      "cherry_log",
      "cherry log",
    ],
    allowedResources: ["cherry_log"],
    targetItem: "cherry_log",
  },
  {
    label: "ペールオークの原木",
    aliases: [
      "ペールオークの原木",
      "ペールオーク",
      "pale_oak_log",
      "pale oak log",
    ],
    allowedResources: ["pale_oak_log"],
    targetItem: "pale_oak_log",
  },
  {
    label: "真紅の幹",
    aliases: ["真紅の幹", "crimson_stem", "crimson stem"],
    allowedResources: ["crimson_stem"],
    targetItem: "crimson_stem",
  },
  {
    label: "歪んだ幹",
    aliases: ["歪んだ幹", "warped_stem", "warped stem"],
    allowedResources: ["warped_stem"],
    targetItem: "warped_stem",
  },
];

const affirmativeCollectionIntentPattern =
  /(?:集め(?:て|たい|よう)|採掘(?:して|したい|しよう)|掘(?:って|りたい|ろう)|採取(?:して|したい|しよう)|持ってき(?:て|たい|てね)|取ってき(?:て|たい|てね)|作(?:って|りたい|ろう)|作成(?:して|したい|しよう)|精錬(?:して|したい|しよう)|(?:mine|collect|gather|obtain|fetch|harvest|craft|smelt)\b)/iu;
const negatedCollectionIntentPattern =
  /(?:集め|採掘|掘|採取|持ってき|持ってこ|取ってき|取ってこ|作|作成|精錬)(?:ない|ません|ず|ないで|しないで|しない|するな|るな)|(?:集め|採掘し|掘っ|採取し|持ってき|取ってき|作っ|作成し|精錬し)て(?:は|ほしく)ない|(?:do not|don't|never|cancel)\s+(?:mine|collect|gather|obtain|fetch|harvest|craft|smelt)|(?:mine|collect|gather|obtain|fetch|harvest|craft|smelt)\s+(?:not|never|cancel)/iu;
const collectionPermissionQuestionPattern =
  /(?:集め|採掘し|掘っ|採取し|持ってき|取ってき|作っ|作成し|精錬し)て(?:も)?(?:いい|よい|良い|大丈夫|問題ない|はいけない)/iu;
const operationWords = new Set([
  "collect_resource",
  "gather_resource",
  "mine_resource",
  "plan_safe_action",
]);

/**
 * Known block-drop and smelting outputs. A canonical resource ID is only
 * authorized automatically when this table can identify the final inventory
 * item. Providers still have to return the same final item in their observed
 * candidate and verified action result.
 */
const canonicalResourceOutputs: Readonly<Record<string, string>> = {
  ancient_debris: "netherite_scrap",
  coal_ore: "coal",
  copper_ore: "raw_copper",
  diamond_ore: "diamond",
  emerald_ore: "emerald",
  gold_ore: "raw_gold",
  iron_ore: "raw_iron",
  lapis_ore: "lapis_lazuli",
  nether_gold_ore: "gold_nugget",
  nether_quartz_ore: "quartz",
  redstone_ore: "redstone",
};

/**
 * Derives a bounded resource authorization from the authenticated owner's
 * current message and, for one short-lived follow-up, a typed pending goal.
 * The result is intentionally ephemeral and never read from memory or from a
 * model-selected tool argument.
 */
export function deriveOwnerGoalAuthorization(
  input: OwnerGoalAuthorizationInput,
): OwnerGoalAuthorizationDecision {
  if (
    input.requestKind !== "owner_message" ||
    input.requesterUsername !== input.authorizedOwnerUsername
  ) {
    return { outcome: "none" };
  }

  const message = normalize(input.message);
  const nowMs = input.nowMs ?? Date.now();
  const namedResource = resourceGoals
    .flatMap((goal) => goal.aliases.map((alias) => ({ alias, goal })))
    .filter(({ alias }) => containsAlias(message, alias))
    .sort(
      (left, right) =>
        normalize(right.alias).length - normalize(left.alias).length,
    )[0]?.goal;
  const resource = namedResource ?? canonicalResourceGoal(message);
  const unresolvedCanonicalResource =
    namedResource === undefined && resource === undefined
      ? canonicalResourceId(message)
      : undefined;
  const count = parseCount(message);
  const hasCollectionIntent = affirmativeCollectionIntentPattern.test(message);
  const hasNegatedCollectionIntent =
    negatedCollectionIntentPattern.test(message);
  const asksCollectionPermission =
    collectionPermissionQuestionPattern.test(message);

  const pendingGoal = input.pendingGoal;
  const pendingGoalValid =
    pendingGoal !== undefined &&
    isPendingGoalValid(pendingGoal, input.authorizedOwnerUsername, nowMs);
  if (
    pendingGoalValid &&
    resource === undefined &&
    isStandaloneQuantityReply(message)
  ) {
    if (count === undefined) {
      return {
        outcome: "clarify",
        question: `数量を数字で指定してください（上限${String(input.maxCount)}個）。`,
      };
    }
    return authorizePendingGoal(pendingGoal, count, input.maxCount);
  }

  if (
    pendingGoalValid &&
    resource === undefined &&
    count !== undefined &&
    hasCollectionQuantityUnit(message)
  ) {
    return {
      outcome: "clarify",
      question:
        "前の資源収集の数量回答は、数量だけで指定してください（例: 20個で）。",
    };
  }

  if (hasNegatedCollectionIntent || asksCollectionPermission) {
    return {
      outcome: "clarify",
      question:
        "実行を求める指示と確認・禁止を区別できないため、採取・採掘・作成・精錬は開始しません。実行する場合は目的と数量を指示してください。",
    };
  }

  if (!hasCollectionIntent) {
    return { outcome: "none" };
  }
  if (resource === undefined) {
    if (unresolvedCanonicalResource !== undefined) {
      return {
        outcome: "clarify",
        question: `${unresolvedCanonicalResource}のドロップまたは精錬後の最終アイテムを確認できません。目標アイテム名を指定してください。`,
      };
    }
    return {
      outcome: "clarify",
      question:
        "集める資源を具体的に指定してください（鉄、鉄インゴット、石炭、銅など）。",
    };
  }
  if (count === undefined) {
    return {
      outcome: "clarify",
      question: `目的は${resource.label}の収集として理解しました。数量を指定してください（上限${String(input.maxCount)}個）。`,
      pendingGoal: createPendingGoal(
        resource,
        input.authorizedOwnerUsername,
        nowMs,
      ),
    };
  }
  if (!Number.isInteger(input.maxCount) || input.maxCount < 1) {
    return {
      outcome: "clarify",
      question:
        "この操作の数量上限を確認できません。数量上限を設定してから再依頼してください。",
    };
  }
  if (count > input.maxCount) {
    return {
      outcome: "clarify",
      question: `指定数が上限を超えています。${resource.label}は${String(input.maxCount)}個以下で指定してください。`,
    };
  }

  return {
    outcome: "authorized",
    authorization: {
      kind: "owner_bounded_resource",
      goal: message,
      allowedResources: resource.allowedResources,
      targetItem: resource.targetItem,
      targetCount: count,
      maxCount: input.maxCount,
      ...(resource.targetItem === "*" ? { selectionRequired: true } : {}),
    },
  };
}

function authorizePendingGoal(
  pendingGoal: PendingOwnerGoal,
  count: number,
  maxCount: number,
): OwnerGoalAuthorizationDecision {
  if (!Number.isInteger(maxCount) || maxCount < 1) {
    return {
      outcome: "clarify",
      question:
        "この操作の数量上限を確認できません。数量上限を設定してから再依頼してください。",
    };
  }
  if (count > maxCount) {
    return {
      outcome: "clarify",
      question: `指定数が上限を超えています。${pendingGoal.label}は${String(maxCount)}個以下で指定してください。`,
    };
  }
  return {
    outcome: "authorized",
    authorization: {
      kind: "owner_bounded_resource",
      goal: pendingGoal.goal,
      allowedResources: pendingGoal.allowedResources,
      targetItem: pendingGoal.targetItem,
      targetCount: count,
      maxCount,
      ...(pendingGoal.targetItem === "*" ? { selectionRequired: true } : {}),
    },
  };
}

function createPendingGoal(
  resource: ResourceGoal,
  ownerUsername: string,
  nowMs: number,
): PendingOwnerGoal {
  return {
    ownerUsername,
    goal: resource.label,
    label: resource.label,
    allowedResources: resource.allowedResources,
    targetItem: resource.targetItem,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ownerGoalPendingTtlMs,
    remainingTurns: 1,
  };
}

function isPendingGoalValid(
  pendingGoal: PendingOwnerGoal,
  authorizedOwnerUsername: string,
  nowMs: number,
): boolean {
  return (
    pendingGoal.ownerUsername === authorizedOwnerUsername &&
    pendingGoal.remainingTurns === 1 &&
    Number.isInteger(pendingGoal.createdAtMs) &&
    Number.isInteger(pendingGoal.expiresAtMs) &&
    pendingGoal.expiresAtMs >= pendingGoal.createdAtMs &&
    nowMs <= pendingGoal.expiresAtMs
  );
}

function isStandaloneQuantityReply(message: string): boolean {
  return /^(?:あと\s*)?[0-9]{1,3}\s*(?:個|つ|本|枚|ブロック|items?|blocks?)(?:\s*(?:で|お願いします|お願い|ください|ね))*$/iu.test(
    message,
  );
}

function hasCollectionQuantityUnit(message: string): boolean {
  return /[0-9]\s*(?:個|つ|本|枚|ブロック|items?|blocks?)/iu.test(message);
}

function normalize(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("ja-JP")
    .replace(/[０-９]/gu, (digit) =>
      String.fromCharCode(
        digit.charCodeAt(0) - "０".charCodeAt(0) + "0".charCodeAt(0),
      ),
    )
    .replace(/\s+/gu, " ");
}

function containsAlias(message: string, alias: string): boolean {
  const normalizedAlias = normalize(alias);
  if (/^[a-z0-9_ ]+$/iu.test(normalizedAlias)) {
    const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, "iu").test(
      message,
    );
  }
  return message.includes(normalizedAlias);
}

function parseCount(message: string): number | undefined {
  const match =
    /(?:^|[^0-9])([0-9]{1,3})\s*(?:個|つ|本|枚|ブロック|個分|items?|blocks?)(?=\s|$|[^0-9])/iu.exec(
      message,
    );
  if (match === null) return undefined;
  const count = Number(match[1]);
  return Number.isInteger(count) && count > 0 ? count : undefined;
}

function canonicalResourceGoal(message: string): ResourceGoal | undefined {
  const id = canonicalResourceId(message);
  if (id === undefined) return undefined;
  const targetItem = canonicalTargetItem(id);
  if (targetItem === undefined) return undefined;
  return {
    label: id,
    aliases: [id],
    allowedResources: [id],
    targetItem,
  };
}

function canonicalResourceId(message: string): string | undefined {
  const matches = message.matchAll(
    /(?<![a-z0-9_])([a-z][a-z0-9_]{2,})(?![a-z0-9_])/giu,
  );
  for (const match of matches) {
    const id = match[1];
    if (id === undefined || operationWords.has(id) || !id.includes("_")) {
      continue;
    }
    return id;
  }
  return undefined;
}

function canonicalTargetItem(resourceId: string): string | undefined {
  const baseId = resourceId.replace(/^deepslate_/u, "");
  const knownOutput =
    canonicalResourceOutputs[resourceId] ?? canonicalResourceOutputs[baseId];
  if (knownOutput !== undefined) return knownOutput;
  if (resourceId.endsWith("_log") || resourceId.endsWith("_stem")) {
    return resourceId;
  }
  if (!resourceId.endsWith("_ore")) {
    return resourceId;
  }
  return undefined;
}
