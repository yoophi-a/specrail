export * from "./artifacts.js";

export interface SpecRailConfig {
  port: number;
  dataDir: string;
  repoArtifactDir: string;
  executionBackend: string;
  executionProfile: string;
  executionWorkspaceMode: SpecRailExecutionWorkspaceMode;
}

export type SpecRailExecutionWorkspaceMode = "directory" | "git_worktree";

export interface SpecRailTerminalClientConfig {
  apiBaseUrl: string;
  refreshIntervalMs: number;
  initialScreen: "home" | "tracks" | "runs" | "settings";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SpecRailConfig {
  const executionWorkspaceMode = parseExecutionWorkspaceMode(env.SPECRAIL_EXECUTION_WORKSPACE_MODE);

  return {
    port: Number(env.SPECRAIL_PORT ?? 4000),
    dataDir: env.SPECRAIL_DATA_DIR ?? ".specrail-data",
    repoArtifactDir: env.SPECRAIL_REPO_ARTIFACT_DIR ?? ".specrail",
    executionBackend: env.SPECRAIL_EXECUTION_BACKEND ?? "codex",
    executionProfile: env.SPECRAIL_EXECUTION_PROFILE ?? "default",
    executionWorkspaceMode,
  };
}

function parseExecutionWorkspaceMode(value: string | undefined): SpecRailExecutionWorkspaceMode {
  if (!value || value === "directory") {
    return "directory";
  }

  if (value === "git_worktree") {
    return "git_worktree";
  }

  throw new Error(`Unsupported SPECRAIL_EXECUTION_WORKSPACE_MODE: ${value}`);
}

export function loadTerminalClientConfig(env: NodeJS.ProcessEnv = process.env): SpecRailTerminalClientConfig {
  const initialScreen = env.SPECRAIL_TERMINAL_INITIAL_SCREEN;

  return {
    apiBaseUrl: env.SPECRAIL_API_BASE_URL ?? "http://127.0.0.1:4000",
    refreshIntervalMs: Number(env.SPECRAIL_TERMINAL_REFRESH_MS ?? 5000),
    initialScreen:
      initialScreen === "tracks" || initialScreen === "runs" || initialScreen === "settings" ? initialScreen : "home",
  };
}
