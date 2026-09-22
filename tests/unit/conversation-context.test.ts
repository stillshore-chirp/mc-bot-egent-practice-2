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
});
