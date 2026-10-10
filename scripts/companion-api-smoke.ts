import { mkdir, writeFile } from "node:fs/promises";
import { config as loadEnvironmentFile } from "dotenv";
import OpenAI from "openai";

import {
  CompanionAgent,
  CompanionAgentError,
  companionDecisionSchema,
  type CompanionDecisionInput,
  type CompanionResponsesClient,
} from "../src/player/agent.js";
import type { PlayerBodyObservation } from "../src/minecraft/player-body.js";
import { personaCoreSchema, type PersonaCore } from "../src/persona/persona.js";
import type { CompanionMemory, CompanionSnapshot } from "../src/player/contracts.js";

const modelName = "gpt-6-luna";
const maxRequests = 2;
const stamp = "2026-10-10T00:00:00.000Z";
const failedTarget = { x: 10, y: 64, z: 10 };
const alternateTarget = { x: 13, y: 64, z: 10 };

interface CheckResult { name: string; passed: boolean; checks: Record<string, boolean> }
interface Summary {
  mode: "preflight" | "live";
  model: string;
  requestCount: number;
  usage: { observedResponses: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  scenarios: CheckResult[];
  failureCode: string | null;
};

class AcceptanceFailure extends Error {
  public constructor(public readonly code: string) { super(code); }
}

const persona: PersonaCore = {
  version: 1,
  name: "ミナ",
  speakingStyle: "親しみやすく、短い日本語で話します。",
  values: ["好奇心", "丁寧な観察"],
  operatingPrinciples: ["見えている情報から安全な一歩を選びます。", "実行していないことを完了したと話しません。"],
  prohibitions: ["停止・認証・権限の境界を変えません。", "観測にない位置や結果を作りません。"],
};

const snapshot: CompanionSnapshot = {
  stopped: false, stopGeneration: 0, goal: null, plan: null, waitUntil: null,
  activeOperation: null, lastOutcome: null, relationshipSummary: "Synthetic acceptance scenario.",
  interests: ["小さな花壇を眺めること"],
};

const flowerBlock = block("red_tulip", 11);
const failedBlock = block("oak_log", failedTarget.x);
const alternateBlock = block("oak_log", alternateTarget.x);
const firstInput: CompanionDecisionInput = {
  snapshot, observation: observation([flowerBlock, alternateBlock]), wakeReason: "synthetic_idle_check",
  ownerMessage: "私は小さな花壇を見るのが好きです。この好みを覚えてください。そのうえで、見えているものをもとにあなた自身の小さな目標を一つ選び、何をするか話してください。",
  messages: [], memories: [],
};

const failedDig = { kind: "dig" as const, position: failedTarget };
const recoveryGoal = {
  title: "近くで安全に入手できるオークの丸太を一つ集める",
  successCondition: "観測した木からオークの丸太を一つ入手する",
  source: "self" as const,
};
const recoverySnapshot: CompanionSnapshot = {
  ...snapshot, goal: recoveryGoal,
  plan: { purpose: "見えているオークの丸太を採掘する", steps: [{ operation: failedDig, expectedOutcome: "丸太が一つ手に入る" }] },
  lastOutcome: {
    operationId: "synthetic-operation-1", operation: failedDig, status: "failed",
    summary: "Synthetic dig attempt failed and the block remained.", expectedOutcome: "The visible log is removed.", observedAt: stamp,
  },
};
const lesson: CompanionMemory = {
  id: "synthetic-memory-1", kind: "skill_lesson",
  content: "The oak log at the previous target failed to break. Do not repeat that dig; choose another visible oak log or inspect first.",
  source: "bot_inferred", status: "active", importance: 4, createdAt: stamp, updatedAt: stamp,
  metadata: { fixture: "synthetic" },
};
const secondInput: CompanionDecisionInput = {
  snapshot: recoverySnapshot, observation: observation([failedBlock, alternateBlock]),
  wakeReason: "synthetic_previous_action_failed", messages: [], memories: [lesson],
  ownerMessage: "さっき失敗した丸太はもう掘らないでください。別の見えている丸太があればそちらへ切り替えて、どう続けるか教えてください。",
};

function block(name: string, x: number) {
  const position = { x, y: 64, z: 10, dimension: "synthetic_garden" };
  return { name, stateId: 1, position, distance: Math.abs(x - 10), properties: {} };
}

function observation(blocks: ReturnType<typeof block>[]): PlayerBodyObservation {
  return {
    observedAt: stamp, source: "minecraft", gameVersion: "synthetic", dimension: "synthetic_garden",
    time: { day: 1, timeOfDay: 1000, isDay: true, raining: false },
    self: {
      username: "SyntheticBot", position: { x: 10, y: 64, z: 10, dimension: "synthetic_garden" },
      eyeHeight: 1.62, velocity: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, health: 20, food: 20, foodSaturation: 5, oxygen: 300,
      inWater: false, inLava: false, onFire: false, suffocating: false, sleeping: false,
      mountedEntityId: null, gameMode: "survival", experience: { level: 0, points: 0, progress: 0 },
      inventory: [], equipment: {},
    },
    perception: {
      coverage: "visible_subset", maxDistance: 8, candidateSearchMayBeTruncated: false,
      blocks: blocks as PlayerBodyObservation["perception"]["blocks"],
      placementCandidates: [], entities: [], nearbyHostiles: undefined, ownerPositionException: undefined,
    } as unknown as PlayerBodyObservation["perception"],
    window: null,
  };
}

function validateLocalFixtures(): void {
  personaCoreSchema.parse(persona);
  companionDecisionSchema.parse({
    speech: "合成シナリオを確認します。",
    goal: { title: "近くを観察する", successCondition: "様子が分かる", source: "self" },
    plan: { purpose: "目の前を観察する", steps: [{ operation: { kind: "look_sweep" }, expectedOutcome: "周囲の見える範囲が分かる" }] },
    memoryUpdates: [{ kind: "preference", content: "花壇が好き", importance: 3, ownerQuote: "花壇が好き" }],
    relationshipSummary: null,
    waitMs: 60_000, knowledgeQuery: null,
  });
}

function providerCategory(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_provider_error";
  const known = ["APIConnectionError", "APIConnectionTimeoutError", "AuthenticationError", "PermissionDeniedError", "RateLimitError", "BadRequestError", "InternalServerError"];
  return known.includes(error.name) ? error.name : "provider_error";
}

async function report(summary: Summary): Promise<void> {
  await mkdir(".git/tmp", { recursive: true, mode: 0o700 });
  await writeFile(".git/tmp/companion-api-smoke.json", `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function main(): Promise<void> {
  loadEnvironmentFile({ path: ".env.local", quiet: true });
  loadEnvironmentFile({ path: ".env", override: false, quiet: true });
  validateLocalFixtures();
  const live = process.argv.length === 3 && process.argv[2] === "--live";
  const model = process.env.OPENAI_MODEL?.trim() ?? modelName;
  if (model !== modelName) throw new AcceptanceFailure("configured_model_mismatch");
  if (!live) {
    await report({ mode: "preflight", model, requestCount: 0, usage: { observedResponses: 0, inputTokens: null, outputTokens: null, totalTokens: null }, scenarios: [], failureCode: null });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new AcceptanceFailure("api_key_unavailable");
  const configuredBaseUrl = process.env.OPENAI_BASE_URL?.trim().replace(/\/$/u, "");
  if (configuredBaseUrl && configuredBaseUrl !== "https://api.openai.com/v1") {
    throw new AcceptanceFailure("nonstandard_api_endpoint");
  }
  let requestCount = 0, observedResponses = 0, inputTokens = 0, outputTokens = 0, totalTokens = 0;
  const providerFailures: string[] = [];
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 60_000 });
  const responses = new Proxy(client.responses, {
    get(target, property, receiver) {
      if (property === "create") return async (...args: Parameters<typeof target.create>) => {
        if (requestCount >= maxRequests) throw new AcceptanceFailure("request_limit_exceeded");
        requestCount += 1;
        try {
          const response = await target.create(...args);
          if ("usage" in response) {
            observedResponses += 1; inputTokens += response.usage.input_tokens;
            outputTokens += response.usage.output_tokens; totalTokens += response.usage.total_tokens;
          }
          return response;
        } catch (error) { providerFailures.push(providerCategory(error)); throw error; }
      };
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
  const agent = new CompanionAgent({ client: { responses } satisfies CompanionResponsesClient, model, persona });
  const scenarios: CheckResult[] = [];
  let scenario = "autonomous_goal_memory", failureCode: string | null = null;
  try {
    const first = await agent.decide(firstInput);
    const checks = {
      structuredOutputValidated: true,
      conversationReply: first.speech !== null && first.speech.trim().length > 0,
      autonomousGoal: first.goal?.source === "self",
      plannedStep: (first.plan?.steps.length ?? 0) > 0,
      rememberedPreference: first.memoryUpdates.some((m) => m.kind === "preference" && m.ownerQuote !== null && firstInput.ownerMessage?.includes(m.ownerQuote) === true && /花壇|花|garden/u.test(m.content)),
    };
    if (Object.values(checks).some((ok) => !ok)) throw new AcceptanceFailure("autonomous_goal_memory_acceptance");
    scenarios.push({ name: scenario, passed: true, checks });

    scenario = "failed_action_replan";
    const second = await agent.decide(secondInput);
    const op = second.plan?.steps[0]?.operation;
    const avoidsFailedDig = op?.kind !== "dig" || op.position.x !== failedTarget.x || op.position.y !== failedTarget.y || op.position.z !== failedTarget.z;
    const opTarget =
      op?.kind === "dig" || op?.kind === "move_to"
        ? op.position
        : op?.kind === "look"
          ? op.target
          : null;
    const targetsAlternate =
      opTarget !== null &&
      Math.hypot(opTarget.x - alternateTarget.x, opTarget.y - alternateTarget.y, opTarget.z - alternateTarget.z) <=
        (op?.kind === "move_to" ? 1 : 0.25);
    const meaningfulReply = second.speech !== null && /別|ほか|他の|切り替|確認|探し|失敗/u.test(second.speech);
    const checks2 = {
      structuredOutputValidated: true,
      conversationReply: second.speech !== null && second.speech.trim().length > 0,
      goalRetained: second.goal?.title === recoveryGoal.title,
      revisedPlan: (second.plan?.steps.length ?? 0) > 0 && avoidsFailedDig,
      alternateVisibleTarget: targetsAlternate || op?.kind === "look_sweep",
      meaningfulReply,
    };
    if (Object.values(checks2).some((ok) => !ok)) throw new AcceptanceFailure("failed_action_replan_acceptance");
    scenarios.push({ name: scenario, passed: true, checks: checks2 });
  } catch (error) {
    failureCode = error instanceof AcceptanceFailure ? error.code : providerFailures[0] ?? (error instanceof CompanionAgentError ? `agent_${error.message}` : "unexpected_safe_failure");
    scenarios.push({ name: scenario, passed: false, checks: { acceptanceCompleted: false } });
  }
  await report({
    mode: "live", model, requestCount,
    usage: { observedResponses, inputTokens: observedResponses === requestCount ? inputTokens : null, outputTokens: observedResponses === requestCount ? outputTokens : null, totalTokens: observedResponses === requestCount ? totalTokens : null },
    scenarios, failureCode,
  });
  if (failureCode !== null) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const failureCode = error instanceof AcceptanceFailure ? error.code : "preflight_failed";
  process.stderr.write(`${JSON.stringify({ failureCode })}\n`);
  process.exitCode = 1;
});
