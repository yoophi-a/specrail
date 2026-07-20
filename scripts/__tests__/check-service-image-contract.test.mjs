import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkServiceImageContract,
  containerImageWorkflowPath,
  dockerIgnorePath,
  serviceDockerfilePath,
} from "../check-service-image-contract.mjs";
import { createDockerBuildCommands, runServiceImageBuilds } from "../build-service-images.mjs";

const validDockerfile = `
FROM node:\${NODE_VERSION}-bookworm-slim AS base
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm check:built-entrypoints
RUN pnpm check:built-health
RUN pnpm --filter "\${SERVICE_PACKAGE}" deploy --prod --legacy /runtime
RUN node -e "const command = 'start:built'"
RUN rm -rf /app/src /app/node_modules/@specrail/*/src /app/node_modules/.pnpm/@specrail+*/node_modules/@specrail/*/src
RUN find /app -path "/app/node_modules/@specrail/*/__tests__" -prune -exec rm -rf {} +
RUN find /app -path "/app/node_modules/.pnpm/@specrail+*/node_modules/@specrail/*/__tests__" -prune -exec rm -rf {} +
RUN rm -f /app/tsconfig.json /app/node_modules/@specrail/*/tsconfig.json
USER specrail
CMD ["./start-built.sh"]
`;

const validDockerIgnore = `
.git
.env
.env.*
.specrail-data
.tmp
coverage
dist
node_modules
**/dist
**/node_modules
**/__tests__
`;

const validWorkflow = `
name: Container images
permissions:
  contents: read
  packages: write
on:
  push:
    paths-ignore:
      - docs/**
      - "**/*.md"
steps:
  - run: pnpm install --frozen-lockfile
  - run: pnpm check:links
  - run: pnpm check
  - run: pnpm test
  - run: pnpm build
  - run: pnpm check:built-entrypoints
  - run: pnpm check:built-health
  - uses: docker/login-action@v3
  - run: pnpm docker:build-services -- --owner "\${GITHUB_REPOSITORY_OWNER}" --tag "\${tags}" --push
`;

test("checkServiceImageContract accepts the service Dockerfile contract", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "specrail-service-images-ok-"));
  await mkdir(path.join(rootDir, "docker"), { recursive: true });
  await mkdir(path.dirname(path.join(rootDir, containerImageWorkflowPath)), { recursive: true });
  await writeFile(path.join(rootDir, serviceDockerfilePath), validDockerfile, "utf8");
  await writeFile(path.join(rootDir, dockerIgnorePath), validDockerIgnore, "utf8");
  await writeFile(path.join(rootDir, containerImageWorkflowPath), validWorkflow, "utf8");

  assert.deepEqual(await checkServiceImageContract(rootDir), []);
});

test("checkServiceImageContract reports missing Dockerfile contract snippets", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "specrail-service-images-fail-"));
  await mkdir(path.join(rootDir, "docker"), { recursive: true });
  await mkdir(path.dirname(path.join(rootDir, containerImageWorkflowPath)), { recursive: true });
  await writeFile(path.join(rootDir, serviceDockerfilePath), "FROM scratch\n", "utf8");
  await writeFile(path.join(rootDir, dockerIgnorePath), "node_modules\n", "utf8");
  await writeFile(path.join(rootDir, containerImageWorkflowPath), "name: broken\n", "utf8");

  const failures = await checkServiceImageContract(rootDir);
  assert.match(failures.join("\n"), /pnpm check:built-health/u);
  assert.match(failures.join("\n"), /USER specrail/u);
  assert.match(failures.join("\n"), /\.env/u);
  assert.match(failures.join("\n"), /packages: write/u);
});

test("createDockerBuildCommands builds and optionally pushes the three service images", () => {
  assert.deepEqual(createDockerBuildCommands({ owner: "acme", tag: "sha-123" }), [
    [
      "docker",
      "build",
      "--file",
      "docker/service.Dockerfile",
      "--build-arg",
      "SERVICE_PACKAGE=@specrail/api",
      "--build-arg",
      "SERVICE_PORT=4000",
      "--tag",
      "ghcr.io/acme/specrail-api:sha-123",
      ".",
    ],
    [
      "docker",
      "build",
      "--file",
      "docker/service.Dockerfile",
      "--build-arg",
      "SERVICE_PACKAGE=@specrail/github",
      "--build-arg",
      "SERVICE_PORT=4200",
      "--tag",
      "ghcr.io/acme/specrail-github:sha-123",
      ".",
    ],
    [
      "docker",
      "build",
      "--file",
      "docker/service.Dockerfile",
      "--build-arg",
      "SERVICE_PACKAGE=@specrail/telegram",
      "--build-arg",
      "SERVICE_PORT=4300",
      "--tag",
      "ghcr.io/acme/specrail-telegram:sha-123",
      ".",
    ],
  ]);

  assert.deepEqual(createDockerBuildCommands({ owner: "acme", tag: "sha-123", push: true }).at(-1), [
    "docker",
    "push",
    "ghcr.io/acme/specrail-telegram:sha-123",
  ]);
});

test("runServiceImageBuilds dry-run accepts the pnpm argument separator", () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    runServiceImageBuilds(["--", "--owner", "acme", "--tag", "sha-123", "--dry-run"]);
  } finally {
    console.log = originalLog;
  }

  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /ghcr.io\/acme\/specrail-api:sha-123/u);
  assert.doesNotMatch(lines[0] ?? "", /:local/u);
});

test("createDockerBuildCommands can attach multiple tags in one build", () => {
  const [apiBuild, apiShaPush, apiMainPush] = createDockerBuildCommands({
    owner: "acme",
    tags: ["sha-123", "main"],
    push: true,
  });

  assert.deepEqual(apiBuild, [
    "docker",
    "build",
    "--file",
    "docker/service.Dockerfile",
    "--build-arg",
    "SERVICE_PACKAGE=@specrail/api",
    "--build-arg",
    "SERVICE_PORT=4000",
    "--tag",
    "ghcr.io/acme/specrail-api:sha-123",
    "--tag",
    "ghcr.io/acme/specrail-api:main",
    ".",
  ]);
  assert.deepEqual(apiShaPush, ["docker", "push", "ghcr.io/acme/specrail-api:sha-123"]);
  assert.deepEqual(apiMainPush, ["docker", "push", "ghcr.io/acme/specrail-api:main"]);
});
