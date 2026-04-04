// src/tools/web.ts — Web search + fetch
// Implementation: Brave Search API or Serper API for search
// Fetch with automatic fallback to agent-browser for JS-heavy pages

import { execFile } from "child_process";
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
    description: "Fetch and extract text content from a URL using a headless browser. Renders JavaScript, handles modern sites (Substack, X, SPAs). No auth needed.",
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

    // Use agent-browser as the default — handles JS-heavy sites (Substack, X, SPAs)
    const result = await fetchViaBrowser(url);

    // If browser failed (not installed, crashed), fall back to plain fetch
    if (result.error && !result.text) {
      console.log(`[web_fetch] Browser failed for ${url}, trying plain fetch`);
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Mame/0.1)",
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          return { error: `HTTP ${response.status}: ${response.statusText}` };
        }

        const html = await response.text();
        const text = stripHtml(html);
        return { url, text, length: text.length, method: "fetch-fallback" };
      } catch (fetchErr) {
        return { error: `Both browser and fetch failed. Browser: ${result.error}. Fetch: ${fetchErr}` };
      }
    }

    return result;
  },
});

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10000);
}

function fetchViaBrowser(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    // Open the page in agent-browser with --no-sandbox for headless Linux servers
    const openArgs = ["--args", "--no-sandbox", "open", url];
    execFile("agent-browser", openArgs, { timeout: 30000 }, (openErr, _openOut, openStderr) => {
      if (openErr) {
        resolve({ error: `Browser failed to open: ${openStderr || openErr.message}`, method: "browser" });
        return;
      }

      // Wait a moment for JS to render, then extract text
      setTimeout(() => {
        execFile("agent-browser", ["--args", "--no-sandbox", "extract", "--text"], { timeout: 15000 }, (extErr, extOut, extStderr) => {
          if (extErr) {
            resolve({ error: `Browser extract failed: ${extStderr || extErr.message}`, method: "browser" });
            return;
          }

          const text = (extOut || "").trim().slice(0, 10000);
          if (!text) {
            resolve({ error: "Browser rendered page but extracted no text content", url, method: "browser" });
            return;
          }

          resolve({ url, text, length: text.length, method: "browser" });
        });
      }, 2000);
    });
  });
}
