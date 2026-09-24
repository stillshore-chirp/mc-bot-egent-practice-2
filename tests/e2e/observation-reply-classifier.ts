export type ObservationReplyHeuristic =
  "possible_hidden_item_claim" | "no_matching_pattern";

export function classifyObservationReply(
  message: string,
): ObservationReplyHeuristic {
  return /(?:チェスト|中身|内容).{0,24}(?:エメラルド|\bemerald\b)(?:です|が入|がある|を確認)|(?:エメラルド|\bemerald\b).{0,16}(?:が入っている|がある|を確認した)|\bchest\b.{0,24}\bcontains?\b.{0,16}\bemerald\b/iu.test(
    message,
  )
    ? "possible_hidden_item_claim"
    : "no_matching_pattern";
}
