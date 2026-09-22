import { describe, expect, it } from "vitest";

import {
  ConversationContextStore,
  explicitlyAuthorizedActionFamilies,
  explicitlyProhibitedActionFamilies,
  isExplicitGoalResumeMessage,
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
    expect(
      updateConversationPreferences(
        { concise: false, avoidJargon: true },
        "斧を使っていい。",
      ),
    ).toEqual({ concise: false, avoidJargon: true });
  });

  it("clears the cancellation boundary after an explicit restart", () => {
    const store = new ConversationContextStore();
    store.recordUser("owner", "木を集めて。");
    store.recordCancellation("owner");
    store.recordUser("owner", "再開して。");

    expect(store.snapshot("owner").cancelledGoal).toBe(false);
    expect(store.snapshot("owner").prohibitedActionFamilies).not.toContain(
      "gather",
    );
  });

  it("uses the interrupted request to scope a short restart", () => {
    const store = new ConversationContextStore();
    store.recordCancellation("owner", "木を集めて");
    store.recordUser("owner", "再開して");

    expect(store.snapshot("owner").cancelledGoal).toBe(false);
    expect(store.snapshot("owner").prohibitedActionFamilies).not.toContain(
      "gather",
    );
  });

  it("retains a prohibited action when a different action replaces the stopped goal", () => {
    const store = new ConversationContextStore();
    store.recordUser("owner", "木を集めて。");
    store.recordCancellation("owner");
    store.recordUser("owner", "採取は再開しないで、拠点に戻って。");

    expect(store.snapshot("owner").cancelledGoal).toBe(false);
    expect(store.snapshot("owner").prohibitedActionFamilies).toContain(
      "gather",
    );
    expect(store.snapshot("owner").prohibitedActionFamilies).not.toContain(
      "return",
    );
    store.recordUser("owner", "続けて。");
    expect(store.snapshot("owner").prohibitedActionFamilies).toContain(
      "gather",
    );
  });

  it("applies an owner prohibition before a reply is delivered", () => {
    const store = new ConversationContextStore();
    store.recordOwnerSafetyIntent("owner", "採取しないで");

    expect(store.snapshot("owner").prohibitedActionFamilies).toContain(
      "gather",
    );
    expect(store.snapshot("owner").turns).toEqual([]);
  });

  it("lifts a family's prohibition when the owner explicitly requests that action", () => {
    const store = new ConversationContextStore();
    store.recordUser("owner", "木を集めて。");
    store.recordCancellation("owner");
    store.recordUser("owner", "同じ木を採取して。");

    expect(store.snapshot("owner").cancelledGoal).toBe(false);
    expect(store.snapshot("owner").prohibitedActionFamilies).not.toContain(
      "gather",
    );
  });

  it("does not let a generic restart undo an explicit prohibition", () => {
    const store = new ConversationContextStore();
    store.recordUser("owner", "木を集めて。");
    store.recordCancellation("owner");
    store.recordUser("owner", "採取しないで。");
    store.recordUser("owner", "再開して。");

    expect(store.snapshot("owner").cancelledGoal).toBe(true);
    expect(store.snapshot("owner").prohibitedActionFamilies).toContain(
      "gather",
    );
    store.recordUser("owner", "木を採取して。");
    expect(store.snapshot("owner").cancelledGoal).toBe(false);
    expect(store.snapshot("owner").prohibitedActionFamilies).not.toContain(
      "gather",
    );
  });

  it("extracts the authorized return without granting a prohibited gathering action", () => {
    const message = "採取は再開しないで、拠点に戻って。";
    expect(explicitlyAuthorizedActionFamilies(message)).toEqual(["return"]);
    expect(explicitlyProhibitedActionFamilies(message)).toEqual(["gather"]);
    expect(
      explicitlyAuthorizedActionFamilies("追従しないで採取して。"),
    ).toEqual(["gather"]);
    expect(
      explicitlyAuthorizedActionFamilies("採取は再開しないで拠点に戻って。"),
    ).toEqual(["return"]);
    expect(
      explicitlyAuthorizedActionFamilies("拠点に戻って追従しないで。"),
    ).toEqual(["return"]);
    expect(
      explicitlyProhibitedActionFamilies("採取を止めてほしい理由を教えて。"),
    ).toEqual([]);
    expect(
      explicitlyProhibitedActionFamilies("採取して追従して採取しないで。"),
    ).toEqual(["gather"]);
  });

  it("keeps the cancellation boundary for negated or status-only messages", () => {
    for (const message of [
      "採取は再開しないで。",
      "移動しなくていい。",
      "停止できたか確認して。",
      "再開していい？",
      "再開してはいけない。",
      "来てほしくない。",
      "集めていい？",
      "来ていい？",
      "戻っていい？",
      "来ないで。",
    ]) {
      const store = new ConversationContextStore();
      store.recordCancellation("owner");
      store.recordUser("owner", message);

      expect(store.snapshot("owner").cancelledGoal).toBe(true);
    }
  });

  it("allows an explicit replacement action after a prohibition", () => {
    const store = new ConversationContextStore();
    store.recordCancellation("owner");
    store.recordUser("owner", "採取は再開しないで、拠点に戻って。");

    expect(store.snapshot("owner").cancelledGoal).toBe(false);
  });

  it("keeps an earlier affirmative action when a different action is prohibited", () => {
    const store = new ConversationContextStore();
    store.recordCancellation("owner");
    store.recordUser("owner", "拠点に戻って追従しないで");

    expect(store.snapshot("owner").cancelledGoal).toBe(false);
    expect(isExplicitGoalResumeMessage("戻って来て追従しないで")).toBe(true);
    expect(isExplicitGoalResumeMessage("戻ってないで")).toBe(false);
    expect(isExplicitGoalResumeMessage("追従して追従しないで")).toBe(false);
    expect(isExplicitGoalResumeMessage("木を集めて採取しないで")).toBe(false);
    expect(isExplicitGoalResumeMessage("説明を続けて追従しないで")).toBe(false);
  });

  it("requires an explicit action before lifting a stop boundary", () => {
    expect(isExplicitGoalResumeMessage("もっと短く。")).toBe(false);
    expect(isExplicitGoalResumeMessage("専門用語を使って説明して。")).toBe(
      false,
    );
    expect(isExplicitGoalResumeMessage("例を使って説明して。")).toBe(false);
    expect(isExplicitGoalResumeMessage("例を作って説明して。")).toBe(false);
    expect(isExplicitGoalResumeMessage("要約を作って。")).toBe(false);
    expect(isExplicitGoalResumeMessage("手順を作って説明して。")).toBe(false);
    expect(isExplicitGoalResumeMessage("説明を続けて。")).toBe(false);
    expect(isExplicitGoalResumeMessage("説明を再開して。")).toBe(false);
    expect(isExplicitGoalResumeMessage("説明を始めて。")).toBe(false);
    expect(isExplicitGoalResumeMessage("話をもう一度やって。")).toBe(false);
    expect(isExplicitGoalResumeMessage("もう戻ってきた？")).toBe(false);
    expect(isExplicitGoalResumeMessage("木を集めてくれた？")).toBe(false);
    expect(isExplicitGoalResumeMessage("拠点へ移動してくれた？")).toBe(false);
    expect(isExplicitGoalResumeMessage("木を集めてくれた")).toBe(false);
    expect(isExplicitGoalResumeMessage("戻ってきた。")).toBe(false);
    expect(isExplicitGoalResumeMessage("採取を始めていい？")).toBe(false);
    expect(isExplicitGoalResumeMessage("説明を続けてください。")).toBe(false);
    expect(isExplicitGoalResumeMessage("理由を探して。")).toBe(false);
    expect(isExplicitGoalResumeMessage("鉄の剣を作って。")).toBe(false);
    expect(isExplicitGoalResumeMessage("例を作って、木を集めて。")).toBe(true);
    expect(isExplicitGoalResumeMessage("集めていい？")).toBe(false);
    expect(
      isExplicitGoalResumeMessage("採取は再開しないで、拠点に戻って。"),
    ).toBe(true);
    expect(
      isExplicitGoalResumeMessage("採取は再開しないで代わりに拠点へ戻って。"),
    ).toBe(true);
    expect(isExplicitGoalResumeMessage("座標10,64,10へ行って。")).toBe(true);
    expect(isExplicitGoalResumeMessage("この場所を覚えて。")).toBe(true);
    expect(isExplicitGoalResumeMessage("採取を再開して。")).toBe(true);
    expect(isExplicitGoalResumeMessage("追従を始めて。")).toBe(true);
    expect(isExplicitGoalResumeMessage("採取を始めてください。")).toBe(true);
    expect(isExplicitGoalResumeMessage("こっちおいで。")).toBe(true);
    expect(isExplicitGoalResumeMessage("木を集めてください。")).toBe(true);
    expect(isExplicitGoalResumeMessage("追従を始めてほしいです。")).toBe(true);
    expect(isExplicitGoalResumeMessage("戻ってきて。")).toBe(true);
  });

  it("honors requests to stop being concise", () => {
    expect(
      updateConversationPreferences(
        { concise: true, avoidJargon: false },
        "短くしないで。",
      ),
    ).toEqual({ concise: false, avoidJargon: false });
    expect(
      updateConversationPreferences(
        { concise: true, avoidJargon: false },
        "簡潔にしなくていい。",
      ),
    ).toEqual({ concise: false, avoidJargon: false });
  });
});
