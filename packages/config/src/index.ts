import path from "node:path";

export * from "./artifacts.js";

export interface SpecRailConfig {
  port: number;
  dataDir: string;
  repoArtifactDir: string;
  executionBackend: SpecRailExecutionBackend;
  executionProfile: string;
  executionWorkspaceMode: SpecRailExecutionWorkspaceMode;
  executionWorkspaceRoot: string;
}

export type SpecRailExecutionBackend = "codex" | "claude_code";

export type SpecRailExecutionWorkspaceMode = "directory" | "git_worktree";

export type SpecRailTerminalInitialRunFilter = "all" | "active" | "terminal";

export interface SpecRailTerminalClientConfig {
  apiBaseUrl: string;
  refreshIntervalMs: number;
  initialScreen: "home" | "tracks" | "runs" | "settings";
  initialProjectId: string | null;
  initialRunFilter: SpecRailTerminalInitialRunFilter;
  preferencePath: string | null;
  messageTemplatesPath?: string | null;
  diffExportDirectory?: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SpecRailConfig {
  const executionWorkspaceMode = parseExecutionWorkspaceMode(env.SPECRAIL_EXECUTION_WORKSPACE_MODE);
  const dataDir = readOptionalEnvValue(env.SPECRAIL_DATA_DIR) ?? ".specrail-data";

  return {
    port: parseIntegerEnv(env.SPECRAIL_PORT, 4000, "SPECRAIL_PORT", { min: 0, max: 65535 }),
    dataDir,
    repoArtifactDir: readOptionalEnvValue(env.SPECRAIL_REPO_ARTIFACT_DIR) ?? ".specrail",
    executionBackend: parseExecutionBackend(env.SPECRAIL_EXECUTION_BACKEND),
    executionProfile: readOptionalEnvValue(env.SPECRAIL_EXECUTION_PROFILE) ?? "default",
    executionWorkspaceMode,
    executionWorkspaceRoot: readOptionalEnvValue(env.SPECRAIL_EXECUTION_WORKSPACE_ROOT) ?? path.join(dataDir, "workspaces"),
  };
}

function parseExecutionBackend(value: string | undefined): SpecRailExecutionBackend {
  const normalized = readOptionalEnvValue(value)?.toLowerCase().replace(/-/gu, "_");
  if (!normalized || normalized === "codex") {
    return "codex";
  }

  if (normalized === "claude_code") {
    return "claude_code";
  }

  throw new Error(`Unsupported SPECRAIL_EXECUTION_BACKEND: ${value}`);
}

function parseExecutionWorkspaceMode(value: string | undefined): SpecRailExecutionWorkspaceMode {
  const normalized = readOptionalEnvValue(value);
  if (!normalized || normalized === "directory") {
    return "directory";
  }

  if (normalized === "git_worktree") {
    return "git_worktree";
  }

  throw new Error(`Unsupported SPECRAIL_EXECUTION_WORKSPACE_MODE: ${value}`);
}

export function loadTerminalClientConfig(env: NodeJS.ProcessEnv = process.env): SpecRailTerminalClientConfig {
  const initialScreen = parseTerminalInitialScreen(env.SPECRAIL_TERMINAL_INITIAL_SCREEN);
  const initialRunFilter = parseTerminalInitialRunFilter(env.SPECRAIL_TERMINAL_INITIAL_RUN_FILTER);
  const initialProjectId = env.SPECRAIL_TERMINAL_INITIAL_PROJECT_ID?.trim() || null;
  const preferencePath = env.SPECRAIL_TERMINAL_PREFERENCES_PATH?.trim() || null;
  const messageTemplatesPath = env.SPECRAIL_TERMINAL_MESSAGE_TEMPLATES_PATH?.trim() || null;
  const diffExportDirectory = env.SPECRAIL_TERMINAL_DIFF_EXPORT_DIR?.trim() || null;

  return {
    apiBaseUrl: readOptionalEnvValue(env.SPECRAIL_API_BASE_URL) ?? "http://127.0.0.1:4000",
    refreshIntervalMs: parseIntegerEnv(env.SPECRAIL_TERMINAL_REFRESH_MS, 5000, "SPECRAIL_TERMINAL_REFRESH_MS", { min: 0 }),
    initialScreen,
    initialProjectId,
    initialRunFilter,
    preferencePath,
    messageTemplatesPath,
    diffExportDirectory,
  };
}

function parseTerminalInitialScreen(value: string | undefined): SpecRailTerminalClientConfig["initialScreen"] {
  const normalized = readOptionalEnvValue(value);
  return normalized === "tracks" || normalized === "runs" || normalized === "settings" ? normalized : "home";
}

function parseTerminalInitialRunFilter(value: string | undefined): SpecRailTerminalInitialRunFilter {
  const normalized = readOptionalEnvValue(value);
  return normalized === "active" || normalized === "terminal" ? normalized : "all";
}

function readOptionalEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function parseIntegerEnv(
  value: string | undefined,
  defaultValue: number,
  envName: string,
  bounds: { min?: number; max?: number } = {},
): number {
  const normalized = value?.trim();
  if (!normalized) {
    return defaultValue;
  }

  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`invalid ${envName}: ${value}`);
  }

  const parsed = Number(normalized);
  if (
    !Number.isSafeInteger(parsed) ||
    (bounds.min !== undefined && parsed < bounds.min) ||
    (bounds.max !== undefined && parsed > bounds.max)
  ) {
    throw new Error(`invalid ${envName}: ${value}`);
  }

  return parsed;
}
