import assert from "node:assert/strict";
import test from "node:test";

import { formatGitHubRunCommentSummary } from "../github-comment-summary.js";

const baseTrack = {
  id: "track-track-29",
  title: "Publish execution summaries back to GitHub",
  status: "review" as const,
  githubIssue: { number: 29, url: "https://github.com/yoophi-a/specrail/issues/29" },
  githubPullRequest: { number: 31, url: "https://github.com/yoophi-a/specrail/pull/31" },
};

test("formatGitHubRunCommentSummary renders a completed run for GitHub comments", () => {
  const comment = formatGitHubRunCommentSummary({
    track: baseTrack,
    run: {
      id: "run-run-29",
      status: "completed",
      backend: "codex",
      profile: "default",
      branchName: "feat/run-comment-summary",
      workspacePath: "/tmp/specrail/run-run-29",
      sessionRef: "session:run-run-29",
      startedAt: "2026-04-10T00:00:00.000Z",
      finishedAt: "2026-04-10T00:15:00.000Z",
      summary: {
        eventCount: 4,
        lastEventSummary: "Run completed",
        lastEventAt: "2026-04-10T00:15:00.000Z",
      },
    },
    events: [
      {
        timestamp: "2026-04-10T00:00:00.000Z",
        type: "task_status_changed",
        summary: "Run started",
      },
      {
        timestamp: "2026-04-10T00:01:00.000Z",
        type: "shell_command",
        summary: "Prepared Codex command",
      },
      {
        timestamp: "2026-04-10T00:14:00.000Z",
        type: "test_result",
        summary: "Verification passed",
      },
      {
        timestamp: "2026-04-10T00:15:00.000Z",
        type: "task_status_changed",
        summary: "Run completed",
      },
    ],
  });

  assert.match(comment, /<!-- specrail:run-summary track=track-track-29 run=run-run-29 status=completed -->/);
  assert.match(comment, /\*\*Outcome:\*\* ✅ Completed/);
  assert.match(comment, /- Issue: \[#29\]\(https:\/\/github.com\/yoophi-a\/specrail\/issues\/29\)/);
  assert.match(comment, /- Pull request: \[#31\]\(https:\/\/github.com\/yoophi-a\/specrail\/pull\/31\)/);
  assert.match(comment, /- Branch: `feat\/run-comment-summary`/);
  assert.match(comment, /- Events: 4/);
  assert.match(comment, /- 2026-04-10T00:14:00.000Z · \*\*test_result\*\* · Verification passed/);
  assert.match(comment, /- 2026-04-10T00:15:00.000Z · \*\*task_status_changed\*\* · Run completed/);
});

test("formatGitHubRunCommentSummary renders a waiting approval run with blocker note", () => {
  const comment = formatGitHubRunCommentSummary({
    track: {
      ...baseTrack,
      githubPullRequest: undefined,
    },
    run: {
      id: "run-approval",
      status: "waiting_approval",
      backend: "codex",
      profile: "review",
      branchName: "feat/approval-gate",
      workspacePath: "/tmp/specrail/run-approval",
      sessionRef: "session:run-approval",
      startedAt: "2026-04-10T01:00:00.000Z",
      finishedAt: undefined,
      summary: {
        eventCount: 2,
        lastEventSummary: "Approval requested",
        lastEventAt: "2026-04-10T01:05:00.000Z",
      },
    },
    events: [
      {
        timestamp: "2026-04-10T01:00:00.000Z",
        type: "task_status_changed",
        summary: "Run started",
      },
      {
        timestamp: "2026-04-10T01:05:00.000Z",
        type: "approval_requested",
        summary: "Approval requested",
      },
    ],
  });

  assert.match(comment, /\*\*Outcome:\*\* ⏸️ Waiting for approval/);
  assert.match(comment, /- Pull request: none linked/i);
  assert.match(comment, /> Approval is currently blocking this run\./);
});

test("formatGitHubRunCommentSummary renders failed and cancelled terminal states deterministically", () => {
  const failedComment = formatGitHubRunCommentSummary({
    track: baseTrack,
    run: {
      id: "run-failed",
      status: "failed",
      backend: "codex",
      profile: "default",
      branchName: "feat/failure",
      workspacePath: "/tmp/specrail/run-failed",
      sessionRef: "session:run-failed",
      startedAt: "2026-04-10T02:00:00.000Z",
      finishedAt: "2026-04-10T02:03:00.000Z",
      summary: {
        eventCount: 3,
        lastEventSummary: "Failed Codex session session:run-failed",
        lastEventAt: "2026-04-10T02:03:00.000Z",
      },
    },
    events: [
      {
        timestamp: "2026-04-10T02:00:00.000Z",
        type: "task_status_changed",
        summary: "Run started",
      },
      {
        timestamp: "2026-04-10T02:02:00.000Z",
        type: "message",
        summary: "STDERR session:run-failed",
      },
      {
        timestamp: "2026-04-10T02:03:00.000Z",
        type: "task_status_changed",
        summary: "Failed Codex session session:run-failed",
      },
    ],
  });

  const cancelledComment = formatGitHubRunCommentSummary({
    track: baseTrack,
    run: {
      id: "run-cancelled",
      status: "cancelled",
      backend: "codex",
      profile: "default",
      branchName: "feat/cancelled",
      workspacePath: "/tmp/specrail/run-cancelled",
      sessionRef: "session:run-cancelled",
      startedAt: "2026-04-10T03:00:00.000Z",
      finishedAt: "2026-04-10T03:01:00.000Z",
      summary: {
        eventCount: 2,
        lastEventSummary: "Run cancelled",
        lastEventAt: "2026-04-10T03:01:00.000Z",
      },
    },
    events: [
      {
        timestamp: "2026-04-10T03:00:00.000Z",
        type: "task_status_changed",
        summary: "Run started",
      },
      {
        timestamp: "2026-04-10T03:01:00.000Z",
        type: "task_status_changed",
        summary: "Run cancelled",
      },
    ],
    options: {
      maxHighlights: 1,
    },
  });

  assert.match(failedComment, /\*\*Outcome:\*\* ❌ Failed/);
  assert.match(failedComment, /Failed Codex session session:run-failed/);
  assert.match(cancelledComment, /\*\*Outcome:\*\* 🛑 Cancelled/);
  assert.doesNotMatch(cancelledComment, /Run started/);
  assert.match(cancelledComment, /Run cancelled/);
});
