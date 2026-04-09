import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  formatGitHubRunCommentSummary,
  type Execution,
  type ExecutionEvent,
  type GitHubRunCommentPublishResult,
  type GitHubRunCommentPublisher,
  type GitHubRunCommentTarget,
  type Track,
} from "@specrail/core";

const execFileAsync = promisify(execFile);

interface GitHubCommentRecord {
  id: number;
  body?: string;
  user?: {
    login?: string;
  };
}

interface GitHubApiClient {
  request<T>(args: string[]): Promise<T>;
}

class GhCliApiClient implements GitHubApiClient {
  async request<T>(args: string[]): Promise<T> {
    const { stdout } = await execFileAsync("gh", ["api", ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });

    return JSON.parse(stdout) as T;
  }
}

export interface GitHubRunCommentPublisherOptions {
  apiClient?: GitHubApiClient;
}

function parseGitHubTarget(target: GitHubRunCommentTarget): { owner: string; repo: string; number: number } {
  const url = new URL(target.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.hostname !== "github.com" || parts.length < 4) {
    throw new Error(`Unsupported GitHub target URL: ${target.url}`);
  }

  const [owner, repo, resource, rawNumber] = parts;
  const number = Number(rawNumber);

  if ((resource !== "issues" && resource !== "pull") || !Number.isInteger(number) || number <= 0) {
    throw new Error(`Unsupported GitHub target URL: ${target.url}`);
  }

  return { owner, repo, number };
}

function findCommentKey(body: string): string {
  const match = body.match(/^<!-- specrail:run-summary track=(.+?) run=(.+?) status=.+?-->$/mu);
  if (!match) {
    throw new Error("GitHub run summary body is missing its marker");
  }

  return `<!-- specrail:run-summary track=${match[1]} run=${match[2]}`;
}

export class GitHubRunCommentGhPublisher implements GitHubRunCommentPublisher {
  private readonly apiClient: GitHubApiClient;
  private viewerLoginPromise: Promise<string> | null = null;

  constructor(options: GitHubRunCommentPublisherOptions = {}) {
    this.apiClient = options.apiClient ?? new GhCliApiClient();
  }

  async publishRunSummary(input: { track: Track; run: Execution; events: ExecutionEvent[] }): Promise<GitHubRunCommentPublishResult[]> {
    const body = formatGitHubRunCommentSummary({
      track: input.track,
      run: input.run,
      events: input.events,
    });
    const markerKey = findCommentKey(body);
    const viewerLogin = await this.getViewerLogin();
    const results: GitHubRunCommentPublishResult[] = [];

    for (const target of this.listTargets(input.track)) {
      const { owner, repo, number } = parseGitHubTarget(target);
      const existing = await this.findExistingComment({ owner, repo, number, markerKey, viewerLogin });

      if (existing && (existing.body ?? "") === body) {
        results.push({ action: "noop", body, target, commentId: existing.id });
        continue;
      }

      if (existing) {
        const updated = await this.apiClient.request<GitHubCommentRecord>([
          `repos/${owner}/${repo}/issues/comments/${existing.id}`,
          "--method",
          "PATCH",
          "--field",
          `body=${body}`,
        ]);
        results.push({ action: "updated", body, target, commentId: updated.id });
        continue;
      }

      const created = await this.apiClient.request<GitHubCommentRecord>([
        `repos/${owner}/${repo}/issues/${number}/comments`,
        "--method",
        "POST",
        "--field",
        `body=${body}`,
      ]);
      results.push({ action: "created", body, target, commentId: created.id });
    }

    return results;
  }

  private listTargets(track: Pick<Track, "githubIssue" | "githubPullRequest">): GitHubRunCommentTarget[] {
    const targets: GitHubRunCommentTarget[] = [];

    if (track.githubIssue) {
      targets.push({ kind: "issue", number: track.githubIssue.number, url: track.githubIssue.url });
    }

    if (track.githubPullRequest) {
      targets.push({ kind: "pull_request", number: track.githubPullRequest.number, url: track.githubPullRequest.url });
    }

    return targets.filter(
      (target, index, all) => all.findIndex((candidate) => candidate.kind === target.kind && candidate.url === target.url) === index,
    );
  }

  private async getViewerLogin(): Promise<string> {
    if (!this.viewerLoginPromise) {
      this.viewerLoginPromise = this.apiClient
        .request<{ login: string }>(["user"])
        .then((response) => {
          if (!response.login) {
            throw new Error("Unable to resolve authenticated GitHub user login");
          }

          return response.login;
        });
    }

    return this.viewerLoginPromise;
  }

  private async findExistingComment(input: {
    owner: string;
    repo: string;
    number: number;
    markerKey: string;
    viewerLogin: string;
  }): Promise<GitHubCommentRecord | undefined> {
    const comments = await this.apiClient.request<GitHubCommentRecord[]>([
      `repos/${input.owner}/${input.repo}/issues/${input.number}/comments`,
      "--paginate",
    ]);

    return comments.find(
      (comment) => comment.user?.login === input.viewerLogin && typeof comment.body === "string" && comment.body.includes(input.markerKey),
    );
  }
}

export { parseGitHubTarget };
