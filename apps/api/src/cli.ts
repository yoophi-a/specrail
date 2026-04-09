#!/usr/bin/env node
import { loadConfig } from "@specrail/config";
import {
  OPENSPEC_RESOLUTION_PRESETS,
  type Execution,
  type RunInspection,
  type Track,
  type TrackOpenSpecInspection,
  type TrackInspection,
  type TrackIntegrationsInspection,
  type OpenSpecImportResolution,
  type OpenSpecImportResolutionChoice,
  type OpenSpecImportResolutionPresetName,
} from "@specrail/core";
import { createDefaultService } from "./runtime.js";

type OpenSpecImportField =
  | "track.title"
  | "track.description"
  | "track.status"
  | "track.specStatus"
  | "track.planStatus"
  | "track.priority"
  | "track.githubIssue"
  | "track.githubPullRequest"
  | "artifacts.spec"
  | "artifacts.plan"
  | "artifacts.tasks";

interface ParsedArgs {
  command:
    | "openspec-export"
    | "openspec-import"
    | "openspec-import-help"
    | "openspec-imports"
    | "openspec-exports"
    | "openspec-inspect"
    | "openspec-inspect-imports"
    | "openspec-inspect-exports"
    | "track-list"
    | "track-inspect"
    | "track-inspect-integrations"
    | "run-list"
    | "run-inspect"
    | null;
  path?: string;
  trackId?: string;
  runId?: string;
  overwrite: boolean;
  preview: boolean;
  apply: boolean;
  json: boolean;
  page?: number;
  pageSize?: number;
  importPage?: number;
  importPageSize?: number;
  exportPage?: number;
  exportPageSize?: number;
  status?: string;
  priority?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  sourcePath?: string;
  targetPath?: string;
  after?: string;
  before?: string;
  conflictPolicy?: "reject" | "overwrite" | "resolve";
  filterConflictPolicy?: "reject" | "overwrite" | "resolve";
  overwriteFilter?: boolean;
  preset?: OpenSpecImportResolutionPresetName;
  incoming: OpenSpecImportField[];
  existing: OpenSpecImportField[];
}

const VALID_FIELDS = new Set<OpenSpecImportField>([
  "track.title",
  "track.description",
  "track.status",
  "track.specStatus",
  "track.planStatus",
  "track.priority",
  "track.githubIssue",
  "track.githubPullRequest",
  "artifacts.spec",
  "artifacts.plan",
  "artifacts.tasks",
]);

function printUsage(): void {
  console.log(`SpecRail admin CLI

Usage:
  specrail-admin openspec export --track-id <track-id> --path <bundle-dir> [--overwrite] [--json]
  specrail-admin openspec import --path <bundle-dir> [--preview] [--apply] [--preset <name>] [--conflict-policy <reject|overwrite|resolve>] [--incoming <field[,field...]>] [--existing <field[,field...]>] [--json]
  specrail-admin openspec import help [--preset <name>] [--json]
  specrail-admin openspec imports [--track-id <track-id>] [--page <n>] [--page-size <count>] [--source-path <text>] [--after <iso>] [--before <iso>] [--filter-conflict-policy <reject|overwrite|resolve>] [--json]
  specrail-admin openspec exports [--track-id <track-id>] [--page <n>] [--page-size <count>] [--target-path <text>] [--after <iso>] [--before <iso>] [--overwrite-only | --no-overwrite-only] [--json]
  specrail-admin openspec inspect --track-id <track-id> [--page <n>] [--page-size <count>] [--import-page <n>] [--import-page-size <count>] [--export-page <n>] [--export-page-size <count>] [--json]
  specrail-admin openspec inspect imports --track-id <track-id> [--page <n>] [--page-size <count>] [--json]
  specrail-admin openspec inspect exports --track-id <track-id> [--page <n>] [--page-size <count>] [--json]
  specrail-admin tracks list [--status <status>] [--priority <priority>] [--page <n>] [--page-size <count>] [--sort-by <updatedAt|createdAt|title|priority|status>] [--sort-order <asc|desc>] [--json]
  specrail-admin tracks inspect --track-id <track-id> [--json]
  specrail-admin tracks inspect integrations --track-id <track-id> [--page <n>] [--page-size <count>] [--import-page <n>] [--import-page-size <count>] [--export-page <n>] [--export-page-size <count>] [--json]
  specrail-admin runs list [--track-id <track-id>] [--status <status>] [--page <n>] [--page-size <count>] [--sort-by <createdAt|startedAt|finishedAt|status>] [--sort-order <asc|desc>] [--json]
  specrail-admin runs inspect --run-id <run-id> [--json]

Examples:
  specrail-admin openspec export --track-id track_123 --path ./bundle
  specrail-admin openspec import --path ./bundle --preview
  specrail-admin openspec import --path ./bundle --apply --preset policyDefaults
  specrail-admin openspec import --path ./bundle --apply --preset policyDefaults --existing artifacts.plan
  specrail-admin openspec import help --preset policyDefaults
  specrail-admin openspec imports --track-id track_123 --page-size 5 --filter-conflict-policy resolve
  specrail-admin openspec exports --track-id track_123 --page-size 5 --overwrite-only
  specrail-admin openspec inspect --track-id track_123 --page-size 1 --export-page 2
  specrail-admin openspec inspect imports --track-id track_123 --page 2 --page-size 5
  specrail-admin tracks list --status ready --sort-by title --sort-order asc
  specrail-admin tracks inspect --track-id track_123
  specrail-admin tracks inspect integrations --track-id track_123 --page-size 5
  specrail-admin runs list --track-id track_123 --status running --page-size 10
  specrail-admin runs inspect --run-id run_123
`);
}

function parseIsoDateOption(name: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return value;
}

function parseFieldList(raw: string): OpenSpecImportField[] {
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean) as OpenSpecImportField[];
  for (const value of values) {
    if (!VALID_FIELDS.has(value)) {
      throw new Error(`Unknown resolution field: ${value}`);
    }
  }
  return values;
}

function applyFieldChoice(
  resolution: OpenSpecImportResolution,
  field: OpenSpecImportField,
  choice: OpenSpecImportResolutionChoice,
): void {
  const [group, key] = field.split(".") as ["track" | "artifacts", string];
  if (group === "track") {
    resolution.track = { ...(resolution.track ?? {}), [key]: choice };
    return;
  }

  resolution.artifacts = { ...(resolution.artifacts ?? {}), [key]: choice };
}

function buildResolution(input: Pick<ParsedArgs, "incoming" | "existing">): OpenSpecImportResolution | undefined {
  const resolution: OpenSpecImportResolution = {};

  for (const field of input.incoming) {
    applyFieldChoice(resolution, field, "incoming");
  }

  for (const field of input.existing) {
    applyFieldChoice(resolution, field, "existing");
  }

  return Object.keys(resolution).length > 0 ? resolution : undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { command: null, overwrite: false, preview: false, apply: false, json: false, incoming: [], existing: [] };
  }

  const [group, action, subaction, ...rest] = argv;
  const args: ParsedArgs = {
    command: null,
    overwrite: false,
    preview: false,
    apply: false,
    json: false,
    incoming: [],
    existing: [],
  };

  if (group === "openspec" && action === "export") {
    args.command = "openspec-export";
    rest.unshift(subaction);
  } else if (group === "openspec" && action === "import" && subaction === "help") {
    args.command = "openspec-import-help";
  } else if (group === "openspec" && action === "import") {
    args.command = "openspec-import";
    rest.unshift(subaction);
  } else if (group === "openspec" && action === "imports") {
    args.command = "openspec-imports";
    rest.unshift(subaction);
  } else if (group === "openspec" && action === "exports") {
    args.command = "openspec-exports";
    rest.unshift(subaction);
  } else if (group === "openspec" && action === "inspect" && subaction === "imports") {
    args.command = "openspec-inspect-imports";
  } else if (group === "openspec" && action === "inspect" && subaction === "exports") {
    args.command = "openspec-inspect-exports";
  } else if (group === "openspec" && action === "inspect") {
    args.command = "openspec-inspect";
    rest.unshift(subaction);
  } else if (group === "tracks" && action === "list") {
    args.command = "track-list";
    rest.unshift(subaction);
  } else if (group === "tracks" && action === "inspect" && subaction === "integrations") {
    args.command = "track-inspect-integrations";
  } else if (group === "tracks" && action === "inspect") {
    args.command = "track-inspect";
    rest.unshift(subaction);
  } else if (group === "runs" && action === "list") {
    args.command = "run-list";
    rest.unshift(subaction);
  } else if (group === "runs" && action === "inspect") {
    args.command = "run-inspect";
    rest.unshift(subaction);
  } else {
    throw new Error(`Unknown command: ${argv.join(" ")}`);
  }

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }

    switch (token) {
      case "--path":
        args.path = rest[++index];
        break;
      case "--track-id":
        args.trackId = rest[++index];
        break;
      case "--run-id":
        args.runId = rest[++index];
        break;
      case "--overwrite":
        args.overwrite = true;
        break;
      case "--preview":
        args.preview = true;
        break;
      case "--apply":
        args.apply = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--preset": {
        const value = rest[++index] as OpenSpecImportResolutionPresetName | undefined;
        if (!value || !OPENSPEC_RESOLUTION_PRESETS.some((preset) => preset.name === value)) {
          throw new Error(`Unknown preset: ${value ?? ""}`);
        }
        args.preset = value;
        break;
      }
      case "--conflict-policy": {
        const value = rest[++index];
        if (value !== "reject" && value !== "overwrite" && value !== "resolve") {
          throw new Error(`Unknown conflict policy: ${value ?? ""}`);
        }
        args.conflictPolicy = value;
        break;
      }
      case "--limit": {
        const value = Number.parseInt(rest[++index] ?? "", 10);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`Invalid limit: ${rest[index] ?? ""}`);
        }
        args.pageSize = value;
        break;
      }
      case "--page": {
        const value = Number.parseInt(rest[++index] ?? "", 10);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`Invalid page: ${rest[index] ?? ""}`);
        }
        args.page = value;
        break;
      }
      case "--page-size": {
        const value = Number.parseInt(rest[++index] ?? "", 10);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`Invalid page size: ${rest[index] ?? ""}`);
        }
        args.pageSize = value;
        break;
      }
      case "--status":
        args.status = rest[++index];
        break;
      case "--priority":
        args.priority = rest[++index];
        break;
      case "--sort-by":
        args.sortBy = rest[++index];
        break;
      case "--sort-order": {
        const value = rest[++index];
        if (value !== "asc" && value !== "desc") {
          throw new Error(`Invalid sort order: ${value ?? ""}`);
        }
        args.sortOrder = value;
        break;
      }
      case "--import-page": {
        const value = Number.parseInt(rest[++index] ?? "", 10);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`Invalid import page: ${rest[index] ?? ""}`);
        }
        args.importPage = value;
        break;
      }
      case "--import-page-size": {
        const value = Number.parseInt(rest[++index] ?? "", 10);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`Invalid import page size: ${rest[index] ?? ""}`);
        }
        args.importPageSize = value;
        break;
      }
      case "--export-page": {
        const value = Number.parseInt(rest[++index] ?? "", 10);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`Invalid export page: ${rest[index] ?? ""}`);
        }
        args.exportPage = value;
        break;
      }
      case "--export-page-size": {
        const value = Number.parseInt(rest[++index] ?? "", 10);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error(`Invalid export page size: ${rest[index] ?? ""}`);
        }
        args.exportPageSize = value;
        break;
      }
      case "--source-path":
        args.sourcePath = rest[++index];
        break;
      case "--target-path":
        args.targetPath = rest[++index];
        break;
      case "--after":
        args.after = parseIsoDateOption("after", rest[++index]);
        break;
      case "--before":
        args.before = parseIsoDateOption("before", rest[++index]);
        break;
      case "--filter-conflict-policy": {
        const value = rest[++index];
        if (value !== "reject" && value !== "overwrite" && value !== "resolve") {
          throw new Error(`Unknown filter conflict policy: ${value ?? ""}`);
        }
        args.filterConflictPolicy = value;
        break;
      }
      case "--overwrite-only":
        args.overwriteFilter = true;
        break;
      case "--no-overwrite-only":
        args.overwriteFilter = false;
        break;
      case "--incoming":
        args.incoming.push(...parseFieldList(rest[++index] ?? ""));
        break;
      case "--existing":
        args.existing.push(...parseFieldList(rest[++index] ?? ""));
        break;
      case undefined:
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  return args;
}

function printTrackList(result: Awaited<ReturnType<ReturnType<typeof createDefaultService>["listTracksPage"]>>, args: ParsedArgs): void {
  if (result.items.length === 0) {
    console.log("No tracks found");
    return;
  }

  console.log(`Tracks (page ${args.page ?? 1}/${result.meta.totalPages || 1}, total ${result.meta.total})`);
  for (const track of result.items) {
    console.log(`- ${track.id} [${track.status}] ${track.title}`);
    console.log(`  - priority: ${track.priority}`);
    console.log(`  - spec/plan: ${track.specStatus}/${track.planStatus}`);
    console.log(`  - updatedAt: ${track.updatedAt}`);
  }
}

function printRunList(result: Awaited<ReturnType<ReturnType<typeof createDefaultService>["listRunsPage"]>>, args: ParsedArgs): void {
  if (result.items.length === 0) {
    console.log("No runs found");
    return;
  }

  console.log(`Runs (page ${args.page ?? 1}/${result.meta.totalPages || 1}, total ${result.meta.total})`);
  for (const run of result.items) {
    console.log(`- ${run.id} [${run.status}] track=${run.trackId}`);
    console.log(`  - backend/profile: ${run.backend}/${run.profile}`);
    console.log(`  - createdAt: ${run.createdAt}`);
    if (run.startedAt) {
      console.log(`  - startedAt: ${run.startedAt}`);
    }
    if (run.finishedAt) {
      console.log(`  - finishedAt: ${run.finishedAt}`);
    }
    if (run.summary) {
      console.log(`  - summary: events=${run.summary.eventCount}, lastEvent=${run.summary.lastEventSummary ?? "none"}`);
    }
  }
}

function printExportHistory(result: Awaited<ReturnType<ReturnType<typeof createDefaultService>["listOpenSpecExportHistoryPage"]>>, args: ParsedArgs): void {
  if (result.items.length === 0) {
    console.log("No OpenSpec export history found");
    return;
  }

  console.log(`OpenSpec export history (page ${args.page ?? 1}/${result.meta.totalPages || 1}, total ${result.meta.total})`);
  for (const entry of result.items) {
    console.log(`- ${entry.exportRecord.exportedAt} ${entry.trackId} (${entry.trackTitle})`);
    console.log(`  - target: ${entry.exportRecord.target.path}`);
    console.log(`  - overwrite: ${entry.exportRecord.target.overwrite ? "true" : "false"}`);
  }
}

function resolveTrackInspectionPagination(args: ParsedArgs): {
  importPage: number | undefined;
  importPageSize: number | undefined;
  exportPage: number | undefined;
  exportPageSize: number | undefined;
} {
  return {
    importPage: args.importPage ?? args.page,
    importPageSize: args.importPageSize ?? args.pageSize,
    exportPage: args.exportPage ?? args.page,
    exportPageSize: args.exportPageSize ?? args.pageSize,
  };
}

function printTrackImportInspection(page: TrackOpenSpecInspection["imports"], pageNumber: number): void {
  console.log(`OpenSpec import inspection (page ${pageNumber}/${page.meta.totalPages || 1}, total ${page.meta.total})`);
  if (page.latest) {
    console.log(`- latest: ${page.latest.importedAt} ${page.latest.source.path} (${page.latest.conflictPolicy})`);
  } else {
    console.log("- latest: none");
  }

  if (page.items.length === 0) {
    console.log("- history: none");
    return;
  }

  console.log("- history:");
  for (const entry of page.items) {
    console.log(`  - ${entry.provenance.importedAt} ${entry.trackId} (${entry.trackTitle})`);
    console.log(`    - source: ${entry.provenance.source.path}`);
    console.log(`    - conflictPolicy: ${entry.provenance.conflictPolicy}`);
    if (entry.provenance.resolutionPreset) {
      console.log(`    - preset: ${entry.provenance.resolutionPreset}`);
    }
  }
}

function printTrackExportInspection(page: TrackOpenSpecInspection["exports"], pageNumber: number): void {
  console.log(`OpenSpec export inspection (page ${pageNumber}/${page.meta.totalPages || 1}, total ${page.meta.total})`);
  if (page.latest) {
    console.log(`- latest: ${page.latest.exportedAt} ${page.latest.target.path} (overwrite=${page.latest.target.overwrite ? "true" : "false"})`);
  } else {
    console.log("- latest: none");
  }

  if (page.items.length === 0) {
    console.log("- history: none");
    return;
  }

  console.log("- history:");
  for (const entry of page.items) {
    console.log(`  - ${entry.exportRecord.exportedAt} ${entry.trackId} (${entry.trackTitle})`);
    console.log(`    - target: ${entry.exportRecord.target.path}`);
    console.log(`    - overwrite: ${entry.exportRecord.target.overwrite ? "true" : "false"}`);
  }
}

function printTrackInspection(result: TrackOpenSpecInspection, args: ParsedArgs): void {
  const pagination = resolveTrackInspectionPagination(args);
  console.log(`OpenSpec track inspection for ${result.trackId}`);
  printTrackImportInspection(result.imports, pagination.importPage ?? 1);
  printTrackExportInspection(result.exports, pagination.exportPage ?? 1);
}

function printTrackStateInspection(result: TrackInspection): void {
  console.log(`Track inspection for ${result.track.id}`);
  console.log(`- title: ${result.track.title}`);
  console.log(`- status: ${result.track.status}`);
  console.log(`- specStatus: ${result.track.specStatus}`);
  console.log(`- planStatus: ${result.track.planStatus}`);
  console.log(`- priority: ${result.track.priority}`);
  console.log(`- projectId: ${result.track.projectId}`);
  if (result.track.githubIssue) {
    console.log(`- githubIssue: #${result.track.githubIssue.number} ${result.track.githubIssue.url}`);
  }
  if (result.track.githubPullRequest) {
    console.log(`- githubPullRequest: #${result.track.githubPullRequest.number} ${result.track.githubPullRequest.url}`);
  }
  console.log(`- artifacts:`);
  console.log(`  - openSpecImport: ${result.track.openSpecImport?.id ?? "none"}`);
  console.log(`  - openSpecExport: ${result.track.openSpecExport?.id ?? "none"}`);
  console.log(`  - importHistory: ${result.track.openSpecImportHistory?.length ?? 0}`);
  console.log(`  - exportHistory: ${result.track.openSpecExportHistory?.length ?? 0}`);
  console.log(`- githubRunCommentSync: ${result.githubRunCommentSync?.comments.length ?? 0} comment target(s)`);
}

function printTrackIntegrationsInspection(result: TrackIntegrationsInspection, args: ParsedArgs): void {
  console.log(`Track integrations inspection for ${result.trackId}`);
  console.log(`- github:`);
  console.log(`  - issue: ${result.github.issue ? `#${result.github.issue.number} ${result.github.issue.url}` : "none"}`);
  console.log(`  - pullRequest: ${result.github.pullRequest ? `#${result.github.pullRequest.number} ${result.github.pullRequest.url}` : "none"}`);
  console.log(`  - runCommentSyncTargets: ${result.github.runCommentSync?.comments.length ?? 0}`);
  console.log(`  - summary: linked=${result.github.summary.linkedTargetCount}, synced=${result.github.summary.syncedTargetCount}, status=${result.github.summary.lastSyncStatus ?? "none"}`);
  if (result.github.summary.lastPublishedAt) {
    console.log(`  - lastPublishedAt: ${result.github.summary.lastPublishedAt}`);
  }
  if (result.github.summary.lastSyncError) {
    console.log(`  - lastSyncError: ${result.github.summary.lastSyncError}`);
  }
  printTrackInspection(result.openSpec, args);
}

function printRunInspection(result: RunInspection): void {
  console.log(`Run inspection for ${result.run.id}`);
  console.log(`- trackId: ${result.run.trackId}`);
  console.log(`- status: ${result.run.status}`);
  console.log(`- backend: ${result.run.backend}`);
  console.log(`- profile: ${result.run.profile}`);
  console.log(`- workspacePath: ${result.run.workspacePath}`);
  console.log(`- branchName: ${result.run.branchName}`);
  console.log(`- sessionRef: ${result.run.sessionRef ?? "none"}`);
  if (result.run.command) {
    console.log(`- command: ${result.run.command.command} ${result.run.command.args.join(" ")}`.trim());
    console.log(`  - cwd: ${result.run.command.cwd}`);
    console.log(`  - prompt: ${JSON.stringify(result.run.command.prompt)}`);
    if (result.run.command.resumeSessionRef) {
      console.log(`  - resumeSessionRef: ${result.run.command.resumeSessionRef}`);
    }
  }
  if (result.run.summary) {
    console.log(`- summary: events=${result.run.summary.eventCount}, lastEvent=${result.run.summary.lastEventSummary ?? "none"}, lastEventAt=${result.run.summary.lastEventAt ?? "none"}`);
  }
  console.log(`- githubRunCommentSync: ${result.githubRunCommentSync?.comments.length ?? 0} track target(s)`);
  console.log(`- githubRunCommentSyncForRun: ${result.githubRunCommentSyncForRun.length} matching target(s)`);
}

function inferConflictPolicy(args: ParsedArgs): "reject" | "overwrite" | "resolve" | undefined {
  if (args.conflictPolicy) {
    return args.conflictPolicy;
  }
  if (!args.apply) {
    return "reject";
  }
  if (args.preset || args.incoming.length > 0 || args.existing.length > 0) {
    return "resolve";
  }
  return undefined;
}

function formatNextCommand(args: ParsedArgs, result: { conflict: { hasConflict: boolean } }): string | null {
  if (!args.path || !result.conflict.hasConflict) {
    return null;
  }

  const tokens = ["specrail-admin", "openspec", "import", "--path", JSON.stringify(args.path), "--apply"];
  if (args.preset) {
    tokens.push("--preset", args.preset);
  }
  if (args.existing.length > 0) {
    tokens.push("--existing", args.existing.join(","));
  }
  if (args.incoming.length > 0) {
    tokens.push("--incoming", args.incoming.join(","));
  }

  const policy = inferConflictPolicy({ ...args, apply: true, preview: false });
  if (policy) {
    tokens.push("--conflict-policy", policy);
  }

  return tokens.join(" ");
}

function printExportSummary(result: Awaited<ReturnType<ReturnType<typeof createDefaultService>["exportTrackToOpenSpec"]>>): void {
  console.log("Exported OpenSpec bundle");
  console.log(`- track: ${result.package.track.id}`);
  console.log(`- path: ${result.target.path}`);
  console.log(`- exportedAt: ${result.package.metadata.exportedAt}`);
}

function printImportHistory(result: Awaited<ReturnType<ReturnType<typeof createDefaultService>["listOpenSpecImportHistoryPage"]>>, args: ParsedArgs): void {
  if (result.items.length === 0) {
    console.log("No OpenSpec import history found");
    return;
  }

  console.log(`OpenSpec import history (page ${args.page ?? 1}/${result.meta.totalPages || 1}, total ${result.meta.total})`);
  for (const entry of result.items) {
    console.log(`- ${entry.provenance.importedAt} ${entry.trackId} (${entry.trackTitle})`);
    console.log(`  - source: ${entry.provenance.source.path}`);
    console.log(`  - conflictPolicy: ${entry.provenance.conflictPolicy}`);
    if (entry.provenance.resolutionPreset) {
      console.log(`  - preset: ${entry.provenance.resolutionPreset}`);
    }
  }
}

function printImportSummary(args: ParsedArgs, result: Awaited<ReturnType<ReturnType<typeof createDefaultService>["importTrackFromOpenSpec"]>>): void {
  console.log(`${result.applied ? "Applied" : "Previewed"} OpenSpec import`);
  console.log(`- track: ${result.track.id}`);
  console.log(`- action: ${result.action}`);
  console.log(`- conflictPolicy: ${result.conflictPolicy}`);
  console.log(`- conflict: ${result.conflict.hasConflict ? result.conflict.reason : "none"}`);
  if (result.provenance.resolutionPreset) {
    console.log(`- preset: ${result.provenance.resolutionPreset}`);
  }
  if (result.conflict.details.length > 0) {
    console.log("- changed fields:");
    for (const detail of result.conflict.details) {
      console.log(`  - ${detail.field}: ${detail.message}`);
    }
  }
  console.log("- recommended flow:");
  for (const step of result.operatorGuide.recommendedFlow) {
    console.log(`  - ${step}`);
  }
  const nextCommand = !args.apply ? formatNextCommand(args, result) : null;
  if (nextCommand) {
    console.log(`- next apply command: ${nextCommand}`);
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === null) {
    printUsage();
    process.exitCode = 0;
    return;
  }

  const service = createDefaultService();

  if (args.command === "openspec-export") {
    if (!args.path) {
      throw new Error("Missing required option: --path");
    }
    if (!args.trackId) {
      throw new Error("Missing required option: --track-id");
    }

    const result = await service.exportTrackToOpenSpec({
      trackId: args.trackId,
      target: { kind: "file", path: args.path, overwrite: args.overwrite },
    });

    if (args.json) {
      console.log(JSON.stringify({ config: loadConfig(), result }, null, 2));
      return;
    }

    printExportSummary(result);
    return;
  }

  if (args.command === "openspec-import-help") {
    const operatorGuide = service.getOpenSpecImportHelp({ resolutionPreset: args.preset, resolution: buildResolution(args) });
    if (args.json) {
      console.log(JSON.stringify({ config: loadConfig(), operatorGuide }, null, 2));
      return;
    }

    console.log("OpenSpec import help");
    console.log(`- selected preset: ${operatorGuide.selectedPreset?.name ?? "none"}`);
    console.log("- recommended flow:");
    for (const step of operatorGuide.recommendedFlow) {
      console.log(`  - ${step}`);
    }
    console.log("- example requests:");
    for (const example of operatorGuide.examples) {
      console.log(`  - ${example.id}: ${example.label}`);
    }
    return;
  }

  if (args.command === "openspec-imports") {
    const result = await service.listOpenSpecImportHistoryPage({
      trackId: args.trackId,
      page: args.page,
      pageSize: args.pageSize,
      sourcePath: args.sourcePath,
      importedAfter: args.after,
      importedBefore: args.before,
      conflictPolicy: args.filterConflictPolicy,
    });

    if (args.json) {
      console.log(JSON.stringify({ config: loadConfig(), result: { ...result, meta: { page: args.page ?? 1, pageSize: args.pageSize ?? 20, ...result.meta } } }, null, 2));
      return;
    }

    printImportHistory(result, args);
    return;
  }

  if (args.command === "openspec-exports") {
    const result = await service.listOpenSpecExportHistoryPage({
      trackId: args.trackId,
      page: args.page,
      pageSize: args.pageSize,
      targetPath: args.targetPath,
      exportedAfter: args.after,
      exportedBefore: args.before,
      overwrite: args.overwriteFilter,
    });

    if (args.json) {
      console.log(JSON.stringify({ config: loadConfig(), result: { ...result, meta: { page: args.page ?? 1, pageSize: args.pageSize ?? 20, ...result.meta } } }, null, 2));
      return;
    }

    printExportHistory(result, args);
    return;
  }

  if (args.command === "openspec-inspect" || args.command === "openspec-inspect-imports" || args.command === "openspec-inspect-exports") {
    if (!args.trackId) {
      throw new Error("Missing required option: --track-id");
    }

    const pagination = resolveTrackInspectionPagination(args);
    const result = await service.getTrackOpenSpecImports(args.trackId, pagination);
    if (!result) {
      throw new Error(`Track not found: ${args.trackId}`);
    }

    if (args.json) {
      if (args.command === "openspec-inspect-imports") {
        console.log(JSON.stringify({ config: loadConfig(), result: { trackId: result.trackId, imports: result.imports } }, null, 2));
        return;
      }
      if (args.command === "openspec-inspect-exports") {
        console.log(JSON.stringify({ config: loadConfig(), result: { trackId: result.trackId, exports: result.exports } }, null, 2));
        return;
      }
      console.log(JSON.stringify({ config: loadConfig(), result }, null, 2));
      return;
    }

    if (args.command === "openspec-inspect-imports") {
      console.log(`OpenSpec track import inspection for ${result.trackId}`);
      printTrackImportInspection(result.imports, pagination.importPage ?? 1);
      return;
    }
    if (args.command === "openspec-inspect-exports") {
      console.log(`OpenSpec track export inspection for ${result.trackId}`);
      printTrackExportInspection(result.exports, pagination.exportPage ?? 1);
      return;
    }

    printTrackInspection(result, args);
    return;
  }

  if (args.command === "track-list") {
    const result = await service.listTracksPage({
      status: args.status as Track["status"] | undefined,
      priority: args.priority as Track["priority"] | undefined,
      page: args.page,
      pageSize: args.pageSize,
      sortBy: args.sortBy as "updatedAt" | "createdAt" | "title" | "priority" | "status" | undefined,
      sortOrder: args.sortOrder,
    });

    const payload = { ...result, meta: { page: args.page ?? 1, pageSize: args.pageSize ?? 20, ...result.meta } };
    if (args.json) {
      console.log(JSON.stringify({ config: loadConfig(), result: { tracks: result.items, meta: payload.meta } }, null, 2));
      return;
    }

    printTrackList(result, args);
    return;
  }

  if (args.command === "track-inspect") {
    if (!args.trackId) {
      throw new Error("Missing required option: --track-id");
    }

    const result = await service.getTrackInspection(args.trackId);
    if (!result) {
      throw new Error(`Track not found: ${args.trackId}`);
    }

    if (args.json) {
      console.log(JSON.stringify({ config: loadConfig(), result }, null, 2));
      return;
    }

    printTrackStateInspection(result);
    return;
  }

  if (args.command === "run-list") {
    const result = await service.listRunsPage({
      trackId: args.trackId,
      status: args.status as Execution["status"] | undefined,
      page: args.page,
      pageSize: args.pageSize,
      sortBy: args.sortBy as "createdAt" | "startedAt" | "finishedAt" | "status" | undefined,
      sortOrder: args.sortOrder,
    });

    const payload = { ...result, meta: { page: args.page ?? 1, pageSize: args.pageSize ?? 20, ...result.meta } };
    if (args.json) {
      console.log(JSON.stringify({ config: loadConfig(), result: { runs: result.items, meta: payload.meta } }, null, 2));
      return;
    }

    printRunList(result, args);
    return;
  }

  if (args.command === "track-inspect-integrations") {
    if (!args.trackId) {
      throw new Error("Missing required option: --track-id");
    }

    const result = await service.getTrackIntegrationsInspection(args.trackId, resolveTrackInspectionPagination(args));
    if (!result) {
      throw new Error(`Track not found: ${args.trackId}`);
    }

    if (args.json) {
      console.log(JSON.stringify({ config: loadConfig(), result }, null, 2));
      return;
    }

    printTrackIntegrationsInspection(result, args);
    return;
  }

  if (args.command === "run-inspect") {
    if (!args.runId) {
      throw new Error("Missing required option: --run-id");
    }

    const result = await service.getRunInspection(args.runId);
    if (!result) {
      throw new Error(`Run not found: ${args.runId}`);
    }

    if (args.json) {
      console.log(JSON.stringify({ config: loadConfig(), result }, null, 2));
      return;
    }

    printRunInspection(result);
    return;
  }

  if (!args.path) {
    throw new Error("Missing required option: --path");
  }

  const resolution = buildResolution(args);
  const result = await service.importTrackFromOpenSpec({
    source: { kind: "file", path: args.path },
    dryRun: args.apply ? false : true,
    conflictPolicy: inferConflictPolicy(args),
    resolutionPreset: args.preset,
    resolution,
  });

  if (args.json) {
    console.log(JSON.stringify({ config: loadConfig(), result }, null, 2));
    return;
  }

  printImportSummary(args, result);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
