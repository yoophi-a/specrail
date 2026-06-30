#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(root, "docs/sql/github-relay-jobs.sql");
const defaultTableName = "github_relay_jobs";
const defaultIndexName = "github_relay_jobs_claim_idx";

function usage() {
  return `Usage: node scripts/bootstrap-github-relay-postgres.mjs [--dry-run|--apply] [--table <name>] [--database-url <url>]

Options:
  --dry-run          Print the SQL that would be applied. This is the default.
  --apply            Apply the SQL with psql. Requires GITHUB_RELAY_QUEUE_POSTGRES_URL or DATABASE_URL.
  --table <name>     Relay table name. Defaults to GITHUB_RELAY_QUEUE_POSTGRES_TABLE or github_relay_jobs.
  --database-url     PostgreSQL URL. Defaults to GITHUB_RELAY_QUEUE_POSTGRES_URL or DATABASE_URL.
  --help             Show this help.
`;
}

function readArgs(argv) {
  const options = {
    apply: false,
    tableName: process.env.GITHUB_RELAY_QUEUE_POSTGRES_TABLE ?? defaultTableName,
    databaseUrl: process.env.GITHUB_RELAY_QUEUE_POSTGRES_URL ?? process.env.DATABASE_URL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--table") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--table requires a value");
      }
      options.tableName = value;
      index += 1;
      continue;
    }
    if (arg === "--database-url") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--database-url requires a value");
      }
      options.databaseUrl = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function assertSafePostgresIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`invalid PostgreSQL relay queue table name: ${identifier}`);
  }
  return identifier;
}

function claimIndexName(tableName) {
  if (tableName === defaultTableName) {
    return defaultIndexName;
  }

  const hash = createHash("sha256").update(tableName).digest("hex").slice(0, 12);
  return `github_relay_${hash}_claim_idx`;
}

async function renderSchema(tableName) {
  const source = await readFile(schemaPath, "utf8");
  const safeTableName = assertSafePostgresIdentifier(tableName);
  const safeIndexName = claimIndexName(safeTableName);

  return source
    .replaceAll(defaultIndexName, safeIndexName)
    .replaceAll(defaultTableName, safeTableName);
}

async function applySchema(input) {
  const child = spawn("psql", ["--set", "ON_ERROR_STOP=1", input.databaseUrl], {
    stdio: ["pipe", "inherit", "inherit"],
  });

  child.stdin.end(input.sql);

  const exitCode = await new Promise((resolveExit) => {
    child.on("close", resolveExit);
  });

  if (exitCode !== 0) {
    throw new Error(`psql exited with code ${exitCode}`);
  }
}

try {
  const options = readArgs(process.argv.slice(2));
  const sql = await renderSchema(options.tableName);

  if (!options.apply) {
    process.stdout.write(sql);
    if (!sql.endsWith("\n")) {
      process.stdout.write("\n");
    }
    process.exit(0);
  }

  if (!options.databaseUrl) {
    throw new Error("--apply requires GITHUB_RELAY_QUEUE_POSTGRES_URL, DATABASE_URL, or --database-url");
  }

  await applySchema({ databaseUrl: options.databaseUrl, sql });
  console.log(`Applied GitHub relay PostgreSQL schema for table ${options.tableName}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
