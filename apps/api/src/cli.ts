#!/usr/bin/env node
import { loadConfig } from "@specrail/config";
import {
  OPENSPEC_RESOLUTION_PRESETS,
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
  command: "openspec-import" | "openspec-import-help" | null;
  path?: string;
  preview: boolean;
  apply: boolean;
  json: boolean;
  conflictPolicy?: "reject" | "overwrite" | "resolve";
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
  specrail-admin openspec import --path <bundle-dir> [--preview] [--apply] [--preset <name>] [--conflict-policy <reject|overwrite|resolve>] [--incoming <field[,field...]>] [--existing <field[,field...]>] [--json]
  specrail-admin openspec import help [--preset <name>] [--json]

Examples:
  specrail-admin openspec import --path ./bundle --preview
  specrail-admin openspec import --path ./bundle --apply --preset policyDefaults
  specrail-admin openspec import --path ./bundle --apply --preset policyDefaults --existing artifacts.plan
  specrail-admin openspec import help --preset policyDefaults
`);
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
    return { command: null, preview: false, apply: false, json: false, incoming: [], existing: [] };
  }

  const [group, action, subaction, ...rest] = argv;
  const args: ParsedArgs = {
    command: null,
    preview: false,
    apply: false,
    json: false,
    incoming: [],
    existing: [],
  };

  if (group === "openspec" && action === "import" && subaction === "help") {
    args.command = "openspec-import-help";
  } else if (group === "openspec" && action === "import") {
    args.command = "openspec-import";
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
