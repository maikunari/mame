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
// ## Per-session transport architecture
//
// Earlier iterations created ONE McpServer + ONE StreamableHTTPServerTransport
// at daemon startup and reused them for every incoming request. That
// works for the very first client (curl, claude mcp list) but every
// subsequent client gets:
//
//   {"jsonrpc":"2.0","error":{"code":-32600,
//    "message":"Invalid Request: Server already initialized"},"id":null}
//
// because the SDK transport tracks initialization state per instance.
// Once it's initialized, it rejects further `initialize` requests.
//
// The fix follows the SDK's official pattern: keep a Map<sessionId,
// transport> and create a fresh transport (and McpServer) on each new
// session. Subsequent requests carry an `Mcp-Session-Id` header that
// the handler uses to find the matching transport. When a session
// closes, we remove it from the map.
//
// One McpServer per session is the right architectural shape because
// each Claude Code invocation runs as its own client and shouldn't
// share initialization state with any other client.

import { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
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

  // Per-session map of transport instances. Each MCP client (each Claude
  // Code invocation) gets its own session created on the initialize
  // request, identified by a UUID returned in the Mcp-Session-Id header.
  // Subsequent requests carry that header and we route them to the
  // matching transport.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const app = express();

  // JSON body parsing with a generous limit — MCP tool calls stay small
  // but the limit protects us from runaway payloads.
  app.use(express.json({ limit: "1mb" }));

  /**
   * Main MCP handler — handles POST (requests + notifications), GET (SSE
   * streams for server-initiated messages), and DELETE (session close).
   *
   * Session lifecycle:
   * - First POST without Mcp-Session-Id, body is an initialize request:
   *   create a new transport + new McpServer, store in map, generate
   *   session ID, route the request through the new transport.
   * - Subsequent POST/GET/DELETE with Mcp-Session-Id header: look up
   *   the existing transport in the map and route through it.
   * - DELETE or transport.onclose: remove from map.
   */
  const mcpHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session — reuse the transport
      transport = transports.get(sessionId);
    } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      // New session — spin up a fresh transport and McpServer for this client
      log.info("Creating new MCP session");

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          if (transport) {
            transports.set(id, transport);
            log.info({ sessionId: id, activeSessions: transports.size }, "MCP session initialized");
          }
        },
      });

      transport.onclose = () => {
        if (transport?.sessionId && transports.has(transport.sessionId)) {
          transports.delete(transport.sessionId);
          log.info(
            { sessionId: transport.sessionId, activeSessions: transports.size },
            "MCP session closed"
          );
        }
      };

      // Each session gets its own McpServer instance with the ask_human
      // tool registered. They all share the same onQuestion callback so
      // questions still route to the same gateway.
      const server = buildMcpServer(options.onQuestion);
      await server.connect(transport);
    } else {
      // Invalid: either has a session ID we don't know, or no session ID
      // and not an initialize request
      log.warn(
        {
          method: req.method,
          sessionId,
          hasBody: !!req.body,
          isInit: req.body ? isInitializeRequest(req.body) : false,
        },
        "MCP request without valid session"
      );
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    if (!transport) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error: no transport" },
        id: null,
      });
      return;
    }

    try {
      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body
      );
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          sessionId: transport.sessionId,
        },
        "MCP handler error"
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
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
      activeSessions: transports.size,
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
          // Close all active transports
          for (const t of transports.values()) {
            try {
              await t.close();
            } catch {
              /* ignore */
            }
          }
          transports.clear();
          await new Promise<void>((r) => httpServer.close(() => r()));
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
 * Build a fresh McpServer instance with the single ask_human tool
 * registered. Called once per MCP session — each connecting client
 * gets its own server instance so initialization state is isolated.
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
