#!/usr/bin/env bash
#
# Run the integration lane end to end: migrate, seed, boot the API and the
# worker, run the suite, shut everything down.
#
# This exists because the sequence is fiddly and easy to get subtly wrong (the
# suite silently passing against a stale API is the failure mode), and because a
# flow run by hand twice should be a command the third time.
#
# The seed is part of the lane, not a prerequisite: it generates and transcodes
# the demo videos with the real pipeline, and those are the fixtures the media
# tests read. A stale media directory would make the suite prove nothing.
#
# Usage: ./scripts/integration.sh [vitest args...]
# Assumes Postgres and Redis are up (infra/docker-compose.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_LOG=/tmp/lms-integration-api.log
WORKER_LOG=/tmp/lms-integration-worker.log
API_PID=""
WORKER_PID=""

cleanup() {
  for pid in "$WORKER_PID" "$API_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export DATABASE_URL="${DATABASE_URL:-postgresql://lms:lms@localhost:5435/lms?schema=public}"
# Prisma requires directUrl to be set; without a pooler locally it is the same.
export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6382}"
export AUTH_SECRET="${AUTH_SECRET:-ci-secret-at-least-32-characters-long}"
export MEDIA_ROOT="${MEDIA_ROOT:-./var/media}"
export API_PORT="${API_PORT:-4000}"
export API_BASE_URL="${API_BASE_URL:-http://localhost:${API_PORT}}"
# The concurrency test fires ten simultaneous certificate requests from one
# address, which a production-shaped per-IP budget is supposed to refuse.
# Raising it here keeps the production defaults honest instead of weakening them
# to make a test pass.
export RATE_LIMIT_GLOBAL=100000
export RATE_LIMIT_AUTH=100000
export RATE_LIMIT_MEDIA=100000

# ffmpeg is not optional for this lane: it is what the media tests are testing.
# Failing here with a clear message beats forty seconds of confusing transcode
# errors.
for binary in "${FFMPEG_PATH:-ffmpeg}" "${FFPROBE_PATH:-ffprobe}"; do
  if ! command -v "$binary" >/dev/null 2>&1 && [[ ! -x "$binary" ]]; then
    echo "$binary is required for the integration lane but was not found." >&2
    echo "  Debian/Ubuntu: sudo apt install ffmpeg" >&2
    exit 1
  fi
done

# A leftover dev server on the port is the nastiest failure mode this script has:
# the new API fails to bind, the suite happily talks to the stale one, and the
# results describe code that is no longer on disk. Refuse to start instead.
if curl -sf "${API_BASE_URL}/health" >/dev/null 2>&1; then
  echo "Something is already serving ${API_BASE_URL}. Stop it first:" >&2
  echo "  pkill -f 'apps/api/dist/main.js'" >&2
  exit 1
fi

echo "==> Applying migrations"
pnpm --filter @lms/db exec prisma migrate deploy >/dev/null

echo "==> Building the API, the worker and the packages they import"
pnpm --filter @lms/shared --filter @lms/db --filter @lms/media \
  --filter @lms/certificates --filter @lms/notifications \
  --filter @lms/api --filter @lms/worker run build >/dev/null

echo "==> Seeding (generates and transcodes the demo videos)"
pnpm --filter @lms/db run seed

echo "==> Starting the API on :${API_PORT} (log: ${API_LOG})"
# Started as plain `node`, not through pnpm or the Nest CLI. Killing a wrapper
# only kills the wrapper: `nest start` spawns `node dist/main` as a grandchild,
# which survives, keeps the port, and makes the next run silently test a stale
# server. `$!` here is the process that actually holds the socket.
node apps/api/dist/main.js >"$API_LOG" 2>&1 &
API_PID=$!

echo "==> Starting the worker (log: ${WORKER_LOG})"
# /health checks the worker heartbeat, so the API reports degraded without one
# and the health smoke test would fail for the wrong reason.
node apps/worker/dist/main.js >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!

echo "==> Waiting for /health"
for _ in $(seq 1 90); do
  if curl -sf "${API_BASE_URL}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "API exited before becoming healthy:" >&2
    tail -30 "$API_LOG" >&2
    exit 1
  fi
  sleep 1
done

if ! curl -sf "${API_BASE_URL}/health" >/dev/null 2>&1; then
  echo "API never became healthy:" >&2
  curl -s "${API_BASE_URL}/health" || true
  tail -30 "$API_LOG" >&2
  exit 1
fi

echo "==> Running the integration suite"
pnpm --filter @lms/api run test:integration -- "$@"
