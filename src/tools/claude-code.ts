// src/tools/claude-code.ts — Dispatch a coding task to Claude Code.
//
// Evening 6 addition: before spawning the Claude Code subprocess, we
// register a task in ask-human-state with the dispatching Turn's
// channel context. That lets the MCP ask_human tool (running inside
// the Mame daemon on localhost:3848) route questions back to the same
// user who dispatched the task. When the subprocess exits, we clear
// the task so subsequent unrelated Discord messages go through the
// normal think() flow.
//
// Claude Code is told about the MCP server via the MAME_MCP_URL env
// var. The user's Claude Code config (~/.claude/settings.json or
// similar) should include an HTTP MCP server entry pointing at that
// URL. Documented in the Evening 6 PR body.

import { execFile } from "child_process";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { Vault } from "../vault.js";
import { registerTool, type ToolContext } from "./index.js";
import {
  registerTask,
  clearTask,
  type AskHumanChannel,
} from "../ask-human-state.js";
import { childLogger } from "../logger.js";

const log = childLogger("claude-code");

registerTool({
  definition: {
    name: "claude_code",
    description:
      "Dispatch a coding task to Claude Code. Use for ALL code changes — file editing, testing, git operations, PR creation. " +
      "Claude Code can call Mame's ask_human MCP tool mid-task to ask you clarifying questions if it hits ambiguous decisions. " +
      "Questions route back to whichever channel dispatched the task.",
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
  async execute(input: Record<string, unknown>, ctx: ToolContext) {
    const project = input.project as string;
    const task = input.task as string;
    const awaitResult = input.await_result !== false;

    const config = loadConfig();
    const projectConfig = config.projects[project];
    if (!projectConfig) {
      return {
        error: `Unknown project: ${project}. Available: ${Object.keys(config.projects).join(", ")}`,
      };
    }

    const projectPath = projectConfig.path.replace("~", process.env.HOME || "");

    // Load project-specific env vars from vault
    const vault = new Vault();
    const env = await vault.getAll(project);

    // Generate a unique task ID and register it in ask-human-state so
    // the MCP ask_human tool can route questions back to the right
    // channel. Only register if we actually know the channel — for
    // fire-and-forget dispatches from a heartbeat, ask-human wouldn't
    // have anywhere to route questions, so we skip registration and
    // the MCP tool will return a clean "no active task" error if it
    // ever fires.
    const taskId = `cc_${randomUUID().slice(0, 8)}`;
    const canRouteQuestions =
      awaitResult &&
      ctx.turn.channel !== "heartbeat" &&
      ctx.turn.channel !== "webhook";

    if (canRouteQuestions) {
      try {
        registerTask({
          taskId,
          channel: ctx.turn.channel as AskHumanChannel,
          channelId: undefined, // TODO: plumb through Discord channel ID from Turn
          persona: ctx.turn.personaId,
          description: task.slice(0, 120),
        });
      } catch (err) {
        // Another task is already active. Return an error to the agent
        // loop rather than running Claude Code without the ability to
        // ask questions — this keeps the architecture's invariant
        // (single active task) intact.
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg }, "claude-code dispatch refused — concurrent task active");
        return {
          error:
            "Cannot dispatch Claude Code: another coding task is already running. " +
            "Wait for it to finish, or report progress to the user and ask if they " +
            "want to cancel. v1 only supports one concurrent Claude Code task.",
        };
      }
    }

    const mcpUrl = process.env.MAME_MCP_URL || "http://127.0.0.1:3848/mcp";

    // claude -p runs Claude Code in non-interactive mode
    try {
      return await new Promise((resolve) => {
        const proc = execFile(
          "claude",
          ["-p", task],
          {
            cwd: projectPath,
            env: {
              ...process.env,
              ...env,
              // Tell Claude Code where the ask_human MCP server is. The
              // user's Claude Code config needs to declare a server
              // pointing at this URL for the tool to actually be
              // available — see Evening 6 PR docs.
              MAME_MCP_URL: mcpUrl,
              MAME_TASK_ID: taskId,
            },
            timeout: awaitResult ? 600000 : undefined, // 10 min timeout if awaiting
          },
          (error, stdout, stderr) => {
            resolve({
              success: !error,
              output: stdout,
              error: stderr || error?.message,
              task_id: taskId,
            });
          }
        );

        if (!awaitResult) {
          resolve({ dispatched: true, pid: proc.pid, task_id: taskId });
        }
      });
    } finally {
      // Always clear the task — the subprocess is gone, whether it
      // succeeded, errored, or timed out.
      if (canRouteQuestions) {
        clearTask(taskId);
      }
    }
  },
});
