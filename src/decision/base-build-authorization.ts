export type BaseBuildDecision =
  | { readonly kind: "none" }
  | { readonly kind: "authorized"; readonly resume: boolean }
  | { readonly kind: "clarify"; readonly question: string };

/** The model never grants the world-changing base-build scope to itself. */
export function decideBaseBuildRequest(
  message: string,
  previousBaseIsIncomplete: boolean,
): BaseBuildDecision {
  const text = message.trim();
  if (text.length === 0 || /[?？]/u.test(text)) return { kind: "none" };
  if (
    /(?:建て|設営|建築|作)(?:ら|て)?(?:ないで|なくて|ない|るな)|(?:やめて|キャンセル|中止)/u.test(
      text,
    )
  )
    return { kind: "none" };
  const resume =
    previousBaseIsIncomplete &&
    /(?:拠点|家|小屋).{0,15}(?:再開|続け|続きを)|(?:再開|続け|続きを).{0,15}(?:拠点|家|小屋)|^(?:再開して|続きをやって|続けて)(?:ください|ね)?$/u.test(
      text,
    );
  const build =
    /(?:拠点|家|小屋|シェルター).{0,25}(?:建てて|建築して|設営して|作って)|(?:建てて|建築して|設営して|作って).{0,25}(?:拠点|家|小屋|シェルター)/u.test(
      text,
    );
  if (!resume && !build) return { kind: "none" };
  if (/(?:石|丸石|レンガ|トウヒ|シラカバ|鉄|ネザー|コンクリート)/u.test(text))
    return {
      kind: "clarify",
      question:
        "現在はオークの板材の小屋を設営できます。材料をオークの板材にしてよいですか。",
    };
  if (/(?:[4-9]\s*[×xX]\s*[4-9]|大き|広い|巨大|城|豪邸|二階|2階)/u.test(text))
    return {
      kind: "clarify",
      question:
        "現在の安全な上限は3×3の小屋一つです。この規模で進めてよいですか。",
    };
  if (/(?:座標|遠く|別の場所|村の中|指定した場所)/u.test(text))
    return {
      kind: "clarify",
      question:
        "現在地付近の平坦で保護されていない区画から選びます。その場所で進めてよいですか。",
    };
  if (
    /(?:保護区域|保護区画|保護された|私有地|領地|他人の|建築禁止)/u.test(text)
  )
    return {
      kind: "clarify",
      question:
        "保護されていない近隣の区画だけを候補にできます。その条件で進めてよいですか。",
    };
  if (
    /(?:上限|以内|まで|以下).{0,12}(?:個|ブロック|原木|丸太)|\d+\s*(?:個|ブロック|本).{0,12}(?:まで|以内|以下)/u.test(
      text,
    )
  )
    return {
      kind: "clarify",
      question:
        "既定の上限は設置23ブロック、採取する原木6本です。この範囲で進めてよいですか。",
    };
  return { kind: "authorized", resume };
}
