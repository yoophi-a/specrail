import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGitHubSignature256,
  executeGitHubRunCommand,
  handleGitHubWebhookCommand,
  parseSpecRailIssueCommentCommand,
  verifyGitHubSignature256,
  type GitHubAcceptedRunCommandContext,
  type GitHubSpecRailPort,
} from "../index.js";

const secret = "webhook-secret";
const rawBody = JSON.stringify({ action: "created" });
const signatureHeader = buildGitHubSignature256(secret, rawBody);

function payload(body: string) {
  return {
    action: "created",
    comment: { body },
    issue: { number: 123, title: "Implement GitHub entrypoint" },
    repository: { full_name: "yoophi-a/specrail" },
    sender: { login: "octocat", id: 42 },
  };
}

test("verifyGitHubSignature256 validates HMAC SHA-256 webhook signatures", () => {
  assert.equal(verifyGitHubSignature256({ secret, payload: rawBody, signatureHeader }), true);
  assert.equal(verifyGitHubSignature256({ secret, payload: rawBody, signatureHeader: "sha256=bad" }), false);
  assert.equal(verifyGitHubSignature256({ secret, payload: rawBody }), false);
});

test("parseSpecRailIssueCommentCommand extracts optional run prompts", () => {
  assert.deepEqual(parseSpecRailIssueCommentCommand("/specrail run"), { kind: "run" });
  assert.deepEqual(parseSpecRailIssueCommentCommand(" /specrail run keep opaque #123 text "), {
    kind: "run",
    prompt: "keep opaque #123 text",
  });
  assert.equal(parseSpecRailIssueCommentCommand("/specrail status"), undefined);
});

test("handleGitHubWebhookCommand accepts issue-comment created run commands", () => {
  const result = handleGitHubWebhookCommand({
    eventName: "issue_comment",
    signatureHeader,
    secret,
    rawBody,
    payload: payload("/specrail run ship the webhook skeleton"),
  });

  assert.equal(result.accepted, true);
  if (!result.accepted) {
    return;
  }
  assert.deepEqual(result.command, { kind: "run", prompt: "ship the webhook skeleton" });
  assert.equal(result.repositoryFullName, "yoophi-a/specrail");
  assert.equal(result.issueNumber, 123);
  assert.equal(result.senderLogin, "octocat");
  assert.equal(result.isPullRequest, false);
});

test("handleGitHubWebhookCommand rejects invalid signatures, unsupported events, and non-command comments", () => {
  assert.deepEqual(
    handleGitHubWebhookCommand({ eventName: "issue_comment", signatureHeader: "sha256=bad", secret, rawBody, payload: payload("/specrail run") }),
    { accepted: false, reason: "invalid_signature" },
  );
  assert.deepEqual(
    handleGitHubWebhookCommand({ eventName: "pull_request", signatureHeader, secret, rawBody, payload: payload("/specrail run") }),
    { accepted: false, reason: "unsupported_event" },
  );
  assert.deepEqual(
    handleGitHubWebhookCommand({ eventName: "issue_comment", signatureHeader, secret, rawBody, payload: payload("Looks good") }),
    { accepted: false, reason: "unsupported_command" },
  );
});

function acceptedContext(overrides: Partial<GitHubAcceptedRunCommandContext> = {}): GitHubAcceptedRunCommandContext {
  return {
    accepted: true,
    command: { kind: "run", prompt: "preserve opaque prompt #123" },
    repositoryFullName: "yoophi-a/specrail",
    issueNumber: 123,
    issueTitle: "Implement GitHub entrypoint",
    senderLogin: "octocat",
    senderId: 42,
    isPullRequest: false,
    ...overrides,
  };
}

function createSpecRailPort(overrides: Partial<GitHubSpecRailPort> = {}): { port: GitHubSpecRailPort; calls: Array<{ name: string; input: unknown }> } {
  const calls: Array<{ name: string; input: unknown }> = [];
  const port: GitHubSpecRailPort = {
    async findChannelBinding(input) {
      calls.push({ name: "findChannelBinding", input });
      return null;
    },
    async createTrack(input) {
      calls.push({ name: "createTrack", input });
      return { track: { id: "track-created" } };
    },
    async bindChannel(input) {
      calls.push({ name: "bindChannel", input });
      return { binding: { id: "binding-created", trackId: input.trackId, planningSessionId: input.planningSessionId } };
    },
    async startRun(input) {
      calls.push({ name: "startRun", input });
      return { run: { id: "run-created", status: "running" } };
    },
    ...overrides,
  };
  return { port, calls };
}

test("executeGitHubRunCommand reuses an existing GitHub binding", async () => {
  const { port, calls } = createSpecRailPort({
    async findChannelBinding(input) {
      calls.push({ name: "findChannelBinding", input });
      return { id: "binding-existing", trackId: "track-existing", planningSessionId: "planning-existing" };
    },
  });

  const outcome = await executeGitHubRunCommand({
    projectId: "project-default",
    context: acceptedContext(),
    specRail: port,
    apiBaseUrl: "https://specrail.example.test",
  });

  assert.deepEqual(outcome, {
    bindingCreated: false,
    bindingId: "binding-existing",
    trackId: "track-existing",
    planningSessionId: "planning-existing",
    runId: "run-created",
    reportUrl: "https://specrail.example.test/runs/run-created/report.md",
  });
  assert.deepEqual(calls.map((call) => call.name), ["findChannelBinding", "startRun"]);
  assert.deepEqual(calls[1]?.input, {
    trackId: "track-existing",
    planningSessionId: "planning-existing",
    prompt: "preserve opaque prompt #123",
  });
});

test("executeGitHubRunCommand creates a track and binding when none exists", async () => {
  const { port, calls } = createSpecRailPort();

  const outcome = await executeGitHubRunCommand({
    projectId: "project-default",
    context: acceptedContext({ command: { kind: "run" }, isPullRequest: true }),
    specRail: port,
  });

  assert.equal(outcome.bindingCreated, true);
  assert.equal(outcome.bindingId, "binding-created");
  assert.equal(outcome.trackId, "track-created");
  assert.equal(outcome.runId, "run-created");
  assert.deepEqual(calls.map((call) => call.name), ["findChannelBinding", "createTrack", "bindChannel", "startRun"]);
  assert.deepEqual(calls[1]?.input, {
    projectId: "project-default",
    title: "GitHub PR #123: Implement GitHub entrypoint",
    description: "Created from GitHub pull request yoophi-a/specrail#123 by @octocat.",
    priority: "medium",
  });
  assert.deepEqual(calls[2]?.input, {
    projectId: "project-default",
    channelType: "github",
    externalChatId: "yoophi-a/specrail",
    externalThreadId: "123",
    externalUserId: "octocat",
    trackId: "track-created",
    planningSessionId: undefined,
  });
  assert.deepEqual(calls[3]?.input, {
    trackId: "track-created",
    planningSessionId: undefined,
    prompt: "Run SpecRail for GitHub pull request yoophi-a/specrail#123.",
  });
});

test("executeGitHubRunCommand propagates SpecRail failures", async () => {
  const { port } = createSpecRailPort({
    async startRun() {
      throw new Error("run start failed");
    },
  });

  await assert.rejects(
    executeGitHubRunCommand({
      projectId: "project-default",
      context: acceptedContext(),
      specRail: port,
    }),
    /run start failed/u,
  );
});
