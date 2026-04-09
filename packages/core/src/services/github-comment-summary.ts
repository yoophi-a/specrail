import type { Execution, ExecutionEvent, Track } from "../domain/types.js";

export interface FormatGitHubRunCommentInput {
  track: Pick<Track, "id" | "title" | "status" | "githubIssue" | "githubPullRequest">;
  run: Pick<
    Execution,
    | "id"
    | "status"
    | "backend"
    | "profile"
    | "branchName"
    | "workspacePath"
    | "sessionRef"
    | "summary"
    | "startedAt"
    | "finishedAt"
  >;
  events: Array<Pick<ExecutionEvent, "timestamp" | "summary" | "type">>;
  options?: {
    maxHighlights?: number;
  };
}

const STATUS_LABELS: Record<Execution["status"], string> = {
  created: "Created",
  queued: "Queued",
  running: "Running",
  waiting_approval: "Waiting for approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_EMOJI: Record<Execution["status"], string> = {
  created: "⚪",
  queued: "🟡",
  running: "🟢",
  waiting_approval: "⏸️",
  completed: "✅",
  failed: "❌",
  cancelled: "🛑",
};

function formatLink(label: string, value: { number: number; url: string } | undefined): string {
  if (!value) {
    return `- ${label}: none linked`;
  }

  return `- ${label}: [#${value.number}](${value.url})`;
}

function formatMetadataRow(label: string, value: string | number | undefined): string | null {
  if (value === undefined || value === "") {
    return null;
  }

  return `- ${label}: ${value}`;
}

function formatCode(value: string | undefined): string | undefined {
  return value ? `\`${value}\`` : undefined;
}

function formatHighlight(event: Pick<ExecutionEvent, "timestamp" | "summary" | "type">): string {
  return `- ${event.timestamp} · **${event.type}** · ${event.summary}`;
}

export function formatGitHubRunCommentSummary(input: FormatGitHubRunCommentInput): string {
  const { track, run, events, options } = input;
  const maxHighlights = options?.maxHighlights ?? 5;
  const highlights = events.slice(-maxHighlights);
  const statusLabel = `${STATUS_EMOJI[run.status]} ${STATUS_LABELS[run.status]}`;

  const sections = [
    `<!-- specrail:run-summary track=${track.id} run=${run.id} status=${run.status} -->`,
    `## SpecRail run summary`,
    "",
    `**Track:** ${track.title} (${formatCode(track.id)})`,
    `**Run:** ${formatCode(run.id)}  `,
    `**Outcome:** ${statusLabel}`,
    "",
    "### Links",
    [formatLink("Issue", track.githubIssue), formatLink("Pull request", track.githubPullRequest)].join("\n"),
    "",
    "### Run metadata",
    [
      formatMetadataRow("Backend", formatCode(run.backend)),
      formatMetadataRow("Profile", formatCode(run.profile)),
      formatMetadataRow("Branch", formatCode(run.branchName)),
      formatMetadataRow("Session", formatCode(run.sessionRef)),
      formatMetadataRow("Workspace", formatCode(run.workspacePath)),
      formatMetadataRow("Started", run.startedAt ?? "Not started"),
      formatMetadataRow("Finished", run.finishedAt),
      formatMetadataRow("Events", run.summary?.eventCount ?? events.length),
      formatMetadataRow("Last event", run.summary?.lastEventSummary),
      formatMetadataRow("Last event at", run.summary?.lastEventAt),
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    "",
    "### Recent highlights",
    highlights.length > 0 ? highlights.map(formatHighlight).join("\n") : "- No execution events recorded",
  ];

  if (run.status === "waiting_approval") {
    sections.push("", "> Approval is currently blocking this run. Resume after the required decision is recorded.");
  }

  return `${sections.join("\n").trim()}\n`;
}
