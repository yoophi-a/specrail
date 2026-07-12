#!/usr/bin/env bash
set -euo pipefail

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

normalize_bool() {
  local value
  value="$(trim "$1")"
  case "$value" in
    1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn])
      printf '1'
      ;;
    *)
      printf '0'
      ;;
  esac
}

STRICT_MODE="$(normalize_bool "${SPECRAIL_CLAUDE_SMOKE_STRICT:-0}")"
RUN_SMOKE="$(normalize_bool "${SPECRAIL_RUN_CLAUDE_SMOKE:-0}")"
SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-}"

note() {
  printf '%s\n' "$1"
  if [[ -n "$SUMMARY_FILE" ]]; then
    printf '%s\n' "$1" >> "$SUMMARY_FILE"
  fi
}

skip() {
  note "$1"
  if [[ "$STRICT_MODE" == "1" ]]; then
    exit 1
  fi
  exit 0
}

note "# Claude smoke CI"
note ""
note "- strict mode: \`${STRICT_MODE}\`"
note "- requested: \`${RUN_SMOKE}\`"
note ""

if [[ "$RUN_SMOKE" != "1" ]]; then
  skip "Claude smoke skipped because \`SPECRAIL_RUN_CLAUDE_SMOKE=1\` was not set."
fi

if ! command -v claude >/dev/null 2>&1; then
  skip "Claude smoke skipped because the \`claude\` CLI is not installed on this runner."
fi

note "## Environment"
note ""
note "- node: \`$(node --version)\`"
note "- pnpm: \`$(pnpm --version)\`"
note "- claude: \`$(claude --version)\`"
note "- model override: \`${CLAUDE_SMOKE_MODEL:-default}\`"
note ""

note "## Running smoke test"
note ""
if ! pnpm test:claude-smoke; then
  note ""
  note "Claude smoke failed. Inspect the test output above for readiness, metadata, event subtype, or raw-output diagnostics."
  exit 1
fi
note ""
note "Claude smoke passed."
