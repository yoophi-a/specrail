import { createHmac, timingSafeEqual } from "node:crypto";

export const SPEC_RAIL_RUN_COMMAND = "/specrail run";

export interface GitHubRunCommand {
  kind: "run";
  prompt?: string;
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
      reason: "invalid_signature" | "unsupported_event" | "unsupported_action" | "unsupported_command" | "missing_context";
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
}

export interface GitHubRunCommandOutcome {
  bindingCreated: boolean;
  bindingId?: string;
  trackId: string;
  planningSessionId?: string;
  runId: string;
  reportUrl?: string;
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
