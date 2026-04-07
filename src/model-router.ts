// src/model-router.ts — Thin shim over @mariozechner/pi-ai.
//
// Evening 1 of the pi-ai migration: we keep the exported chatCompletion()
// signature identical to before so agent.ts, onboard.ts, and heartbeat.ts
// don't need to change yet. All provider-specific quirks (Qwen tool-call
// formatting, Google multimodal image fetching, OpenRouter HTML error walls)
// are handled inside pi-ai now. This file just translates between our
// Anthropic-flavored ChatMessage/ModelResponse types and pi-ai's Context /
// AssistantMessage types.
//
// Evening 2 will delete most of this translation code when the agent loop
// moves to pi-agent-core's Agent class and callers start consuming pi-ai
// shapes directly.

import type Anthropic from "@anthropic-ai/sdk";
import {
  completeSimple,
  getModel,
  Type,
  type AssistantMessage,
  type Context,
  type ImageContent,
  type KnownProvider,
  type Message,
  type TextContent,
  type Tool,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Public types — unchanged from the pre-migration surface so callers are
// untouched in Evening 1.
// ---------------------------------------------------------------------------

export type ModelBackend = "anthropic" | "openrouter" | "google";

export interface ModelRoute {
  backend: ModelBackend;
  modelId: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | Anthropic.ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelResponse {
  content: Anthropic.ContentBlock[];
  stop_reason: string | null;
}

// ---------------------------------------------------------------------------
// Model string parsing — same prefix scheme the config files already use:
//   "openrouter/qwen/qwen3.5-plus-02-15"
//   "google/gemini-2.5-pro"
//   "claude-haiku-4-5"                    (no prefix → anthropic)
// ---------------------------------------------------------------------------

export function parseModelString(model: string): ModelRoute {
  if (model.startsWith("google/")) {
    return { backend: "google", modelId: model.slice("google/".length) };
  }
  if (model.startsWith("openrouter/")) {
    return { backend: "openrouter", modelId: model.slice("openrouter/".length) };
  }
  return { backend: "anthropic", modelId: model };
}

function backendToProvider(backend: ModelBackend): KnownProvider {
  // Our backend names happen to match pi-ai's provider names one-to-one.
  return backend;
}

// ---------------------------------------------------------------------------
// Message translation: our ChatMessage[] → pi-ai Message[].
//
// The trick is assistant messages with tool_use blocks: pi-ai's AssistantMessage
// carries many metadata fields (api, provider, model, usage, stopReason, ...)
// that we don't have when replaying history mid-loop. We synthesize sensible
// placeholders. pi-ai uses these for its own bookkeeping, not as part of the
// wire format sent to providers, so placeholder values are fine.
// ---------------------------------------------------------------------------

async function fetchImageAsContent(url: string): Promise<ImageContent | TextContent> {
  try {
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type") || "image/png";
    return { type: "image", data: buffer.toString("base64"), mimeType };
  } catch {
    return { type: "text", text: `[Image failed to load: ${url}]` };
  }
}

async function convertUserContent(
  content: string | Anthropic.ContentBlock[]
): Promise<{ userContent: (TextContent | ImageContent)[] | string; toolResults: ToolResultMessage[] }> {
  if (typeof content === "string") {
    return { userContent: content, toolResults: [] };
  }

  const userParts: (TextContent | ImageContent)[] = [];
  const toolResults: ToolResultMessage[] = [];

  for (const block of content as Array<Anthropic.ContentBlock | { type: string; [k: string]: unknown }>) {
    const b = block as any;
    if (b.type === "text") {
      userParts.push({ type: "text", text: b.text || "" });
    } else if (b.type === "image_url") {
      userParts.push(await fetchImageAsContent(b.url));
    } else if (b.type === "image" && b.source?.data) {
      userParts.push({
        type: "image",
        data: b.source.data,
        mimeType: b.source.media_type || "image/png",
      });
    } else if (b.type === "tool_result") {
      // Tool result blocks ride inside user messages in the Anthropic
      // format. pi-ai has them as separate top-level messages, so we hoist
      // each one out and return it alongside the user content.
      const resultContent: (TextContent | ImageContent)[] = [];
      if (typeof b.content === "string") {
        resultContent.push({ type: "text", text: b.content });
      } else if (Array.isArray(b.content)) {
        for (const inner of b.content) {
          if (inner?.type === "text") {
            resultContent.push({ type: "text", text: inner.text || "" });
          } else if (inner?.type === "image" && inner.source?.data) {
            resultContent.push({
              type: "image",
              data: inner.source.data,
              mimeType: inner.source.media_type || "image/png",
            });
          }
        }
      } else {
        resultContent.push({ type: "text", text: JSON.stringify(b.content ?? "") });
      }
      toolResults.push({
        role: "toolResult",
        toolCallId: b.tool_use_id,
        toolName: "unknown",
        content: resultContent,
        isError: !!b.is_error,
        timestamp: Date.now(),
      });
    }
  }

  return { userContent: userParts, toolResults };
}

function convertAssistantContent(
  content: string | Anthropic.ContentBlock[],
  placeholderModel: { api: string; provider: string; id: string }
): AssistantMessage {
  const blocks: AssistantMessage["content"] = [];

  if (typeof content === "string") {
    blocks.push({ type: "text", text: content });
  } else {
    for (const b of content as Array<Anthropic.ContentBlock | { type: string; [k: string]: unknown }>) {
      const block = b as any;
      if (block.type === "text") {
        blocks.push({ type: "text", text: block.text || "" });
      } else if (block.type === "tool_use") {
        blocks.push({
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.input ?? {},
        });
      }
    }
  }

  return {
    role: "assistant",
    content: blocks,
    api: placeholderModel.api as AssistantMessage["api"],
    provider: placeholderModel.provider,
    model: placeholderModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    // Pick a plausible stopReason so pi-ai never sees an invalid state during
    // history replay. If the assistant turn contained tool_use blocks, label
    // it "toolUse"; otherwise it's a completed text turn.
    stopReason:
      blocks.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

// Exported for unit tests. Not a stable API surface.
export async function _toPiMessagesForTest(
  messages: ChatMessage[],
  placeholder?: { api: string; provider: string; id: string }
): Promise<Message[]> {
  return toPiMessages(
    messages,
    placeholder ?? { api: "anthropic-messages", provider: "anthropic", id: "test" }
  );
}

export function _fromPiResponseForTest(msg: AssistantMessage): ModelResponse {
  return fromPiResponse(msg);
}

async function toPiMessages(
  messages: ChatMessage[],
  placeholderModel: { api: string; provider: string; id: string }
): Promise<Message[]> {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const { userContent, toolResults } = await convertUserContent(m.content);
      // Tool results must appear as their own messages in pi-ai's format.
      // If the original user message also had text/image parts, keep them.
      if (toolResults.length > 0) {
        out.push(...toolResults);
      }
      const hasUserText =
        typeof userContent === "string"
          ? userContent.length > 0
          : (userContent as (TextContent | ImageContent)[]).length > 0;
      if (hasUserText) {
        out.push({
          role: "user",
          content: userContent,
          timestamp: Date.now(),
        });
      }
    } else {
      out.push(convertAssistantContent(m.content, placeholderModel));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool translation: JSON Schema (Anthropic-style) → TypeBox wrapper.
// Type.Unsafe lets us pass an arbitrary JSON Schema object through to pi-ai
// without rewriting every tool definition to TypeBox (that's Evening 2 work).
// ---------------------------------------------------------------------------

function toPiTools(tools: ToolDefinition[]): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: Type.Unsafe<unknown>(t.input_schema),
  }));
}

// ---------------------------------------------------------------------------
// Response translation: pi-ai AssistantMessage → our Anthropic-flavored
// ModelResponse. Evening 2 will delete this when agent.ts consumes pi-ai
// directly.
// ---------------------------------------------------------------------------

function fromPiResponse(msg: AssistantMessage): ModelResponse {
  const content: Anthropic.ContentBlock[] = [];
  let hasToolCall = false;

  for (const block of msg.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text, citations: null } as Anthropic.TextBlock);
    } else if (block.type === "toolCall") {
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.arguments,
      } as Anthropic.ToolUseBlock);
      hasToolCall = true;
    }
    // thinking blocks are dropped for now — agent.ts doesn't consume them
  }

  // pi-ai encodes provider errors as a final AssistantMessage with
  // stopReason "error" or "aborted" and an errorMessage field rather than
  // throwing. Surface the error text so callers see something useful.
  if ((msg.stopReason === "error" || msg.stopReason === "aborted") && msg.errorMessage) {
    const errText = msg.errorMessage.replace(/<[^>]+>/g, "").slice(0, 300);
    console.error(`[model-router] ${msg.provider}/${msg.model} error: ${errText}`);
    if (content.length === 0 || !content.some((b) => b.type === "text" && (b as Anthropic.TextBlock).text)) {
      content.push({ type: "text", text: `LLM error: ${errText}`, citations: null } as Anthropic.TextBlock);
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "", citations: null } as Anthropic.TextBlock);
  }

  // Map pi-ai stopReason → our stop_reason strings that agent.ts switches on.
  let stop_reason: string | null = "end_turn";
  if (hasToolCall || msg.stopReason === "toolUse") stop_reason = "tool_use";
  else if (msg.stopReason === "length") stop_reason = "max_tokens";
  else if (msg.stopReason === "stop") stop_reason = "end_turn";
  else if (msg.stopReason === "error" || msg.stopReason === "aborted") stop_reason = "end_turn";

  return { content, stop_reason };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function chatCompletion(
  model: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxTokens = 8096
): Promise<ModelResponse> {
  const route = parseModelString(model);
  const provider = backendToProvider(route.backend);

  // Resolve the model. If it's not registered in pi-ai's catalog, surface
  // a clean error rather than a cryptic TypeBox failure.
  let piModel;
  try {
    piModel = getModel(provider as any, route.modelId as any);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[model-router] Unknown model ${provider}/${route.modelId}: ${msg}`);
    return {
      content: [
        {
          type: "text",
          text: `Model ${provider}/${route.modelId} is not registered in pi-ai's catalog.`,
          citations: null,
        } as Anthropic.TextBlock,
      ],
      stop_reason: "end_turn",
    };
  }

  const piMessages = await toPiMessages(messages, {
    api: piModel.api,
    provider: piModel.provider,
    id: piModel.id,
  });

  const context: Context = {
    systemPrompt: system,
    messages: piMessages,
    tools: tools.length > 0 ? toPiTools(tools) : undefined,
  };

  try {
    const response = await completeSimple(piModel, context, {
      maxTokens,
    });
    return fromPiResponse(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    // Strip any HTML that sneaks through error messages (providers still
    // occasionally return HTML error pages even through pi-ai).
    const clean = errMsg.replace(/<[^>]+>/g, "").slice(0, 300);
    console.error(`[model-router] ${route.backend} error: ${clean}`);
    return {
      content: [
        { type: "text", text: `LLM error: ${clean}`, citations: null } as Anthropic.TextBlock,
      ],
      stop_reason: "end_turn",
    };
  }
}
