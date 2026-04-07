// src/tools/index.ts — Tool registry + executor
//
// This file maintains two parallel surfaces during the pi-ai migration:
//
// 1. The legacy surface (ToolDefinition, executeToolCalls, withRetry) — still
//    used by onboard.ts and heartbeat.ts until Evening 3.
// 2. The pi-agent-core surface (getAgentTools) — used by the new agent.ts
//    starting in Evening 2. Returns AgentTool[] ready for Agent instances.
//
// Evening 3 will delete the legacy surface when the last callers migrate.

import type Anthropic from "@anthropic-ai/sdk";
import { Type, type TSchema } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import pRetry, { AbortError } from "p-retry";
import type { Turn } from "../agent.js";
import type { ToolDefinition } from "../model-router.js";

export interface ToolContext {
  turn: Turn;
}

interface ToolHandler {
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  requiresApproval?: boolean;
}

// Tool registry — populated by loadTools()
const tools = new Map<string, ToolHandler>();

export function registerTool(handler: ToolHandler): void {
  tools.set(handler.definition.name, handler);
}

// Lazy tool loading — must be called once before using tools
let toolsLoaded = false;
export async function loadTools(): Promise<void> {
  if (toolsLoaded) return;
  toolsLoaded = true;
  await import("./browser.js");
  await import("./web.js");
  await import("./github.js");
  await import("./email.js");
  await import("./claude-code.js");
  await import("./memory-tool.js");
  await import("./report.js");
  await import("./self-modify.js");
  await import("./self-config.js");
}

// ---------------------------------------------------------------------------
// Transient error detection — shared between the legacy withRetry() path and
// the new p-retry-based path in getAgentTools().
// ---------------------------------------------------------------------------

function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("econnrefused")) {
      return true;
    }
  }
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: number }).status;
    return status === 429 || status === 503 || status === 502 || status === 504;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Legacy surface: ToolDefinition[] + executeToolCalls() + withRetry()
// Used by onboard.ts and heartbeat.ts via the chatCompletion() shim. Deleted
// in Evening 3 when those callers move to pi-agent-core.
// ---------------------------------------------------------------------------

export function getToolDefinitions(enabledTools: string[]): ToolDefinition[] {
  return Array.from(tools.values())
    .filter((t) => enabledTools.includes(t.definition.name))
    .map((t) => t.definition);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && isTransientError(error)) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(`[tools] Transient error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw lastError;
}

export async function executeToolCalls(
  content: Anthropic.ContentBlock[],
  turn: Turn
): Promise<Anthropic.ToolResultBlockParam[]> {
  const results: Anthropic.ToolResultBlockParam[] = [];

  for (const block of content) {
    if (block.type !== "tool_use") continue;

    const handler = tools.get(block.name);
    if (!handler) {
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify({ error: `Unknown tool: ${block.name}` }),
      });
      continue;
    }

    try {
      const result = await withRetry(
        () => handler.execute(block.input as Record<string, unknown>, { turn })
      );
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const retriesExhausted = isTransientError(error);
      console.error(`[tools] ${block.name} failed: ${errMsg}`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify({
          error: errMsg,
          retriesExhausted,
        }),
        is_error: true,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// pi-agent-core surface: getAgentTools() returns AgentTool[] ready to be
// handed to a fresh Agent instance. Each call closes over the current Turn
// so tool handlers see the right project/persona/channel context.
//
// Retry: p-retry handles transient errors (timeouts, 429/502/503/504). On
// non-transient errors we throw AbortError to stop p-retry immediately; the
// Agent loop then catches the throw and emits an error tool_result for the
// model to react to.
// ---------------------------------------------------------------------------

export function getAgentTools(enabledTools: string[], turn: Turn): AgentTool<TSchema>[] {
  return Array.from(tools.values())
    .filter((t) => enabledTools.includes(t.definition.name))
    .map((handler) => toolHandlerToAgentTool(handler, turn));
}

function toolHandlerToAgentTool(
  handler: ToolHandler,
  turn: Turn
): AgentTool<TSchema> {
  const parameters = Type.Unsafe<unknown>(handler.definition.input_schema);

  return {
    name: handler.definition.name,
    description: handler.definition.description,
    label: handler.definition.name,
    parameters,
    execute: async (
      _toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<unknown>> => {
      try {
        const result = await pRetry(
          async () => {
            try {
              return await handler.execute(
                (params as Record<string, unknown>) ?? {},
                { turn }
              );
            } catch (err) {
              // Non-transient errors bypass the retry budget entirely.
              if (!isTransientError(err)) {
                throw new AbortError(err instanceof Error ? err.message : String(err));
              }
              throw err;
            }
          },
          {
            retries: 2,
            minTimeout: 1000,
            factor: 2,
            onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
              console.warn(
                `[tools] ${handler.definition.name} transient error, attempt ${attemptNumber}, ${retriesLeft} retries left: ${error.message}`
              );
            },
          }
        );

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        // Unwrap AbortError for a cleaner message to the model.
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[tools] ${handler.definition.name} failed: ${errMsg}`);
        throw new Error(errMsg);
      }
    },
  };
}
