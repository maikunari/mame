// src/model-router.ts — Prefix-based routing to Anthropic/OpenRouter/Google

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

export type ModelBackend = "anthropic" | "openrouter" | "google";

export interface ModelRoute {
  backend: ModelBackend;
  modelId: string;
}

export function parseModelString(model: string): ModelRoute {
  if (model.startsWith("google/")) {
    return { backend: "google", modelId: model.slice("google/".length) };
  }
  if (model.startsWith("openrouter/")) {
    return { backend: "openrouter", modelId: model.slice("openrouter/".length) };
  }
  // No prefix → direct Anthropic
  return { backend: "anthropic", modelId: model };
}

// Anthropic client — direct API
let anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

// OpenRouter client — uses OpenAI SDK with OpenRouter base URL
// Supports all models on OpenRouter (Qwen, Llama, Claude, Gemma, etc.)
let openRouterClient: OpenAI | null = null;
function getOpenRouterClient(): OpenAI {
  if (!openRouterClient) {
    openRouterClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY || "",
      baseURL: "https://openrouter.ai/api/v1",
    });
  }
  return openRouterClient;
}

// Google Generative AI client
let googleClient: GoogleGenerativeAI | null = null;
function getGoogleClient(): GoogleGenerativeAI {
  if (!googleClient) {
    googleClient = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "");
  }
  return googleClient;
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

// Unified chat completion that routes to the correct backend
export async function chatCompletion(
  model: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxTokens = 8096
): Promise<ModelResponse> {
  const route = parseModelString(model);

  switch (route.backend) {
    case "anthropic":
      return anthropicCompletion(route.modelId, system, messages, tools, maxTokens);
    case "openrouter":
      return openRouterCompletion(route.modelId, system, messages, tools, maxTokens);
    case "google":
      return googleCompletion(route.modelId, system, messages, tools, maxTokens);
  }
}

async function anthropicCompletion(
  modelId: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxTokens: number
): Promise<ModelResponse> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: modelId,
    max_tokens: maxTokens,
    system,
    messages: messages as Anthropic.MessageParam[],
    tools: tools.length > 0 ? (tools as Anthropic.Tool[]) : undefined,
  });
  return {
    content: response.content,
    stop_reason: response.stop_reason,
  };
}

async function openRouterCompletion(
  modelId: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxTokens: number
): Promise<ModelResponse> {
  const client = getOpenRouterClient();

  // Convert messages to OpenAI format
  const oaiMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];

  for (const m of messages) {
    if (typeof m.content === "string") {
      oaiMessages.push({ role: m.role, content: m.content });
    } else {
      const blocks = m.content as any[];

      // Collect tool_use blocks (assistant) and tool_result blocks (user) separately
      const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
      const toolResultBlocks = blocks.filter((b) => b.type === "tool_result");
      const textBlocks = blocks.filter((b) => b.type === "text" || b.type === "image_url");

      // If this is an assistant message with tool calls
      if (m.role === "assistant" && toolUseBlocks.length > 0) {
        const textContent = textBlocks.map((b) => b.text || "").join("\n").trim() || null;
        oaiMessages.push({
          role: "assistant",
          content: textContent,
          tool_calls: toolUseBlocks.map((b) => ({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })),
        } as any);
      }
      // If this is a user message with tool results
      else if (toolResultBlocks.length > 0) {
        for (const block of toolResultBlocks) {
          oaiMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
          } as any);
        }
      }
      // Regular content (text, images)
      else if (textBlocks.length > 0) {
        const parts: OpenAI.ChatCompletionContentPart[] = textBlocks.map((b) => {
          if (b.type === "image_url") {
            return { type: "image_url" as const, image_url: { url: b.url } };
          }
          return { type: "text" as const, text: b.text || JSON.stringify(b) };
        });
        oaiMessages.push({ role: m.role, content: parts } as any);
      }
    }
  }

  // Convert tools to OpenAI format
  const oaiTools = tools.length > 0
    ? tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
    : undefined;

  let response;
  try {
    response = await client.chat.completions.create({
      model: modelId,
      max_tokens: maxTokens,
      messages: oaiMessages,
      tools: oaiTools,
    });
  } catch (error: any) {
    // Extract a clean error message — never dump raw HTML
    let errMsg = "OpenRouter API error";
    if (error?.message) {
      // Strip HTML if present
      errMsg = error.message.replace(/<[^>]+>/g, "").slice(0, 200);
    }
    if (error?.status) errMsg = `OpenRouter ${error.status}: ${errMsg}`;
    console.error(`[model-router] OpenRouter error: ${errMsg}`);
    return { content: [{ type: "text", text: errMsg, citations: null } as Anthropic.TextBlock], stop_reason: "end_turn" };
  }

  const choice = response.choices[0];
  if (!choice) {
    return { content: [{ type: "text", text: "No response from OpenRouter model", citations: null } as Anthropic.TextBlock], stop_reason: "end_turn" };
  }

  // Convert OpenAI response back to Anthropic format
  const content: Anthropic.ContentBlock[] = [];
  let stopReason: string | null = "end_turn";

  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content, citations: null } as Anthropic.TextBlock);
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      const fn = (tc as any).function;
      content.push({
        type: "tool_use",
        id: tc.id,
        name: fn.name,
        input: JSON.parse(fn.arguments || "{}"),
      } as Anthropic.ToolUseBlock);
    }
    stopReason = "tool_use";
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "", citations: null } as Anthropic.TextBlock);
  }

  return { content, stop_reason: stopReason };
}

async function googleCompletion(
  modelId: string,
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  maxTokens: number
): Promise<ModelResponse> {
  const client = getGoogleClient();
  const model = client.getGenerativeModel({
    model: modelId,
    systemInstruction: system,
    generationConfig: { maxOutputTokens: maxTokens },
  });

  // Convert Anthropic-style messages to Google format (with multimodal support)
  const googleMessages = await Promise.all(messages.map(async (m) => {
    const role = m.role === "assistant" ? ("model" as const) : ("user" as const);

    if (typeof m.content === "string") {
      return { role, parts: [{ text: m.content }] };
    }

    // Handle content blocks (may include images)
    const parts: any[] = [];
    for (const block of m.content as any[]) {
      if (block.type === "text") {
        parts.push({ text: block.text });
      } else if (block.type === "image_url" && block.url) {
        // Download image and pass as inline base64
        try {
          const response = await fetch(block.url);
          const buffer = Buffer.from(await response.arrayBuffer());
          const mimeType = response.headers.get("content-type") || "image/png";
          parts.push({
            inlineData: {
              mimeType,
              data: buffer.toString("base64"),
            },
          });
        } catch (err) {
          parts.push({ text: `[Image failed to load: ${block.url}]` });
        }
      } else {
        parts.push({ text: JSON.stringify(block) });
      }
    }

    if (parts.length === 0) parts.push({ text: "" });
    return { role, parts };
  }));

  // Google tool format
  const googleTools = tools.length > 0
    ? [{
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema as any,
        })),
      }]
    : undefined;

  const result = await model.generateContent({
    contents: googleMessages,
    tools: googleTools as any,
  });

  const response = result.response;
  const candidate = response.candidates?.[0];

  if (!candidate) {
    return { content: [{ type: "text", text: "No response from Google model", citations: null } as Anthropic.TextBlock], stop_reason: "end_turn" };
  }

  // Convert Google response back to Anthropic format
  const content: Anthropic.ContentBlock[] = [];
  let stopReason: string | null = "end_turn";

  for (const part of candidate.content.parts) {
    if (part.text) {
      content.push({ type: "text", text: part.text, citations: null } as Anthropic.TextBlock);
    } else if (part.functionCall) {
      content.push({
        type: "tool_use",
        id: `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      } as Anthropic.ToolUseBlock);
      stopReason = "tool_use";
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "", citations: null } as Anthropic.TextBlock);
  }

  return { content, stop_reason: stopReason };
}
