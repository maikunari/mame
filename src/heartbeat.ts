// src/heartbeat.ts — Cron scheduler backed by pi-ai structured output + croner.
//
// Evening 3 of the pi-ai migration. What changed:
//
// - parseSchedule() now uses pi-agent-core's Agent class with a single
//   "submit_schedule" tool whose TypeBox schema forces the model to return
//   entries matching an exact shape. Replaces the old freeform-JSON-in-text
//   approach that had two failure modes:
//     1. `no JSON array found` when the model wrapped output in prose
//     2. Silent hallucination of phantom entries from explanatory prose
//        (e.g. a "system monitoring" entry that fired every minute in prod)
//
// - node-cron → croner. Same pattern strings, better DST handling, TS-native
//   types, smaller install.
//
// Public API (start, loadSchedule, listEntries, runNow) is unchanged —
// callers in index.ts and cli.ts don't need to change.

import fs from "fs";
import path from "path";
import { Cron } from "croner";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import {
  Type,
  getModel,
  type Api,
  type KnownProvider,
  type Model,
  type Static,
} from "@mariozechner/pi-ai";
import { think, type Turn } from "./agent.js";
import { MAME_HOME, type PersonaConfig, type MameConfig } from "./config.js";
import { parseModelString } from "./model-router.js";
import { childLogger } from "./logger.js";

const log = childLogger("heartbeat");

interface HeartbeatEntry {
  cron: string;
  prompt: string;
  project: string | null;
}

// Schema for structured output — the schedule parser's model is forced to
// call submit_schedule with an array matching this shape. Validation is
// handled by pi-agent-core via TypeBox + AJV.
const ScheduleEntrySchema = Type.Object({
  cron: Type.String({
    description:
      "Standard 5-field cron expression (minute hour day-of-month month day-of-week). Examples: '30 7 * * *' for 7:30 AM daily, '*/15 * * * *' for every 15 minutes.",
  }),
  prompt: Type.String({
    description:
      "The task description the agent should run at this time. Combine related bullet points from the schedule document into one coherent prompt.",
  }),
  project: Type.Union([Type.String(), Type.Null()], {
    description:
      "A specific project name if the schedule explicitly scopes this task to one, otherwise null.",
  }),
});

const ScheduleSchema = Type.Object({
  entries: Type.Array(ScheduleEntrySchema, {
    description:
      "The list of scheduled tasks extracted from the document. Include ONLY tasks that have an explicit schedule (time of day, interval, or cron spec). Skip anything that's explanatory prose or a future-feature note.",
  }),
});

type ScheduleSchemaType = Static<typeof ScheduleSchema>;

// --------------------------------------------------------------------------
// Testable parser core — accepts a pre-resolved pi-ai Model so offline tests
// can inject a faux-registered model without going through pi-ai's static
// getModel() catalog. The HeartbeatScheduler method below is a thin wrapper
// that handles model-string resolution via the persona config.
// --------------------------------------------------------------------------
export async function parseScheduleWithModel(
  piModel: Model<Api>,
  markdown: string
): Promise<HeartbeatEntry[]> {
  let captured: HeartbeatEntry[] | null = null;

  const submitTool: AgentTool<typeof ScheduleSchema> = {
    name: "submit_schedule",
    label: "submit_schedule",
    description:
      "Submit the parsed schedule entries extracted from the document. Call this exactly once with all valid schedule entries you found. If the document contains no scheduled tasks, call it with an empty entries array.",
    parameters: ScheduleSchema,
    execute: async (_toolCallId, params: ScheduleSchemaType) => {
      captured = params.entries.map((e) => ({
        cron: e.cron,
        prompt: e.prompt,
        // AJV coerces Type.Union([String, Null]) nulls to "" in some
        // provider paths; treat empty strings as null so downstream code
        // sees the same "no project scope" sentinel regardless of model.
        project: e.project && e.project.length > 0 ? e.project : null,
      }));
      return {
        content: [
          {
            type: "text",
            text: `Captured ${params.entries.length} schedule entries.`,
          },
        ],
        details: params,
      };
    },
  };

  const systemPrompt = `You are a schedule parser. Your only job is to read a natural-language schedule document and extract the scheduled tasks into a structured list.

You MUST call the submit_schedule tool exactly once with all entries you found. Do not return any other text.

RULES:
- ONLY include tasks that have an explicit schedule: a time of day ("every morning at 7:30"), an interval ("every 15 minutes"), or a cron spec.
- DO NOT hallucinate entries from explanatory prose, future-feature descriptions, or general discussion.
- DO NOT add entries for "system monitoring" or "health checks" unless they have an explicit schedule.
- If a section describes a feature but gives no schedule, SKIP it.
- Combine related bullet points under the same schedule into one coherent prompt string.

Common pattern translations:
- "every morning at 7:30" → "30 7 * * *"
- "every evening at 18:30" → "30 18 * * *"
- "every day at 9 AM" → "0 9 * * *"
- "every 15 minutes" → "*/15 * * * *"
- "every hour" → "0 * * * *"
- "weekdays at 8 AM" → "0 8 * * 1-5"`;

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: piModel,
      tools: [submitTool as AgentTool<any>],
      thinkingLevel: "off",
      messages: [],
    },
  });

  try {
    await agent.prompt(
      `Parse this schedule document and call submit_schedule with the extracted entries:\n\n${markdown}`
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Schedule parser threw"
    );
    return [];
  }

  if (agent.state.errorMessage) {
    log.error({ err: agent.state.errorMessage }, "Schedule parser error");
    return [];
  }

  if (captured === null) {
    log.error(
      "Schedule parser did not call submit_schedule. The model returned text instead of invoking the tool. No entries loaded."
    );
    return [];
  }

  return captured;
}

export class HeartbeatScheduler {
  private jobs: Cron[] = [];
  private config: MameConfig;
  private persona: PersonaConfig;
  private notify: (project: string | undefined, message: string) => Promise<void>;
  private fileWatcher?: fs.FSWatcher;

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

    if (fs.existsSync(heartbeatPath)) {
      await this.loadSchedule();
      this.fileWatcher = fs.watch(heartbeatPath, async (eventType) => {
        if (eventType === "change") {
          log.info("HEARTBEAT.md changed, reloading schedule");
          await this.loadSchedule();
        }
      });
    } else {
      log.info("No HEARTBEAT.md found — skipping LLM schedule parse");
    }

    // Always register the magazine digest job regardless of HEARTBEAT.md.
    this.startMagazineJob();
  }

  stop(): void {
    for (const job of this.jobs) {
      job.stop();
    }
    this.jobs = [];
    this.fileWatcher?.close();
  }

  private async loadSchedule(): Promise<void> {
    // Clear existing jobs before reloading
    for (const job of this.jobs) {
      job.stop();
    }
    this.jobs = [];

    const heartbeatPath = path.join(MAME_HOME, "HEARTBEAT.md");
    const raw = fs.readFileSync(heartbeatPath, "utf-8");

    const entries = await this.parseSchedule(raw);
    const timezone = this.config.timezone || "Asia/Tokyo";

    for (const entry of entries) {
      try {
        // croner validates the pattern in its constructor — throws on bad
        // input, which the catch below converts to a skip-with-warning.
        const job = new Cron(
          entry.cron,
          { timezone },
          async () => {
            log.info(
              { cron: entry.cron, prompt_preview: entry.prompt.slice(0, 50) },
              "Running scheduled check"
            );

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

            // Exact-match suppression only — if the model replies with
            // ALL_CLEAR as its entire response, treat the check as healthy.
            // Any response containing ALL_CLEAR as a substring still gets
            // delivered (a daily brief mentioning "everything's clear" is
            // still a daily brief).
            const trimmed = reply.trim();
            if (trimmed === "ALL_CLEAR" || trimmed === "ALL_CLEAR.") {
              log.info(
                { cron: entry.cron, prompt_preview: entry.prompt.slice(0, 50) },
                "Suppressed (ALL_CLEAR)"
              );
              return;
            }

            await this.notify(entry.project || undefined, `💓 ${reply}`);
          }
        );

        this.jobs.push(job);
      } catch (err) {
        log.error(
          { cron: entry.cron, err: err instanceof Error ? err.message : String(err) },
          "Invalid cron expression, skipping"
        );
      }
    }

    log.info({ count: this.jobs.length }, `Loaded ${this.jobs.length} scheduled checks`);
  }

  // ---------------------------------------------------------------------------
  // Magazine daily digest job — direct pipeline, no LLM indirection.
  // Fires daily at 06:00 in the configured timezone (default Asia/Tokyo).
  // ---------------------------------------------------------------------------

  private startMagazineJob(): void {
    const timezone = this.config.timezone || "Asia/Tokyo";
    const job = new Cron("0 6 * * *", { timezone }, async () => {
      log.info({ timezone }, "Daily magazine job firing");
      try {
        await this.runMagazinePipeline();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err: msg }, "Daily magazine job failed");
        await this.notify(undefined, `❌ dAIly digest failed: ${msg}`);
      }
    });
    this.jobs.push(job);
    log.info({ timezone }, "Daily magazine job registered (06:00)");
  }

  private async runMagazinePipeline(): Promise<void> {
    const { runIngest } = await import("./magazine/ingest.js");
    const { generateDailyDigest } = await import("./magazine/digest.js");
    const { renderIssue } = await import("./magazine/render.js");
    const { todayISO } = await import("./magazine/state.js");

    const timezone = this.config.timezone || "Asia/Tokyo";
    const date = todayISO(timezone);

    const ingest = await runIngest(date);
    log.info({ date, newCount: ingest.newCount, total: ingest.totalScanned }, "Magazine ingest done");

    if (ingest.newCount === 0) {
      log.info({ date }, "No new bookmarks today — skipping digest + notify");
      return;
    }

    const digest = await generateDailyDigest({ date, persona: this.persona });
    log.info({ date, issueNumber: digest.issue.issueNumber }, "Magazine digest done");

    await renderIssue(date);
    log.info({ date }, "Magazine render done");

    const url = `https://dailydigest.sonicpixel.io/magazine/${date}.html`;
    const msg =
      `📰 **dAIly digest #${digest.issue.issueNumber} is out** — *"${digest.issue.signal}"*\n` +
      `→ ${url}`;
    await this.notify(undefined, msg);
  }

  /** Run the magazine pipeline immediately — for CLI testing and manual triggers. */
  async runMagazineNow(): Promise<void> {
    log.info("Running magazine pipeline now (manual trigger)");
    try {
      await this.runMagazinePipeline();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "Magazine pipeline failed");
      await this.notify(undefined, `❌ dAIly digest failed: ${msg}`);
    }
  }

  private async parseSchedule(markdown: string): Promise<HeartbeatEntry[]> {
    const modelStr = this.persona.models.heartbeat || this.persona.models.default;
    const route = parseModelString(modelStr);

    let piModel;
    try {
      piModel = getModel(route.backend as KnownProvider as any, route.modelId as any);
    } catch (err) {
      log.error(
        { model: modelStr, err: err instanceof Error ? err.message : String(err) },
        "Model lookup failed"
      );
      return [];
    }
    if (!piModel) {
      log.error({ model: modelStr }, "Model not registered in pi-ai catalog");
      return [];
    }

    return parseScheduleWithModel(piModel, markdown);
  }

  // List the parsed schedule entries (for CLI inspection)
  async listEntries(): Promise<HeartbeatEntry[]> {
    const heartbeatPath = path.join(MAME_HOME, "HEARTBEAT.md");
    if (!fs.existsSync(heartbeatPath)) return [];
    const raw = fs.readFileSync(heartbeatPath, "utf-8");
    return this.parseSchedule(raw);
  }

  // Run all scheduled entries immediately (for manual testing via CLI)
  async runNow(): Promise<string> {
    const entries = await this.listEntries();
    if (entries.length === 0) {
      return "No HEARTBEAT.md entries to run.";
    }

    const results: string[] = [];
    for (const entry of entries) {
      log.info(
        { cron: entry.cron, prompt_preview: entry.prompt.slice(0, 60) },
        "Running scheduled check (manual)"
      );

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

      await this.notify(entry.project || undefined, `💓 ${reply}`);
      results.push(`✓ [${entry.cron}] Delivered`);
    }

    return results.join("\n");
  }
}
