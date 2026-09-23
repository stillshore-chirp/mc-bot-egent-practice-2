import { describe, expect, it } from "vitest";
import { decideBaseBuildRequest } from "../../src/decision/base-build-authorization.js";

describe("authenticated base-build request scope", () => {
  it("accepts a delegated nearby house without arbitrary tool arguments", () => {
    expect(decideBaseBuildRequest("近くに家を作って", false)).toEqual({
      kind: "authorized",
      resume: false,
    });
    expect(decideBaseBuildRequest("拠点を建ててください", false)).toEqual({
      kind: "authorized",
      resume: false,
    });
    expect(decideBaseBuildRequest("家の続きをやって", true)).toEqual({
      kind: "authorized",
      resume: true,
    });
  });

  it("does not turn questions, negations or unrelated resume into a grant", () => {
    expect(decideBaseBuildRequest("家を建てられる？", false)).toEqual({
      kind: "none",
    });
    expect(decideBaseBuildRequest("家を建ててもいいですか", false)).toEqual({
      kind: "none",
    });
    expect(decideBaseBuildRequest("家を作ってもいいですか", false)).toEqual({
      kind: "none",
    });
    expect(decideBaseBuildRequest("家を建てないで", false)).toEqual({
      kind: "none",
    });
    expect(decideBaseBuildRequest("家を作らないで", false)).toEqual({
      kind: "none",
    });
    expect(decideBaseBuildRequest("家を建てて、やっぱりやめて", false)).toEqual(
      {
        kind: "none",
      },
    );
    expect(decideBaseBuildRequest("続きをやって", false)).toEqual({
      kind: "none",
    });
    expect(decideBaseBuildRequest("家を建てて", true)).toEqual({
      kind: "authorized",
      resume: false,
    });
  });

  it("clarifies unsupported material, scale and location before changing the world", () => {
    for (const request of [
      "石で家を建てて",
      "5×5の家を建てて",
      "遠くに家を建てて",
      "保護区域内に家を建てて",
      "原木4本以内で家を建てて",
    ]) {
      expect(decideBaseBuildRequest(request, false).kind).toBe("clarify");
    }
  });
});
