// src/tools/self-modify.ts — Self-modification (~40 lines per spec)
// Dispatches Claude Code to modify Mame's own codebase
// ALWAYS requires user approval — non-negotiable

import { execFile, execSync } from "child_process";
import { remember } from "../memory.js";
import { registerTool, type ToolContext } from "./index.js";

const MAME_PROJECT_PATH = process.env.MAME_PROJECT_PATH || process.cwd();

registerTool({
  definition: {
    name: "self_modify",
    description:
      "Add new capabilities to Mame by creating or modifying tools. " +
      "ALWAYS requires user approval. Follow existing patterns in src/tools/.",
    input_schema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description: "What capability to add or change",
        },
        restart: {
          type: "boolean",
          description: "Restart after changes (default true)",
        },
      },
      required: ["task"],
    },
  },
  requiresApproval: true,
  async execute(input: Record<string, unknown>, _ctx: ToolContext) {
    const task = input.task as string;
    const restart = input.restart !== false;

    const prompt = `${task}

RULES:
- Follow existing patterns in src/tools/. Each tool = one file.
- Register new tools in src/tools/index.ts.
- Add any new npm dependencies needed.
- DO NOT modify src/agent.ts, src/gateway.ts, or src/memory.ts.
- Write clean, minimal code. Match the style of existing tools.
- Test that the tool schema is valid JSON.`;

    return new Promise((resolve) => {
      execFile(
        "claude",
        ["-p", prompt],
        {
          cwd: MAME_PROJECT_PATH,
          env: process.env,
          timeout: 600000, // 10 min timeout
        },
        async (error, stdout, stderr) => {
          if (!error && restart) {
            try {
              execSync("pm2 restart mame-gateway", { stdio: "ignore" });
            } catch {
              // pm2 might not be running in dev mode
            }
          }

          // Store the skill as a memory
          await remember(
            `Built new tool: ${task}`,
            "mame",
            "skill",
            0.9
          );

          resolve({
            success: !error,
            output: stdout,
            error: stderr || error?.message,
            restarted: !error && restart,
          });
        }
      );
    });
  },
});
