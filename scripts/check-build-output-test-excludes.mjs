import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const requiredBuildConfigs = [
  "apps/acp-server/tsconfig.json",
  "apps/api/tsconfig.json",
  "apps/github/tsconfig.json",
  "apps/telegram/tsconfig.json",
  "apps/terminal/tsconfig.json",
  "packages/adapters/tsconfig.json",
];

export const requiredTestExclude = "src/**/__tests__/**/*.ts";

export async function checkBuildOutputTestExcludes(rootDir = process.cwd()) {
  const failures = [];

  for (const configPath of requiredBuildConfigs) {
    const raw = await readFile(path.join(rootDir, configPath), "utf8");
    const config = JSON.parse(raw);
    const excludes = Array.isArray(config.exclude) ? config.exclude : [];

    if (!excludes.includes(requiredTestExclude)) {
      failures.push(`${configPath}: expected exclude to include ${JSON.stringify(requiredTestExclude)}`);
    }
  }

  return failures;
}

async function main() {
  const failures = await checkBuildOutputTestExcludes();

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log(`Checked ${requiredBuildConfigs.length} build test excludes.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
