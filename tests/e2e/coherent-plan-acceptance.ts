import type { PlayerBodyObservation } from "../../src/minecraft/player-body-observation.js";
import type { PlayerOperation } from "../../src/minecraft/player-body-schema.js";
import type {
  PlayerActionPlan,
  PlayerRuntimeSnapshot,
} from "../../src/player/contracts.js";

type Outcome = PlayerRuntimeSnapshot["recentOutcomes"][number];
type Step = PlayerActionPlan["steps"][number];
type Runtime = Pick<
  PlayerRuntimeSnapshot,
  "purpose" | "goals" | "recentOutcomes" | "actionPlan"
>;
interface Capture {
  readonly sampledAt: string;
  readonly runtime: Runtime;
}
interface Linked {
  readonly sequence: number;
  readonly operation: PlayerOperation;
  readonly status: Outcome["status"];
  readonly operationId: string;
  readonly at: string;
}

export type CoherentPlanCapture = Capture;
export type CoherentPlanAcceptanceReason =
  | "accepted_container_chain"
  | "accepted_replan"
  | "accepted_failed_replan"
  | "plan_missing"
  | "plan_identity_changed"
  | "goal_mismatch"
  | "body_outcome_mismatch"
  | "no_linked_body_outcomes"
  | "movement_only"
  | "repeated_unchanged_failure"
  | "container_chain_incomplete"
  | "replan_missing";
export interface CoherentPlanAcceptance {
  readonly accepted: boolean;
  readonly reason: CoherentPlanAcceptanceReason;
  readonly linkedBodyOutcomeCount: number;
}

const movement = new Set([
  "move_to",
  "move_relative",
  "look",
  "look_sweep",
  "control",
]);
const uiOnly = new Set(["open_window", "window_click", "window_close"]);

/** Mockable oracle only: plans count when their steps match observed Body outcomes. */
export function evaluateCoherentPlanAcceptance(input: {
  readonly captures: readonly Capture[];
  readonly observations: readonly PlayerBodyObservation[];
  readonly neededItems: readonly string[];
}): CoherentPlanAcceptance {
  const captures = [...input.captures].sort(
    (a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt),
  );
  const plans = captures.flatMap(({ runtime }) =>
    runtime.actionPlan ? [runtime.actionPlan] : [],
  );
  const first = plans[0];
  const latest = plans.at(-1);
  if (!first || !latest) return result(false, "plan_missing");
  if (
    plans.some(
      (p) =>
        p.id !== first.id ||
        p.purpose !== first.purpose ||
        p.goalId !== first.goalId,
    )
  )
    return result(false, "plan_identity_changed");
  if (latest.goalId !== undefined) {
    const goal = captures
      .at(-1)
      ?.runtime.goals.find((item) => item.id === latest.goalId);
    if (
      !goal ||
      goal.status === "paused" ||
      goal.status === "abandoned" ||
      (goal.status === "completed" &&
        latest.steps.some((step) => step.status === "pending"))
    )
      return result(false, "goal_mismatch");
  }

  const outcomes = new Map(
    captures.flatMap(({ runtime }) =>
      runtime.recentOutcomes.map((item) => [item.operationId, item] as const),
    ),
  );
  const bySequence = new Map<number, Step>();
  for (const plan of plans)
    for (const step of plan.steps) {
      const old = bySequence.get(step.sequence);
      if (old && fingerprint(old.operation) !== fingerprint(step.operation))
        return result(false, "body_outcome_mismatch");
      bySequence.set(step.sequence, step);
    }
  const linked: Linked[] = [];
  for (const step of [...bySequence.values()].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    // Invalidated queued steps without operation IDs are not Body evidence.
    if (!step.operationId || step.status === "pending") continue;
    const body = outcomes.get(step.operationId);
    if (body?.kind !== step.operation.kind)
      return result(false, "body_outcome_mismatch", linked);
    if (
      body.status !== step.status ||
      (step.observedAt !== undefined && step.observedAt !== body.observedAt)
    )
      return result(false, "body_outcome_mismatch", linked);
    linked.push({
      sequence: step.sequence,
      operation: step.operation,
      status: step.status,
      operationId: step.operationId,
      at: body.observedAt,
    });
  }
  if (!linked.length) return result(false, "no_linked_body_outcomes");
  if (linked.some((step) => !wasPlanned(step, captures)))
    return result(false, "body_outcome_mismatch", linked);
  let previousOutcomeAt: number | undefined;
  for (const step of linked) {
    const outcomeAt = Date.parse(step.at);
    if (previousOutcomeAt !== undefined && previousOutcomeAt > outcomeAt)
      return result(false, "body_outcome_mismatch", linked);
    previousOutcomeAt = outcomeAt;
  }
  const failures = new Set<string>();
  for (const step of linked) {
    const key = fingerprint(step.operation);
    if (step.status === "failed") {
      if (failures.has(key))
        return result(false, "repeated_unchanged_failure", linked);
      failures.add(key);
    } else if (step.status === "successful") failures.delete(key);
  }
  if (linked.every(({ operation }) => movement.has(operation.kind)))
    return result(false, "movement_only", linked);

  const observations = [...input.observations].sort(
    (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt),
  );
  const open = linked.find(
    (s) => s.operation.kind === "open_window" && s.status === "successful",
  );
  if (open) {
    const visible = find(observations, open.at, false, (o) =>
      targetVisible(open, o),
    );
    const window = find(observations, open.at, true, (o) => o.window !== null);
    if (visible && window) {
      const slots =
        window.window?.slots.slice(0, window.window.inventoryStart) ?? [];
      return slots.some(
        (item) =>
          item !== null &&
          input.neededItems.includes(item.name) &&
          gearDestination(item.name) !== undefined,
      )
        ? containerChain(
            open,
            window,
            linked,
            captures,
            observations,
            input.neededItems,
          )
        : replan(
            open.sequence,
            window.observedAt,
            linked,
            captures,
            observations,
            input.neededItems,
          );
    }
  }
  const failedOpen = linked.find(
    (s) => s.operation.kind === "open_window" && s.status === "failed",
  );
  return failedOpen
    ? replan(
        failedOpen.sequence,
        failedOpen.at,
        linked,
        captures,
        observations,
        input.neededItems,
      )
    : result(false, "container_chain_incomplete", linked);
}

function containerChain(
  open: Linked,
  inspected: PlayerBodyObservation,
  linked: readonly Linked[],
  captures: readonly Capture[],
  obs: readonly PlayerBodyObservation[],
  neededItems: readonly string[],
): CoherentPlanAcceptance {
  const slots =
    inspected.window?.slots.slice(0, inspected.window.inventoryStart) ?? [];
  for (const [slot, stack] of slots.entries()) {
    if (!stack) continue;
    const destination = gearDestination(stack.name);
    if (!destination || !neededItems.includes(stack.name)) continue;
    const transfer = linked.find(
      (s) =>
        s.sequence > open.sequence &&
        s.status === "successful" &&
        ((s.operation.kind === "window_transfer" &&
          s.operation.direction === "window_to_inventory" &&
          s.operation.item === stack.name) ||
          (s.operation.kind === "window_click" && s.operation.slot === slot)),
    );
    if (!transfer || !wasPlanned(transfer, captures, inspected.observedAt))
      continue;
    const before = find(obs, transfer.at, false);
    const after = find(obs, transfer.at, true);
    if (
      !before ||
      !after ||
      count(after, stack.name) <= count(before, stack.name)
    )
      continue;
    const equip = linked.find(
      (s) =>
        s.sequence > transfer.sequence &&
        s.status === "successful" &&
        s.operation.kind === "equip" &&
        s.operation.item === stack.name &&
        s.operation.destination === destination,
    );
    if (
      equip &&
      wasPlanned(equip, captures, inspected.observedAt) &&
      find(obs, equip.at, true)?.self.equipment[destination]?.name ===
        stack.name
    )
      return result(true, "accepted_container_chain", linked);
  }
  return result(false, "container_chain_incomplete", linked);
}

function replan(
  sequence: number,
  afterAt: string,
  linked: readonly Linked[],
  captures: readonly Capture[],
  obs: readonly PlayerBodyObservation[],
  neededItems: readonly string[],
): CoherentPlanAcceptance {
  const actions = linked.filter(
    (s) =>
      s.sequence > sequence &&
      Date.parse(s.at) > Date.parse(afterAt) &&
      !movement.has(s.operation.kind) &&
      !uiOnly.has(s.operation.kind),
  );
  for (const step of actions)
    if (step.status === "successful" && wasPlanned(step, captures, afterAt)) {
      const before = find(obs, step.at, false);
      const after = find(obs, step.at, true);
      if (
        before &&
        after &&
        madeNeededProgress(step, before, after, neededItems)
      )
        return result(true, "accepted_replan", linked);
    }
  for (let i = 1; i < actions.length; i++) {
    const a = actions[i - 1];
    const b = actions[i];
    if (
      a?.status === "failed" &&
      b?.status === "failed" &&
      fingerprint(a.operation) !== fingerprint(b.operation) &&
      wasPlanned(a, captures, afterAt) &&
      wasPlanned(b, captures, a.at)
    )
      return result(true, "accepted_failed_replan", linked);
  }
  return result(false, "replan_missing", linked);
}

function gearDestination(
  name: string,
): "hand" | "head" | "torso" | "legs" | "feet" | undefined {
  if (/(?:sword|axe|spear)$/u.test(name)) return "hand";
  if (name.endsWith("_helmet")) return "head";
  if (name.endsWith("_chestplate")) return "torso";
  if (name.endsWith("_leggings")) return "legs";
  if (name.endsWith("_boots")) return "feet";
  return undefined;
}
function targetVisible(s: Linked, o: PlayerBodyObservation): boolean {
  if (s.operation.kind !== "open_window" || s.operation.target.kind !== "block")
    return false;
  const p = s.operation.target.position;
  return o.perception.blocks.some(
    (b) =>
      ["chest", "trapped_chest", "barrel"].includes(b.name) &&
      b.position.x === p.x &&
      b.position.y === p.y &&
      b.position.z === p.z,
  );
}
function wasPlanned(
  s: Linked,
  captures: readonly Capture[],
  afterAt?: string,
): boolean {
  return captures.some(
    ({ sampledAt, runtime }) =>
      Date.parse(sampledAt) <= Date.parse(s.at) &&
      (afterAt === undefined || Date.parse(sampledAt) >= Date.parse(afterAt)) &&
      !runtime.recentOutcomes.some(
        (outcome) => outcome.operationId === s.operationId,
      ) &&
      runtime.actionPlan?.steps.some(
        (step) =>
          step.sequence === s.sequence &&
          step.status === "pending" &&
          (step.operationId === undefined ||
            step.operationId === s.operationId) &&
          fingerprint(step.operation) === fingerprint(s.operation),
      ) === true,
  );
}
function find(
  obs: readonly PlayerBodyObservation[],
  time: string,
  later: boolean,
  test: (o: PlayerBodyObservation) => boolean = () => true,
): PlayerBodyObservation | undefined {
  const list = later ? obs : [...obs].reverse();
  return list.find(
    (o) =>
      (later
        ? Date.parse(o.observedAt) > Date.parse(time)
        : Date.parse(o.observedAt) < Date.parse(time)) && test(o),
  );
}
function count(o: PlayerBodyObservation, item: string): number {
  return o.self.inventory
    .filter((stack) => stack.name === item)
    .reduce((sum, stack) => sum + stack.count, 0);
}
function madeNeededProgress(
  step: Linked,
  before: PlayerBodyObservation,
  after: PlayerBodyObservation,
  neededItems: readonly string[],
): boolean {
  const gainedNeededItem = neededItems.some(
    (item) => count(after, item) > count(before, item),
  );
  const operation = step.operation;
  if (operation.kind === "dig")
    return (
      hasBlockAt(before, operation.position) &&
      !hasBlockAt(after, operation.position) &&
      gainedNeededItem
    );
  if (operation.kind === "equip")
    return (
      neededItems.includes(operation.item) &&
      before.self.equipment[operation.destination]?.name !== operation.item &&
      after.self.equipment[operation.destination]?.name === operation.item
    );
  if (operation.kind === "craft")
    return (
      neededItems.includes(operation.item) &&
      count(after, operation.item) > count(before, operation.item)
    );
  if (operation.kind === "window_transfer")
    return (
      operation.direction === "window_to_inventory" &&
      neededItems.includes(operation.item) &&
      count(after, operation.item) > count(before, operation.item)
    );
  if (operation.kind === "collect_item" || operation.kind === "fish")
    return gainedNeededItem;
  return false;
}
function hasBlockAt(
  observation: PlayerBodyObservation,
  position: Extract<PlayerOperation, { kind: "dig" }>["position"],
): boolean {
  return observation.perception.blocks.some(
    (block) =>
      block.position.x === position.x &&
      block.position.y === position.y &&
      block.position.z === position.z,
  );
}
function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}
function result(
  accepted: boolean,
  reason: CoherentPlanAcceptanceReason,
  steps: readonly Linked[] = [],
): CoherentPlanAcceptance {
  return { accepted, reason, linkedBodyOutcomeCount: steps.length };
}
