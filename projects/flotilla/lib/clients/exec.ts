// lib/clients/exec.ts — child-process helper shared by the CLI-driven clients
// (Convex export/import shells out to `npx convex`). Captures output, streams
// each line to the log tap so a long import shows progress in the merged tail.

import { execFile } from "node:child_process";
import type { ScopedLogger } from "../logtap.ts";

export type ExecResult = { code: number; stdout: string; stderr: string };

export type ExecOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  log?: ScopedLogger;
  /** milliseconds; a stuck import must not hang the orchestrator forever */
  timeoutMs?: number;
};

/**
 * Run a command, capturing stdout/stderr. Never throws on non-zero exit — the
 * caller decides what a failing step means (some checks read the exit code).
 */
export function execCapture(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        env: opts.env ?? process.env,
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 10 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
    child.stdout?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) if (line.trim()) opts.log?.("info", line.trimEnd());
    });
    child.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) if (line.trim()) opts.log?.("warn", line.trimEnd());
    });
  });
}
