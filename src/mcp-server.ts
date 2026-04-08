// src/mcp-server.ts — Embedded MCP HTTP server exposing the ask_human tool.
//
// Evening 6 of the pi-ai migration. Runs inside the Mame daemon on a
// dedicated localhost port (default 3848) and exposes a single MCP tool:
// ask_human. Child agents (primarily Claude Code dispatched via the
// claude-code tool) connect to this server as MCP clients and use
// ask_human to pause mid-task and route a clarifying question back to
// the human user through the messaging gateway.
//
// ## Why HTTP instead of stdio
//
// stdio is the default MCP transport and it's simpler for one-shot
// subprocess servers, but our case is different: we need a long-running
// server embedded in the Mame daemon that SHARES STATE with the rest of
// the daemon (specifically src/ask-human-state.ts). A stdio server
// spawned per Claude Code invocation would be a separate process with
// its own memory, no access to gateway.notify(), and no way to resolve
// a promise waiting for a Discord message.
//
// HTTP on localhost keeps the server inside the Mame process, which is
// the whole point.
//
// ## Request flow
//
// 1. Claude Code (configured with http://localhost:3848 as an MCP server)
//    calls ask_human with a question argument
// 2. handleAskHuman() reads the current active task from ask-human-state
// 3. It registers a pending question, which causes askHuman() to send
//    the question to the user's channel via onQuestion callback
// 4. The promise hangs until the user replies (via Discord message
//    handler in gateway.ts) or the 10-minute timeout fires
// 5. The resolved answer becomes the tool call result, MCP returns it
//    to Claude Code, Claude Code resumes

import { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { askHuman, getActiveTask, type ActiveTask } from "./ask-human-state.js";
import { childLogger } from "./logger.js";

const log = childLogger("mcp-server");

/**
 * Signature for the callback that actually delivers a question to the
 * user. Injected by the daemon startup path (src/index.ts) so this
 * module stays free of any gateway-specific imports — one-way
 * dependency: mcp-server → ask-human-state → (callback → gateway).
 */
export type DeliverQuestionFn = (task: ActiveTask, question: string) => Promise<void>;

export interface McpServerHandle {
  /** Close the HTTP server and all active transports. */
  close: () => Promise<void>;
  /** Port the server is actually listening on. */
  port: number;
}

export interface McpServerOptions {
  /**
   * Port to listen on. Defaults to 3848. Chosen to be distinct from
   * 3847 (webhooks) so the two servers don't collide.
   */
  port?: number;
  /**
   * Host interface. Defaults to 127.0.0.1 so the server is only
   * reachable from localhost — a child process on the same machine
   * is the expected client, never an external network request.
   */
  host?: string;
  /**
   * Callback invoked when the ask_human tool fires. Wires the question
   * into the messaging gateway (Discord, Signal, etc.).
   */
  onQuestion: DeliverQuestionFn;
}

/**
 * Start the MCP server. Returns a handle the daemon can use to close
 * it during shutdown. Throws if the port is already in use — we don't
 * auto-retry because a collision means something else is listening and
 * the operator should see the error.
 */
export async function startMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
  const port = options.port ?? 3848;
  const host = options.host ?? "127.0.0.1";

  const server = buildMcpServer(options.onQuestion);

  // Stateful mode — generates a Mcp-Session-Id on initialize and tracks
  // the session across subsequent requests. Originally tried stateless
  // mode for simplicity but Claude Code's MCP HTTP client expects
  // stateful: it issues an initialize POST, expects a session ID back
  // in the response headers, then sends notifications/initialized as
  // a separate request that requires the session ID. Stateless mode
  // returned 500 on the second request because the SDK couldn't
  // associate the notification with any session.
  //
  // ask-human-state tracks the *task* state (which channel dispatched
  // the active claude_code task); the MCP session is a different layer
  // of state that lives inside the SDK transport. Both can coexist —
  // the MCP session is per-Claude-Code-invocation and dies when that
  // process exits.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(transport);

  const app = express();

  // JSON body parsing with a generous limit — MCP tool calls stay small
  // but the limit protects us from runaway payloads.
  app.use(express.json({ limit: "1mb" }));

  // Single endpoint that the MCP spec expects. Both POST (tool calls)
  // and GET (SSE streams) go through handleRequest.
  const mcpHandler = async (req: Request, res: Response) => {
    try {
      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body
      );
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "MCP handler error"
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  };

  app.post("/mcp", mcpHandler);
  app.get("/mcp", mcpHandler);
  app.delete("/mcp", mcpHandler);

  // Health check endpoint — not part of the MCP protocol, just a
  // convenience for ops debugging and the Mame CLI.
  app.get("/health", (_req: Request, res: Response) => {
    const task = getActiveTask();
    res.json({
      ok: true,
      activeTask: task
        ? {
            taskId: task.taskId,
            channel: task.channel,
            persona: task.persona,
            elapsedMs: Date.now() - task.startedAt,
            hasPendingQuestion: task.pendingQuestion !== null,
          }
        : null,
    });
  });

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      log.info({ host, port }, `MCP server listening on http://${host}:${port}/mcp`);
      resolve({
        port,
        close: async () => {
          log.info("MCP server shutting down");
          await new Promise<void>((r) => httpServer.close(() => r()));
          await server.close();
        },
      });
    });

    httpServer.on("error", (err) => {
      log.error({ err: err.message, port }, "MCP server failed to start");
      reject(err);
    });
  });
}

/**
 * Build the MCP server with the single ask_human tool registered.
 * Separated from startMcpServer() so it can be instantiated for tests
 * without needing a real HTTP listener.
 */
function buildMcpServer(onQuestion: DeliverQuestionFn): McpServer {
  const server = new McpServer(
    {
      name: "mame-ask-human",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.registerTool(
    "ask_human",
    {
      title: "Ask Human",
      description:
        "Pause your current task and ask the human user a clarifying question. " +
        "Mame will route the question to whichever messaging channel dispatched " +
        "your task (Discord, Signal, etc.) and return the human's answer as this " +
        "tool's result. Use this when you encounter an ambiguous decision, need " +
        "permission for a destructive action, or hit a blocker only the human can " +
        "resolve. The call will block until the human responds or a 10-minute " +
        "timeout fires. Provide enough context in your question for the human to " +
        "answer without needing more back-and-forth.",
      inputSchema: {
        question: z
          .string()
          .min(1)
          .describe(
            "The question to ask the human. Include enough context that they can " +
              "answer without needing follow-up. Example: 'I found 47 products " +
              "tagged spring-2026 but 12 of them are last year leftover stock. " +
              "Should I update the leftover stock too, or skip them?'"
          ),
      },
    },
    async ({ question }) => {
      log.info(
        { question_preview: question.slice(0, 80) },
        "ask_human invoked"
      );
      try {
        const answer = await askHuman(question, onQuestion);
        return {
          content: [{ type: "text" as const, text: answer }],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn({ err: errMsg }, "ask_human failed");
        return {
          content: [
            {
              type: "text" as const,
              text: errMsg,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}
