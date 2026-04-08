// src/logger.ts — Structured JSON logger backed by pino.
//
// Evening 4 of the pi-ai migration. Replaces scattered console.log calls
// with a single pino instance that emits one JSON object per event, with
// ISO-8601 timestamps and fields queryable via journalctl + jq:
//
//   journalctl -u mame -o cat | jq 'select(.level >= 40)'           # warnings and up
//   journalctl -u mame -o cat | jq 'select(.component == "heartbeat")'
//   journalctl -u mame -o cat | jq 'select(.msg | test("Discord"))'
//
// In development (NODE_ENV=development or TTY), pino-pretty provides a
// colorized human-readable format so you don't have to `jq` your own logs
// while hacking on the code.

import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
const isTty = process.stdout.isTTY;

// Use pino-pretty in dev (TTY + not explicitly prod) for colorized output
// Use raw JSON in production (systemd/journalctl consumes it)
const transport = !isProduction && isTty
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    }
  : undefined;

/**
 * Default logger. Import and use directly in source files:
 *
 *   import { logger } from "./logger.js";
 *   logger.info({ component: "heartbeat", count: 2 }, "Loaded scheduled checks");
 *
 * The first argument is a bag of structured fields; the second is the
 * human-readable message. Either can be omitted — pino handles both
 * patterns.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  // ISO 8601 timestamps with milliseconds + timezone offset — readable in
  // journalctl without further processing and trivially sortable.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact known sensitive field names defensively. Won't catch everything
  // but prevents accidental logging of bearer tokens if a log site ever
  // tries to dump a whole config object.
  redact: {
    paths: [
      "*.password",
      "*.api_key",
      "*.apiKey",
      "*.token",
      "*.authorization",
      "*.master_key",
      "*.masterKey",
      "OPENROUTER_API_KEY",
      "GEMINI_API_KEY",
      "BRAVE_SEARCH_API_KEY",
      "DISCORD_BOT_TOKEN",
      "MAME_MASTER_KEY",
    ],
    censor: "[REDACTED]",
  },
  transport,
});

/**
 * Create a child logger scoped to a component. Useful for tagging every
 * log line from a single subsystem without having to pass `component`
 * explicitly each time:
 *
 *   const log = childLogger("heartbeat");
 *   log.info("Loaded 2 scheduled checks");  // logs { component: "heartbeat", msg: "..." }
 */
export function childLogger(component: string): pino.Logger {
  return logger.child({ component });
}
