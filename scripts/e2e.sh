#!/usr/bin/env bash
#
# Run the E2E lane: migrate, reseed, boot api + worker + web, run Playwright,
# tear everything down.
#
# The reseed matters. The specs revoke enrollments, bank quiz attempts and
# create courses, so a second run against a used database would fail for reasons
# that have nothing to do with the code. The seed is idempotent and prunes what
# the suite leaves behind, which is what makes the lane repeatable.
#
# Usage: ./scripts/e2e.sh [playwright args...]
# Assumes Postgres and Redis are up (infra/docker-compose.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_PID=""
WORKER_PID=""
WEB_PID=""

cleanup() {
  for pid in "$WEB_PID" "$WORKER_PID" "$API_PID"; do
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
export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6382}"
export AUTH_SECRET="${AUTH_SECRET:-ci-secret-at-least-32-characters-long}"
export MEDIA_ROOT="${MEDIA_ROOT:-./var/media}"
export API_PORT="${API_PORT:-4000}"
export WEB_PORT="${WEB_PORT:-3000}"
export API_BASE_URL="${API_BASE_URL:-http://localhost:${API_PORT}}"
export APP_BASE_URL="${APP_BASE_URL:-http://localhost:${WEB_PORT}}"
export NEXT_PUBLIC_API_BASE_URL="$API_BASE_URL"
# Playing real video is ~150 segment requests per lesson from one address, and
# the suite drives several. Production keeps the defaults in .env.example.
export RATE_LIMIT_GLOBAL=100000
export RATE_LIMIT_AUTH=100000
export RATE_LIMIT_MEDIA=100000

for binary in "${FFMPEG_PATH:-ffmpeg}" "${FFPROBE_PATH:-ffprobe}"; do
  if ! command -v "$binary" >/dev/null 2>&1 && [[ ! -x "$binary" ]]; then
    echo "$binary is required for the E2E lane (the seed transcodes the demo videos)." >&2
    echo "  Debian/Ubuntu: sudo apt install ffmpeg" >&2
    exit 1
  fi
done

# A leftover server from an interrupted run is the worst failure mode here: the
# new process fails to bind, the suite talks to the stale one, and the results
# describe code that is no longer on disk. The API is probed on /health because
# its root path 404s, which `curl -f` would read as "nothing is listening".
for url in "${API_BASE_URL}/health" "${APP_BASE_URL}/"; do
  if curl -sf "$url" >/dev/null 2>&1; then
    echo "Something is already serving ${url}. Stop it first:" >&2
    echo "  pkill -f 'apps/api/dist/main.js'; pkill -f 'apps/worker/dist/main.js'; pkill -f 'next start'" >&2
    exit 1
  fi
done

echo "==> Migrating"
pnpm --filter @lms/db exec prisma migrate deploy >/dev/null

echo "==> Building"
# NODE_ENV=production is required: `next build` under development produces a
# broken prerender that the build itself reports as successful.
NODE_ENV=production pnpm build

echo "==> Seeding (generates and transcodes the demo videos)"
pnpm --filter @lms/db run seed

echo "==> Starting api, worker, web"
node apps/api/dist/main.js >/tmp/lms-e2e-api.log 2>&1 &
API_PID=$!
node apps/worker/dist/main.js >/tmp/lms-e2e-worker.log 2>&1 &
WORKER_PID=$!
pnpm --filter @lms/web exec next start -p "$WEB_PORT" >/tmp/lms-e2e-web.log 2>&1 &
WEB_PID=$!

wait_for() {
  local url="$1" name="$2" pid="$3"
  for _ in $(seq 1 120); do
    if curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi
    # A process that has already exited will never become healthy, and waiting
    # the full timeout to discover that hides the reason it died.
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "${name} exited during startup. Logs:" >&2
      tail -30 "/tmp/lms-e2e-${name}.log" >&2
      return 1
    fi
    sleep 1
  done
  echo "${name} never came up. Logs:" >&2
  tail -30 "/tmp/lms-e2e-${name}.log" >&2
  return 1
}

wait_for "${API_BASE_URL}/health" api "$API_PID"
wait_for "${APP_BASE_URL}/" web "$WEB_PID"

echo "==> Running Playwright"
pnpm --filter @lms/e2e exec playwright test "$@"
