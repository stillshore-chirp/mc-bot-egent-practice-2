import { describe, expect, it } from "vitest";

import {
  ConversationContextStore,
  renderConversationContext,
  updateConversationPreferences,
} from "../../src/agent/conversation-context.js";

describe("conversation context", () => {
  it("keeps a bounded recent window and carries explanation preferences", () => {
    const store = new ConversationContextStore();
    store.recordUser("owner", "目の前の木を選んで。");
    store.recordAssistant("owner", "目の前の木を選びます。");
    store.recordUser("owner", "短く、専門用語を使わないで。");

    const snapshot = store.snapshot("owner");
    expect(snapshot.turns).toEqual([
      { role: "user", text: "目の前の木を選んで。" },
      { role: "assistant", text: "目の前の木を選びます。" },
      { role: "user", text: "短く、専門用語を使わないで。" },
    ]);
    expect(snapshot.preferences).toEqual({ concise: true, avoidJargon: true });
    expect(renderConversationContext(snapshot)).toContain(
      "利用者の説明方法の希望: 短く要点だけ話す。",
    );
    expect(renderConversationContext(snapshot)).toContain(
      "利用者の説明方法の希望: 内部名や専門用語を使わず、平易に話す。",
    );
    expect(renderConversationContext(snapshot)).not.toContain(
      "目の前の木を選んで",
    );

    for (let index = 0; index < 10; index += 1) {
      store.recordUser("owner", `追加の依頼${String(index)}`);
    }
    expect(store.snapshot("owner").turns).toHaveLength(8);
    expect(store.snapshot("owner").turns[0]?.text).toBe("追加の依頼2");
  });

  it("allows a later explicit explanation preference to replace the old one", () => {
    const updated = updateConversationPreferences(
      { concise: true, avoidJargon: true },
      "詳しく説明して。専門用語も使っていい。",
    );
    expect(updated).toEqual({ concise: false, avoidJargon: false });
  });

  it("keeps concise wording when detail is explicitly negated", () => {
    expect(
      updateConversationPreferences(
        { concise: true, avoidJargon: false },
        "詳しく説明しないで、要点だけでいい。",
      ),
    ).toEqual({ concise: true, avoidJargon: false });
    expect(
      updateConversationPreferences(
        { concise: false, avoidJargon: false },
        "詳しくなくていい。",
      ),
    ).toEqual({ concise: true, avoidJargon: false });
  });

  it("keeps jargon avoidance for polite negative requests", () => {
    expect(
      updateConversationPreferences(
        { concise: false, avoidJargon: true },
        "専門用語は使いません。",
      ),
    ).toEqual({ concise: false, avoidJargon: true });
    expect(
      updateConversationPreferences(
        { concise: false, avoidJargon: true },
        "専門用語を使いたくないです。",
      ),
    ).toEqual({ concise: false, avoidJargon: true });
  });

  it("keeps a cancellation boundary until the user explicitly resumes", () => {
    const store = new ConversationContextStore();
    store.recordUser("owner", "木を集めて。");
    store.recordAssistant("owner", "木を探します。");
    store.recordCancellation("owner");

    const snapshot = store.snapshot("owner");
    expect(snapshot.cancelledGoal).toBe(true);
    expect(renderConversationContext(snapshot)).toContain(
      "直前の作業は停止済みです",
    );
    expect(renderConversationContext(snapshot)).toContain(
      "明示された場合だけ再開",
    );
  });

  it("allows jargon again when the user permits avoiding it", () => {
    expect(
      updateConversationPreferences(
        { concise: false, avoidJargon: true },
        "専門用語を避けなくていい。",
      ),
    ).toEqual({ concise: false, avoidJargon: false });
  });
});
