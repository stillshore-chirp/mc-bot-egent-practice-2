import { z } from "zod";
import { AppError } from "../domain/errors.js";
import type { DeliveryTarget } from "../memory/delivery-targets.js";
import type { ToolContext } from "./contracts.js";
import type { ToolDefinition } from "./definition.js";
function define<Name extends string, Input extends z.ZodType, Output>(
  definition: ToolDefinition<Name, Input, Output>,
) {
  return definition;
}
export function delivery(context: ToolContext) {
  if (!context.game.delivery)
    throw new AppError({
      category: "validation",
      code: "DELIVERY_UNAVAILABLE",
      message: "拠点・収納機能を利用できません。",
      retryable: false,
    });
  return context.game.delivery;
}
function publicTarget(target: DeliveryTarget) {
  return {
    kind: target.kind,
    position: target.position,
    dimension: target.dimension,
  };
}
const kind = z.enum(["home", "chest"]);
const position = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2048).max(2048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  })
  .strict();
export const deliveryRegistrationTools = [
  define({
    name: "register_delivery_target",
    description:
      "利用者の明示指示で帰還拠点または指定チェストを登録・訂正する。homeはBot現在地を登録しposition=null。chestは利用者が指定した座標のみを使う。未指定・曖昧な収納先は推測せず質問する。",
    input: z.object({ kind, position: position.nullable() }).strict(),
    action: true,
    fixtures: {
      valid: [
        { kind: "home", position: null },
        { kind: "chest", position: { x: 2, y: 64, z: 1 } },
      ],
      invalid: [{ kind: "guess", position: null }],
    },
    execute: async (input, context) => {
      const target = await delivery(context).register(
        input.kind,
        input.position,
        context.signal,
      );
      return {
        success: true as const,
        data: publicTarget(target),
        evidence: [],
        userSummary:
          input.kind === "home"
            ? "現在のBot位置を帰還拠点として登録しました。"
            : "指定チェストの個体を確認して収納先に登録しました。",
      };
    },
  }),
  define({
    name: "get_delivery_targets",
    description: "登録済みの帰還拠点と収納先を読む。未登録の対象は補完しない。",
    input: z.object({}).strict(),
    action: false,
    fixtures: { valid: [{}], invalid: [{ guess: true }] },
    execute: async (_input, context) => ({
      success: true as const,
      data: delivery(context).list().map(publicTarget),
      evidence: [],
      userSummary: "登録状態を確認しました。",
    }),
  }),
  define({
    name: "forget_delivery_target",
    description:
      "利用者の明示指示で帰還拠点または収納先の登録を削除する。チェスト本体や内容物は変更しない。",
    input: z.object({ kind }).strict(),
    action: false,
    fixtures: { valid: [{ kind: "chest" }], invalid: [{ kind: "all" }] },
    execute: async (input, context) => {
      delivery(context).forget(input.kind, context.signal);
      return {
        success: true as const,
        data: { forgotten: input.kind },
        evidence: [],
        userSummary: "指定された登録を削除しました。",
      };
    },
  }),
] as const;
