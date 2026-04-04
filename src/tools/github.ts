// src/tools/github.ts — GitHub operations (~60 lines per spec)
// Implementation: @octokit/rest — token from vault

import { Octokit } from "@octokit/rest";
import { registerTool, type ToolContext } from "./index.js";

let octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (!octokit) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not set. Add it to the vault.");
    octokit = new Octokit({ auth: token });
  }
  return octokit;
}

registerTool({
  definition: {
    name: "github",
    description: "Interact with GitHub repositories. Read code, list PRs, create issues, check notifications.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: [
            "list_repos",
            "read_file",
            "list_prs",
            "create_issue",
            "get_pr",
            "list_notifications",
            "search_code",
          ],
        },
        repo: { type: "string", description: "owner/repo format" },
        path: { type: "string", description: "File path within repo" },
        query: { type: "string", description: "Search query or issue body" },
        title: { type: "string", description: "Issue title" },
        pr_number: { type: "number", description: "PR number" },
      },
      required: ["action"],
    },
  },
  async execute(input: Record<string, unknown>, _ctx: ToolContext) {
    const action = input.action as string;
    const repo = input.repo as string | undefined;
    const filePath = input.path as string | undefined;
    const query = input.query as string | undefined;
    const title = input.title as string | undefined;
    const prNumber = input.pr_number as number | undefined;

    const gh = getOctokit();

    const parseRepo = (r: string) => {
      const [owner, name] = r.split("/");
      return { owner, repo: name };
    };

    switch (action) {
      case "list_repos": {
        const { data } = await gh.repos.listForAuthenticatedUser({ sort: "updated", per_page: 20 });
        return data.map((r) => ({ name: r.full_name, description: r.description, updated: r.updated_at }));
      }

      case "read_file": {
        if (!repo || !filePath) return { error: "repo and path required" };
        const { owner, repo: repoName } = parseRepo(repo);
        const { data } = await gh.repos.getContent({ owner, repo: repoName, path: filePath });
        if ("content" in data) {
          const content = Buffer.from(data.content, "base64").toString("utf-8");
          return { path: filePath, content: content.slice(0, 10000) };
        }
        return { error: "Not a file" };
      }

      case "list_prs": {
        if (!repo) return { error: "repo required" };
        const { owner, repo: repoName } = parseRepo(repo);
        const { data } = await gh.pulls.list({ owner, repo: repoName, state: "open", per_page: 10 });
        return data.map((pr) => ({ number: pr.number, title: pr.title, author: pr.user?.login, updated: pr.updated_at }));
      }

      case "create_issue": {
        if (!repo || !title) return { error: "repo and title required" };
        const { owner, repo: repoName } = parseRepo(repo);
        const { data } = await gh.issues.create({ owner, repo: repoName, title, body: query || "" });
        return { number: data.number, url: data.html_url };
      }

      case "get_pr": {
        if (!repo || !prNumber) return { error: "repo and pr_number required" };
        const { owner, repo: repoName } = parseRepo(repo);
        const { data } = await gh.pulls.get({ owner, repo: repoName, pull_number: prNumber });
        return {
          number: data.number, title: data.title, state: data.state,
          author: data.user?.login, body: data.body?.slice(0, 2000),
          additions: data.additions, deletions: data.deletions,
        };
      }

      case "list_notifications": {
        const { data } = await gh.activity.listNotificationsForAuthenticatedUser({ per_page: 10 });
        return data.map((n) => ({ repo: n.repository.full_name, reason: n.reason, title: n.subject.title, type: n.subject.type }));
      }

      case "search_code": {
        if (!query) return { error: "query required" };
        const q = repo ? `${query} repo:${repo}` : query;
        const { data } = await gh.search.code({ q, per_page: 10 });
        return data.items.map((r) => ({ repo: r.repository.full_name, path: r.path, url: r.html_url }));
      }

      default:
        return { error: `Unknown action: ${action}` };
    }
  },
});
