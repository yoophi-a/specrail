import type { Execution, ExecutionEvent, Project, Track } from "../domain/types.js";

export interface CompletedRunReportInput {
  run: Execution;
  track: Track;
  project?: Project | null;
  events: ExecutionEvent[];
  generatedAt: string;
}

export function renderCompletedRunReport(input: CompletedRunReportInput): string {
  const { run, track, project, generatedAt } = input;
  const events = [...input.events].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const highlights = events.filter((event) =>
    ["approval_requested", "approval_resolved", "tool_call", "tool_result", "test_result", "task_status_changed", "summary"].includes(event.type),
  );

  const lines: string[] = [];

  lines.push(`# Run Report — ${run.id}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Project: ${project ? `${project.name} (${project.id})` : `unknown (${track.projectId})`}`);
  lines.push(`- Track: ${track.title} (${track.id})`);
  lines.push(`- Status: ${run.status}`);
  lines.push(`- Backend/Profile: ${run.backend} / ${run.profile}`);
  lines.push(`- Started: ${run.startedAt ?? "not started"}`);
  lines.push(`- Finished: ${run.finishedAt ?? "not finished"}`);
  lines.push(`- Event count: ${run.summary?.eventCount ?? events.length}`);
  lines.push(`- Last event: ${run.summary?.lastEventSummary ?? "none"}${run.summary?.lastEventAt ? ` (${run.summary.lastEventAt})` : ""}`);
  lines.push("");
  lines.push("## Prompt");
  lines.push("");
  lines.push(run.command?.prompt?.trim() ? run.command.prompt : "No prompt recorded.");
  lines.push("");
  lines.push("## Planning Context");
  lines.push(`- Planning session: ${run.planningSessionId ?? "none"}`);
  lines.push(`- Spec revision: ${run.specRevisionId ?? "none"}`);
  lines.push(`- Plan revision: ${run.planRevisionId ?? "none"}`);
  lines.push(`- Tasks revision: ${run.tasksRevisionId ?? "none"}`);
  lines.push("");
  lines.push("## Timeline");
  lines.push("");
  lines.push("| Time | Type | Source | Summary |");
  lines.push("| ---- | ---- | ------ | ------- |");

  if (events.length === 0) {
    lines.push("| none | none | none | No events recorded. |");
  } else {
    for (const event of events) {
      lines.push(`| ${escapeMarkdownTableCell(event.timestamp)} | ${escapeMarkdownTableCell(event.type)} | ${escapeMarkdownTableCell(event.source)} | ${escapeMarkdownTableCell(event.summary)} |`);
    }
  }

  lines.push("");
  lines.push("## Highlights");
  lines.push("");

  if (highlights.length === 0) {
    lines.push("- No highlight events recorded.");
  } else {
    for (const event of highlights) {
      lines.push(`- ${event.timestamp} — ${event.type} — ${event.summary}`);
    }
  }

  lines.push("");
  lines.push("## Source of Truth");
  lines.push("");
  lines.push(`Generated from \`state/events/${run.id}.jsonl\` at ${generatedAt}.`);
  lines.push("This report is a derived snapshot and does not replace canonical run history.");
  lines.push("It does not mutate `spec.md`, `plan.md`, or `tasks.md`.");
  lines.push("");

  return lines.join("\n");
}

export function escapeMarkdownTableCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}
