// src/tools/claude-code.ts — Dispatch to Claude Code (~30 lines per spec)

import { execFile } from "child_process";
import { loadConfig } from "../config.js";
import { Vault } from "../vault.js";
import { registerTool, type ToolContext } from "./index.js";

registerTool({
  definition: {
    name: "claude_code",
    description:
      "Dispatch a coding task to Claude Code. Use for ALL code changes — file editing, testing, git operations, PR creation.",
    input_schema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description: "Project name (maps to local path in config)",
        },
        task: {
          type: "string",
          description: "What to do — be specific and detailed",
        },
        await_result: {
          type: "boolean",
          description: "Wait for completion (true) or fire-and-forget (false). Default true.",
        },
      },
      required: ["project", "task"],
    },
  },
  async execute(input: Record<string, unknown>, _ctx: ToolContext) {
    const project = input.project as string;
    const task = input.task as string;
    const awaitResult = input.await_result !== false;

    const config = loadConfig();
    const projectConfig = config.projects[project];
    if (!projectConfig) {
      return { error: `Unknown project: ${project}. Available: ${Object.keys(config.projects).join(", ")}` };
    }

    const projectPath = projectConfig.path.replace("~", process.env.HOME || "");

    // Load project-specific env vars from vault
    const vault = new Vault();
    const env = await vault.getAll(project);

    // claude -p runs Claude Code in non-interactive mode
    return new Promise((resolve) => {
      const proc = execFile(
        "claude",
        ["-p", task],
        {
          cwd: projectPath,
          env: { ...process.env, ...env },
          timeout: awaitResult ? 600000 : undefined, // 10 min timeout if awaiting
        },
        (error, stdout, stderr) => {
          resolve({
            success: !error,
            output: stdout,
            error: stderr || error?.message,
          });
        }
      );

      if (!awaitResult) {
        resolve({ dispatched: true, pid: proc.pid });
      }
    });
  },
});
