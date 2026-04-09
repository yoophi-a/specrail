export * from "./artifacts.js";

export interface SpecRailConfig {
  port: number;
  dataDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SpecRailConfig {
  return {
    port: Number(env.SPECRAIL_PORT ?? 4000),
    dataDir: env.SPECRAIL_DATA_DIR ?? ".specrail-data",
  };
}
