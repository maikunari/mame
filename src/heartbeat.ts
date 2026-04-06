// src/heartbeat.ts — Cron scheduler (~40 lines per spec, extended with HEARTBEAT.md parsing)
// HEARTBEAT.md is the single source of truth. No hardcoded crons.

import fs from "fs";
import path from "path";
import cron from "node-cron";
import { think, type Turn } from "./agent.js";
import { MAME_HOME, type PersonaConfig, type MameConfig } from "./config.js";
import type Anthropic from "@anthropic-ai/sdk";
import { chatCompletion } from "./model-router.js";

interface HeartbeatEntry {
  cron: string;
  prompt: string;
  project: string | null;
}

export class HeartbeatScheduler {
  private jobs: cron.ScheduledTask[] = [];
  private config: MameConfig;
  private persona: PersonaConfig;
  private notify: (project: string | undefined, message: string) => Promise<void>;

  constructor(
    config: MameConfig,
    persona: PersonaConfig,
    notify: (project: string | undefined, message: string) => Promise<void>
  ) {
    this.config = config;
    this.persona = persona;
    this.notify = notify;
  }

  async start(): Promise<void> {
    const heartbeatPath = path.join(MAME_HOME, "HEARTBEAT.md");

    if (!fs.existsSync(heartbeatPath)) {
      console.log("[heartbeat] No HEARTBEAT.md found, skipping scheduler");
      return;
    }

    await this.loadSchedule();

    // Reload when HEARTBEAT.md changes
    fs.watch(heartbeatPath, async (eventType) => {
      if (eventType === "change") {
        console.log("[heartbeat] HEARTBEAT.md changed, reloading schedule...");
        await this.loadSchedule();
      }
    });
  }

  private async loadSchedule(): Promise<void> {
    // Clear existing jobs
    for (const job of this.jobs) {
      job.stop();
    }
    this.jobs = [];

    const heartbeatPath = path.join(MAME_HOME, "HEARTBEAT.md");
    const raw = fs.readFileSync(heartbeatPath, "utf-8");

    // Use a cheap model to parse natural language → structured schedule
    const entries = await this.parseSchedule(raw);

    const timezone = this.config.timezone || "Asia/Tokyo";

    for (const entry of entries) {
      if (!cron.validate(entry.cron)) {
        console.error(`[heartbeat] Invalid cron expression: ${entry.cron} — skipping`);
        continue;
      }

      const job = cron.schedule(entry.cron, async () => {
        console.log(`[heartbeat] Running: ${entry.prompt.slice(0, 50)}...`);

        const turn: Turn = {
          message: entry.prompt,
          channel: "heartbeat",
          project: entry.project || undefined,
          personaId: this.persona.name,
          soulFile: this.persona.soul,
          model: this.persona.models.heartbeat || this.persona.models.default,
          tools: this.persona.tools,
        };

        const reply = await think(turn);

        // Only suppress on EXACT "ALL_CLEAR" reply (trimmed). If the model
        // includes ALL_CLEAR within a larger response (e.g. a daily brief
        // that mentions everything is fine), we still deliver it.
        const trimmed = reply.trim();
        if (trimmed === "ALL_CLEAR" || trimmed === "ALL_CLEAR.") {
          console.log(`[heartbeat] Suppressed (ALL_CLEAR): ${entry.prompt.slice(0, 50)}...`);
          return;
        }

        await this.notify(entry.project || undefined, `💓 ${reply}`);
      }, { timezone });

      this.jobs.push(job);
    }

    console.log(`[heartbeat] Loaded ${this.jobs.length} scheduled checks`);
  }

  private async parseSchedule(markdown: string): Promise<HeartbeatEntry[]> {
    try {
      const model = this.persona.models.heartbeat || this.persona.models.default;

      const response = await chatCompletion(
        model,
        "You are a schedule parser. Convert natural language schedules into cron expressions.",
        [{
          role: "user",
          content: `Parse this heartbeat schedule into JSON.
Return ONLY a valid JSON array of objects with these fields:
- cron: standard 5-field cron expression
- prompt: what to check (combine related items into one prompt)
- project: project name if specified, or null

Important: Use standard cron syntax. "Every 30 minutes" = "*/30 * * * *". "Every morning at 9:00" = "0 9 * * *".

Schedule to parse:
${markdown}`,
        }],
        [], // no tools needed for parsing
        2000
      );

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error("[heartbeat] Failed to parse schedule — no JSON array found in response");
        return [];
      }

      return JSON.parse(jsonMatch[0]) as HeartbeatEntry[];
    } catch (error) {
      console.error(`[heartbeat] Schedule parse error: ${error}`);
      return [];
    }
  }

  // List the parsed schedule entries (for CLI inspection)
  async listEntries(): Promise<HeartbeatEntry[]> {
    const heartbeatPath = path.join(MAME_HOME, "HEARTBEAT.md");
    if (!fs.existsSync(heartbeatPath)) return [];
    const raw = fs.readFileSync(heartbeatPath, "utf-8");
    return this.parseSchedule(raw);
  }

  // Run all scheduled entries immediately (for manual testing)
  async runNow(): Promise<string> {
    const entries = await this.listEntries();
    if (entries.length === 0) {
      return "No HEARTBEAT.md entries to run.";
    }

    const results: string[] = [];
    for (const entry of entries) {
      console.log(`[heartbeat] Running: ${entry.prompt.slice(0, 60)}...`);

      const turn: Turn = {
        message: entry.prompt,
        channel: "heartbeat",
        project: entry.project || undefined,
        personaId: this.persona.name,
        soulFile: this.persona.soul,
        model: this.persona.models.heartbeat || this.persona.models.default,
        tools: this.persona.tools,
      };

      const reply = await think(turn);
      const trimmed = reply.trim();

      if (trimmed === "ALL_CLEAR" || trimmed === "ALL_CLEAR.") {
        results.push(`✓ [${entry.cron}] ALL_CLEAR (suppressed)`);
        continue;
      }

      // Deliver via notify callback
      await this.notify(entry.project || undefined, `💓 ${reply}`);
      results.push(`✓ [${entry.cron}] Delivered`);
    }

    return results.join("\n");
  }
}
