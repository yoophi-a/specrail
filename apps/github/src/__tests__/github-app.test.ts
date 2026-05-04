import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  authorizeGitHubActor,
  buildGitHubSignature256,
  createGitHubAppInstallationTokenProvider,
  createGitHubAppJwt,
  createGitHubRestAuthorizationClient,
  createGitHubRestIssueCommentClient,
  createGitHubWebhookHttpServer,
  JsonFileGitHubRelayJobQueue,
  createSpecRailHttpClient,
  executeGitHubRunCommand,
  formatGitHubTerminalOutcomeComment,
  getTerminalStatusFromRunEvent,
  handleGitHubWebhookCommand,
  isGitHubActorAuthorized,
  loadGitHubAppConfig,
  parseSpecRailIssueCommentCommand,
  postGitHubTerminalOutcomeComment,
  processGitHubRelayQueue,
  relayGitHubRunTerminalOutcome,
  resolveGitHubProjectId,
  startGitHubWebhookApp,
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

test("formatGitHubTerminalOutcomeComment formats terminal outcomes with optional report links", () => {
  assert.equal(
    formatGitHubTerminalOutcomeComment({
      repositoryFullName: "yoophi-a/specrail",
      issueNumber: 123,
      runId: "run-1",
      status: "completed",
      reportUrl: "https://specrail.example.test/runs/run-1/report.md",
    }),
    "SpecRail run run-1 completed.\nReport: https://specrail.example.test/runs/run-1/report.md",
  );
  assert.equal(
    formatGitHubTerminalOutcomeComment({ repositoryFullName: "yoophi-a/specrail", issueNumber: 123, runId: "run-2", status: "failed" }),
    "SpecRail run run-2 failed.",
  );
  assert.equal(
    formatGitHubTerminalOutcomeComment({ repositoryFullName: "yoophi-a/specrail", issueNumber: 123, runId: "run-3", status: "cancelled" }),
    "SpecRail run run-3 cancelled.",
  );
  assert.equal(
    formatGitHubTerminalOutcomeComment({ repositoryFullName: "yoophi-a/specrail", issueNumber: 123, runId: "run-4", status: "running" }),
    undefined,
  );
});

test("postGitHubTerminalOutcomeComment posts terminal comments and ignores progress statuses", async () => {
  const calls: Array<{ repositoryFullName: string; issueNumber: number; body: string }> = [];
  const github = {
    async createIssueComment(input: { repositoryFullName: string; issueNumber: number; body: string }) {
      calls.push(input);
      return { id: 1001, url: `https://github.com/${input.repositoryFullName}/issues/${input.issueNumber}#issuecomment-1001` };
    },
  };

  const posted = await postGitHubTerminalOutcomeComment({
    github,
    outcome: {
      repositoryFullName: "yoophi-a/specrail",
      issueNumber: 123,
      runId: "run-1",
      status: "completed",
      reportUrl: "https://specrail.example.test/runs/run-1/report.md",
    },
  });

  assert.equal(posted.posted, true);
  if (!posted.posted) {
    return;
  }
  assert.equal(posted.comment.id, 1001);
  assert.deepEqual(calls, [
    {
      repositoryFullName: "yoophi-a/specrail",
      issueNumber: 123,
      body: "SpecRail run run-1 completed.\nReport: https://specrail.example.test/runs/run-1/report.md",
    },
  ]);

  const ignored = await postGitHubTerminalOutcomeComment({
    github,
    outcome: { repositoryFullName: "yoophi-a/specrail", issueNumber: 123, runId: "run-2", status: "waiting_approval" },
  });

  assert.deepEqual(ignored, { posted: false, reason: "non_terminal_status" });
  assert.equal(calls.length, 1);
});

async function withGitHubWebhookServer(
  specRail: GitHubSpecRailPort,
  fn: (baseUrl: string) => Promise<void>,
  configOverrides: Partial<ReturnType<typeof loadGitHubAppConfig>> = {},
  authorization?: { isOrganizationMember(input: { organization: string; username: string }): Promise<boolean>; isTeamMember(input: { organization: string; teamSlug: string; username: string }): Promise<boolean> },
): Promise<void> {
  const server = createGitHubWebhookHttpServer({
    config: {
      apiBaseUrl: "https://specrail.example.test",
      port: 0,
      webhookPath: "/github/webhook",
      webhookSecret: secret,
      projectId: "project-default",
      githubApiBaseUrl: "https://api.github.example.test",
      followTerminalEvents: false,
      repositoryProjects: {},
      allowedActors: [],
      allowedOrganizations: [],
      allowedTeams: [],
      ...configOverrides,
    },
    specRail,
    authorization,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function signedWebhookInit(body: string, signature = buildGitHubSignature256(secret, body)): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-hub-signature-256": signature,
    },
    body,
  };
}

test("GitHub webhook HTTP app accepts run commands and invokes orchestration", async () => {
  const { port, calls } = createSpecRailPort();
  await withGitHubWebhookServer(port, async (baseUrl) => {
    const body = JSON.stringify(payload("/specrail run from http"));
    const response = await fetch(`${baseUrl}/github/webhook`, signedWebhookInit(body));
    assert.equal(response.status, 202);
    const responseBody = (await response.json()) as { accepted: boolean; outcome: { runId: string; reportUrl: string } };
    assert.equal(responseBody.accepted, true);
    assert.equal(responseBody.outcome.runId, "run-created");
    assert.equal(responseBody.outcome.reportUrl, "https://specrail.example.test/runs/run-created/report.md");
    assert.deepEqual(calls.map((call) => call.name), ["findChannelBinding", "createTrack", "bindChannel", "startRun"]);
  });
});

test("GitHub webhook HTTP app ignores non-command comments without starting runs", async () => {
  const { port, calls } = createSpecRailPort();
  await withGitHubWebhookServer(port, async (baseUrl) => {
    const body = JSON.stringify(payload("Looks good"));
    const response = await fetch(`${baseUrl}/github/webhook`, signedWebhookInit(body));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: false, reason: "unsupported_command" });
    assert.deepEqual(calls, []);
  });
});

test("GitHub webhook HTTP app rejects invalid signatures and bad JSON", async () => {
  const { port, calls } = createSpecRailPort();
  await withGitHubWebhookServer(port, async (baseUrl) => {
    const body = JSON.stringify(payload("/specrail run"));
    const invalidSignatureResponse = await fetch(`${baseUrl}/github/webhook`, signedWebhookInit(body, "sha256=bad"));
    assert.equal(invalidSignatureResponse.status, 401);
    assert.deepEqual(await invalidSignatureResponse.json(), { accepted: false, reason: "invalid_signature" });

    const badJsonResponse = await fetch(`${baseUrl}/github/webhook`, signedWebhookInit("{"));
    assert.equal(badJsonResponse.status, 400);
    assert.deepEqual(await badJsonResponse.json(), { error: "invalid_json" });
    assert.deepEqual(calls, []);
  });
});

test("GitHub webhook HTTP app surfaces orchestration failures", async () => {
  const { port } = createSpecRailPort({
    async startRun() {
      throw new Error("SpecRail unavailable");
    },
  });

  await withGitHubWebhookServer(port, async (baseUrl) => {
    const body = JSON.stringify(payload("/specrail run"));
    const response = await fetch(`${baseUrl}/github/webhook`, signedWebhookInit(body));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "specrail_request_failed", message: "SpecRail unavailable" });
  });
});

async function withJsonServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("createSpecRailHttpClient maps GitHub orchestration calls to SpecRail API requests", async () => {
  const requests: Array<{ method: string | undefined; url: string | undefined; body?: unknown }> = [];
  await withJsonServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method, url: request.url, body: bodyText ? JSON.parse(bodyText) : undefined });
      response.setHeader("content-type", "application/json");

      if (request.url?.startsWith("/channel-bindings?") && request.method === "GET") {
        response.statusCode = 200;
        response.end(JSON.stringify({ binding: { id: "binding-existing", trackId: "track-existing", planningSessionId: "planning-existing" } }));
        return;
      }
      if (request.url === "/tracks" && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ track: { id: "track-created" } }));
        return;
      }
      if (request.url === "/channel-bindings" && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ binding: { id: "binding-created", trackId: "track-created" } }));
        return;
      }
      if (request.url === "/runs" && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ run: { id: "run-created", status: "running" } }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
  }, async (baseUrl) => {
    const client = createSpecRailHttpClient(baseUrl);
    assert.deepEqual(await client.findChannelBinding({ channelType: "github", externalChatId: "yoophi-a/specrail", externalThreadId: "123" }), {
      id: "binding-existing",
      trackId: "track-existing",
      planningSessionId: "planning-existing",
    });
    assert.deepEqual(await client.createTrack({ projectId: "project-default", title: "Title", description: "Description", priority: "medium" }), {
      track: { id: "track-created" },
    });
    assert.deepEqual(
      await client.bindChannel({
        projectId: "project-default",
        channelType: "github",
        externalChatId: "yoophi-a/specrail",
        externalThreadId: "123",
        externalUserId: "octocat",
        trackId: "track-created",
      }),
      { binding: { id: "binding-created", trackId: "track-created" } },
    );
    assert.deepEqual(await client.startRun({ trackId: "track-created", prompt: "preserve opaque prompt #123" }), {
      run: { id: "run-created", status: "running" },
    });
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      url: "/channel-bindings?channelType=github&externalChatId=yoophi-a%2Fspecrail&externalThreadId=123",
      body: undefined,
    },
    { method: "POST", url: "/tracks", body: { projectId: "project-default", title: "Title", description: "Description", priority: "medium" } },
    {
      method: "POST",
      url: "/channel-bindings",
      body: {
        projectId: "project-default",
        channelType: "github",
        externalChatId: "yoophi-a/specrail",
        externalThreadId: "123",
        externalUserId: "octocat",
        trackId: "track-created",
      },
    },
    { method: "POST", url: "/runs", body: { trackId: "track-created", prompt: "preserve opaque prompt #123" } },
  ]);
});

test("createSpecRailHttpClient maps missing bindings to null and preserves non-404 API errors", async () => {
  await withJsonServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("missing")) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    response.statusCode = 500;
    response.end(JSON.stringify({ error: "boom" }));
  }, async (baseUrl) => {
    const client = createSpecRailHttpClient(baseUrl);
    assert.equal(await client.findChannelBinding({ channelType: "github", externalChatId: "missing", externalThreadId: "123" }), null);
    await assert.rejects(
      client.findChannelBinding({ channelType: "github", externalChatId: "yoophi-a/specrail", externalThreadId: "123" }),
      /SpecRail API GET \/channel-bindings\?channelType=github&externalChatId=yoophi-a%2Fspecrail&externalThreadId=123 failed with 500.*boom/u,
    );
  });
});

test("startGitHubWebhookApp starts the webhook server with injected config and port", async () => {
  const { port } = createSpecRailPort();
  const server = startGitHubWebhookApp({
    config: {
      apiBaseUrl: "https://specrail.example.test",
      port: 0,
      webhookPath: "/github/webhook",
      webhookSecret: secret,
      projectId: "project-default",
      githubApiBaseUrl: "https://api.github.example.test",
      followTerminalEvents: false,
      repositoryProjects: {},
      allowedActors: [],
      allowedOrganizations: [],
      allowedTeams: [],
    },
    specRail: port,
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  server.close();
  await once(server, "close");
});

test("createGitHubRestIssueCommentClient posts issue comments with GitHub REST headers", async () => {
  const requests: Array<{ method: string | undefined; url: string | undefined; headers: Record<string, string>; body?: unknown }> = [];
  await withJsonServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method,
        url: request.url,
        headers: {
          accept: request.headers.accept ?? "",
          authorization: request.headers.authorization ?? "",
          contentType: request.headers["content-type"] ?? "",
          apiVersion: request.headers["x-github-api-version"] ?? "",
        } as Record<string, string>,
        body: bodyText ? JSON.parse(bodyText) : undefined,
      });
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: 1001, html_url: "https://github.com/yoophi-a/specrail/issues/123#issuecomment-1001" }));
    });
  }, async (baseUrl) => {
    const client = createGitHubRestIssueCommentClient({ token: "github-token", apiBaseUrl: baseUrl });
    assert.deepEqual(
      await client.createIssueComment({
        repositoryFullName: "yoophi-a/specrail",
        issueNumber: 123,
        body: "SpecRail run run-1 completed.\nReport: https://specrail.example.test/runs/run-1/report.md",
      }),
      { id: 1001, html_url: "https://github.com/yoophi-a/specrail/issues/123#issuecomment-1001" },
    );
  });

  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "/repos/yoophi-a/specrail/issues/123/comments",
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer github-token",
        contentType: "application/json",
        apiVersion: "2022-11-28",
      },
      body: { body: "SpecRail run run-1 completed.\nReport: https://specrail.example.test/runs/run-1/report.md" },
    },
  ]);
});

test("createGitHubRestIssueCommentClient rejects invalid repository names and preserves API errors", async () => {
  const clientWithInvalidRepo = createGitHubRestIssueCommentClient({ token: "github-token", apiBaseUrl: "https://api.github.example.test" });
  await assert.rejects(
    clientWithInvalidRepo.createIssueComment({ repositoryFullName: "specrail", issueNumber: 123, body: "hello" }),
    /invalid GitHub repository full name: specrail/u,
  );

  await withJsonServer((_request, response) => {
    response.statusCode = 403;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ message: "Resource not accessible by integration" }));
  }, async (baseUrl) => {
    const client = createGitHubRestIssueCommentClient({ token: "github-token", apiBaseUrl: baseUrl });
    await assert.rejects(
      client.createIssueComment({ repositoryFullName: "yoophi-a/specrail", issueNumber: 123, body: "hello" }),
      /GitHub API POST \/repos\/yoophi-a\/specrail\/issues\/123\/comments failed with 403.*Resource not accessible/u,
    );
  });
});

test("getTerminalStatusFromRunEvent derives terminal status from payloads and summaries", () => {
  assert.equal(getTerminalStatusFromRunEvent({ type: "task_status_changed", payload: { status: "completed" } }), "completed");
  assert.equal(getTerminalStatusFromRunEvent({ type: "task_status_changed", payload: { status: "failed" } }), "failed");
  assert.equal(getTerminalStatusFromRunEvent({ type: "task_status_changed", summary: "Run cancelled" }), "cancelled");
  assert.equal(getTerminalStatusFromRunEvent({ type: "task_status_changed", summary: "Run is still running" }), undefined);
});

test("relayGitHubRunTerminalOutcome posts exactly one terminal outcome comment", async () => {
  const comments: Array<{ repositoryFullName: string; issueNumber: number; body: string }> = [];
  const result = await relayGitHubRunTerminalOutcome({
    specRail: {
      async *streamRunEvents() {
        yield { type: "task_status_changed", summary: "Run is running" };
        yield { type: "task_status_changed", payload: { status: "completed" } };
        yield { type: "task_status_changed", payload: { status: "failed" } };
      },
    },
    github: {
      async createIssueComment(input: { repositoryFullName: string; issueNumber: number; body: string }) {
        comments.push(input);
        return { id: 1001, url: "https://github.com/yoophi-a/specrail/issues/123#issuecomment-1001" };
      },
    },
    repositoryFullName: "yoophi-a/specrail",
    issueNumber: 123,
    runId: "run-1",
    reportUrl: "https://specrail.example.test/runs/run-1/report.md",
  });

  assert.deepEqual(result, {
    posted: true,
    status: "completed",
    body: "SpecRail run run-1 completed.\nReport: https://specrail.example.test/runs/run-1/report.md",
    comment: { id: 1001, url: "https://github.com/yoophi-a/specrail/issues/123#issuecomment-1001" },
  });
  assert.deepEqual(comments, [
    {
      repositoryFullName: "yoophi-a/specrail",
      issueNumber: 123,
      body: "SpecRail run run-1 completed.\nReport: https://specrail.example.test/runs/run-1/report.md",
    },
  ]);
});

test("relayGitHubRunTerminalOutcome no-ops when no terminal event or stream is unavailable", async () => {
  const github = {
    async createIssueComment() {
      throw new Error("should not post");
    },
  };

  assert.deepEqual(
    await relayGitHubRunTerminalOutcome({
      specRail: {},
      github,
      repositoryFullName: "yoophi-a/specrail",
      issueNumber: 123,
      runId: "run-1",
    }),
    { posted: false, reason: "stream_not_available" },
  );

  assert.deepEqual(
    await relayGitHubRunTerminalOutcome({
      specRail: {
        async *streamRunEvents() {
          yield { type: "task_status_changed", summary: "Run is running" };
        },
      },
      github,
      repositoryFullName: "yoophi-a/specrail",
      issueNumber: 123,
      runId: "run-1",
    }),
    { posted: false, reason: "no_terminal_event" },
  );
});

test("createSpecRailHttpClient streams run events and preserves SSE failures", async () => {
  await withJsonServer((request, response) => {
    if (request.url === "/runs/run-1/events/stream") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.end('event: message\ndata: {"type":"task_status_changed","summary":"Run completed","payload":{"status":"completed"}}\n\n');
      return;
    }
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "stream failed" }));
  }, async (baseUrl) => {
    const client = createSpecRailHttpClient(baseUrl);
    const events = [];
    for await (const event of client.streamRunEvents?.("run-1") ?? []) {
      events.push(event);
    }
    assert.deepEqual(events, [{ type: "task_status_changed", summary: "Run completed", payload: { status: "completed" } }]);

    await assert.rejects(async () => {
      for await (const _event of client.streamRunEvents?.("run-2") ?? []) {
        // consume stream
      }
    }, /SpecRail API GET \/runs\/run-2\/events\/stream failed with 500.*stream failed/u);
  });
});

test("GitHub webhook HTTP app schedules terminal relay without waiting for terminal events", async () => {
  const comments: Array<{ repositoryFullName: string; issueNumber: number; body: string }> = [];
  const tasks: Array<() => Promise<void>> = [];
  const { port } = createSpecRailPort({
    async *streamRunEvents() {
      yield { type: "task_status_changed", payload: { status: "failed" } };
    },
  });

  const server = createGitHubWebhookHttpServer({
    config: {
      apiBaseUrl: "https://specrail.example.test",
      port: 0,
      webhookPath: "/github/webhook",
      webhookSecret: secret,
      projectId: "project-default",
      githubApiBaseUrl: "https://api.github.example.test",
      followTerminalEvents: true,
      repositoryProjects: {},
      allowedActors: [],
      allowedOrganizations: [],
      allowedTeams: [],
    },
    specRail: port,
    github: {
      async createIssueComment(input: { repositoryFullName: string; issueNumber: number; body: string }) {
        comments.push(input);
        return { id: 1001 };
      },
    },
    scheduler: {
      schedule(task) {
        tasks.push(task);
      },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const body = JSON.stringify(payload("/specrail run"));
    const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, signedWebhookInit(body));
    assert.equal(response.status, 202);
    const responseBody = (await response.json()) as { relay: { scheduled: boolean } };
    assert.deepEqual(responseBody.relay, { scheduled: true });
    assert.deepEqual(comments, []);
    assert.equal(tasks.length, 1);

    await tasks[0]?.();
    assert.deepEqual(comments, [
      {
        repositoryFullName: "yoophi-a/specrail",
        issueNumber: 123,
        body: "SpecRail run run-created failed.\nReport: https://specrail.example.test/runs/run-created/report.md",
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GitHub webhook HTTP app surfaces terminal relay enqueue failures", async () => {
  const { port } = createSpecRailPort();
  const server = createGitHubWebhookHttpServer({
    config: {
      apiBaseUrl: "https://specrail.example.test",
      port: 0,
      webhookPath: "/github/webhook",
      webhookSecret: secret,
      projectId: "project-default",
      githubApiBaseUrl: "https://api.github.example.test",
      followTerminalEvents: true,
      repositoryProjects: {},
      allowedActors: [],
      allowedOrganizations: [],
      allowedTeams: [],
    },
    specRail: port,
    github: {
      async createIssueComment() {
        return { id: 1001 };
      },
    },
    scheduler: {
      schedule() {
        throw new Error("queue unavailable");
      },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const body = JSON.stringify(payload("/specrail run"));
    const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, signedWebhookInit(body));
    assert.equal(response.status, 502);
    const responseBody = (await response.json()) as { error: string; message: string; outcome: { runId: string } };
    assert.deepEqual(responseBody, {
      error: "github_relay_enqueue_failed",
      message: "queue unavailable",
      outcome: {
        bindingCreated: true,
        bindingId: "binding-created",
        trackId: "track-created",
        runId: "run-created",
        reportUrl: "https://specrail.example.test/runs/run-created/report.md",
      },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("loadGitHubAppConfig parses repository project mappings and actor allowlists", () => {
  const config = loadGitHubAppConfig({
    SPECRAIL_API_BASE_URL: "https://specrail.example.test",
    SPECRAIL_GITHUB_PROJECT_ID: "project-default",
    GITHUB_WEBHOOK_SECRET: "secret",
    SPECRAIL_GITHUB_REPOSITORY_PROJECTS: "yoophi-a/specrail=project-specrail, other/repo = project-other",
    GITHUB_ALLOWED_ACTORS: "octocat,@hubot",
  });

  assert.deepEqual(config.repositoryProjects, { "yoophi-a/specrail": "project-specrail", "other/repo": "project-other" });
  assert.deepEqual(config.allowedActors, ["octocat", "@hubot"]);
  assert.equal(resolveGitHubProjectId(config, "yoophi-a/specrail"), "project-specrail");
  assert.equal(resolveGitHubProjectId(config, "missing/repo"), undefined);
  assert.equal(isGitHubActorAuthorized(config, "octocat"), true);
  assert.equal(isGitHubActorAuthorized(config, "hubot"), true);
  assert.equal(isGitHubActorAuthorized(config, "mallory"), false);
});

test("GitHub webhook HTTP app uses mapped repository project ids", async () => {
  const { port, calls } = createSpecRailPort();
  await withGitHubWebhookServer(port, async (baseUrl) => {
    const body = JSON.stringify(payload("/specrail run mapped"));
    const response = await fetch(`${baseUrl}/github/webhook`, signedWebhookInit(body));
    assert.equal(response.status, 202);
    assert.equal(((await response.json()) as { accepted: boolean }).accepted, true);
  }, { repositoryProjects: { "yoophi-a/specrail": "project-mapped" } });

  assert.deepEqual(calls[1]?.input, {
    projectId: "project-mapped",
    title: "GitHub issue #123: Implement GitHub entrypoint",
    description: "Created from GitHub issue yoophi-a/specrail#123 by @octocat.",
    priority: "medium",
  });
});

test("GitHub webhook HTTP app rejects unmapped repositories when repository allowlist is configured", async () => {
  const { port, calls } = createSpecRailPort();
  await withGitHubWebhookServer(port, async (baseUrl) => {
    const body = JSON.stringify(payload("/specrail run unmapped"));
    const response = await fetch(`${baseUrl}/github/webhook`, signedWebhookInit(body));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: false, reason: "unsupported_repository" });
  }, { repositoryProjects: { "other/repo": "project-other" } });

  assert.deepEqual(calls, []);
});

test("GitHub webhook HTTP app authorizes allowed actors and rejects unauthorized actors", async () => {
  const allowed = createSpecRailPort();
  await withGitHubWebhookServer(allowed.port, async (baseUrl) => {
    const body = JSON.stringify(payload("/specrail run authorized"));
    const response = await fetch(`${baseUrl}/github/webhook`, signedWebhookInit(body));
    assert.equal(response.status, 202);
    assert.equal(((await response.json()) as { accepted: boolean }).accepted, true);
  }, { allowedActors: ["octocat"] });
  assert.notDeepEqual(allowed.calls, []);

  const rejected = createSpecRailPort();
  await withGitHubWebhookServer(rejected.port, async (baseUrl) => {
    const body = JSON.stringify(payload("/specrail run unauthorized"));
    const response = await fetch(`${baseUrl}/github/webhook`, signedWebhookInit(body));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: false, reason: "unauthorized_actor" });
  }, { allowedActors: ["hubot"] });
  assert.deepEqual(rejected.calls, []);
});

function decodeJwtPart(token: string, index: number): unknown {
  const part = token.split(".")[index];
  assert.ok(part);
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
}

test("createGitHubAppJwt signs GitHub App JWT claims", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwt = createGitHubAppJwt({ appId: "12345", privateKey: privateKeyPem, now: () => 1_700_000_000_000 });

  assert.equal(jwt.split(".").length, 3);
  assert.deepEqual(decodeJwtPart(jwt, 0), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decodeJwtPart(jwt, 1), { iat: 1_699_999_940, exp: 1_700_000_540, iss: "12345" });
});

test("createGitHubAppInstallationTokenProvider exchanges, caches, and refreshes installation tokens", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let nowMs = 1_700_000_000_000;
  const requests: Array<{ url: string; method?: string; authorization?: string }> = [];
  const tokens = ["installation-token-1", "installation-token-2"];
  const fetchFn: typeof fetch = async (url, init) => {
    requests.push({
      url: url.toString(),
      method: init?.method,
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? undefined : (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    const token = tokens.shift();
    assert.ok(token);
    return new Response(JSON.stringify({ token, expires_at: new Date(nowMs + 3_600_000).toISOString() }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  const provider = createGitHubAppInstallationTokenProvider({
    appId: "12345",
    installationId: "67890",
    privateKey: privateKeyPem,
    apiBaseUrl: "https://api.github.example.test",
    fetchFn,
    now: () => nowMs,
  });

  assert.equal(await provider.getToken(), "installation-token-1");
  assert.equal(await provider.getToken(), "installation-token-1");
  nowMs += 3_550_000;
  assert.equal(await provider.getToken(), "installation-token-2");

  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => ({ url: request.url, method: request.method })),
    [
      { url: "https://api.github.example.test/app/installations/67890/access_tokens", method: "POST" },
      { url: "https://api.github.example.test/app/installations/67890/access_tokens", method: "POST" },
    ],
  );
  assert.ok(requests[0]?.authorization?.startsWith("Bearer "));
});

test("createGitHubRestIssueCommentClient accepts token providers", async () => {
  const requests: Array<{ authorization: string }> = [];
  await withJsonServer((request, response) => {
    requests.push({ authorization: request.headers.authorization ?? "" });
    response.statusCode = 201;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: 1001 }));
  }, async (baseUrl) => {
    const client = createGitHubRestIssueCommentClient({
      apiBaseUrl: baseUrl,
      tokenProvider: {
        async getToken() {
          return "provider-token";
        },
      },
    });
    assert.deepEqual(await client.createIssueComment({ repositoryFullName: "yoophi-a/specrail", issueNumber: 123, body: "hello" }), { id: 1001 });
  });

  assert.deepEqual(requests, [{ authorization: "Bearer provider-token" }]);
});

test("JsonFileGitHubRelayJobQueue persists relay jobs across instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "specrail-github-relay-"));
  const queuePath = path.join(dir, "queue.json");
  const queue = new JsonFileGitHubRelayJobQueue(queuePath);
  const created = await queue.enqueue({ repositoryFullName: "yoophi-a/specrail", issueNumber: 123, runId: "run-created", reportUrl: "https://specrail.example.test/runs/run-created/report.md" });

  const reloaded = new JsonFileGitHubRelayJobQueue(queuePath);
  assert.deepEqual(await reloaded.list(), [created]);

  const claimed = await reloaded.claimNext(new Date(created.createdAt));
  assert.equal(claimed?.id, created.id);
  assert.equal((await reloaded.list())[0]?.status, "running");
});

test("processGitHubRelayQueue posts terminal comments and completes jobs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "specrail-github-relay-"));
  const queue = new JsonFileGitHubRelayJobQueue(path.join(dir, "queue.json"));
  const job = await queue.enqueue({ repositoryFullName: "yoophi-a/specrail", issueNumber: 123, runId: "run-created" });
  const comments: Array<{ repositoryFullName: string; issueNumber: number; body: string }> = [];

  const result = await processGitHubRelayQueue({
    queue,
    specRail: {
      async *streamRunEvents() {
        yield { type: "task_status_changed", payload: { status: "completed" } };
      },
    },
    github: {
      async createIssueComment(input) {
        comments.push(input);
        return { id: 1001 };
      },
    },
  });

  assert.equal(result.processed, true);
  assert.equal(result.jobId, job.id);
  assert.equal((await queue.list())[0]?.status, "completed");
  assert.deepEqual(comments, [{ repositoryFullName: "yoophi-a/specrail", issueNumber: 123, body: "SpecRail run run-created completed." }]);
});

test("processGitHubRelayQueue records retryable failures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "specrail-github-relay-"));
  const queue = new JsonFileGitHubRelayJobQueue(path.join(dir, "queue.json"));
  const job = await queue.enqueue({ repositoryFullName: "yoophi-a/specrail", issueNumber: 123, runId: "run-created" });

  await assert.rejects(
    processGitHubRelayQueue({
      queue,
      specRail: {
        async *streamRunEvents() {
          yield { type: "task_status_changed", payload: { status: "failed" } };
        },
      },
      github: {
        async createIssueComment() {
          throw new Error("GitHub unavailable");
        },
      },
    }),
    /GitHub unavailable/u,
  );

  const [failed] = await queue.list();
  assert.equal(failed?.id, job.id);
  assert.equal(failed?.status, "pending");
  assert.equal(failed?.attempts, 1);
  assert.equal(failed?.lastError, "GitHub unavailable");
  assert.ok(failed?.nextAttemptAt);
});

test("GitHub webhook HTTP app enqueues durable terminal relay jobs", async () => {
  const { port } = createSpecRailPort();
  const queue = new JsonFileGitHubRelayJobQueue(path.join(await mkdtemp(path.join(os.tmpdir(), "specrail-github-relay-")), "queue.json"));
  const server = createGitHubWebhookHttpServer({
    config: {
      apiBaseUrl: "https://specrail.example.test",
      port: 0,
      webhookPath: "/github/webhook",
      webhookSecret: secret,
      projectId: "project-default",
      githubApiBaseUrl: "https://api.github.example.test",
      followTerminalEvents: true,
      repositoryProjects: {},
      allowedActors: [],
      allowedOrganizations: [],
      allowedTeams: [],
    },
    specRail: port,
    github: {
      async createIssueComment() {
        return { id: 1001 };
      },
    },
    relayQueue: queue,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const body = JSON.stringify(payload("/specrail run"));
    const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, signedWebhookInit(body));
    assert.equal(response.status, 202);
    assert.deepEqual(((await response.json()) as { relay: { scheduled: boolean } }).relay, { scheduled: true });
    assert.equal((await queue.list())[0]?.runId, "run-created");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("authorizeGitHubActor supports organization and team membership", async () => {
  const checks: string[] = [];
  const authorization = {
    async isOrganizationMember(input: { organization: string; username: string }) {
      checks.push(`org:${input.organization}:${input.username}`);
      return input.organization === "yoophi-a";
    },
    async isTeamMember(input: { organization: string; teamSlug: string; username: string }) {
      checks.push(`team:${input.organization}/${input.teamSlug}:${input.username}`);
      return input.organization === "other" && input.teamSlug === "maintainers";
    },
  };

  assert.equal(
    await authorizeGitHubActor({ config: { allowedActors: [], allowedOrganizations: ["yoophi-a"], allowedTeams: [] }, senderLogin: "octocat", authorization }),
    true,
  );
  assert.equal(
    await authorizeGitHubActor({ config: { allowedActors: [], allowedOrganizations: ["missing"], allowedTeams: ["other/maintainers"] }, senderLogin: "hubot", authorization }),
    true,
  );
  assert.equal(
    await authorizeGitHubActor({ config: { allowedActors: [], allowedOrganizations: ["missing"], allowedTeams: ["other/reviewers"] }, senderLogin: "mallory", authorization }),
    false,
  );
  assert.deepEqual(checks, ["org:yoophi-a:octocat", "org:missing:hubot", "team:other/maintainers:hubot", "org:missing:mallory", "team:other/reviewers:mallory"]);
});

test("createGitHubRestAuthorizationClient checks org and team membership", async () => {
  const requests: Array<{ url?: string; authorization?: string }> = [];
  await withJsonServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.statusCode = request.url?.includes("/teams/maintainers/") ? 404 : 204;
    response.end();
  }, async (baseUrl) => {
    const client = createGitHubRestAuthorizationClient({ token: "github-token", apiBaseUrl: baseUrl });
    assert.equal(await client.isOrganizationMember({ organization: "yoophi-a", username: "octocat" }), true);
    assert.equal(await client.isTeamMember({ organization: "yoophi-a", teamSlug: "maintainers", username: "octocat" }), false);
  });

  assert.deepEqual(requests, [
    { url: "/orgs/yoophi-a/members/octocat", authorization: "Bearer github-token" },
    { url: "/orgs/yoophi-a/teams/maintainers/memberships/octocat", authorization: "Bearer github-token" },
  ]);
});

test("GitHub webhook HTTP app accepts org-authorized actors and rejects authorization failures before runs", async () => {
  const accepted = createSpecRailPort();
  await withGitHubWebhookServer(
    accepted.port,
    async (baseUrl) => {
      const body = JSON.stringify(payload("/specrail run org"));
      const response = await fetch(`${baseUrl}/github/webhook`, signedWebhookInit(body));
      assert.equal(response.status, 202);
      assert.equal(((await response.json()) as { accepted: boolean }).accepted, true);
    },
    { allowedOrganizations: ["yoophi-a"] },
    {
      async isOrganizationMember() {
        return true;
      },
      async isTeamMember() {
        return false;
      },
    },
  );
  assert.notDeepEqual(accepted.calls, []);

  const rejected = createSpecRailPort();
  await withGitHubWebhookServer(
    rejected.port,
    async (baseUrl) => {
      const body = JSON.stringify(payload("/specrail run rejected"));
      const response = await fetch(`${baseUrl}/github/webhook`, signedWebhookInit(body));
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "github_authorization_failed", message: "membership check failed" });
    },
    { allowedOrganizations: ["yoophi-a"] },
    {
      async isOrganizationMember() {
        throw new Error("membership check failed");
      },
      async isTeamMember() {
        return false;
      },
    },
  );
  assert.deepEqual(rejected.calls, []);
});
