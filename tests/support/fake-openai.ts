import type OpenAI from "openai";

export interface RecordedOpenAIRequest {
  parallel_tool_calls?: boolean | null;
  store?: boolean | null;
  input?: unknown;
}

export class ScriptedOpenAI {
  public readonly requests: RecordedOpenAIRequest[] = [];
  readonly #responses: unknown[];

  public constructor(responses: unknown[]) {
    this.#responses = [...responses];
  }

  public readonly responses = {
    create: async (request: RecordedOpenAIRequest) => {
      this.requests.push(request);
      const response = this.#responses.shift();
      if (response === undefined)
        throw new Error("scripted response exhausted");
      return response;
    },
  };

  public asClient(): OpenAI {
    return this as unknown as OpenAI;
  }
}
