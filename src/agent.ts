// src/agent.ts — The agent loop, now running on pi-agent-core's Agent class.
//
// Evening 2 of the pi-ai migration. What changed:
//
// - The hand-rolled `while (stop_reason === "tool_use")` loop is gone. Tool
//   execution is driven by pi-agent-core internally.
// - The conversation buffer now stores pi-ai Message[] directly instead of
//   our Anthropic-flavored ChatMessage[], which is one less translation layer.
// - A fresh Agent instance is constructed per think() call so tool closures
//   see the current Turn context and the system prompt reflects freshly
//   recalled memories.
// - Error handling: pi-agent-core swallows provider/tool errors internally
//   and pushes a failure assistant message with stopReason "error" onto the
//   transcript. We surface state.errorMessage if present.

import { Agent } from "@mariozechner/pi-agent-core";
import {
  getModel,
  type ImageContent,
  type KnownProvider,
  type Message,
  type TextContent,
} from "@mariozechner/pi-ai";
import { recall } from "./memory.js";
import { buildSystemPrompt } from "./prompt.js";
import { loadSoul, loadConfig } from "./config.js";
import { parseModelString } from "./model-router.js";
import { getAgentTools } from "./tools/index.js";
import { childLogger } from "./logger.js";

const log = childLogger("agent");

export interface Turn {
  message: string;
  imageUrls?: string[];
  channel: "discord" | "line" | "signal" | "email" | "webhook" | "cli" | "heartbeat";
  project?: string;
  personaId: string;
  soulFile: string;
  model: string;
  tools: string[];
}

// Conversation buffer keyed by personaId:channel:project — last ~20 pi-ai
// messages per channel. Switching from ChatMessage[] to Message[] eliminates
// the translation pass we used to do on every turn.
const conversationBuffer = new Map<string, Message[]>();
const MAX_BUFFER_SIZE = 20;

function getBufferKey(turn: Turn): string {
  return `${turn.personaId}:${turn.channel}:${turn.project || "global"}`;
}

function getHistory(turn: Turn): Message[] {
  return conversationBuffer.get(getBufferKey(turn)) || [];
}

function setHistory(turn: Turn, messages: Message[]): void {
  const key = getBufferKey(turn);
  const trimmed = messages.length > MAX_BUFFER_SIZE
    ? messages.slice(-MAX_BUFFER_SIZE)
    : messages;
  conversationBuffer.set(key, trimmed);
}

/**
 * Returns a snapshot of all active conversation buffers.
 * Used by the graceful shutdown handler to persist context to memory.
 */
export function getActiveConversations(): Map<string, Message[]> {
  return conversationBuffer;
}

async function loadProjectContext(project: string): Promise<string> {
  // For now, return a minimal context string from config.
  return `Project: ${project}`;
}

async function fetchImageAsContent(url: string): Promise<ImageContent | null> {
  try {
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type") || "image/png";
    return { type: "image", data: buffer.toString("base64"), mimeType };
  } catch {
    return null;
  }
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
    const timezone = loadConfig().timezone;
    const systemPrompt = buildSystemPrompt({ soul, memories, projectContext, timezone });

    // 4. Resolve the model via pi-ai's catalog
    const route = parseModelString(turn.model);
    const piModel = getModel(route.backend as KnownProvider as any, route.modelId as any);
    if (!piModel) {
      return `Model ${route.backend}/${route.modelId} is not registered in pi-ai's catalog.`;
    }

    // 5. Build tool list (closes over this specific Turn context)
    const tools = getAgentTools(turn.tools, turn);

    // 6. Construct a fresh Agent with the conversation history seeded from
    //    our buffer. Heartbeat firings bypass the buffer entirely — they're
    //    independent scheduled tasks that should never share message history,
    //    and accumulating buffer state across firings caused intermittent
    //    Gemini 400 errors ("function response turn comes immediately after
    //    a function call turn") because unrelated tool_call/tool_result
    //    sequences ended up adjacent in the transcript.
    //
    //    thinkingLevel: respect the model's reasoning flag. Models like
    //    MiniMax M2.7 and DeepSeek R1 require reasoning to be enabled;
    //    sending "off" to them returns a 400. Non-reasoning models ignore
    //    the "medium" level and behave normally.
    const useBuffer = turn.channel !== "heartbeat";
    const history = useBuffer ? getHistory(turn) : [];
    const thinkingLevel = piModel.reasoning ? "medium" : "off";
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: piModel,
        tools,
        thinkingLevel,
        messages: history,
      },
    });

    // 7. Resolve any attached images (Discord, LINE attachments carry URLs)
    let images: ImageContent[] | undefined;
    if (turn.imageUrls && turn.imageUrls.length > 0) {
      const resolved = await Promise.all(turn.imageUrls.map(fetchImageAsContent));
      images = resolved.filter((i): i is ImageContent => i !== null);
      if (images.length === 0) images = undefined;
    }

    // 8. Run the agent loop. pi-agent-core handles tool_use → tool_result →
    //    next turn internally. Errors are swallowed into the transcript.
    await agent.prompt(turn.message, images);

    // 9. Persist the updated transcript back to our buffer (skipped for
    //    heartbeat channel — see step 6 comment).
    if (useBuffer) {
      setHistory(turn, agent.state.messages as Message[]);
    }

    // 10. Extract the final assistant text reply.
    if (agent.state.errorMessage) {
      log.error({ err: agent.state.errorMessage, channel: turn.channel, persona: turn.personaId }, "Agent run error");
      return `Something went wrong while processing your message. Error: ${agent.state.errorMessage}`;
    }

    const reply = extractFinalAssistantText(agent.state.messages as Message[]);
    return reply || "I processed your request but had no text response.";
  } catch (error) {
    // Outermost catch — keeps the daemon alive if anything escapes pi-agent-core.
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error({ err: errMsg, channel: turn.channel, persona: turn.personaId }, "think() error");
    return `Something went wrong while processing your message. Error: ${errMsg}`;
  }
}

function extractFinalAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const parts: string[] = [];
    for (const block of m.content) {
      if (block.type === "text") {
        parts.push((block as TextContent).text);
      }
    }
    const joined = parts.join("\n").trim();
    if (joined) return joined;
  }
  return "";
}
