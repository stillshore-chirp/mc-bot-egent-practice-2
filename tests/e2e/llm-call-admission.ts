export type LlmCallAdmissionFailure =
  "RUN_LLM_BUDGET_EXCEEDED" | "CASE_LLM_BUDGET_EXCEEDED";

export class LlmCallAdmissionError extends Error {
  public constructor(public readonly code: LlmCallAdmissionFailure) {
    super(code);
    this.name = "LlmCallAdmissionError";
  }
}

export interface LlmCallAdmission {
  readonly beforeCall: () => void;
  readonly beginCase: (maxCalls: number) => void;
  readonly endCase: () => void;
}

export function createLlmCallAdmission(
  maxRunCalls: number,
  onExhausted: (code: LlmCallAdmissionFailure) => void,
): LlmCallAdmission {
  let runCalls = 0;
  let caseCalls = 0;
  let caseLimit: number | undefined;

  return {
    beginCase: (maxCalls) => {
      caseCalls = 0;
      caseLimit = maxCalls;
    },
    endCase: () => {
      caseCalls = 0;
      caseLimit = undefined;
    },
    beforeCall: () => {
      const code =
        runCalls >= maxRunCalls
          ? "RUN_LLM_BUDGET_EXCEEDED"
          : caseLimit !== undefined && caseCalls >= caseLimit
            ? "CASE_LLM_BUDGET_EXCEEDED"
            : undefined;
      if (code !== undefined) {
        onExhausted(code);
        throw new LlmCallAdmissionError(code);
      }
      runCalls += 1;
      if (caseLimit !== undefined) caseCalls += 1;
    },
  };
}
