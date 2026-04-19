// src/config.ts — Load config + persona with runtime validation via zod.
//
// Evening 4 of the pi-ai migration. Previously loadConfig() and
// loadPersona() did a raw TypeScript cast (`parse(raw) as MameConfig`)
// with no runtime checks, which meant a typo in config.yml or a missing
// required field would crash somewhere deep in the daemon with a cryptic
// "undefined is not a function" message.
//
// Now we parse through zod schemas that both validate structure AND
// generate the TypeScript types via z.infer, so there's only one source
// of truth per interface. Malformed config fails at startup with a clear,
// path-scoped error message.

import fs from "fs";
import path from "path";
import { parse } from "yaml";
import { z } from "zod";

export const MAME_HOME = process.env.MAME_HOME || path.join(process.env.HOME || "~", ".mame");

// ---------------------------------------------------------------------------
// Schemas — one per interface. Zod does runtime validation; z.infer below
// gives us the TypeScript types for free, so nothing else needs to change.
// ---------------------------------------------------------------------------

const ProjectConfigSchema = z.object({
  path: z.string(),
  github: z.string().optional(),
});

const DiscordConfigSchema = z.object({
  enabled: z.boolean(),
  channelMap: z.record(z.string(), z.string().nullable()).default({}),
  defaultChannel: z.string().optional(),
});

const LineConfigSchema = z.object({
  enabled: z.boolean(),
  userMap: z.record(z.string(), z.string().nullable()).default({}),
  defaultUserId: z.string().optional(),
});

const SignalConfigSchema = z.object({
  enabled: z.boolean(),
  number: z.string(),
  userMap: z.record(z.string(), z.string().nullable()).default({}),
});

const WebhookConfigSchema = z.object({
  port: z.number().int().positive(),
});

const AgentMailConfigSchema = z.object({
  pollInterval: z.number().int().positive(),
});

const ModelsConfigSchema = z.object({
  default: z.string().min(1, "models.default is required"),
  heartbeat: z.string().optional(),
  complex: z.string().optional(),
});

const MameConfigSchema = z.object({
  projects: z.record(z.string(), ProjectConfigSchema).default({}),
  discord: DiscordConfigSchema.optional(),
  line: LineConfigSchema.optional(),
  signal: SignalConfigSchema.optional(),
  webhook: WebhookConfigSchema.optional(),
  agentmail: AgentMailConfigSchema.optional(),
  models: ModelsConfigSchema.optional(),
  timezone: z.string().default("Asia/Tokyo"),
});

const PersonaConfigSchema = z.object({
  name: z.string().min(1, "persona.name is required"),
  soul: z.string().min(1, "persona.soul is required (path to the SOUL.md file)"),
  language: z.string().optional(),
  models: ModelsConfigSchema,
  tools: z.array(z.string()).default([]),
  /**
   * Default thinking level for reasoning-capable models. "off" = no
   * reasoning tokens (fast, cheap). "low"/"medium"/"high" = progressively
   * more internal deliberation (slower, better quality).
   * Ignored for models without reasoning support.
   */
  thinkingLevel: z.enum(["off", "low", "medium", "high"]).default("off"),
  discord: z
    .object({ channelMap: z.record(z.string(), z.string().nullable()) })
    .optional(),
  line: z.object({ userIds: z.array(z.string()) }).optional(),
  signal: z.object({ userNumbers: z.array(z.string()) }).optional(),
});

// ---------------------------------------------------------------------------
// TypeScript types — inferred from the schemas above. Every downstream
// file importing these types gets the same shape as before, so this change
// is invisible at the type level.
// ---------------------------------------------------------------------------

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;
export type LineConfig = z.infer<typeof LineConfigSchema>;
export type SignalConfig = z.infer<typeof SignalConfigSchema>;
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export type AgentMailConfig = z.infer<typeof AgentMailConfigSchema>;
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type MameConfig = z.infer<typeof MameConfigSchema>;
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;

// ---------------------------------------------------------------------------
// Loaders — each runs the YAML through its schema and turns any validation
// failure into a human-readable error with dotted paths so the operator
// can find the problem field in <1 second.
// ---------------------------------------------------------------------------

function formatZodError(
  prefix: string,
  filePath: string,
  error: z.ZodError
): Error {
  const lines = error.errors.map((e) => {
    const pathStr = e.path.length > 0 ? e.path.join(".") : "(root)";
    return `  - ${pathStr}: ${e.message}`;
  });
  return new Error(
    `${prefix} ${filePath}:\n${lines.join("\n")}\n\nFix the fields above and restart.`
  );
}

export function loadConfig(): MameConfig {
  const configPath = path.join(MAME_HOME, "config.yml");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}. Run 'mame init' first.`);
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = parse(raw);
  const result = MameConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw formatZodError("Invalid config.yml at", configPath, result.error);
  }
  return result.data;
}

export function loadPersona(personaName: string): PersonaConfig {
  const personaPath = path.join(MAME_HOME, "personas", `${personaName}.yml`);
  if (!fs.existsSync(personaPath)) {
    throw new Error(`Persona not found: ${personaPath}`);
  }
  const raw = fs.readFileSync(personaPath, "utf-8");
  const parsed = parse(raw);
  const result = PersonaConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw formatZodError("Invalid persona file at", personaPath, result.error);
  }
  return result.data;
}

export function loadSoul(soulFile: string): string {
  const soulPath = path.join(MAME_HOME, soulFile);
  if (!fs.existsSync(soulPath)) {
    throw new Error(`Soul file not found: ${soulPath}`);
  }
  return fs.readFileSync(soulPath, "utf-8");
}
