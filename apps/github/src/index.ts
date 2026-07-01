import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import type { QueryResultRow } from "pg";

export const SPEC_RAIL_RUN_COMMAND = "/specrail run";

export interface GitHubRunCommand {
  kind: "run";
  prompt?: string;
}

export interface GitHubAppConfig {
  apiBaseUrl: string;
  operatorBaseUrl?: string;
  port: number;
  webhookPath: string;
  webhookSecret: string;
  projectId: string;
  githubApiBaseUrl: string;
  githubToken?: string;
  githubAppId?: string;
  githubInstallationId?: string;
  githubPrivateKey?: string;
  followTerminalEvents: boolean;
  githubRelayQueueBackend?: GitHubRelayQueueBackend;
  githubRelayQueuePath?: string;
  githubRelayQueueDir?: string;
  githubRelayQueuePostgresUrl?: string;
  githubRelayQueuePostgresTable?: string;
  githubRelayQueueRunningLeaseMs?: number;
  repositoryProjects: Record<string, string>;
  allowedActors: string[];
  allowedOrganizations: string[];
  allowedTeams: string[];
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
  status?: GitHubRunOutcomeStatus;
  payload?: { status?: string };
}

export interface GitHubRunCommandOutcome {
  bindingCreated: boolean;
  bindingId?: string;
  trackId: string;
  planningSessionId?: string;
  runId: string;
  reportUrl?: string;
  operatorUrl?: string;
}

export type GitHubRunOutcomeStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export interface GitHubIssueCommentPort {
  createIssueComment(input: { repositoryFullName: string; issueNumber: number; body: string }): Promise<{ id?: string | number; url?: string }>;
}

export interface GitHubAuthorizationPort {
  isOrganizationMember(input: { organization: string; username: string }): Promise<boolean>;
  isTeamMember(input: { organization: string; teamSlug: string; username: string }): Promise<boolean>;
}

export interface GitHubTokenProvider {
  getToken(): Promise<string>;
}

export interface GitHubBackgroundTaskScheduler {
  schedule(task: () => Promise<void>): void;
}

export interface GitHubDiagnosticLogger {
  log(input: {
    code: "unsupported_repository" | "unauthorized_actor" | "github_authorization_failed";
    repositoryFullName: string;
    issueNumber: number;
    senderLogin?: string;
    message?: string;
  }): void;
}

export type GitHubCommandMetricReason =
  | "accepted"
  | "unsupported_repository"
  | "unauthorized_actor"
  | "github_authorization_failed"
  | "specrail_request_failed"
  | "github_relay_enqueue_failed";

export interface GitHubCommandMetricsSink {
  increment(input: { reason: GitHubCommandMetricReason }): void;
}

export interface GitHubWebhookAppDeps {
  config: GitHubAppConfig;
  specRail: GitHubSpecRailPort;
  github?: GitHubIssueCommentPort;
  authorization?: GitHubAuthorizationPort;
  diagnostics?: GitHubDiagnosticLogger;
  metrics?: GitHubCommandMetricsSink;
  scheduler?: GitHubBackgroundTaskScheduler;
  relayQueue?: GitHubRelayJobQueue;
}

export interface GitHubTerminalRelayJob {
  id: string;
  repositoryFullName: string;
  issueNumber: number;
  runId: string;
  reportUrl?: string;
  operatorUrl?: string;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  lastError?: string;
}

export type GitHubRelayQueueBackend = "none" | "directory" | "json-file" | "postgres";

export interface GitHubRelayJobQueue {
  enqueue(input: { repositoryFullName: string; issueNumber: number; runId: string; reportUrl?: string; operatorUrl?: string }): Promise<GitHubTerminalRelayJob>;
  claimNext(now?: Date): Promise<GitHubTerminalRelayJob | undefined>;
  complete(jobId: string, now?: Date): Promise<void>;
  fail(jobId: string, error: unknown, now?: Date): Promise<void>;
  list(): Promise<GitHubTerminalRelayJob[]>;
}

export interface GitHubRelayPostgresQueryClient {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface GitHubTerminalOutcomeCommentInput {
  repositoryFullName: string;
  issueNumber: number;
  runId: string;
  status: GitHubRunOutcomeStatus;
  reportUrl?: string;
  operatorUrl?: string;
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

function readOptionalEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function parseGitHubRelayQueueBackend(value: string | undefined): GitHubRelayQueueBackend | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/_/gu, "-");
  if (normalized === "none" || normalized === "directory" || normalized === "json-file" || normalized === "postgres") {
    return normalized;
  }
  throw new Error(`invalid GITHUB_RELAY_QUEUE_BACKEND: ${value}`);
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return parsed;
}

function parsePort(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return parsed;
}

function normalizePrivateKey(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value.replace(/\\n/g, "\n");
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

function parseAllowedTeam(value: string): { organization: string; teamSlug: string } {
  const [organization, teamSlug] = value.split("/").map((part) => part.trim());
  if (!organization || !teamSlug) {
    throw new Error(`invalid GITHUB_ALLOWED_TEAMS entry: ${value}`);
  }
  return { organization, teamSlug };
}

export async function authorizeGitHubActor(input: {
  config: Pick<GitHubAppConfig, "allowedActors" | "allowedOrganizations" | "allowedTeams">;
  senderLogin?: string;
  authorization?: GitHubAuthorizationPort;
}): Promise<boolean> {
  const hasActorPolicy = input.config.allowedActors.length > 0;
  const hasMembershipPolicy = input.config.allowedOrganizations.length > 0 || input.config.allowedTeams.length > 0;
  if (!hasActorPolicy && !hasMembershipPolicy) {
    return true;
  }
  if (hasActorPolicy && isGitHubActorAuthorized({ allowedActors: input.config.allowedActors }, input.senderLogin)) {
    return true;
  }
  if (!hasMembershipPolicy || !input.senderLogin || !input.authorization) {
    return false;
  }

  for (const organization of input.config.allowedOrganizations) {
    if (await input.authorization.isOrganizationMember({ organization, username: input.senderLogin })) {
      return true;
    }
  }
  for (const team of input.config.allowedTeams) {
    if (await input.authorization.isTeamMember({ ...parseAllowedTeam(team), username: input.senderLogin })) {
      return true;
    }
  }
  return false;
}

export function loadGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig {
  return {
    apiBaseUrl: readOptionalEnvValue(env.SPECRAIL_API_BASE_URL) ?? "http://127.0.0.1:4000",
    operatorBaseUrl: readOptionalEnvValue(env.SPECRAIL_OPERATOR_BASE_URL),
    port: parsePort(env.GITHUB_APP_PORT, 4200, "GITHUB_APP_PORT"),
    webhookPath: normalizeWebhookPath(env.GITHUB_WEBHOOK_PATH),
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
    projectId: readOptionalEnvValue(env.SPECRAIL_GITHUB_PROJECT_ID) ?? readOptionalEnvValue(env.SPECRAIL_PROJECT_ID) ?? "project-default",
    githubApiBaseUrl: readOptionalEnvValue(env.GITHUB_API_BASE_URL) ?? "https://api.github.com",
    githubToken: env.GITHUB_TOKEN ?? env.GITHUB_INSTALLATION_TOKEN,
    githubAppId: env.GITHUB_APP_ID,
    githubInstallationId: env.GITHUB_INSTALLATION_ID,
    githubPrivateKey: normalizePrivateKey(env.GITHUB_PRIVATE_KEY),
    followTerminalEvents: env.GITHUB_FOLLOW_TERMINAL_EVENTS === "true",
    githubRelayQueueBackend: parseGitHubRelayQueueBackend(env.GITHUB_RELAY_QUEUE_BACKEND),
    githubRelayQueuePath: env.GITHUB_RELAY_QUEUE_PATH,
    githubRelayQueueDir: env.GITHUB_RELAY_QUEUE_DIR,
    githubRelayQueuePostgresUrl: env.GITHUB_RELAY_QUEUE_POSTGRES_URL ?? env.DATABASE_URL,
    githubRelayQueuePostgresTable: env.GITHUB_RELAY_QUEUE_POSTGRES_TABLE,
    githubRelayQueueRunningLeaseMs: parseOptionalPositiveInteger(env.GITHUB_RELAY_QUEUE_RUNNING_LEASE_MS, "GITHUB_RELAY_QUEUE_RUNNING_LEASE_MS"),
    repositoryProjects: parseRepositoryProjectMap(env.SPECRAIL_GITHUB_REPOSITORY_PROJECTS),
    allowedActors: parseCsvList(env.GITHUB_ALLOWED_ACTORS),
    allowedOrganizations: parseCsvList(env.GITHUB_ALLOWED_ORGS),
    allowedTeams: parseCsvList(env.GITHUB_ALLOWED_TEAMS),
  };
}

type FetchLike = typeof fetch;

function encodeGitHubPathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

async function githubJsonRequest<T>(baseUrl: string, path: string, init: RequestInit = {}, fetchFn: FetchLike = fetch): Promise<T> {
  const response = await fetchFn(resolveGitHubApiUrl(baseUrl, path), {
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

function resolveGitHubApiUrl(baseUrl: string, pathname: string): URL {
  const relativePath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath, normalizedBaseUrl);
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createStaticGitHubTokenProvider(token: string): GitHubTokenProvider {
  return {
    async getToken() {
      return token;
    },
  };
}

export function createGitHubAppJwt(input: { appId: string; privateKey: string; now?: () => number }): string {
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: input.appId });
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(input.privateKey).toString("base64url")}`;
}

export function createGitHubAppInstallationTokenProvider(input: {
  appId: string;
  installationId: string;
  privateKey: string;
  apiBaseUrl?: string;
  fetchFn?: FetchLike;
  now?: () => number;
}): GitHubTokenProvider {
  const apiBaseUrl = input.apiBaseUrl ?? "https://api.github.com";
  const fetchFn = input.fetchFn ?? fetch;
  const now = input.now ?? Date.now;
  let cached: { token: string; expiresAtMs: number } | undefined;

  return {
    async getToken() {
      if (cached && now() < cached.expiresAtMs - 60_000) {
        return cached.token;
      }

      const jwt = createGitHubAppJwt({ appId: input.appId, privateKey: input.privateKey, now });
      const response = await githubJsonRequest<{ token: string; expires_at: string }>(
        apiBaseUrl,
        `/app/installations/${encodeGitHubPathSegment(input.installationId)}/access_tokens`,
        { method: "POST", headers: { authorization: `Bearer ${jwt}` } },
        fetchFn,
      );
      cached = { token: response.token, expiresAtMs: Date.parse(response.expires_at) };
      return cached.token;
    },
  };
}

function createGitHubTokenProviderFromConfig(config: GitHubAppConfig): GitHubTokenProvider | undefined {
  if (config.githubAppId && config.githubInstallationId && config.githubPrivateKey) {
    return createGitHubAppInstallationTokenProvider({
      appId: config.githubAppId,
      installationId: config.githubInstallationId,
      privateKey: config.githubPrivateKey,
      apiBaseUrl: config.githubApiBaseUrl,
    });
  }
  return config.githubToken ? createStaticGitHubTokenProvider(config.githubToken) : undefined;
}

export function createGitHubRestIssueCommentClient(input: { token?: string; tokenProvider?: GitHubTokenProvider; apiBaseUrl?: string; fetchFn?: FetchLike }): GitHubIssueCommentPort {
  const apiBaseUrl = input.apiBaseUrl ?? "https://api.github.com";
  const tokenProvider = input.tokenProvider ?? (input.token ? createStaticGitHubTokenProvider(input.token) : undefined);
  if (!tokenProvider) {
    throw new Error("GitHub issue comment client requires a token or token provider");
  }
  return {
    async createIssueComment(commentInput) {
      const [owner, repo] = commentInput.repositoryFullName.split("/");
      if (!owner || !repo) {
        throw new Error(`invalid GitHub repository full name: ${commentInput.repositoryFullName}`);
      }

      const token = await tokenProvider.getToken();
      return githubJsonRequest(apiBaseUrl, `/repos/${encodeGitHubPathSegment(owner)}/${encodeGitHubPathSegment(repo)}/issues/${commentInput.issueNumber}/comments`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ body: commentInput.body }),
      }, input.fetchFn);
    },
  };
}

export function createGitHubRestAuthorizationClient(input: { token?: string; tokenProvider?: GitHubTokenProvider; apiBaseUrl?: string; fetchFn?: FetchLike }): GitHubAuthorizationPort {
  const apiBaseUrl = input.apiBaseUrl ?? "https://api.github.com";
  const tokenProvider = input.tokenProvider ?? (input.token ? createStaticGitHubTokenProvider(input.token) : undefined);
  if (!tokenProvider) {
    throw new Error("GitHub authorization client requires a token or token provider");
  }
  const provider = tokenProvider;
  async function request(pathname: string): Promise<boolean> {
    const token = await provider.getToken();
    const response = await (input.fetchFn ?? fetch)(resolveGitHubApiUrl(apiBaseUrl, pathname), {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.status === 204) {
      return true;
    }
    if (response.status === 404) {
      return false;
    }
    const responseText = await response.text();
    const bodySuffix = responseText ? `: ${responseText}` : "";
    throw new Error(`GitHub API GET ${pathname} failed with ${response.status}${bodySuffix}`);
  }
  return {
    isOrganizationMember(input) {
      return request(`/orgs/${encodeGitHubPathSegment(input.organization)}/members/${encodeGitHubPathSegment(input.username)}`);
    },
    isTeamMember(input) {
      return request(
        `/orgs/${encodeGitHubPathSegment(input.organization)}/teams/${encodeGitHubPathSegment(input.teamSlug)}/memberships/${encodeGitHubPathSegment(input.username)}`,
      );
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
  const response = await fetch(resolveSpecRailApiUrl(baseUrl, path), {
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

function resolveSpecRailApiUrl(baseUrl: string, pathname: string): URL {
  const relativePath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath, normalizedBaseUrl);
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
      const response = await fetch(resolveSpecRailApiUrl(apiBaseUrl, path), { headers: { accept: "text/event-stream" } });
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

export const defaultGitHubDiagnosticLogger: GitHubDiagnosticLogger = {
  log(input) {
    console.warn("GitHub /specrail command diagnostic", JSON.stringify(input));
  },
};

export const defaultGitHubCommandMetricsSink: GitHubCommandMetricsSink = {
  increment() {
    // Default local/dev sink is intentionally quiet; deployments can inject metrics exporters.
  },
};

export function resolveGitHubRelayQueueBackend(
  config: Pick<GitHubAppConfig, "githubRelayQueueBackend" | "githubRelayQueueDir" | "githubRelayQueuePath" | "githubRelayQueuePostgresUrl">,
): GitHubRelayQueueBackend {
  if (config.githubRelayQueueBackend) {
    return config.githubRelayQueueBackend;
  }
  if (config.githubRelayQueueDir) {
    return "directory";
  }
  if (config.githubRelayQueuePostgresUrl) {
    return "postgres";
  }
  if (config.githubRelayQueuePath) {
    return "json-file";
  }
  return "none";
}

export function createGitHubRelayJobQueueFromConfig(
  config: Pick<
    GitHubAppConfig,
    "githubRelayQueueBackend" | "githubRelayQueueDir" | "githubRelayQueuePath" | "githubRelayQueuePostgresUrl" | "githubRelayQueuePostgresTable" | "githubRelayQueueRunningLeaseMs"
  >,
): GitHubRelayJobQueue | undefined {
  const backend = resolveGitHubRelayQueueBackend(config);
  if (backend === "none") {
    return undefined;
  }
  if (backend === "directory") {
    if (!config.githubRelayQueueDir) {
      throw new Error("GITHUB_RELAY_QUEUE_DIR is required when GITHUB_RELAY_QUEUE_BACKEND=directory");
    }
    return new DirectoryGitHubRelayJobQueue(config.githubRelayQueueDir);
  }
  if (backend === "postgres") {
    if (!config.githubRelayQueuePostgresUrl) {
      throw new Error("GITHUB_RELAY_QUEUE_POSTGRES_URL or DATABASE_URL is required when GITHUB_RELAY_QUEUE_BACKEND=postgres");
    }
    const { Pool } = pg;
    return new PostgresGitHubRelayJobQueue({
      client: new Pool({ connectionString: config.githubRelayQueuePostgresUrl }),
      tableName: config.githubRelayQueuePostgresTable,
      runningLeaseMs: config.githubRelayQueueRunningLeaseMs,
    });
  }
  if (!config.githubRelayQueuePath) {
    throw new Error("GITHUB_RELAY_QUEUE_PATH is required when GITHUB_RELAY_QUEUE_BACKEND=json-file");
  }
  return new JsonFileGitHubRelayJobQueue(config.githubRelayQueuePath);
}

export function startGitHubWebhookApp(input: { config?: GitHubAppConfig; specRail?: GitHubSpecRailPort; github?: GitHubIssueCommentPort } = {}): http.Server {
  const config = input.config ?? loadGitHubAppConfig();
  const specRail = input.specRail ?? createSpecRailHttpClient(config.apiBaseUrl);
  const tokenProvider = createGitHubTokenProviderFromConfig(config);
  const github = input.github ?? (tokenProvider ? createGitHubRestIssueCommentClient({ tokenProvider, apiBaseUrl: config.githubApiBaseUrl }) : undefined);
  const authorization = tokenProvider ? createGitHubRestAuthorizationClient({ tokenProvider, apiBaseUrl: config.githubApiBaseUrl }) : undefined;
  const relayQueue = createGitHubRelayJobQueueFromConfig(config);
  const server = createGitHubWebhookHttpServer({
    config,
    specRail,
    github,
    authorization,
    diagnostics: defaultGitHubDiagnosticLogger,
    metrics: defaultGitHubCommandMetricsSink,
    scheduler: defaultGitHubBackgroundTaskScheduler,
    relayQueue,
  });
  if (relayQueue && github) {
    const interval = setInterval(() => {
      processGitHubRelayQueue({ queue: relayQueue, specRail, github }).catch((error: unknown) => {
        console.error("GitHub terminal outcome relay failed", error);
      });
    }, 5_000);
    server.on("close", () => clearInterval(interval));
  }
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
  return resolveSpecRailApiUrl(apiBaseUrl, `/runs/${encodeURIComponent(runId)}/report.md`).toString();
}

export function buildGitHubOperatorRunUrl(operatorBaseUrl: string, runId: string): string {
  const url = resolveSpecRailApiUrl(operatorBaseUrl, "/operator");
  url.searchParams.set("runId", runId);
  return url.toString();
}

function isTerminalGitHubRunStatus(status: GitHubRunOutcomeStatus): status is "completed" | "failed" | "cancelled" {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function getTerminalStatusFromRunEvent(event: GitHubRunEvent): "completed" | "failed" | "cancelled" | undefined {
  if (event.status === "completed" || event.status === "failed" || event.status === "cancelled") {
    return event.status;
  }

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
  if (input.operatorUrl) {
    lines.push(`Operator: ${input.operatorUrl}`);
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
  operatorUrl?: string;
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
        operatorUrl: input.operatorUrl,
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
  operatorUrl?: string;
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
        operatorUrl: input.operatorUrl,
      },
    });

    if (!result.posted) {
      return { posted: false, reason: "no_terminal_event" };
    }
    return { posted: true, status, body: result.body, comment: result.comment };
  }

  return { posted: false, reason: "no_terminal_event" };
}

function createRelayJobId(input: { repositoryFullName: string; issueNumber: number; runId: string }, now: Date): string {
  return Buffer.from(`${input.repositoryFullName}#${input.issueNumber}:${input.runId}:${now.toISOString()}`).toString("base64url");
}

export class JsonFileGitHubRelayJobQueue implements GitHubRelayJobQueue {
  constructor(private readonly filePath: string) {}

  async enqueue(input: { repositoryFullName: string; issueNumber: number; runId: string; reportUrl?: string; operatorUrl?: string }): Promise<GitHubTerminalRelayJob> {
    const now = new Date();
    const jobs = await this.readJobs();
    const job: GitHubTerminalRelayJob = {
      id: createRelayJobId(input, now),
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.issueNumber,
      runId: input.runId,
      ...(input.reportUrl ? { reportUrl: input.reportUrl } : {}),
      ...(input.operatorUrl ? { operatorUrl: input.operatorUrl } : {}),
      status: "pending",
      attempts: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextAttemptAt: now.toISOString(),
    };
    jobs.push(job);
    await this.writeJobs(jobs);
    return job;
  }

  async claimNext(now: Date = new Date()): Promise<GitHubTerminalRelayJob | undefined> {
    const jobs = await this.readJobs();
    const job = jobs.find((candidate) => candidate.status === "pending" && (!candidate.nextAttemptAt || Date.parse(candidate.nextAttemptAt) <= now.getTime()));
    if (!job) {
      return undefined;
    }
    job.status = "running";
    job.updatedAt = now.toISOString();
    await this.writeJobs(jobs);
    return { ...job };
  }

  async complete(jobId: string, now: Date = new Date()): Promise<void> {
    await this.updateJob(jobId, (job) => {
      job.status = "completed";
      job.updatedAt = now.toISOString();
    });
  }

  async fail(jobId: string, error: unknown, now: Date = new Date()): Promise<void> {
    await this.updateJob(jobId, (job) => {
      job.attempts += 1;
      job.status = job.attempts >= 3 ? "failed" : "pending";
      job.updatedAt = now.toISOString();
      job.lastError = error instanceof Error ? error.message : String(error);
      job.nextAttemptAt = new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** job.attempts)).toISOString();
    });
  }

  async list(): Promise<GitHubTerminalRelayJob[]> {
    return this.readJobs();
  }

  private async updateJob(jobId: string, update: (job: GitHubTerminalRelayJob) => void): Promise<void> {
    const jobs = await this.readJobs();
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      throw new Error(`GitHub relay job not found: ${jobId}`);
    }
    update(job);
    await this.writeJobs(jobs);
  }

  private async readJobs(): Promise<GitHubTerminalRelayJob[]> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as GitHubTerminalRelayJob[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async writeJobs(jobs: GitHubTerminalRelayJob[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  }
}


const directoryRelayStatuses = ["pending", "running", "completed", "failed"] as const satisfies readonly GitHubTerminalRelayJob["status"][];

type DirectoryRelayStatus = (typeof directoryRelayStatuses)[number];

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function relayJobFileName(jobId: string): string {
  return `${jobId}.json`;
}

function parseRelayJobFileName(fileName: string): string | undefined {
  return fileName.endsWith(".json") ? fileName.slice(0, -".json".length) : undefined;
}

export class DirectoryGitHubRelayJobQueue implements GitHubRelayJobQueue {
  constructor(private readonly directoryPath: string) {}

  async enqueue(input: { repositoryFullName: string; issueNumber: number; runId: string; reportUrl?: string; operatorUrl?: string }): Promise<GitHubTerminalRelayJob> {
    const now = new Date();
    const job: GitHubTerminalRelayJob = {
      id: createRelayJobId(input, now),
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.issueNumber,
      runId: input.runId,
      ...(input.reportUrl ? { reportUrl: input.reportUrl } : {}),
      ...(input.operatorUrl ? { operatorUrl: input.operatorUrl } : {}),
      status: "pending",
      attempts: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextAttemptAt: now.toISOString(),
    };
    await this.writeJob("pending", job);
    return job;
  }

  async claimNext(now: Date = new Date()): Promise<GitHubTerminalRelayJob | undefined> {
    const pendingJobs = (await this.readJobsByStatus("pending"))
      .filter((job) => !job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now.getTime())
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

    for (const pendingJob of pendingJobs) {
      const claimedJob: GitHubTerminalRelayJob = {
        ...pendingJob,
        status: "running",
        updatedAt: now.toISOString(),
      };
      try {
        await this.moveJobFile("pending", "running", claimedJob);
        return claimedJob;
      } catch (error) {
        if (isMissingFileError(error)) {
          continue;
        }
        throw error;
      }
    }
    return undefined;
  }

  async complete(jobId: string, now: Date = new Date()): Promise<void> {
    const job = await this.readJob("running", jobId);
    await this.moveJobFile("running", "completed", {
      ...job,
      status: "completed",
      updatedAt: now.toISOString(),
    });
  }

  async fail(jobId: string, error: unknown, now: Date = new Date()): Promise<void> {
    const job = await this.readJob("running", jobId);
    const attempts = job.attempts + 1;
    const failedJob: GitHubTerminalRelayJob = {
      ...job,
      attempts,
      status: attempts >= 3 ? "failed" : "pending",
      updatedAt: now.toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
      nextAttemptAt: new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** attempts)).toISOString(),
    };
    await this.moveJobFile("running", failedJob.status, failedJob);
  }

  async list(): Promise<GitHubTerminalRelayJob[]> {
    const groups = await Promise.all(directoryRelayStatuses.map((status) => this.readJobsByStatus(status)));
    return groups.flat().sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  private statusDirectory(status: DirectoryRelayStatus): string {
    return path.join(this.directoryPath, status);
  }

  private jobPath(status: DirectoryRelayStatus, jobId: string): string {
    return path.join(this.statusDirectory(status), relayJobFileName(jobId));
  }

  private async readJob(status: DirectoryRelayStatus, jobId: string): Promise<GitHubTerminalRelayJob> {
    try {
      return JSON.parse(await readFile(this.jobPath(status, jobId), "utf8")) as GitHubTerminalRelayJob;
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new Error(`GitHub relay job not found: ${jobId}`);
      }
      throw error;
    }
  }

  private async readJobsByStatus(status: DirectoryRelayStatus): Promise<GitHubTerminalRelayJob[]> {
    let files: string[];
    try {
      files = await readdir(this.statusDirectory(status));
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }

    const jobs = await Promise.all(
      files.map(async (fileName) => {
        const jobId = parseRelayJobFileName(fileName);
        if (!jobId) {
          return undefined;
        }
        try {
          return await this.readJob(status, jobId);
        } catch (error) {
          if (error instanceof Error && error.message === `GitHub relay job not found: ${jobId}`) {
            return undefined;
          }
          throw error;
        }
      }),
    );
    return jobs.filter((job): job is GitHubTerminalRelayJob => Boolean(job));
  }

  private async writeJob(status: DirectoryRelayStatus, job: GitHubTerminalRelayJob): Promise<void> {
    await mkdir(this.statusDirectory(status), { recursive: true });
    const destination = this.jobPath(status, job.id);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  }

  private async moveJobFile(from: DirectoryRelayStatus, to: DirectoryRelayStatus, job: GitHubTerminalRelayJob): Promise<void> {
    await mkdir(this.statusDirectory(to), { recursive: true });
    const fromPath = this.jobPath(from, job.id);
    const toPath = this.jobPath(to, job.id);
    await rename(fromPath, toPath);
    const temporary = `${toPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    await rename(temporary, toPath);
  }
}

interface PostgresRelayJobRow extends QueryResultRow {
  id: string;
  repository_full_name: string;
  issue_number: number;
  run_id: string;
  report_url: string | null;
  operator_url: string | null;
  status: GitHubTerminalRelayJob["status"];
  attempts: number;
  created_at: Date | string;
  updated_at: Date | string;
  next_attempt_at: Date | string | null;
  last_error: string | null;
}

export interface PostgresGitHubRelayJobQueueOptions {
  client: GitHubRelayPostgresQueryClient;
  tableName?: string;
  runningLeaseMs?: number;
}

const defaultPostgresRelayRunningLeaseMs = 5 * 60 * 1000;

function assertSafePostgresIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`invalid PostgreSQL relay queue table name: ${identifier}`);
  }
  return identifier;
}

function postgresDate(value: Date | string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function postgresRelayJobFromRow(row: PostgresRelayJobRow): GitHubTerminalRelayJob {
  return {
    id: row.id,
    repositoryFullName: row.repository_full_name,
    issueNumber: row.issue_number,
    runId: row.run_id,
    ...(row.report_url ? { reportUrl: row.report_url } : {}),
    ...(row.operator_url ? { operatorUrl: row.operator_url } : {}),
    status: row.status,
    attempts: row.attempts,
    createdAt: postgresDate(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: postgresDate(row.updated_at) ?? new Date(0).toISOString(),
    ...(postgresDate(row.next_attempt_at) ? { nextAttemptAt: postgresDate(row.next_attempt_at) } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

const postgresRelayJobSelectColumns = [
  "id",
  "repository_full_name",
  "issue_number",
  "run_id",
  "report_url",
  "operator_url",
  "status",
  "attempts",
  "created_at",
  "updated_at",
  "next_attempt_at",
  "last_error",
].join(", ");

function postgresRelayJobReturningColumns(tableName: string): string {
  return [
    "id",
    "repository_full_name",
    "issue_number",
    "run_id",
    "report_url",
    "operator_url",
    "status",
    "attempts",
    "created_at",
    "updated_at",
    "next_attempt_at",
    "last_error",
  ]
    .map((column) => `${tableName}.${column}`)
    .join(", ");
}

export class PostgresGitHubRelayJobQueue implements GitHubRelayJobQueue {
  private readonly tableName: string;

  constructor(private readonly options: PostgresGitHubRelayJobQueueOptions) {
    this.tableName = assertSafePostgresIdentifier(options.tableName ?? "github_relay_jobs");
  }

  async enqueue(input: { repositoryFullName: string; issueNumber: number; runId: string; reportUrl?: string; operatorUrl?: string }): Promise<GitHubTerminalRelayJob> {
    const now = new Date();
    const job: GitHubTerminalRelayJob = {
      id: createRelayJobId(input, now),
      repositoryFullName: input.repositoryFullName,
      issueNumber: input.issueNumber,
      runId: input.runId,
      ...(input.reportUrl ? { reportUrl: input.reportUrl } : {}),
      ...(input.operatorUrl ? { operatorUrl: input.operatorUrl } : {}),
      status: "pending",
      attempts: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextAttemptAt: now.toISOString(),
    };

    const result = await this.options.client.query<PostgresRelayJobRow>(
      `/* specrail:postgres-relay-enqueue */
      INSERT INTO ${this.tableName} (
        id, repository_full_name, issue_number, run_id, report_url, operator_url,
        status, attempts, created_at, updated_at, next_attempt_at, last_error
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0, $7, $7, $7, NULL)
      RETURNING ${postgresRelayJobSelectColumns}`,
      [job.id, job.repositoryFullName, job.issueNumber, job.runId, job.reportUrl ?? null, job.operatorUrl ?? null, job.createdAt],
    );
    return postgresRelayJobFromRow(this.requireSingleRow(result.rows, job.id));
  }

  async claimNext(now: Date = new Date()): Promise<GitHubTerminalRelayJob | undefined> {
    const staleRunningBefore = new Date(now.getTime() - (this.options.runningLeaseMs ?? defaultPostgresRelayRunningLeaseMs));
    const result = await this.options.client.query<PostgresRelayJobRow>(
      `/* specrail:postgres-relay-claim-next */
      WITH next_job AS (
        SELECT id
        FROM ${this.tableName}
        WHERE (
          status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
        ) OR (
          status = 'running'
          AND updated_at <= $2
        )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE ${this.tableName}
      SET status = 'running', updated_at = $1
      FROM next_job
      WHERE ${this.tableName}.id = next_job.id
      RETURNING ${postgresRelayJobReturningColumns(this.tableName)}`,
      [now.toISOString(), staleRunningBefore.toISOString()],
    );
    return result.rows[0] ? postgresRelayJobFromRow(result.rows[0]) : undefined;
  }

  async complete(jobId: string, now: Date = new Date()): Promise<void> {
    const result = await this.options.client.query<PostgresRelayJobRow>(
      `/* specrail:postgres-relay-complete */
      UPDATE ${this.tableName}
      SET status = 'completed', updated_at = $2
      WHERE id = $1 AND status = 'running'
      RETURNING ${postgresRelayJobReturningColumns(this.tableName)}`,
      [jobId, now.toISOString()],
    );
    this.requireSingleRow(result.rows, jobId);
  }

  async fail(jobId: string, error: unknown, now: Date = new Date()): Promise<void> {
    const lastError = error instanceof Error ? error.message : String(error);
    const result = await this.options.client.query<PostgresRelayJobRow>(
      `/* specrail:postgres-relay-fail */
      UPDATE ${this.tableName}
      SET
        attempts = attempts + 1,
        status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
        updated_at = $2,
        last_error = $3,
        next_attempt_at = $2::timestamptz + (LEAST(60000, (1000 * POWER(2, attempts + 1))::int) * INTERVAL '1 millisecond')
      WHERE id = $1 AND status = 'running'
      RETURNING ${postgresRelayJobReturningColumns(this.tableName)}`,
      [jobId, now.toISOString(), lastError],
    );
    this.requireSingleRow(result.rows, jobId);
  }

  async list(): Promise<GitHubTerminalRelayJob[]> {
    const result = await this.options.client.query<PostgresRelayJobRow>(
      `/* specrail:postgres-relay-list */
      SELECT ${postgresRelayJobSelectColumns}
      FROM ${this.tableName}
      ORDER BY created_at ASC`,
    );
    return result.rows.map(postgresRelayJobFromRow);
  }

  private requireSingleRow(rows: PostgresRelayJobRow[], jobId: string): PostgresRelayJobRow {
    const row = rows[0];
    if (!row) {
      throw new Error(`GitHub relay job not found: ${jobId}`);
    }
    return row;
  }
}

export async function processGitHubRelayQueue(input: {
  queue: GitHubRelayJobQueue;
  specRail: Pick<GitHubSpecRailPort, "streamRunEvents">;
  github: GitHubIssueCommentPort;
  now?: Date;
}): Promise<{ processed: boolean; jobId?: string; result?: GitHubRunEventRelayResult }> {
  const job = await input.queue.claimNext(input.now);
  if (!job) {
    return { processed: false };
  }

  try {
    const result = await relayGitHubRunTerminalOutcome({
      specRail: input.specRail,
      github: input.github,
      repositoryFullName: job.repositoryFullName,
      issueNumber: job.issueNumber,
      runId: job.runId,
      reportUrl: job.reportUrl,
      operatorUrl: job.operatorUrl,
    });
    if (!result.posted) {
      throw new Error(`GitHub relay job ${job.id} did not post a terminal outcome: ${result.reason}`);
    }
    await input.queue.complete(job.id, input.now);
    return { processed: true, jobId: job.id, result };
  } catch (error) {
    await input.queue.fail(job.id, error, input.now);
    throw error;
  }
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

function logGitHubCommandDiagnostic(
  deps: GitHubWebhookAppDeps,
  command: GitHubAcceptedRunCommandContext,
  input: { code: "unsupported_repository" | "unauthorized_actor" | "github_authorization_failed"; message?: string },
): void {
  deps.diagnostics?.log({
    code: input.code,
    repositoryFullName: command.repositoryFullName,
    issueNumber: command.issueNumber,
    senderLogin: command.senderLogin,
    message: input.message,
  });
}

function incrementGitHubCommandMetric(deps: GitHubWebhookAppDeps, reason: GitHubCommandMetricReason): void {
  deps.metrics?.increment({ reason });
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

  if (request.method === "GET" && requestUrl.pathname === "/healthz") {
    sendJson(response, 200, { ok: true, service: "specrail-github" });
    return;
  }

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
      logGitHubCommandDiagnostic(deps, command, { code: "unsupported_repository" });
      incrementGitHubCommandMetric(deps, "unsupported_repository");
      sendJson(response, 202, { accepted: false, reason: "unsupported_repository" });
      return;
    }
    let authorized: boolean;
    try {
      authorized = await authorizeGitHubActor({ config: deps.config, senderLogin: command.senderLogin, authorization: deps.authorization });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logGitHubCommandDiagnostic(deps, command, { code: "github_authorization_failed", message });
      incrementGitHubCommandMetric(deps, "github_authorization_failed");
      sendJson(response, 502, { error: "github_authorization_failed", message });
      return;
    }
    if (!authorized) {
      logGitHubCommandDiagnostic(deps, command, { code: "unauthorized_actor" });
      incrementGitHubCommandMetric(deps, "unauthorized_actor");
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
    const operatorUrl = deps.config.operatorBaseUrl ? buildGitHubOperatorRunUrl(deps.config.operatorBaseUrl, outcome.runId) : undefined;
    try {
      if (deps.config.followTerminalEvents && deps.github && deps.relayQueue) {
        await deps.relayQueue.enqueue({
          repositoryFullName: command.repositoryFullName,
          issueNumber: command.issueNumber,
          runId: outcome.runId,
          reportUrl: outcome.reportUrl,
          operatorUrl,
        });
        relay = { scheduled: true };
      } else {
        relay = scheduleGitHubRunTerminalOutcomeRelay({
          enabled: deps.config.followTerminalEvents,
          scheduler: deps.scheduler ?? defaultGitHubBackgroundTaskScheduler,
          specRail: deps.specRail,
          github: deps.github,
          repositoryFullName: command.repositoryFullName,
          issueNumber: command.issueNumber,
          runId: outcome.runId,
          reportUrl: outcome.reportUrl,
          operatorUrl,
          onError: (error) => console.error("GitHub terminal outcome relay failed", error),
        });
      }
    } catch (error) {
      incrementGitHubCommandMetric(deps, "github_relay_enqueue_failed");
      sendJson(response, 502, { error: "github_relay_enqueue_failed", message: error instanceof Error ? error.message : String(error), outcome });
      return;
    }
    incrementGitHubCommandMetric(deps, "accepted");
    sendJson(response, 202, relay?.scheduled ? { accepted: true, outcome, relay } : { accepted: true, outcome });
  } catch (error) {
    incrementGitHubCommandMetric(deps, "specrail_request_failed");
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
