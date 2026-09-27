import {
  appendFile,
  chmod,
  mkdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIAGNOSTICS_DIRECTORY = "ai-player-e2e-private-diagnostics";

function sidecarPath(runId: string, root: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(runId))
    throw new Error("Invalid E2E run identifier");
  return join(root, DIAGNOSTICS_DIRECTORY, `${runId}-armor-capability.json`);
}

export async function retainArmorCapabilityReply(
  runId: string,
  reply: string,
  root = tmpdir(),
): Promise<string> {
  const destination = sidecarPath(runId, root);
  const directory = join(root, DIAGNOSTICS_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(
    destination,
    `${JSON.stringify(privateReplyRecord("capability_reply", 0, 0, reply))}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await chmod(destination, 0o600);
  return destination;
}

export async function retainArmorCapabilityCompletionNotices(
  runId: string,
  candidates: readonly { readonly offsetMs: number; readonly text: string }[],
  root = tmpdir(),
): Promise<void> {
  await appendPrivateReplies(runId, "completion_notice", candidates, root);
}

export async function retainArmorCapabilityReplyFragments(
  runId: string,
  fragments: readonly { readonly offsetMs: number; readonly text: string }[],
  root = tmpdir(),
): Promise<void> {
  await appendPrivateReplies(runId, "capability_reply", fragments, root);
}

async function appendPrivateReplies(
  runId: string,
  stage: "capability_reply" | "completion_notice",
  candidates: readonly { readonly offsetMs: number; readonly text: string }[],
  root: string,
): Promise<void> {
  const destination = sidecarPath(runId, root);
  const file = await stat(destination);
  if ((file.mode & 0o777) !== 0o600)
    throw new Error("Armor capability sidecar must remain private");
  const records = candidates.map(({ offsetMs, text }, index) =>
    privateReplyRecord(
      stage,
      index + (stage === "capability_reply" ? 1 : 0),
      offsetMs,
      text,
    ),
  );
  if (records.length === 0) return;
  await appendFile(
    destination,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(destination, 0o600);
}

export async function removeArmorCapabilityReply(
  runId: string,
  root = tmpdir(),
): Promise<void> {
  await rm(sidecarPath(runId, root), { force: true });
}

function privateReplyRecord(
  stage: "capability_reply" | "completion_notice",
  sequence: number,
  offsetMs: number,
  text: string,
): Record<string, unknown> {
  return {
    schema: "ai-player-e2e-private-armor-capability/v1",
    caseId: "armor_capability",
    stage,
    sequence,
    offsetMs,
    text,
  };
}
