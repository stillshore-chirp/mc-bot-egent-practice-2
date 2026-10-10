const stopTeForms =
  "(?:止めて|停止して|やめて|中止して|中断して|止まって|ストップして)";
const stopTeSuffix =
  "(?:ください|下さい|ほしい(?:です)?|くれ(?![てた])|ちょうだい|お願い(?:します)?)?(?:ね|よ)?";
const stopImperatives =
  "(?:止まれ|止めろ|やめろ|停止しろ|中止しろ|中断しろ|ストップしろ|止まりなさい|止めなさい|やめなさい|停止しなさい|中止しなさい|中断しなさい)";
const targetedStopCommandPattern = new RegExp(
  `${stopTeForms}${stopTeSuffix}$|${stopImperatives}$|(?:停止|中止|中断|ストップ)$`,
  "u",
);
const deferredStopConditionPattern =
  /(?:もし|仮に|なら|たら|場合(?:は|に|$)|とき(?:は|に|$)|時(?:は|に|$)|(?:して|終わって|戻って)から)/u;
const deferredStopTimePattern =
  /(?:あとで|後で|後ほど|明日|次回|次に|(?:あと|後|今から|これから)\s*[0-9０-９一二三四五六七八九十]+\s*(?:秒|分|時間|日)(?:後|で|に|経ったら)|[0-9０-９一二三四五六七八九十]+\s*(?:秒|分|時間|日)(?:後|経ったら))/u;

function splitStopClauses(message: string): string[] {
  const punctuationClauses =
    message.match(/[^、，,。！？!?]+(?:[、，,。！？!?]|$)/gu) ?? [];
  const grouped: string[] = [];
  let deferredPrefix = "";
  for (const clause of punctuationClauses) {
    const combined = deferredPrefix + clause;
    const normalized = normalizedStopClause(combined);
    if (
      /[、，,]$/u.test(clause) &&
      hasDeferredStopPrefix(normalized) &&
      !targetedStopCommandPattern.test(normalized)
    ) {
      deferredPrefix = combined;
      continue;
    }
    grouped.push(combined);
    deferredPrefix = "";
  }
  if (deferredPrefix.length > 0) grouped.push(deferredPrefix);
  return grouped
    .flatMap((clause) => clause.split(/(?=代わりに|その代わり)/u))
    .flatMap(splitInlineStopClause)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function splitInlineStopClause(clause: string): string[] {
  if (/[?？]/u.test(clause)) return [clause];
  const normalized = normalizedStopClause(clause);
  const commands = new RegExp(
    `${stopTeForms}${stopTeSuffix}|${stopImperatives}`,
    "gu",
  );
  for (const match of normalized.matchAll(commands)) {
    const end = match.index + match[0].length;
    const stop = normalized.slice(0, end).trim();
    const rest = normalized.slice(end).trim();
    if (
      rest.length > 0 &&
      isStopClause(stop) &&
      (!/ほしい(?:です)?(?:ね|よ)?$/u.test(match[0]) ||
        /^(?:今すぐ|すぐに?|直ちに|ただちに)$/u.test(rest)) &&
      !/(?:ない|ません|ではない|じゃない|不要|しまった|かどうか|^い(?:る|た|ました)|^みた|^もら|^くれた|^くれて|^いい|^よい|^良い|^と|^って|^は)/u.test(
        rest,
      )
    ) {
      return [stop, rest];
    }
  }
  return [clause];
}

function normalizedStopClause(clause: string): string {
  return clause.replace(/[、，,。！!]$/u, "").trim();
}

function hasDeferredStopPrefix(prefix: string): boolean {
  return (
    deferredStopConditionPattern.test(prefix) ||
    deferredStopTimePattern.test(prefix)
  );
}

function isStopClause(clause: string): boolean {
  if (/[?？]/u.test(clause)) return false;
  const normalized = normalizedStopClause(clause);
  if (/[「」『』“”"'`]/u.test(normalized)) return false;
  const command = targetedStopCommandPattern.exec(normalized);
  if (command === null) return false;
  return !hasDeferredStopPrefix(normalized.slice(0, command.index));
}

/** Detect an immediate owner stop request without treating quotes or future conditions as commands. */
export function isImmediateStopCommand(message: string): boolean {
  const normalized = message.trim().replace(/\s+/gu, " ");
  return splitStopClauses(normalized).some(isStopClause);
}
