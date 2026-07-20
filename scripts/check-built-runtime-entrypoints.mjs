import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const builtRuntimeEntrypoints = [
  { service: "api", path: "apps/api/dist/apps/api/src/index.js" },
  { service: "github", path: "apps/github/dist/index.js" },
  { service: "telegram", path: "apps/telegram/dist/index.js" },
];

export function checkBuiltRuntimeEntrypoints(rootDir = process.cwd(), entrypoints = builtRuntimeEntrypoints) {
  const failures = [];

  for (const entrypoint of entrypoints) {
    const absolutePath = path.join(rootDir, entrypoint.path);

    if (!existsSync(absolutePath)) {
      failures.push(`${entrypoint.service}: missing built entrypoint ${entrypoint.path}; run pnpm build first`);
      continue;
    }

    const result = spawnSync(
      process.execPath,
      [
        "--conditions=specrail-built",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(pathToFileURL(absolutePath).href)});`,
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
        env: {
          ...process.env,
          SPECRAIL_PORT: process.env.SPECRAIL_PORT ?? "0",
          GITHUB_APP_PORT: process.env.GITHUB_APP_PORT ?? "0",
          GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET ?? "specrail-smoke-secret",
          TELEGRAM_APP_PORT: process.env.TELEGRAM_APP_PORT ?? "0",
          TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "123456:specrail-smoke-token",
        },
      },
    );

    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      failures.push(`${entrypoint.service}: built entrypoint import failed${output ? `\n${output}` : ""}`);
    }
  }

  return failures;
}

async function main() {
  const failures = checkBuiltRuntimeEntrypoints();

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log(`Checked ${builtRuntimeEntrypoints.length} built runtime entrypoints.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
