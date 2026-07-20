import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDockerBuildCommands, serviceImageBuilds } from "./build-service-images.mjs";

export const serviceDockerfilePath = "docker/service.Dockerfile";
export const dockerIgnorePath = ".dockerignore";

const requiredDockerfileSnippets = [
  "FROM node:${NODE_VERSION}-bookworm-slim AS base",
  "pnpm install --frozen-lockfile",
  "pnpm build",
  "pnpm check:built-entrypoints",
  "pnpm check:built-health",
  "pnpm --filter \"${SERVICE_PACKAGE}\" deploy --prod --legacy /runtime",
  "start:built",
  "rm -rf /app/src",
  "/app/node_modules/@specrail/*/src",
  "/app/node_modules/.pnpm/@specrail+*/node_modules/@specrail/*/src",
  "find /app -path \"/app/node_modules/@specrail/*/__tests__\" -prune -exec rm -rf {} +",
  "find /app -path \"/app/node_modules/.pnpm/@specrail+*/node_modules/@specrail/*/__tests__\" -prune -exec rm -rf {} +",
  "rm -f /app/tsconfig.json",
  "/app/node_modules/@specrail/*/tsconfig.json",
  "USER specrail",
  "CMD [\"./start-built.sh\"]",
];

const requiredDockerIgnoreEntries = [
  ".git",
  ".env",
  ".env.*",
  ".specrail-data",
  ".tmp",
  "coverage",
  "dist",
  "node_modules",
  "**/dist",
  "**/node_modules",
  "**/__tests__",
];

const expectedBuilds = [
  ["api", "specrail-api", "@specrail/api", 4000],
  ["github", "specrail-github", "@specrail/github", 4200],
  ["telegram", "specrail-telegram", "@specrail/telegram", 4300],
];

export async function checkServiceImageContract(rootDir = process.cwd()) {
  const failures = [];
  const dockerfile = await readFile(path.join(rootDir, serviceDockerfilePath), "utf8");
  const dockerIgnore = await readFile(path.join(rootDir, dockerIgnorePath), "utf8");

  for (const snippet of requiredDockerfileSnippets) {
    if (!dockerfile.includes(snippet)) {
      failures.push(`${serviceDockerfilePath}: missing ${JSON.stringify(snippet)}`);
    }
  }

  const dockerIgnoreEntries = new Set(
    dockerIgnore
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  for (const entry of requiredDockerIgnoreEntries) {
    if (!dockerIgnoreEntries.has(entry)) {
      failures.push(`${dockerIgnorePath}: missing ${JSON.stringify(entry)}`);
    }
  }

  const actualBuilds = serviceImageBuilds.map(({ service, image, packageName, port }) => [
    service,
    image,
    packageName,
    port,
  ]);

  if (JSON.stringify(actualBuilds) !== JSON.stringify(expectedBuilds)) {
    failures.push("scripts/build-service-images.mjs: service image definitions do not match the documented API/GitHub/Telegram contract");
  }

  const dryRunCommands = createDockerBuildCommands({ owner: "your-org", tag: "local" }).map((command) =>
    command.join(" "),
  );
  for (const [, image, packageName, port] of expectedBuilds) {
    const expectedImage = `ghcr.io/your-org/${image}:local`;
    const command = dryRunCommands.find((entry) => entry.includes(expectedImage));
    if (!command) {
      failures.push(`scripts/build-service-images.mjs: missing build command for ${expectedImage}`);
      continue;
    }
    if (!command.includes(`SERVICE_PACKAGE=${packageName}`)) {
      failures.push(`scripts/build-service-images.mjs: ${expectedImage} missing SERVICE_PACKAGE=${packageName}`);
    }
    if (!command.includes(`SERVICE_PORT=${port}`)) {
      failures.push(`scripts/build-service-images.mjs: ${expectedImage} missing SERVICE_PORT=${port}`);
    }
  }

  return failures;
}

async function main() {
  const failures = await checkServiceImageContract();

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log(`Checked ${serviceImageBuilds.length} service image build definitions.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
