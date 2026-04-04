// src/agent.ts — The agent loop (~50 lines per spec, extended with error handling)

import type Anthropic from "@anthropic-ai/sdk";
import { recall, remember } from "./memory.js";
import { buildSystemPrompt } from "./prompt.js";
import { loadSoul } from "./config.js";
import { chatCompletion, type ChatMessage, type ToolDefinition } from "./model-router.js";
import { executeToolCalls, getToolDefinitions } from "./tools/index.js";

export interface Turn {
  message: string;
  channel: "discord" | "line" | "email" | "webhook" | "cli" | "heartbeat";
  project?: string;
  personaId: string;
  soulFile: string;
  model: string;
  tools: string[];
}

// Conversation buffer keyed by personaId:channelId — last ~20 messages per channel
// TODO: optional SQLite persistence for non-technical personas who need cross-restart continuity
const conversationBuffer = new Map<string, ChatMessage[]>();
const MAX_BUFFER_SIZE = 20;

function getBufferKey(turn: Turn): string {
  return `${turn.personaId}:${turn.channel}:${turn.project || "global"}`;
}

function getHistory(turn: Turn): ChatMessage[] {
  return conversationBuffer.get(getBufferKey(turn)) || [];
}

function appendToHistory(turn: Turn, messages: ChatMessage[]): void {
  const key = getBufferKey(turn);
  const history = conversationBuffer.get(key) || [];
  history.push(...messages);
  // Keep only the last MAX_BUFFER_SIZE messages
  if (history.length > MAX_BUFFER_SIZE) {
    conversationBuffer.set(key, history.slice(-MAX_BUFFER_SIZE));
  } else {
    conversationBuffer.set(key, history);
  }
}

async function loadProjectContext(project: string): Promise<string> {
  // Load project-specific context (config paths, recent activity, etc.)
  // For now, return a minimal context string from config
  return `Project: ${project}`;
}

export async function think(turn: Turn): Promise<string> {
  try {
    // 1. Recall relevant memories
    const memories = await recall(turn.message, turn.project);

    // 2. Load project context if matched
    const projectContext = turn.project
      ? await loadProjectContext(turn.project)
      : undefined;

    // 3. Load soul and assemble system prompt
    const soul = loadSoul(turn.soulFile);
    const system = buildSystemPrompt({ soul, memories, projectContext });

    // 4. Build messages with conversation history
    const history = getHistory(turn);
    const messages: ChatMessage[] = [
      ...history,
      { role: "user" as const, content: turn.message },
    ];

    // 5. Get tool definitions filtered by persona permissions
    const tools = getToolDefinitions(turn.tools);

    // 6. Run agent loop with tools
    let response = await chatCompletion(turn.model, system, messages, tools);

    // 7. Execute tool calls until done
    while (response.stop_reason === "tool_use") {
      const toolResults = await executeToolCalls(response.content, turn);
      messages.push({ role: "assistant" as const, content: response.content });
      messages.push({ role: "user" as const, content: toolResults as unknown as Anthropic.ContentBlock[] });
      response = await chatCompletion(turn.model, system, messages, tools);
    }

    // 8. Extract text response
    const reply = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // 9. Update conversation buffer
    appendToHistory(turn, [
      { role: "user", content: turn.message },
      { role: "assistant", content: reply },
    ]);

    // 10. Remember what happened (agent decides what's worth storing)
    await maybeRemember(turn.message, reply, turn.project);

    return reply;
  } catch (error) {
    // Outer catch — keeps the daemon alive
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[agent] think() error: ${errMsg}`);
    return `Something went wrong while processing your message. Error: ${errMsg}`;
  }
}

async function maybeRemember(
  userMessage: string,
  agentReply: string,
  project?: string
): Promise<void> {
  // The agent's tool calls handle explicit memory storage.
  // This function handles implicit memory — storing important interactions
  // that the agent didn't explicitly save via the memory tool.
  // For v1, we rely on the agent using the memory tool explicitly.
  // Auto-extraction happens in improve.ts after complex tasks.
}

function pickModel(turn: Turn): string {
  if (turn.channel === "heartbeat") return turn.model; // Already set by heartbeat scheduler
  return turn.model;
}
