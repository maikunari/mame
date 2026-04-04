// src/config.ts — Load config + persona (~30 lines per spec)

import fs from "fs";
import path from "path";
import { parse } from "yaml";

export const MAME_HOME = process.env.MAME_HOME || path.join(process.env.HOME || "~", ".mame");

export interface ProjectConfig {
  path: string;
  github?: string;
}

export interface DiscordConfig {
  enabled: boolean;
  channelMap: Record<string, string | null>;
  defaultChannel?: string;
}

export interface LineConfig {
  enabled: boolean;
  userMap: Record<string, string | null>;
  defaultUserId?: string;
}

export interface WebhookConfig {
  port: number;
}

export interface AgentMailConfig {
  pollInterval: number;
}

export interface ModelsConfig {
  default: string;
  heartbeat?: string;
  complex?: string;
}

export interface MameConfig {
  projects: Record<string, ProjectConfig>;
  discord?: DiscordConfig;
  line?: LineConfig;
  webhook?: WebhookConfig;
  agentmail?: AgentMailConfig;
  models?: ModelsConfig;
  timezone?: string;
}

export interface PersonaConfig {
  name: string;
  soul: string;
  language?: string;
  models: ModelsConfig;
  tools: string[];
  discord?: { channelMap: Record<string, string | null> };
  line?: { userIds: string[] };
}

export function loadConfig(): MameConfig {
  const configPath = path.join(MAME_HOME, "config.yml");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}. Run 'mame init' first.`);
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  return parse(raw) as MameConfig;
}

export function loadPersona(personaName: string): PersonaConfig {
  const personaPath = path.join(MAME_HOME, "personas", `${personaName}.yml`);
  if (!fs.existsSync(personaPath)) {
    throw new Error(`Persona not found: ${personaPath}`);
  }
  const raw = fs.readFileSync(personaPath, "utf-8");
  return parse(raw) as PersonaConfig;
}

export function loadSoul(soulFile: string): string {
  const soulPath = path.join(MAME_HOME, soulFile);
  if (!fs.existsSync(soulPath)) {
    throw new Error(`Soul file not found: ${soulPath}`);
  }
  return fs.readFileSync(soulPath, "utf-8");
}
