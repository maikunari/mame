// src/magazine/render.ts — Render a magazine issue JSON into a self-contained
// static HTML file by filling the Handlebars template and inlining styles.css.
//
// Input:  ~/.mame/magazine/issues/YYYY-MM-DD.json
// Output: ~/.mame/magazine/public/YYYY-MM-DD.html
//         ~/.mame/magazine/public/latest.html  (updated each run)
//
// Template lives alongside this file in ./template/ in both source and dist.
// The build script copies src/magazine/template → dist/magazine/template.

import Handlebars from "handlebars";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PUBLIC_DIR, ISSUES_DIR, issueJsonPath, todayISO } from "./state.js";
import { loadConfig } from "../config.js";
import type { MagazineIssue } from "./digest.js";
import { childLogger } from "../logger.js";

const log = childLogger("magazine:render");

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "template");

export interface RenderResult {
  path: string;
  latestPath: string;
}

export async function renderIssue(date?: string): Promise<RenderResult> {
  const cfg = loadConfig();
  const targetDate = date ?? todayISO(cfg.timezone);
  const jsonPath = issueJsonPath(targetDate);

  if (!fs.existsSync(jsonPath)) {
    throw new Error(
      `No issue JSON for ${targetDate} at ${jsonPath}. Run 'mame magazine generate' first.`
    );
  }

  const issue = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as MagazineIssue;

  const templateSrc = fs.readFileSync(path.join(TEMPLATE_DIR, "index.html"), "utf-8");
  const cssSrc = fs.readFileSync(path.join(TEMPLATE_DIR, "styles.css"), "utf-8");

  // Inline CSS: replace the <link rel="stylesheet" href="styles.css"> tag with
  // a <style> block. Google Fonts <link> tags remain — the font loading still
  // needs the external request. We assert the replacement happened so a
  // template edit that drops/renames the tag fails loudly instead of
  // silently shipping an unstyled page.
  const cssLinkRe = /<link[^>]+href=["']styles\.css["'][^>]*\/?>/;
  if (!cssLinkRe.test(templateSrc)) {
    throw new Error(
      "render: template is missing <link ... href=\"styles.css\"> — CSS cannot be inlined. " +
        "Restore the styles.css link tag in src/magazine/template/index.html."
    );
  }
  const inlined = templateSrc.replace(cssLinkRe, `<style>\n${cssSrc}\n</style>`);

  // Stock Handlebars lacks an equality helper — the template uses {{#if (eq a b)}}.
  // Registered per-render (not at module load) so we don't mutate the global
  // Handlebars singleton from import side effects.
  const hb = Handlebars.create();
  hb.registerHelper("eq", (a: unknown, b: unknown) => a === b);
  const template = hb.compile(inlined);
  const html = template(issue);

  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  const outPath = path.join(PUBLIC_DIR, `${targetDate}.html`);
  fs.writeFileSync(outPath, html, "utf-8");

  const latestPath = path.join(PUBLIC_DIR, "latest.html");
  fs.writeFileSync(latestPath, html, "utf-8");

  log.info({ path: outPath, date: targetDate }, "issue rendered");
  return { path: outPath, latestPath };
}

/**
 * List every rendered issue (YYYY-MM-DD.html), most-recent first, with
 * metadata from the corresponding issue JSON for use in the index page.
 */
export interface IssueSummary {
  date: string;
  issueNumber: number | null;
  signal: string | null;
  savedToday: number | null;
}

export function listRenderedIssues(): IssueSummary[] {
  if (!fs.existsSync(PUBLIC_DIR)) return [];

  return fs
    .readdirSync(PUBLIC_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const date = f.replace(".html", "");
      const jsonPath = path.join(ISSUES_DIR, `${date}.json`);
      try {
        const iss = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as MagazineIssue;
        return {
          date,
          issueNumber: iss.issueNumber,
          signal: iss.signal,
          savedToday: iss.stats.savedToday,
        };
      } catch (err) {
        log.warn(
          { date, jsonPath, err: err instanceof Error ? err.message : String(err) },
          "listRenderedIssues: failed to read issue JSON for rendered HTML"
        );
        return { date, issueNumber: null, signal: null, savedToday: null };
      }
    });
}
