import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import { inspectProcess, main } from "../../scripts/inspect-process.js";

const CLI_FAILURE = {
  exitCode: 1,
  stdout: "",
  stderr: "Process inspection failed.\n",
};
const FAKE_CREDENTIAL =
  "--accessToken=fake-access-token eyJhbGciOiJub25lIn0.fake.signature Bearer fake.jwt.content";

beforeEach(() => spawnSyncMock.mockReset());

function psResult(
  stdout: string,
  stderr = "",
  status: number | null = 0,
  error?: Error,
) {
  return {
    pid: 1,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
    ...(error ? { error } : {}),
  };
}

function runCli(args: string[]) {
  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

  process.argv = [process.execPath, "inspect-process.ts", ...args];
  process.exitCode = undefined;
  try {
    main();
    return {
      exitCode: process.exitCode,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
    };
  } finally {
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe("inspect process", () => {
  it("prints only the safe JSON fields and invokes fixed ps fields", () => {
    spawnSyncMock.mockReturnValueOnce(psResult("4321 1 S+\n"));

    const result = runCli(["4321"]);

    expect(result).toEqual({
      exitCode: undefined,
      stdout: '{"pid":4321,"ppid":1,"state":"S+"}\n',
      stderr: "",
    });
    expect(spawnSyncMock).toHaveBeenCalledExactlyOnceWith(
      "/bin/ps",
      ["-p", "4321", "-o", "pid=,ppid=,stat="],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 4_096 },
    );
  });

  it("rejects extra output containing credential-shaped text", () => {
    spawnSyncMock.mockReturnValueOnce(
      psResult(`4321 1 S+ ${FAKE_CREDENTIAL}\n`),
    );

    const result = runCli(["4321"]);

    expect(result).toEqual(CLI_FAILURE);
  });

  it("rejects mismatched PIDs, invalid parent PIDs, extra rows, and invalid states", () => {
    for (const stdout of [
      "4322 1 S\n",
      "4321 -1 S\n",
      "4321 9007199254740992 S\n",
      "4321 1 S\n4322 1 R\n",
      "4321 1 Ssecret-shaped-value\n",
    ]) {
      spawnSyncMock.mockReturnValueOnce(psResult(stdout));
      expect(inspectProcess("4321")).toBeNull();
    }
  });

  it("hides failed stderr, timeout details, and thrown errors", () => {
    spawnSyncMock
      .mockReturnValueOnce(psResult("", FAKE_CREDENTIAL, 1))
      .mockReturnValueOnce(
        psResult(
          "",
          "fake timeout: Bearer fake.jwt.content",
          null,
          new Error(FAKE_CREDENTIAL),
        ),
      )
      .mockImplementationOnce(() => {
        throw new Error(FAKE_CREDENTIAL);
      });

    for (const pid of ["4321", "4321", "4321"]) {
      expect(runCli([pid])).toEqual(CLI_FAILURE);
    }
  });

  it("rejects invalid PIDs without running ps or reflecting the input", () => {
    const result = runCli(["not-a-pid-secret"]);

    expect(result).toEqual(CLI_FAILURE);
    expect(runCli(["4321\n"])).toEqual(CLI_FAILURE);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
