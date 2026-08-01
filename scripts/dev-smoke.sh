#!/usr/bin/env bash
#
# Smoke the documented developer command.
#
# scripts/env-contract.mjs proves the variables are declared. It cannot prove
# they arrive: that depends on package.json pointing "dev" at scripts/dev.sh, on
# dev.sh sourcing .env, and on turbo passing the names through. This boots the
# real `pnpm dev` and asserts the app serves.
#
# Why this is not folded into scripts/e2e.sh: that lane sources .env itself and
# starts the built apps directly, never touching turbo. It is a genuinely
# different path, and it stayed green while `pnpm dev` was broken. A lane that
# cannot fail the way the README fails is not covering it.
#
# Usage: ./scripts/dev-smoke.sh
# Assumes Postgres and Redis are up and the database is migrated and seeded.
set -euo pipefail

# Job control, so each background job lands in its own process group and the
# cleanup below can take down turbo *and* the next/nest/worker children it
# spawned. Killing only the turbo PID leaves servers holding :3000 and :4000,
# which makes the next run fail for a reason unrelated to the code.
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEV_PID=""
LOG=/tmp/lms-dev-smoke.log

# The seeded course. Its slug is stable, unlike the cuid primary keys, so the
# assertion below needs no database lookup.
COURSE_SLUG=adaptive-video-streaming
COURSE_TITLE='Adaptive Video Streaming, End to End'

cleanup() {
  if [[ -n "$DEV_PID" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    kill -- -"$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

[[ -f .env ]] || { echo "No .env. See README.md, 'Running it'." >&2; exit 1; }

# Read what the probes need WITHOUT sourcing .env.
#
# This is the difference between a real check and a vacuous one: a version of
# this script that did `set -a; . ./.env` put every variable into its own
# environment, where `pnpm dev` inherited them as an ordinary child process. It
# then passed with the fix reverted, because the app was being configured by the
# test rather than by the repo. A test that supplies the thing it is testing for
# proves nothing.
env_value() {
  sed -n "s/^[[:space:]]*$1=//p" .env | tail -1
}
API_BASE_URL="$(env_value API_BASE_URL)"
APP_BASE_URL="$(env_value APP_BASE_URL)"
API_BASE_URL="${API_BASE_URL:-http://localhost:4000}"
APP_BASE_URL="${APP_BASE_URL:-http://localhost:3000}"

# Every name .env defines is stripped from the child's environment, so the only
# way the app can see one is if dev.sh loaded it and turbo passed it through.
# That reproduces what a fresh clone experiences: a .env on disk, nothing in the
# shell.
mapfile -t ENV_KEYS < <(sed -n 's/^[[:space:]]*\([A-Z][A-Z0-9_]*\)=.*/\1/p' .env | sort -u)
UNSET_ARGS=()
for key in "${ENV_KEYS[@]}"; do UNSET_ARGS+=(-u "$key"); done

for url in "${API_BASE_URL}/health" "${APP_BASE_URL}/"; do
  if curl -sf "$url" >/dev/null 2>&1; then
    echo "Something is already serving ${url}. Stop it first." >&2
    exit 1
  fi
done

echo "==> Starting: pnpm dev (with every .env name stripped from the environment)"
env "${UNSET_ARGS[@]}" pnpm dev >"$LOG" 2>&1 &
DEV_PID=$!

# Dev-mode Next compiles a route on first request, so the first GET is slow by
# design. 120s covers a cold .next on a loaded machine without hiding a hang.
#
# The API is polled for *any* response rather than a 2xx: /health answers 503
# when a dependency is down, and a 503 that names the failing check is far more
# useful than a timeout that says nothing. The body is asserted below.
wait_for() {
  local url="$1" name="$2" mode="${3:-ok}"
  for _ in $(seq 1 120); do
    if [[ "$mode" == "any" ]]; then
      curl -s -o /dev/null "$url" && return 0
    elif curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi
    # A process that has already exited will never become healthy, and waiting
    # out the full timeout hides the reason it died.
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "pnpm dev exited before ${name} came up. Log:" >&2
      tail -40 "$LOG" >&2
      return 1
    fi
    sleep 1
  done
  echo "${name} never came up at ${url}. Log:" >&2
  tail -40 "$LOG" >&2
  return 1
}

wait_for "${API_BASE_URL}/health" api any
wait_for "${APP_BASE_URL}/" web

echo "==> Checking /health reports its dependencies"
health="$(curl -s "${API_BASE_URL}/health")"
# ffmpeg is checked but not required. Everything except transcoding works without
# it, and refusing to pass here would make the check about the machine's system
# packages rather than about whether the environment reached the app.
for dep in database redis mediaStorage worker; do
  if ! grep -q "\"${dep}\":true" <<<"$health"; then
    echo "/health does not report ${dep} healthy: ${health}" >&2
    exit 1
  fi
done
grep -q '"ffmpeg":true' <<<"$health" || echo "note: ffmpeg absent, transcoding is unavailable" >&2

# The load-bearing assertion. The course page is server rendered from the API, so
# the seeded title only appears if the web app actually reached it -- which only
# happens if AUTH_SECRET and API_BASE_URL survived the trip through turbo. A
# status-code check alone would pass on a 200 error page.
echo "==> Checking the course page rendered data from the API"
page="$(curl -sf "${APP_BASE_URL}/courses/${COURSE_SLUG}")"
if ! grep -qF "$COURSE_TITLE" <<<"$page"; then
  echo "/courses/${COURSE_SLUG} did not render the seeded course. It is an error page." >&2
  tail -40 "$LOG" >&2
  exit 1
fi

# The symptoms of the original bug, by name. Any of these in a dev log means the
# environment did not arrive, even if the pages happened to render.
echo "==> Checking the dev log is clean"
if grep -qE "ECONNREFUSED|MissingSecret|AUTH_SECRET is not set|AUTH_SECRET must be set" "$LOG"; then
  echo "pnpm dev logged an environment failure:" >&2
  grep -nE "ECONNREFUSED|MissingSecret|AUTH_SECRET is not set|AUTH_SECRET must be set" "$LOG" | head -5 >&2
  exit 1
fi

echo "==> OK: pnpm dev serves the course page, /health green on database + redis + media + worker"
