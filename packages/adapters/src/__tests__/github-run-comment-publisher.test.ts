import assert from "node:assert/strict";
import test from "node:test";

import type { Execution, ExecutionEvent, GitHubRunCommentPublishResult, Track } from "@specrail/core";

import { GitHubRunCommentGhPublisher, parseGitHubTarget } from "../providers/github-run-comment-publisher.js";

class FakeGitHubApiClient {
  readonly calls: string[][] = [];

  constructor(private readonly handler: (args: string[]) => unknown | Promise<unknown>) {}

  async request<T>(args: string[]): Promise<T> {
    this.calls.push(args);
    return (await this.handler(args)) as T;
  }
}

const events: ExecutionEvent[] = [
  {
    id: "run-1:start",
    executionId: "run-1",
    type: "task_status_changed",
    timestamp: "2026-04-10T00:10:00.000Z",
    source: "codex",
    summary: "Run started",
    payload: { status: "running" },
  },
  {
    id: "run-1:done",
    executionId: "run-1",
    type: "task_status_changed",
    timestamp: "2026-04-10T00:15:00.000Z",
    source: "codex",
    summary: "Run completed",
    payload: { status: "completed" },
  },
];

test("parseGitHubTarget extracts owner, repo, and number from issue and pull request URLs", () => {
  assert.deepEqual(parseGitHubTarget({ kind: "issue", number: 30, url: "https://github.com/yoophi-a/specrail/issues/30" }), {
    owner: "yoophi-a",
    repo: "specrail",
    number: 30,
  });
  assert.deepEqual(parseGitHubTarget({ kind: "pull_request", number: 31, url: "https://github.com/yoophi-a/specrail/pull/31" }), {
    owner: "yoophi-a",
    repo: "specrail",
    number: 31,
  });
  assert.throws(
    () => parseGitHubTarget({ kind: "issue", number: 1, url: "https://example.com/nope" }),
    /Unsupported GitHub target URL/,
  );
});

test("GitHubRunCommentGhPublisher creates issue and pull request comments for linked targets", async () => {
  const client = new FakeGitHubApiClient(async (args) => {
    if (args[0] === "user") {
      return { login: "specrail-bot" };
    }

    if (args[0] === "repos/yoophi-a/specrail/issues/30/comments" && args.includes("--paginate")) {
      return [];
    }

    if (args[0] === "repos/yoophi-a/specrail/issues/31/comments" && args.includes("--paginate")) {
      return [];
    }

    if (args[0] === "repos/yoophi-a/specrail/issues/30/comments" && args.includes("POST")) {
      return { id: 3001 };
    }

    if (args[0] === "repos/yoophi-a/specrail/issues/31/comments" && args.includes("POST")) {
      return { id: 3101 };
    }

    throw new Error(`Unexpected request: ${args.join(" ")}`);
  });

  const publisher = new GitHubRunCommentGhPublisher({ apiClient: client });
  const results = await publisher.publishRunSummary({
    track: {
      id: "track-30",
      projectId: "project-default",
      title: "Publish run summaries",
      description: "",
      status: "review",
      specStatus: "approved",
      planStatus: "approved",
      priority: "high",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:16:00.000Z",
      githubIssue: { number: 30, url: "https://github.com/yoophi-a/specrail/issues/30" },
      githubPullRequest: { number: 31, url: "https://github.com/yoophi-a/specrail/pull/31" },
    },
    run: {
      id: "run-1",
      trackId: "track-30",
      backend: "codex",
      profile: "default",
      workspacePath: "/tmp/specrail/run-1",
      branchName: "specrail/run-1",
      sessionRef: "session:run-1",
      status: "completed",
      createdAt: "2026-04-10T00:10:00.000Z",
      startedAt: "2026-04-10T00:10:00.000Z",
      finishedAt: "2026-04-10T00:15:00.000Z",
      summary: {
        eventCount: 2,
        lastEventSummary: "Run completed",
        lastEventAt: "2026-04-10T00:15:00.000Z",
      },
    },
    events,
  });

  assert.deepEqual(
    results.map((result) => ({ action: result.action, kind: result.target.kind, commentId: result.commentId })),
    [
      { action: "created", kind: "issue", commentId: 3001 },
      { action: "created", kind: "pull_request", commentId: 3101 },
    ],
  );
  assert.equal(client.calls.filter((args) => args[0] === "user").length, 1);
});

test("GitHubRunCommentGhPublisher updates existing marker-matched comments and noops when the body is unchanged", async () => {
  let phase: "update" | "noop" = "update";
  let updatedBody = "";
  const existingBody = "<!-- specrail:run-summary track=track-30 run=run-1 status=running -->\nold\n";
  const client: FakeGitHubApiClient = new FakeGitHubApiClient(async (args: string[]): Promise<unknown> => {
    if (args[0] === "user") {
      return { login: "specrail-bot" };
    }

    if (args[0] === "repos/yoophi-a/specrail/issues/30/comments" && args.includes("--paginate")) {
      if (phase === "update") {
        return [{ id: 3001, body: existingBody, user: { login: "specrail-bot" } }];
      }

      return [{ id: 3001, body: updatedBody, user: { login: "specrail-bot" } }];
    }

    if (args[0] === "repos/yoophi-a/specrail/issues/comments/3001" && args.includes("PATCH")) {
      return { id: 3001 };
    }

    throw new Error(`Unexpected request: ${args.join(" ")}`);
  });

  const publisher = new GitHubRunCommentGhPublisher({ apiClient: client });
  const input: { track: Track; run: Execution; events: ExecutionEvent[] } = {
    track: {
      id: "track-30",
      projectId: "project-default",
      title: "Publish run summaries",
      description: "",
      status: "review",
      specStatus: "approved",
      planStatus: "approved",
      priority: "high",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:16:00.000Z",
      githubIssue: { number: 30, url: "https://github.com/yoophi-a/specrail/issues/30" },
    },
    run: {
      id: "run-1",
      trackId: "track-30",
      backend: "codex",
      profile: "default",
      workspacePath: "/tmp/specrail/run-1",
      branchName: "specrail/run-1",
      sessionRef: "session:run-1",
      status: "completed" as const,
      createdAt: "2026-04-10T00:10:00.000Z",
      startedAt: "2026-04-10T00:10:00.000Z",
      finishedAt: "2026-04-10T00:15:00.000Z",
      summary: {
        eventCount: 2,
        lastEventSummary: "Run completed",
        lastEventAt: "2026-04-10T00:15:00.000Z",
      },
    },
    events,
  };

  const updateResults: GitHubRunCommentPublishResult[] = await publisher.publishRunSummary(input);
  updatedBody = updateResults[0]?.body ?? "";
  assert.deepEqual(updateResults.map((result: GitHubRunCommentPublishResult) => result.action), ["updated"]);

  phase = "noop";
  const noopResults: GitHubRunCommentPublishResult[] = await publisher.publishRunSummary(input);
  assert.deepEqual(noopResults.map((result: GitHubRunCommentPublishResult) => result.action), ["noop"]);
  assert.equal(
    client.calls.filter((args: string[]) => args[0] === "repos/yoophi-a/specrail/issues/comments/3001" && args.includes("PATCH")).length,
    1,
  );
});

test("GitHubRunCommentGhPublisher reuses persisted comment ids before falling back to comment scans", async () => {
  const client = new FakeGitHubApiClient(async (args) => {
    if (args[0] === "user") {
      return { login: "specrail-bot" };
    }

    if (args[0] === "repos/yoophi-a/specrail/issues/comments/3001") {
      return {
        id: 3001,
        body: "<!-- specrail:run-summary track=track-30 run=run-1 status=completed -->\nbody\n",
        user: { login: "specrail-bot" },
      };
    }

    throw new Error(`Unexpected request: ${args.join(" ")}`);
  });

  const publisher = new GitHubRunCommentGhPublisher({ apiClient: client });
  const results = await publisher.publishRunSummary({
    track: {
      id: "track-30",
      projectId: "project-default",
      title: "Publish run summaries",
      description: "",
      status: "review",
      specStatus: "approved",
      planStatus: "approved",
      priority: "high",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:16:00.000Z",
      githubIssue: { number: 30, url: "https://github.com/yoophi-a/specrail/issues/30" },
    },
    run: {
      id: "run-1",
      trackId: "track-30",
      backend: "codex",
      profile: "default",
      workspacePath: "/tmp/specrail/run-1",
      branchName: "specrail/run-1",
      sessionRef: "session:run-1",
      status: "completed",
      createdAt: "2026-04-10T00:10:00.000Z",
      startedAt: "2026-04-10T00:10:00.000Z",
      finishedAt: "2026-04-10T00:15:00.000Z",
      summary: {
        eventCount: 2,
        lastEventSummary: "Run completed",
        lastEventAt: "2026-04-10T00:15:00.000Z",
      },
    },
    events,
    syncState: {
      id: "track-30",
      trackId: "track-30",
      updatedAt: "2026-04-10T00:15:00.000Z",
      comments: [
        {
          target: { kind: "issue", number: 30, url: "https://github.com/yoophi-a/specrail/issues/30" },
          commentId: 3001,
          lastRunId: "run-1",
          lastRunStatus: "completed",
          lastPublishedAt: "2026-04-10T00:15:00.000Z",
          lastCommentBody: "body",
          lastSyncStatus: "success",
        },
      ],
    },
  });

  assert.deepEqual(results.map((result) => result.action), ["updated"]);
  assert.equal(client.calls.some((args) => args[0] === "repos/yoophi-a/specrail/issues/30/comments" && args.includes("--paginate")), false);
});

test("GitHubRunCommentGhPublisher falls back to comment scans when persisted comment id is stale", async () => {
  const client = new FakeGitHubApiClient(async (args) => {
    if (args[0] === "user") {
      return { login: "specrail-bot" };
    }

    if (args[0] === "repos/yoophi-a/specrail/issues/comments/9999") {
      throw new Error("comment not found");
    }

    if (args[0] === "repos/yoophi-a/specrail/issues/30/comments" && args.includes("--paginate")) {
      return [
        {
          id: 3001,
          body: "<!-- specrail:run-summary track=track-30 run=run-1 status=running -->\nold\n",
          user: { login: "specrail-bot" },
        },
      ];
    }

    if (args[0] === "repos/yoophi-a/specrail/issues/comments/3001" && args.includes("PATCH")) {
      return { id: 3001 };
    }

    throw new Error(`Unexpected request: ${args.join(" ")}`);
  });

  const publisher = new GitHubRunCommentGhPublisher({ apiClient: client });
  const results = await publisher.publishRunSummary({
    track: {
      id: "track-30",
      projectId: "project-default",
      title: "Publish run summaries",
      description: "",
      status: "review",
      specStatus: "approved",
      planStatus: "approved",
      priority: "high",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:16:00.000Z",
      githubIssue: { number: 30, url: "https://github.com/yoophi-a/specrail/issues/30" },
    },
    run: {
      id: "run-1",
      trackId: "track-30",
      backend: "codex",
      profile: "default",
      workspacePath: "/tmp/specrail/run-1",
      branchName: "specrail/run-1",
      sessionRef: "session:run-1",
      status: "completed",
      createdAt: "2026-04-10T00:10:00.000Z",
      startedAt: "2026-04-10T00:10:00.000Z",
      finishedAt: "2026-04-10T00:15:00.000Z",
      summary: {
        eventCount: 2,
        lastEventSummary: "Run completed",
        lastEventAt: "2026-04-10T00:15:00.000Z",
      },
    },
    events,
    syncState: {
      id: "track-30",
      trackId: "track-30",
      updatedAt: "2026-04-10T00:15:00.000Z",
      comments: [
        {
          target: { kind: "issue", number: 30, url: "https://github.com/yoophi-a/specrail/issues/30" },
          commentId: 9999,
          lastRunId: "run-0",
          lastRunStatus: "running",
          lastPublishedAt: "2026-04-10T00:05:00.000Z",
          lastCommentBody: "body",
          lastSyncStatus: "success",
        },
      ],
    },
  });

  assert.deepEqual(results.map((result) => result.action), ["updated"]);
  assert.equal(client.calls.some((args) => args[0] === "repos/yoophi-a/specrail/issues/30/comments" && args.includes("--paginate")), true);
});
