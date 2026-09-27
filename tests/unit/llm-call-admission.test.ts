import { describe, expect, it, vi } from "vitest";

import {
  createLlmCallAdmission,
  LlmCallAdmissionError,
} from "../e2e/llm-call-admission.js";

describe("LLM call admission", () => {
  it("admits the configured run limit and rejects the next call", () => {
    const onExhausted = vi.fn();
    const admission = createLlmCallAdmission(8, onExhausted);

    for (let call = 0; call < 8; call += 1) admission.beforeCall();
    expect(() => admission.beforeCall()).toThrow(
      new LlmCallAdmissionError("RUN_LLM_BUDGET_EXCEEDED"),
    );
    expect(onExhausted).toHaveBeenCalledWith("RUN_LLM_BUDGET_EXCEEDED");
  });

  it("limits an active case and clears that limit when the case ends", () => {
    const admission = createLlmCallAdmission(4, () => undefined);
    admission.beginCase(2);
    admission.beforeCall();
    admission.beforeCall();
    expect(() => admission.beforeCall()).toThrow(
      new LlmCallAdmissionError("CASE_LLM_BUDGET_EXCEEDED"),
    );

    admission.endCase();
    admission.beforeCall();
    admission.beforeCall();
    expect(() => admission.beforeCall()).toThrow(
      new LlmCallAdmissionError("RUN_LLM_BUDGET_EXCEEDED"),
    );
  });

  it("shares one synchronous run limit across concurrent callers", async () => {
    const admission = createLlmCallAdmission(2, () => undefined);
    const invoke = async (): Promise<void> => {
      admission.beforeCall();
    };

    const outcomes = await Promise.allSettled([
      invoke(),
      invoke(),
      invoke(),
      invoke(),
    ]);

    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(2);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
      2,
    );
  });

  it("ends the case scope when a deadline wins while the body is pending", async () => {
    const admission = createLlmCallAdmission(3, () => undefined);
    let finishBody!: () => void;
    const body = new Promise<void>((resolve) => {
      finishBody = resolve;
    });
    const timeout = new Error("CASE_DEADLINE_EXCEEDED");
    admission.beginCase(1);

    const runCase = async (): Promise<void> => {
      try {
        await Promise.race([body, Promise.reject(timeout)]);
      } finally {
        admission.endCase();
      }
    };

    await expect(runCase()).rejects.toBe(timeout);
    admission.beforeCall();
    admission.beforeCall();
    admission.beforeCall();
    expect(() => admission.beforeCall()).toThrow(
      new LlmCallAdmissionError("RUN_LLM_BUDGET_EXCEEDED"),
    );
    finishBody();
  });
});
