// src/model-router.ts — Prefix-based routing to Anthropic/OpenRouter/Google

import Anthropic from "@anthropic-ai/sdk";
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

// OpenRouter client — uses Anthropic SDK with custom base URL
let openRouterClient: Anthropic | null = null;
function getOpenRouterClient(): Anthropic {
  if (!openRouterClient) {
    openRouterClient = new Anthropic({
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
  // OpenRouter is Anthropic-compatible API
  const client = getOpenRouterClient();
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

  // Convert Anthropic-style messages to Google format
  const googleMessages = messages.map((m) => ({
    role: m.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
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
