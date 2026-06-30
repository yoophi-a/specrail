CREATE TABLE github_relay_jobs (
  id text PRIMARY KEY,
  repository_full_name text NOT NULL,
  issue_number integer NOT NULL,
  run_id text NOT NULL,
  report_url text,
  operator_url text,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  next_attempt_at timestamptz,
  last_error text
);

CREATE INDEX github_relay_jobs_claim_idx
  ON github_relay_jobs (status, next_attempt_at, created_at)
  WHERE status = 'pending';
