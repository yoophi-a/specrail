import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const builtServiceHealthChecks = [
  {
    service: "api",
    packageName: "@specrail/api",
    portEnv: "SPECRAIL_PORT",
    expectedService: "specrail-api",
    extraEnv: async () => {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "specrail-built-api-data-"));
      const repoArtifactDir = await mkdtemp(path.join(os.tmpdir(), "specrail-built-api-artifacts-"));
      return {
        SPECRAIL_DATA_DIR: dataDir,
        SPECRAIL_REPO_ARTIFACT_DIR: repoArtifactDir,
      };
    },
  },
  {
    service: "github",
    packageName: "@specrail/github",
    portEnv: "GITHUB_APP_PORT",
    expectedService: "specrail-github",
    extraEnv: async () => ({
      GITHUB_WEBHOOK_SECRET: "specrail-smoke-secret",
    }),
  },
  {
    service: "telegram",
    packageName: "@specrail/telegram",
    portEnv: "TELEGRAM_APP_PORT",
    expectedService: "specrail-telegram",
    extraEnv: async () => ({
      TELEGRAM_BOT_TOKEN: "123456:specrail-smoke-token",
    }),
  },
];

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
          return;
        }
        reject(new Error("failed to allocate a local port"));
      });
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHealth(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json();
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(url, expectedService, timeoutMs) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await fetchHealth(url, 1_000);
      if (result.status === 200 && result.body?.ok === true && result.body?.service === expectedService) {
        return;
      }
      lastError = new Error(`unexpected health response ${result.status}: ${JSON.stringify(result.body)}`);
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }

  throw lastError ?? new Error(`timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function checkBuiltServiceHealth(rootDir = process.cwd(), checks = builtServiceHealthChecks) {
  const failures = [];

  for (const check of checks) {
    const port = await allocatePort();
    const extraEnv = await check.extraEnv();
    const child = spawn("pnpm", ["--filter", check.packageName, "start:built"], {
      cwd: rootDir,
      env: {
        ...process.env,
        ...extraEnv,
        [check.portEnv]: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk.toString()));
    child.stderr.on("data", (chunk) => output.push(chunk.toString()));

    try {
      await waitForHealth(`http://127.0.0.1:${port}/healthz`, check.expectedService, 5_000);
    } catch (error) {
      failures.push(`${check.service}: ${error instanceof Error ? error.message : String(error)}\n${output.join("").trim()}`);
    } finally {
      await stopProcess(child);
    }
  }

  return failures;
}

async function main() {
  const failures = await checkBuiltServiceHealth();

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log(`Checked ${builtServiceHealthChecks.length} built service health endpoints.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
