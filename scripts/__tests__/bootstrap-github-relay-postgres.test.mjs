import assert from "node:assert/strict";
import test from "node:test";

import { readArgs, renderSchema, validateApplyOptions } from "../bootstrap-github-relay-postgres.mjs";

test("bootstrap helper renders the default PostgreSQL relay schema", async () => {
  const sql = await renderSchema("github_relay_jobs");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS github_relay_jobs/u);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS github_relay_jobs_claim_idx/u);
  assert.match(sql, /ON github_relay_jobs \(status, next_attempt_at, created_at\)/u);
});

test("bootstrap helper renders custom table and claim index names", async () => {
  const sql = await renderSchema("specrail_relay_jobs");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS specrail_relay_jobs/u);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS github_relay_[a-f0-9]{12}_claim_idx/u);
  assert.match(sql, /ON specrail_relay_jobs \(status, next_attempt_at, created_at\)/u);
  assert.doesNotMatch(sql, /github_relay_jobs_claim_idx/u);
});

test("bootstrap helper rejects unsafe table names", async () => {
  await assert.rejects(() => renderSchema("bad-table"), /invalid PostgreSQL relay queue table name: bad-table/u);
});

test("bootstrap helper parses env defaults and validates apply mode database URL", () => {
  assert.deepEqual(readArgs([], { GITHUB_RELAY_QUEUE_POSTGRES_TABLE: " custom_jobs ", DATABASE_URL: " postgres://example/db " }), {
    apply: false,
    help: false,
    tableName: "custom_jobs",
    databaseUrl: "postgres://example/db",
  });

  assert.deepEqual(
    readArgs([], {
      GITHUB_RELAY_QUEUE_POSTGRES_TABLE: " ",
      GITHUB_RELAY_QUEUE_POSTGRES_URL: " ",
      DATABASE_URL: " postgres://example/fallback ",
    }),
    {
      apply: false,
      help: false,
      tableName: "github_relay_jobs",
      databaseUrl: "postgres://example/fallback",
    },
  );

  assert.deepEqual(readArgs(["--table", " cli_jobs ", "--database-url", " postgres://example/cli "], {}), {
    apply: false,
    help: false,
    tableName: "cli_jobs",
    databaseUrl: "postgres://example/cli",
  });

  assert.throws(() => readArgs(["--table", " "], {}), /--table requires a value/u);
  assert.throws(() => readArgs(["--database-url", " "], {}), /--database-url requires a value/u);
  assert.throws(() => validateApplyOptions(readArgs(["--apply"], {})), /--apply requires GITHUB_RELAY_QUEUE_POSTGRES_URL/u);
  assert.doesNotThrow(() => validateApplyOptions(readArgs(["--apply", "--database-url", "postgres://example/db"], {})));
});
