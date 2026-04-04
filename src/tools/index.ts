// src/tools/index.ts — Tool registry + executor (~40 lines per spec)

import type Anthropic from "@anthropic-ai/sdk";
import type { Turn } from "../agent.js";
import type { ToolDefinition } from "../model-router.js";

// Import all tool registrations (side-effect imports)
import "./browser.js";
import "./web.js";
import "./github.js";
import "./email.js";
import "./claude-code.js";
import "./memory-tool.js";
import "./report.js";
import "./self-modify.js";

export interface ToolContext {
  turn: Turn;
}

interface ToolHandler {
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  requiresApproval?: boolean;
}

// Tool registry — populated by individual tool modules
const tools = new Map<string, ToolHandler>();

export function registerTool(handler: ToolHandler): void {
  tools.set(handler.definition.name, handler);
}

export function getToolDefinitions(enabledTools: string[]): ToolDefinition[] {
  return Array.from(tools.values())
    .filter((t) => enabledTools.includes(t.definition.name))
    .map((t) => t.definition);
}

// Transient error detection
function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("econnrefused")) {
      return true;
    }
  }
  // Check for HTTP status codes
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: number }).status;
    return status === 429 || status === 503 || status === 502 || status === 504;
  }
  return false;
}

// Retry with exponential backoff for transient errors
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
      // Non-transient error or retries exhausted — return to agent as tool result
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
