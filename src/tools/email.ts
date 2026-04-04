// src/tools/email.ts — AgentMail (~40 lines per spec)
// Implementation: AgentMail REST API — fetch calls with API key from vault

import { registerTool, type ToolContext } from "./index.js";

const AGENTMAIL_BASE = "https://api.agentmail.to/v0";

async function agentMailFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) throw new Error("AGENTMAIL_API_KEY not set. Add it to the vault.");

  const response = await fetch(`${AGENTMAIL_BASE}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`AgentMail API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

registerTool({
  definition: {
    name: "email",
    description: "Read, search, and send emails via AgentMail. Use for checking inbox, reading threads, and sending messages.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["check_inbox", "read_thread", "send", "search"],
        },
        thread_id: { type: "string", description: "Thread ID to read" },
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body" },
        query: { type: "string", description: "Search query" },
      },
      required: ["action"],
    },
  },
  async execute(input: Record<string, unknown>, _ctx: ToolContext) {
    const action = input.action as string;

    switch (action) {
      case "check_inbox": {
        const data = await agentMailFetch("/inbox") as any;
        return { threads: data.threads?.slice(0, 10) || [] };
      }

      case "read_thread": {
        const threadId = input.thread_id as string;
        if (!threadId) return { error: "thread_id required" };
        const data = await agentMailFetch(`/threads/${threadId}`);
        return data;
      }

      case "send": {
        const to = input.to as string;
        const subject = input.subject as string;
        const body = input.body as string;
        if (!to || !subject || !body) return { error: "to, subject, and body required" };
        const data = await agentMailFetch("/send", {
          method: "POST",
          body: JSON.stringify({ to, subject, body }),
        });
        return data;
      }

      case "search": {
        const query = input.query as string;
        if (!query) return { error: "query required" };
        const data = await agentMailFetch(`/search?q=${encodeURIComponent(query)}`);
        return data;
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  },
});
