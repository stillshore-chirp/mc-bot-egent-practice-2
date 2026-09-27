import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  retainArmorCapabilityCompletionNotices,
  retainArmorCapabilityReplyFragments,
  removeArmorCapabilityReply,
  retainArmorCapabilityReply,
} from "./armor-capability-reply-sidecar.js";

describe("armor capability private reply sidecar", () => {
  it("stores only the case reply in a private 0600 file", async () => {
    const root = await mkdtemp(join(tmpdir(), "armor-capability-sidecar-"));
    const runId = "5b9a3c70-4d2a-4d0b-9b63-0f4fd4c9db32";
    const reply = "digとequip、かまどUIの操作に対応しています。";
    try {
      const path = await retainArmorCapabilityReply(runId, reply, root);
      await retainArmorCapabilityReplyFragments(
        runId,
        [{ offsetMs: 100, text: "Continuation." }],
        root,
      );
      await retainArmorCapabilityCompletionNotices(
        runId,
        [
          { offsetMs: 120, text: "Notice candidate one." },
          { offsetMs: 260, text: "Notice candidate two." },
        ],
        root,
      );
      const file = await stat(path);
      const directory = await stat(dirname(path));
      const records = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(file.mode & 0o777).toBe(0o600);
      expect(directory.mode & 0o777).toBe(0o700);
      expect(records).toEqual([
        {
          schema: "ai-player-e2e-private-armor-capability/v1",
          caseId: "armor_capability",
          stage: "capability_reply",
          sequence: 0,
          offsetMs: 0,
          text: reply,
        },
        {
          schema: "ai-player-e2e-private-armor-capability/v1",
          caseId: "armor_capability",
          stage: "capability_reply",
          sequence: 1,
          offsetMs: 100,
          text: "Continuation.",
        },
        {
          schema: "ai-player-e2e-private-armor-capability/v1",
          caseId: "armor_capability",
          stage: "completion_notice",
          sequence: 0,
          offsetMs: 120,
          text: "Notice candidate one.",
        },
        {
          schema: "ai-player-e2e-private-armor-capability/v1",
          caseId: "armor_capability",
          stage: "completion_notice",
          sequence: 1,
          offsetMs: 260,
          text: "Notice candidate two.",
        },
      ]);
      await expect(
        retainArmorCapabilityReply(runId, "duplicate", root),
      ).rejects.toMatchObject({ code: "EEXIST" });
      await removeArmorCapabilityReply(runId, root);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-UUID run identifier", async () => {
    await expect(
      retainArmorCapabilityReply("../unsafe", "reply"),
    ).rejects.toThrow("Invalid E2E run identifier");
  });
});
