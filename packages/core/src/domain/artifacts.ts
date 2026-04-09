import type { ApprovalStatus } from "./types.js";

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface SpecDocument {
  title: string;
  problem: string;
  goals: string[];
  nonGoals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
}

export interface PlanStep {
  title: string;
  detail: string;
}

export interface PlanDocument {
  objective: string;
  steps: PlanStep[];
  risks: string[];
  testStrategy: string[];
  approvalStatus: ApprovalStatus;
}

export interface TaskDocumentItem {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  owner?: string;
  notes?: string[];
}

export interface TaskDocument {
  trackTitle: string;
  tasks: TaskDocumentItem[];
}

function renderBulletList(items: string[], emptyMessage: string): string {
  if (items.length === 0) {
    return `- ${emptyMessage}`;
  }

  return items.map((item) => `- ${item}`).join("\n");
}

export function renderSpecDocument(document: SpecDocument): string {
  return [
    `# Spec — ${document.title}`,
    "",
    "## Problem",
    document.problem,
    "",
    "## Goals",
    renderBulletList(document.goals, "TBD"),
    "",
    "## Non-goals",
    renderBulletList(document.nonGoals, "None yet"),
    "",
    "## Constraints",
    renderBulletList(document.constraints, "None yet"),
    "",
    "## Acceptance criteria",
    renderBulletList(document.acceptanceCriteria, "TBD"),
    "",
  ].join("\n");
}

export function renderPlanDocument(document: PlanDocument): string {
  const steps =
    document.steps.length === 0
      ? "1. TBD"
      : document.steps.map((step, index) => `${index + 1}. **${step.title}** — ${step.detail}`).join("\n");

  return [
    "# Plan",
    "",
    `- Objective: ${document.objective}`,
    `- Approval status: ${document.approvalStatus}`,
    "",
    "## Steps",
    steps,
    "",
    "## Risks",
    renderBulletList(document.risks, "None yet"),
    "",
    "## Test strategy",
    renderBulletList(document.testStrategy, "TBD"),
    "",
  ].join("\n");
}

function renderTaskCheckbox(status: TaskStatus): string {
  return status === "done" ? "x" : " ";
}

export function renderTaskDocument(document: TaskDocument): string {
  const tasks =
    document.tasks.length === 0
      ? "- [ ] No tasks defined yet"
      : document.tasks
          .map((task) => {
            const metadata = [`id=${task.id}`, `status=${task.status}`, `priority=${task.priority}`];

            if (task.owner) {
              metadata.push(`owner=${task.owner}`);
            }

            const notes = task.notes?.length ? `\n  notes: ${task.notes.join(" | ")}` : "";

            return `- [${renderTaskCheckbox(task.status)}] ${task.title} (${metadata.join(", ")})${notes}`;
          })
          .join("\n");

  return [
    `# Tasks — ${document.trackTitle}`,
    "",
    "Status values: `todo`, `in_progress`, `blocked`, `done`.",
    "",
    tasks,
    "",
  ].join("\n");
}
