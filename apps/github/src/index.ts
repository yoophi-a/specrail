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
  | {
      accepted: true;
      command: GitHubRunCommand;
      repositoryFullName: string;
      issueNumber: number;
      issueTitle?: string;
      senderLogin?: string;
      senderId?: number;
      isPullRequest: boolean;
    }
  | {
      accepted: false;
      reason: "invalid_signature" | "unsupported_event" | "unsupported_action" | "unsupported_command" | "missing_context";
    };

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
