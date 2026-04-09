// src/tools/bash.ts — Execute shell commands on the host
//
// Lightweight alternative to claude_code for simple commands like
// npm install, git clone, systemctl status, file operations, etc.

import { exec } from "node:child_process";
import { registerTool } from "./index.js";

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024; // 4 MB
const MAX_OUTPUT_CHARS = 10_000; // Truncate stdout/stderr to avoid flooding the model

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  const truncated = str.slice(-max);
  return `... (truncated, showing last ${max} chars) ...\n${truncated}`;
}

registerTool({
  definition: {
    name: "bash",
    description:
      "Execute a shell command on the host machine. Returns stdout, stderr, and exit code. " +
      "Use for lightweight tasks like npm install, git clone, ls, cat, systemctl status, etc. " +
      "Commands time out after 30 seconds. For complex multi-step coding tasks, prefer claude_code.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute (runs in /bin/bash)",
        },
        working_directory: {
          type: "string",
          description:
            "Working directory for the command. Defaults to the daemon's cwd if omitted.",
        },
      },
      required: ["command"],
    },
  },
  async execute(input: Record<string, unknown>) {
    const command = input.command as string;
    const cwd = (input.working_directory as string | undefined) || undefined;

    console.warn(`[bash] executing: ${command}${cwd ? ` (in ${cwd})` : ""}`);

    return new Promise((resolve) => {
      exec(
        command,
        {
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          shell: "/bin/bash",
          cwd,
        },
        (error, stdout, stderr) => {
          const killed = error && "killed" in error && error.killed;

          if (killed) {
            resolve({
              stdout: truncate(stdout || "", MAX_OUTPUT_CHARS),
              stderr: truncate(stderr || "", MAX_OUTPUT_CHARS),
              exit_code: -1,
              error: `Command timed out after ${TIMEOUT_MS / 1000}s`,
            });
            return;
          }

          const exit_code = error?.code ?? 0;

          resolve({
            stdout: truncate(stdout || "", MAX_OUTPUT_CHARS),
            stderr: truncate(stderr || "", MAX_OUTPUT_CHARS),
            exit_code,
          });
        }
      );
    });
  },
});
