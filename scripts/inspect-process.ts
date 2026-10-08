import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FAILURE_MESSAGE = "Process inspection failed.\n";
const STATE = /^[DIRSTtUWXZ][+<>AELNSsVWXl]{0,12}$/;

interface ProcessInspection {
  pid: number;
  ppid: number;
  state: string;
}

export function inspectProcess(pidInput: unknown): ProcessInspection | null {
  if (typeof pidInput !== "string" || !/^\d+$/.test(pidInput)) return null;
  const requestedPid = Number(pidInput);
  if (!Number.isSafeInteger(requestedPid) || requestedPid < 1) return null;

  try {
    const result = spawnSync(
      "/bin/ps",
      ["-p", String(requestedPid), "-o", "pid=,ppid=,stat="],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 4_096 },
    );
    if (result.error || result.status !== 0 || result.signal !== null) return null;

    let line = result.stdout;
    if (line.endsWith("\n")) {
      line = line.slice(0, -1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
    }
    if (line.includes("\n") || line.includes("\r")) return null;

    const match = /^[ \t]*(\d+)[ \t]+(\d+)[ \t]+([^ \t]+)[ \t]*$/.exec(line);
    if (!match) return null;

    const [rawPid, rawPpid, state] = [match[1], match[2], match[3]];
    if (rawPid === undefined || rawPpid === undefined || state === undefined) return null;
    const pid = Number(rawPid);
    const ppid = Number(rawPpid);
    if (
      !Number.isSafeInteger(pid) ||
      pid !== requestedPid ||
      !Number.isSafeInteger(ppid) ||
      ppid < 0 ||
      !STATE.test(state)
    ) {
      return null;
    }

    return { pid, ppid, state };
  } catch {
    return null;
  }
}

export function main(): void {
  const result =
    process.argv.length === 3 ? inspectProcess(process.argv[2]) : null;
  if (result) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stderr.write(FAILURE_MESSAGE);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
