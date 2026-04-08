// src/env.ts — Type-safe env var access via znv + zod.
//
// Evening 4 of the pi-ai migration. Centralizes all env var reads through
// a single schema so:
//
// - Typos in env var names fail loudly at startup instead of silently
//   returning undefined and breaking deep in the daemon
// - Everyone gets consistent defaults (e.g. LOG_LEVEL defaults to "info")
// - The returned object is fully typed — no more `process.env.FOO!` non-null
//   assertions sprinkled everywhere
//
// Secrets (API keys, master key) are intentionally NOT in this schema.
// They're populated by the systemd-creds loader and the vault loader at
// runtime, which happen AFTER module import. The schema here is for
// *non-secret* operational env vars that are present at daemon startup.
//
// Usage:
//   import { env } from "./env.js";
//   if (env.LOG_LEVEL === "debug") { ... }

import { parseEnv } from "znv";
import { z } from "zod";

export const env = parseEnv(process.env, {
  /**
   * Log level passed to pino. Default "info" in production, overridable
   * via LOG_LEVEL env for debugging.
   */
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),

  /**
   * Controls whether pino emits raw JSON (production) or pino-pretty
   * colorized output (development). Checked by src/logger.ts.
   */
  NODE_ENV: z.string().default("production"),

  /**
   * Overrides the default MAME_HOME path (~/.mame). Rarely set outside
   * tests and temporary sandboxes.
   */
  MAME_HOME: z.string().optional(),

  /**
   * Which persona the daemon should load. Command-line --persona flag
   * takes precedence; this is the fallback.
   */
  MAME_PERSONA: z.string().optional(),

  /**
   * Override the model used for CLI onboarding. Falls back to Qwen via
   * OpenRouter in the onboarding code.
   */
  MAME_ONBOARD_MODEL: z.string().optional(),
});
