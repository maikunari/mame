// src/tools/web.ts — Web search + fetch (~50 lines per spec)
// Implementation: Brave Search API or Serper API for search
// Simple fetch + cheerio for page content extraction

import { registerTool, type ToolContext } from "./index.js";

registerTool({
  definition: {
    name: "web_search",
    description: "Search the web and return results. Use for research tasks that don't need a browser session.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext) {
    const query = input.query as string;

    // Try Brave Search API first, fall back to Serper
    const braveKey = process.env.BRAVE_SEARCH_API_KEY;
    const serperKey = process.env.SERPER_API_KEY;

    if (braveKey) {
      const response = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`,
        { headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": braveKey } }
      );
      const data = await response.json();
      const results = (data as any).web?.results?.slice(0, 5).map((r: any) => ({
        title: r.title,
        url: r.url,
        description: r.description,
      })) || [];
      return { results };
    }

    if (serperKey) {
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": serperKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query }),
      });
      const data = await response.json();
      const results = (data as any).organic?.slice(0, 5).map((r: any) => ({
        title: r.title,
        url: r.link,
        description: r.snippet,
      })) || [];
      return { results };
    }

    return { error: "No search API key configured. Set BRAVE_SEARCH_API_KEY or SERPER_API_KEY." };
  },
});

registerTool({
  definition: {
    name: "web_fetch",
    description: "Fetch and extract text content from a URL (no auth needed). Use for reading articles, documentation, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
  async execute(input: Record<string, unknown>, _ctx: ToolContext) {
    const url = input.url as string;

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mame/0.1 (AI Agent)" },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return { error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        return { error: `Unsupported content type: ${contentType}` };
      }

      const html = await response.text();

      // Simple text extraction — strip HTML tags
      // For v1, we do basic extraction. Can add cheerio later if needed.
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 10000); // Cap at 10K chars to avoid huge context

      return { url, text, length: text.length };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
});
