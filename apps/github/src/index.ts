import { createHmac, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

export const SPEC_RAIL_RUN_COMMAND = "/specrail run";

export interface GitHubRunCommand {
  kind: "run";
  prompt?: string;
}

export interface GitHubAppConfig {
  apiBaseUrl: string;
  port: number;
  webhookPath: string;
  webhookSecret: string;
  projectId: string;
  githubApiBaseUrl: string;
  githubToken?: string;
  followTerminalEvents: boolean;
  repositoryProjects: Record<string, string>;
  allowedActors: string[];
}

export interface GitHubIssueCommentCommandEvent {
  action: string;
  comment?: {
    body?: string;
  };
  issue?: {
    number?: number;
    title?: string;
    pull_request?: unknown;
  };
  repository?: {
    full_name?: string;
  };
  sender?: {
    login?: string;
    id?: number;
  };
}

export type GitHubWebhookCommandResult =
  | GitHubAcceptedRunCommandContext
  | {
      accepted: false;
      reason:
        | "invalid_signature"
        | "unsupported_event"
        | "unsupported_action"
        | "unsupported_command"
        | "missing_context"
        | "unsupported_repository"
        | "unauthorized_actor";
    };

export interface GitHubAcceptedRunCommandContext {
  accepted: true;
  command: GitHubRunCommand;
  repositoryFullName: string;
  issueNumber: number;
  issueTitle?: string;
  senderLogin?: string;
  senderId?: number;
  isPullRequest: boolean;
}

export interface GitHubSpecRailPort {
  findChannelBinding(input: {
    channelType: "github";
    externalChatId: string;
    externalThreadId: string;
  }): Promise<{ id: string; trackId?: string; planningSessionId?: string } | null>;
  createTrack(input: { projectId: string; title: string; description: string; priority: "medium" }): Promise<{ track: { id: string } }>;
  bindChannel(input: {
    projectId: string;
    channelType: "github";
    externalChatId: string;
    externalThreadId: string;
    externalUserId?: string;
    trackId: string;
    planningSessionId?: string;
  }): Promise<{ binding: { id: string; trackId?: string; planningSessionId?: string } }>;
  startRun(input: { trackId: string; planningSessionId?: string; prompt: string }): Promise<{ run: { id: string; status: string } }>;
  streamRunEvents?(runId: string): AsyncGenerator<GitHubRunEvent>;
}

export interface GitHubRunEvent {
  type: string;
  summary?: string;
  payload?: { status?: string };
}

export interface GitHubRunCommandOutcome {
  bindingCreated: boolean;
  bindingId?: string;
  trackId: string;
  planningSessionId?: string;
  runId: string;
  reportUrl?: string;
}

export type GitHubRunOutcomeStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export interface GitHubIssueCommentPort {
  createIssueComment(input: { repositoryFullName: string; issueNumber: number; body: string }): Promise<{ id?: string | number; url?: string }>;
}

export interface GitHubBackgroundTaskScheduler {
  schedule(task: () => Promise<void>): void;
}

export interface GitHubWebhookAppDeps {
  config: GitHubAppConfig;
  specRail: GitHubSpecRailPort;
  github?: GitHubIssueCommentPort;
  scheduler?: GitHubBackgroundTaskScheduler;
}

export interface GitHubTerminalOutcomeCommentInput {
  repositoryFullName: string;
  issueNumber: number;
  runId: string;
  status: GitHubRunOutcomeStatus;
  reportUrl?: string;
}

export type GitHubTerminalOutcomeCommentResult =
  | { posted: true; body: string; comment: { id?: string | number; url?: string } }
  | { posted: false; reason: "non_terminal_status" };

export type GitHubRunEventRelayResult =
  | { posted: true; status: "completed" | "failed" | "cancelled"; body: string; comment: { id?: string | number; url?: string } }
  | { posted: false; reason: "no_terminal_event" | "stream_not_available" };

export type GitHubRunEventRelayScheduleResult = { scheduled: true } | { scheduled: false; reason: "disabled" | "missing_github_client" };

function parseRepositoryProjectMap(value: string | undefined): Record<string, string> {
  if (!value?.trim()) {
    return {};
  }

  return Object.fromEntries(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [repositoryFullName, projectId] = entry.split("=").map((part) => part.trim());
        if (!repositoryFullName || !projectId) {
          throw new Error(`invalid SPECRAIL_GITHUB_REPOSITORY_PROJECTS entry: ${entry}`);
        }
        return [repositoryFullName, projectId];
      }),
  );
}

function parseCsvList(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveGitHubProjectId(config: Pick<GitHubAppConfig, "projectId" | "repositoryProjects">, repositoryFullName: string): string | undefined {
  const configuredProject = config.repositoryProjects[repositoryFullName];
  if (configuredProject) {
    return configuredProject;
  }
  return Object.keys(config.repositoryProjects).length > 0 ? undefined : config.projectId;
}

export function isGitHubActorAuthorized(config: Pick<GitHubAppConfig, "allowedActors">, senderLogin?: string): boolean {
  if (config.allowedActors.length === 0) {
    return true;
  }
  if (!senderLogin) {
    return false;
  }
  return config.allowedActors.includes(senderLogin) || config.allowedActors.includes(`@${senderLogin}`);
}

export function loadGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig {
  return {
    apiBaseUrl: env.SPECRAIL_API_BASE_URL ?? "http://127.0.0.1:4000",
    port: Number(env.GITHUB_APP_PORT ?? 4200),
    webhookPath: env.GITHUB_WEBHOOK_PATH ?? "/github/webhook",
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
    projectId: env.SPECRAIL_GITHUB_PROJECT_ID ?? env.SPECRAIL_PROJECT_ID ?? "project-default",
    githubApiBaseUrl: env.GITHUB_API_BASE_URL ?? "https://api.github.com",
    githubToken: env.GITHUB_TOKEN ?? env.GITHUB_INSTALLATION_TOKEN,
    followTerminalEvents: env.GITHUB_FOLLOW_TERMINAL_EVENTS === "true",
    repositoryProjects: parseRepositoryProjectMap(env.SPECRAIL_GITHUB_REPOSITORY_PROJECTS),
    allowedActors: parseCsvList(env.GITHUB_ALLOWED_ACTORS),
  };
}

function encodeGitHubPathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

async function githubJsonRequest<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const responseText = await response.text();
  if (!response.ok) {
    const bodySuffix = responseText ? `: ${responseText}` : "";
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} failed with ${response.status}${bodySuffix}`);
  }

  return (responseText ? JSON.parse(responseText) : {}) as T;
}

export function createGitHubRestIssueCommentClient(input: { token: string; apiBaseUrl?: string }): GitHubIssueCommentPort {
  const apiBaseUrl = input.apiBaseUrl ?? "https://api.github.com";
  return {
    async createIssueComment(commentInput) {
      const [owner, repo] = commentInput.repositoryFullName.split("/");
      if (!owner || !repo) {
        throw new Error(`invalid GitHub repository full name: ${commentInput.repositoryFullName}`);
      }

      return githubJsonRequest(apiBaseUrl, `/repos/${encodeGitHubPathSegment(owner)}/${encodeGitHubPathSegment(repo)}/issues/${commentInput.issueNumber}/comments`, {
        method: "POST",
        headers: { authorization: `Bearer ${input.token}` },
        body: JSON.stringify({ body: commentInput.body }),
      });
    },
  };
}

async function* parseSpecRailSseStream<T>(response: Response): AsyncGenerator<T> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex === -1) {
        break;
      }

      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();

      if (dataLine) {
        yield JSON.parse(dataLine) as T;
      }
    }
  }
}

async function specRailJsonRequest<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  const responseText = await response.text();
  if (!response.ok) {
    const bodySuffix = responseText ? `: ${responseText}` : "";
    throw new Error(`SpecRail API ${init.method ?? "GET"} ${path} failed with ${response.status}${bodySuffix}`);
  }

  return (responseText ? JSON.parse(responseText) : {}) as T;
}

export function createSpecRailHttpClient(apiBaseUrl: string): GitHubSpecRailPort {
  return {
    async findChannelBinding(input) {
      const searchParams = new URLSearchParams({
        channelType: input.channelType,
        externalChatId: input.externalChatId,
      });
      if (input.externalThreadId) {
        searchParams.set("externalThreadId", input.externalThreadId);
      }

      try {
        const result = await specRailJsonRequest<{ binding: { id: string; trackId?: string; planningSessionId?: string } }>(
          apiBaseUrl,
          `/channel-bindings?${searchParams.toString()}`,
        );
        return result.binding;
      } catch (error) {
        if (error instanceof Error && error.message.includes(" failed with 404")) {
          return null;
        }
        throw error;
      }
    },
    async createTrack(input) {
      return specRailJsonRequest(apiBaseUrl, "/tracks", { method: "POST", body: JSON.stringify(input) });
    },
    async bindChannel(input) {
      return specRailJsonRequest(apiBaseUrl, "/channel-bindings", { method: "POST", body: JSON.stringify(input) });
    },
    async startRun(input) {
      return specRailJsonRequest(apiBaseUrl, "/runs", { method: "POST", body: JSON.stringify(input) });
    },
    async *streamRunEvents(runId) {
      const path = `/runs/${encodeURIComponent(runId)}/events/stream`;
      const response = await fetch(new URL(path, apiBaseUrl), { headers: { accept: "text/event-stream" } });
      if (!response.ok || !response.body) {
        const responseText = await response.text();
        const bodySuffix = responseText ? `: ${responseText}` : "";
        throw new Error(`SpecRail API GET ${path} failed with ${response.status}${bodySuffix}`);
      }

      yield* parseSpecRailSseStream<GitHubRunEvent>(response);
    },
  };
}

export const defaultGitHubBackgroundTaskScheduler: GitHubBackgroundTaskScheduler = {
  schedule(task) {
    setTimeout(() => {
      task().catch((error: unknown) => {
        console.error("GitHub background task failed", error);
      });
    }, 0);
  },
};

export function startGitHubWebhookApp(input: { config?: GitHubAppConfig; specRail?: GitHubSpecRailPort; github?: GitHubIssueCommentPort } = {}): http.Server {
  const config = input.config ?? loadGitHubAppConfig();
  const specRail = input.specRail ?? createSpecRailHttpClient(config.apiBaseUrl);
  const github = input.github ?? (config.githubToken ? createGitHubRestIssueCommentClient({ token: config.githubToken, apiBaseUrl: config.githubApiBaseUrl }) : undefined);
  const server = createGitHubWebhookHttpServer({ config, specRail, github, scheduler: defaultGitHubBackgroundTaskScheduler });
  server.listen(config.port, () => {
    console.log(`SpecRail GitHub webhook listening on ${normalizeWebhookPath(config.webhookPath)} at port ${config.port}`);
  });
  return server;
}

export function buildGitHubSignature256(secret: string, payload: string | Buffer): string {
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${digest}`;
}

export function verifyGitHubSignature256(input: { secret: string; payload: string | Buffer; signatureHeader?: string }): boolean {
  if (!input.signatureHeader) {
    return false;
  }

  const expected = Buffer.from(buildGitHubSignature256(input.secret, input.payload), "utf8");
  const actual = Buffer.from(input.signatureHeader, "utf8");

  if (actual.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(actual, expected);
}

export function parseSpecRailIssueCommentCommand(body: string): GitHubRunCommand | undefined {
  const trimmed = body.trim();
  if (trimmed !== SPEC_RAIL_RUN_COMMAND && !trimmed.startsWith(`${SPEC_RAIL_RUN_COMMAND} `)) {
    return undefined;
  }

  const prompt = trimmed.slice(SPEC_RAIL_RUN_COMMAND.length).trim();
  return prompt.length > 0 ? { kind: "run", prompt } : { kind: "run" };
}

function deriveGitHubTrackTitle(context: GitHubAcceptedRunCommandContext): string {
  const prefix = context.isPullRequest ? "GitHub PR" : "GitHub issue";
  const title = context.issueTitle?.trim();
  return title ? `${prefix} #${context.issueNumber}: ${title}` : `${prefix} #${context.issueNumber}`;
}

function deriveGitHubRunPrompt(context: GitHubAcceptedRunCommandContext): string {
  if (context.command.prompt) {
    return context.command.prompt;
  }

  const itemType = context.isPullRequest ? "pull request" : "issue";
  return `Run SpecRail for GitHub ${itemType} ${context.repositoryFullName}#${context.issueNumber}.`;
}

function buildGitHubDescription(context: GitHubAcceptedRunCommandContext): string {
  const itemType = context.isPullRequest ? "pull request" : "issue";
  const sender = context.senderLogin ? ` by @${context.senderLogin}` : "";
  return `Created from GitHub ${itemType} ${context.repositoryFullName}#${context.issueNumber}${sender}.`;
}

export function buildGitHubRunReportUrl(apiBaseUrl: string, runId: string): string {
  return new URL(`/runs/${encodeURIComponent(runId)}/report.md`, apiBaseUrl).toString();
}

function isTerminalGitHubRunStatus(status: GitHubRunOutcomeStatus): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function getTerminalStatusFromRunEvent(event: GitHubRunEvent): "completed" | "failed" | "cancelled" | undefined {
  const payloadStatus = event.payload?.status;
  if (payloadStatus === "completed" || payloadStatus === "failed" || payloadStatus === "cancelled") {
    return payloadStatus;
  }

  const summary = event.summary?.toLowerCase() ?? "";
  if (/\bcompleted\b|\brun completed\b/u.test(summary)) {
    return "completed";
  }
  if (/\bfailed\b|\brun failed\b/u.test(summary)) {
    return "failed";
  }
  if (/\bcancelled\b|\bcanceled\b|\brun cancelled\b|\brun canceled\b/u.test(summary)) {
    return "cancelled";
  }
  return undefined;
}

export function formatGitHubTerminalOutcomeComment(input: GitHubTerminalOutcomeCommentInput): string | undefined {
  if (!isTerminalGitHubRunStatus(input.status)) {
    return undefined;
  }

  const statusLabel = input.status === "completed" ? "completed" : input.status === "failed" ? "failed" : "cancelled";
  const lines = [`SpecRail run ${input.runId} ${statusLabel}.`];
  if (input.reportUrl) {
    lines.push(`Report: ${input.reportUrl}`);
  }
  return lines.join("\n");
}

export async function postGitHubTerminalOutcomeComment(input: {
  github: GitHubIssueCommentPort;
  outcome: GitHubTerminalOutcomeCommentInput;
}): Promise<GitHubTerminalOutcomeCommentResult> {
  const body = formatGitHubTerminalOutcomeComment(input.outcome);
  if (!body) {
    return { posted: false, reason: "non_terminal_status" };
  }

  const comment = await input.github.createIssueComment({
    repositoryFullName: input.outcome.repositoryFullName,
    issueNumber: input.outcome.issueNumber,
    body,
  });

  return { posted: true, body, comment };
}

export function scheduleGitHubRunTerminalOutcomeRelay(input: {
  enabled: boolean;
  scheduler: GitHubBackgroundTaskScheduler;
  specRail: Pick<GitHubSpecRailPort, "streamRunEvents">;
  github?: GitHubIssueCommentPort;
  repositoryFullName: string;
  issueNumber: number;
  runId: string;
  reportUrl?: string;
  onError?: (error: unknown) => void;
}): GitHubRunEventRelayScheduleResult {
  if (!input.enabled) {
    return { scheduled: false, reason: "disabled" };
  }
  if (!input.github) {
    return { scheduled: false, reason: "missing_github_client" };
  }

  input.scheduler.schedule(async () => {
    try {
      await relayGitHubRunTerminalOutcome({
        specRail: input.specRail,
        github: input.github as GitHubIssueCommentPort,
        repositoryFullName: input.repositoryFullName,
        issueNumber: input.issueNumber,
        runId: input.runId,
        reportUrl: input.reportUrl,
      });
    } catch (error) {
      input.onError?.(error);
      if (!input.onError) {
        throw error;
      }
    }
  });

  return { scheduled: true };
}

export async function relayGitHubRunTerminalOutcome(input: {
  specRail: Pick<GitHubSpecRailPort, "streamRunEvents">;
  github: GitHubIssueCommentPort;
  repositoryFullName: string;
  issueNumber: number;
  runId: string;
  reportUrl?: string;
}): Promise<GitHubRunEventRelayResult> {
  if (!input.specRail.streamRunEvents) {
    return { posted: false, reason: "stream_not_available" };
  }

  for await (const event of input.specRail.streamRunEvents(input.runId)) {
    const status = getTerminalStatusFromRunEvent(event);
    if (!status) {
      continue;
    }

    const result = await postGitHubTerminalOutcomeComment({
      github: input.github,
      outcome: {
        repositoryFullName: input.repositoryFullName,
        issueNumber: input.issueNumber,
        runId: input.runId,
        status,
        reportUrl: input.reportUrl,
      },
    });

    if (!result.posted) {
      return { posted: false, reason: "no_terminal_event" };
    }
    return { posted: true, status, body: result.body, comment: result.comment };
  }

  return { posted: false, reason: "no_terminal_event" };
}

export async function executeGitHubRunCommand(input: {
  projectId: string;
  context: GitHubAcceptedRunCommandContext;
  specRail: GitHubSpecRailPort;
  apiBaseUrl?: string;
}): Promise<GitHubRunCommandOutcome> {
  const externalChatId = input.context.repositoryFullName;
  const externalThreadId = String(input.context.issueNumber);
  const externalUserId = input.context.senderLogin ?? (input.context.senderId !== undefined ? String(input.context.senderId) : undefined);

  const existingBinding = await input.specRail.findChannelBinding({
    channelType: "github",
    externalChatId,
    externalThreadId,
  });

  let bindingCreated = false;
  let bindingId = existingBinding?.id;
  let trackId = existingBinding?.trackId;
  let planningSessionId = existingBinding?.planningSessionId;

  if (!trackId) {
    const createdTrack = await input.specRail.createTrack({
      projectId: input.projectId,
      title: deriveGitHubTrackTitle(input.context),
      description: buildGitHubDescription(input.context),
      priority: "medium",
    });
    trackId = createdTrack.track.id;

    const createdBinding = await input.specRail.bindChannel({
      projectId: input.projectId,
      channelType: "github",
      externalChatId,
      externalThreadId,
      externalUserId,
      trackId,
      planningSessionId,
    });
    bindingCreated = true;
    bindingId = createdBinding.binding.id;
    planningSessionId = createdBinding.binding.planningSessionId;
  }

  const run = await input.specRail.startRun({
    trackId,
    planningSessionId,
    prompt: deriveGitHubRunPrompt(input.context),
  });

  return {
    bindingCreated,
    bindingId,
    trackId,
    planningSessionId,
    runId: run.run.id,
    reportUrl: input.apiBaseUrl ? buildGitHubRunReportUrl(input.apiBaseUrl, run.run.id) : undefined,
  };
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}

function normalizeWebhookPath(pathname: string | undefined): string {
  const trimmed = pathname?.trim() || "/github/webhook";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export async function handleGitHubWebhookHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: GitHubWebhookAppDeps,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const webhookPath = normalizeWebhookPath(deps.config.webhookPath);

  if (request.method !== "POST" || requestUrl.pathname !== webhookPath) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  const rawBody = await readRawBody(request);
  let payload: GitHubIssueCommentCommandEvent;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as GitHubIssueCommentCommandEvent;
  } catch {
    sendJson(response, 400, { error: "invalid_json" });
    return;
  }

  const command = handleGitHubWebhookCommand({
    eventName: String(request.headers["x-github-event"] ?? ""),
    signatureHeader: typeof request.headers["x-hub-signature-256"] === "string" ? request.headers["x-hub-signature-256"] : undefined,
    secret: deps.config.webhookSecret,
    rawBody,
    payload,
  });

  if (!command.accepted) {
    const statusCode = command.reason === "invalid_signature" ? 401 : 202;
    sendJson(response, statusCode, { accepted: false, reason: command.reason });
    return;
  }

  try {
    const projectId = resolveGitHubProjectId(deps.config, command.repositoryFullName);
    if (!projectId) {
      sendJson(response, 202, { accepted: false, reason: "unsupported_repository" });
      return;
    }
    if (!isGitHubActorAuthorized(deps.config, command.senderLogin)) {
      sendJson(response, 202, { accepted: false, reason: "unauthorized_actor" });
      return;
    }

    const outcome = await executeGitHubRunCommand({
      projectId,
      context: command,
      specRail: deps.specRail,
      apiBaseUrl: deps.config.apiBaseUrl,
    });
    let relay: GitHubRunEventRelayScheduleResult | undefined;
    try {
      relay = scheduleGitHubRunTerminalOutcomeRelay({
        enabled: deps.config.followTerminalEvents,
        scheduler: deps.scheduler ?? defaultGitHubBackgroundTaskScheduler,
        specRail: deps.specRail,
        github: deps.github,
        repositoryFullName: command.repositoryFullName,
        issueNumber: command.issueNumber,
        runId: outcome.runId,
        reportUrl: outcome.reportUrl,
        onError: (error) => console.error("GitHub terminal outcome relay failed", error),
      });
    } catch (error) {
      sendJson(response, 502, { error: "github_relay_enqueue_failed", message: error instanceof Error ? error.message : String(error), outcome });
      return;
    }
    sendJson(response, 202, relay?.scheduled ? { accepted: true, outcome, relay } : { accepted: true, outcome });
  } catch (error) {
    sendJson(response, 502, { error: "specrail_request_failed", message: error instanceof Error ? error.message : String(error) });
  }
}

export function createGitHubWebhookHttpServer(deps: GitHubWebhookAppDeps): http.Server {
  return http.createServer((request, response) => {
    handleGitHubWebhookHttpRequest(request, response, deps).catch((error: unknown) => {
      sendJson(response, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
    });
  });
}

export function handleGitHubWebhookCommand(input: {
  eventName: string;
  signatureHeader?: string;
  secret: string;
  rawBody: string | Buffer;
  payload: GitHubIssueCommentCommandEvent;
}): GitHubWebhookCommandResult {
  if (!verifyGitHubSignature256({ secret: input.secret, payload: input.rawBody, signatureHeader: input.signatureHeader })) {
    return { accepted: false, reason: "invalid_signature" };
  }

  if (input.eventName !== "issue_comment") {
    return { accepted: false, reason: "unsupported_event" };
  }

  if (input.payload.action !== "created") {
    return { accepted: false, reason: "unsupported_action" };
  }

  const command = parseSpecRailIssueCommentCommand(input.payload.comment?.body ?? "");
  if (!command) {
    return { accepted: false, reason: "unsupported_command" };
  }

  const repositoryFullName = input.payload.repository?.full_name;
  const issueNumber = input.payload.issue?.number;
  if (!repositoryFullName || !issueNumber) {
    return { accepted: false, reason: "missing_context" };
  }

  return {
    accepted: true,
    command,
    repositoryFullName,
    issueNumber,
    issueTitle: input.payload.issue?.title,
    senderLogin: input.payload.sender?.login,
    senderId: input.payload.sender?.id,
    isPullRequest: input.payload.issue?.pull_request !== undefined,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGitHubWebhookApp();
}
