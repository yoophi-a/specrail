export * from "./artifacts.js";

export interface SpecRailConfig {
  port: number;
  dataDir: string;
  repoArtifactDir: string;
  executionBackend: string;
  executionProfile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SpecRailConfig {
  return {
    port: Number(env.SPECRAIL_PORT ?? 4000),
    dataDir: env.SPECRAIL_DATA_DIR ?? ".specrail-data",
    repoArtifactDir: env.SPECRAIL_REPO_ARTIFACT_DIR ?? ".specrail",
    executionBackend: env.SPECRAIL_EXECUTION_BACKEND ?? "codex",
    executionProfile: env.SPECRAIL_EXECUTION_PROFILE ?? "default",
  };
}
