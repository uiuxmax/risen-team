#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Risen Team Schedule Builder - macOS launcher
#
#  Starts the bundled Next.js standalone server on loopback only and opens the
#  browser once the application has confirmed it is healthy.
#
#  Rules this script is written against (same contract as
#  scripts/windows-launcher.ps1):
#    * fixed port 3178, bound to 127.0.0.1 only;
#    * a normal launch never runs `npm install` and never builds;
#    * a repeated launch reuses a running Risen instance found via /api/health;
#    * an unrelated service on 3178 is never killed;
#    * the browser opens only after a successful health response;
#    * user data lives in ~/Library/Application Support/RisenTeamSchedule-v1.0,
#      while source checkouts keep existing data/risen-team.db; RISEN_DB_PATH wins.
#
#  Usage:  ./start.command            start the app and open the browser
#          ./start.command --no-browser
# ---------------------------------------------------------------------------
set -euo pipefail

APP_IDENTITY="risen-team-schedule-builder-v1"
PORT=3178
BIND_ADDRESS="127.0.0.1"
BASE_URL="http://${BIND_ADDRESS}:${PORT}"
HEALTH_URL="${BASE_URL}/api/health"
MINIMUM_NODE_MAJOR=22
DATA_FOLDER_NAME="RisenTeamSchedule-v1.0"
PACKAGE_FOLDER_NAME="RisenTeamSchedule"
LOG_FILES_TO_KEEP=5
TIMEOUT_SECONDS=45

OPEN_BROWSER=1
for argument in "$@"; do
  case "$argument" in
    --no-browser|-n) OPEN_BROWSER=0 ;;
    --timeout=*) TIMEOUT_SECONDS="${argument#*=}" ;;
    *) ;;
  esac
done

case "$TIMEOUT_SECONDS" in
  ''|*[!0-9]*) TIMEOUT_SECONDS=45 ;;
esac

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Risen Team Schedule Builder"
echo "Application folder : $APP_ROOT"

# ---------------------------------------------------------------------------
# Data location. The explicit override is preserved exactly as the app's own
# RISEN_DB_PATH handling expects it; otherwise the macOS user-support folder is
# used so the database survives replacing or deleting the application folder.
# ---------------------------------------------------------------------------
if [ -n "${RISEN_DB_PATH:-}" ] && [ -n "$(printf '%s' "$RISEN_DB_PATH" | tr -d '[:space:]')" ]; then
  DATABASE_PATH="$RISEN_DB_PATH"
  echo "Database (override): $DATABASE_PATH"
elif [ -f "$APP_ROOT/data/risen-team.db" ]; then
  DATABASE_PATH="$APP_ROOT/data/risen-team.db"
  echo "Database (source)  : $DATABASE_PATH"
else
  DATABASE_PATH="$HOME/Library/Application Support/$DATA_FOLDER_NAME/risen-team.db"
  echo "Database           : $DATABASE_PATH"
fi

DATA_DIRECTORY="$(dirname "$DATABASE_PATH")"
LOG_DIRECTORY="$DATA_DIRECTORY/logs"

# ---------------------------------------------------------------------------
# Health probing. `probe` writes the HTTP status to stdout and the response
# body to $PROBE_BODY, so "nothing is listening", "an unrelated service is
# listening" and "Risen answered" stay three distinguishable outcomes.
# ---------------------------------------------------------------------------
PROBE_BODY="$(mktemp "${TMPDIR:-/tmp}/risen-health.XXXXXX")"
trap 'rm -f "$PROBE_BODY"' EXIT

probe() {
  : >"$PROBE_BODY"
  local code
  code="$(curl --silent --show-error --max-time 3 \
    --output "$PROBE_BODY" --write-out '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
  case "$code" in
    ''|*[!0-9]*) code=000 ;;
  esac
  printf '%s' "$code"
}

# Prints the `app` field of the JSON body, or nothing when it is absent.
identity_from_body() {
  [ -s "$PROBE_BODY" ] || return 0
  # Prefer a real JSON parser when the machine has one; fall back to a narrow
  # field read so the launcher still works without extra dependencies.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$PROBE_BODY" <<'PY' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    sys.exit(0)
if isinstance(data, dict) and isinstance(data.get("app"), str):
    sys.stdout.write(data["app"])
PY
    return 0
  fi
  grep -o '"app"[[:space:]]*:[[:space:]]*"[^"]*"' "$PROBE_BODY" 2>/dev/null \
    | head -n 1 | sed -E 's/.*:[[:space:]]*"([^"]*)".*/\1/' || true
}

CODE="$(probe)"

if [ "$CODE" != "000" ]; then
  IDENTITY="$(identity_from_body)"
  if [ "$IDENTITY" = "$APP_IDENTITY" ]; then
    if [ "$CODE" = "200" ]; then
      # Repeated launch: reuse the running instance instead of fighting for it.
      echo "Already running - opening the existing instance."
      if [ "$OPEN_BROWSER" -eq 1 ]; then open "$BASE_URL"; fi
      echo "$BASE_URL"
      exit 0
    fi

    # Existing Risen instance, but unhealthy (e.g. HTTP 500).
    echo "[Risen] Risen Team Schedule Builder is already running on port $PORT, but its health check is failing (HTTP $CODE)." >&2
    echo "[Risen] Close/restart the existing Risen process and check the server log." >&2
    exit 5
  fi

  # Something else owns the port. Never kill it.
  if [ -n "$IDENTITY" ]; then
    OTHER="another application ('$IDENTITY')"
  else
    OTHER="an unrelated service"
  fi
  echo "[Risen] Port $PORT is already in use by $OTHER, not by $APP_IDENTITY." >&2
  echo "[Risen] This launcher will not stop or replace another application." >&2
  echo "[Risen] Close that application yourself, free the port, then run again." >&2
  exit 4
fi

# ---------------------------------------------------------------------------
# Locate an already-built standalone server. The launcher never builds it.
#
# SOURCE CHECKOUT vs END-USER PACKAGE:
#   - Source checkout: `npm run build` alone produces `.next/standalone`
#     WITHOUT `.next/static` and `public` copied into the standalone folder.
#     Launching that directly would show unstyled HTML.
#     The root launcher therefore prefers the prepared portable staging
#     `dist/portable/RisenTeamSchedule/` which is known to be complete.
#   - Portable release: APP_ROOT itself contains server.js + .next/static + public.
#   - If only an incomplete `.next/standalone` exists, we fail clearly and tell
#     the developer to run `npm run prepare:portable` instead of opening a broken UI.
# ---------------------------------------------------------------------------
is_complete_server_dir() {
  local dir="$1"
  [ -n "$dir" ] || return 1
  [ -f "$dir/server.js" ] || return 1
  # Next.js standalone requires `.next/static` for CSS/JS.
  [ -d "$dir/.next/static" ] || return 1
  return 0
}

SERVER_DIRECTORY=""
CANDIDATES=(
  "$APP_ROOT/dist/portable/$PACKAGE_FOLDER_NAME/server.js"
  "$APP_ROOT/server.js"
  "$APP_ROOT/.next/standalone/server.js"
)

for candidate in "${CANDIDATES[@]}"; do
  if [ -f "$candidate" ]; then
    dir="$(dirname "$candidate")"
    if is_complete_server_dir "$dir"; then
      SERVER_DIRECTORY="$dir"
      break
    fi
  fi
done

if [ -z "$SERVER_DIRECTORY" ]; then
  STANDALONE_SERVER="$APP_ROOT/.next/standalone/server.js"
  STANDALONE_DIR="$APP_ROOT/.next/standalone"
  if [ -f "$STANDALONE_SERVER" ]; then
    if [ ! -d "$STANDALONE_DIR/.next/static" ]; then
      cat >&2 <<EOF
[Risen] Incomplete production build found in:
  $STANDALONE_DIR

Next.js standalone output does NOT automatically contain .next/static and public
in the correct runtime location. Launching it directly would show unstyled HTML
and a stuck loading screen.

Fix it by staging a complete portable bundle:

  npm run build
  npm run prepare:portable

Then launch either:
  dist/portable/$PACKAGE_FOLDER_NAME/start.command   (preferred, complete)
  or re-run this root start.command which will now pick the prepared package.

The end-user ZIP always runs the prepared portable layout and never this incomplete
standalone folder.
EOF
      exit 3
    fi
  fi

  cat >&2 <<EOF
[Risen] No built application was found in:
  $APP_ROOT

This launcher intentionally does not install dependencies or build the app.
Build it once, then launch:

  npm ci
  npm run build
  npm run prepare:portable

After that, start either:
  dist/portable/$PACKAGE_FOLDER_NAME/start.command   (source checkout, preferred)
  or the extracted portable release's own start.command (end-user)

Both work offline with no further npm commands.
EOF
  exit 3
fi

# Nothing is created on disk until the launcher knows it can actually start
# something, so a mistaken run leaves no stray user-data folder behind.
mkdir -p "$DATA_DIRECTORY" "$LOG_DIRECTORY"
echo "Logs               : $LOG_DIRECTORY"

echo "Server             : $SERVER_DIRECTORY/server.js"

# ---------------------------------------------------------------------------
# Node resolution: a runtime bundled with the portable release is preferred,
# because it is the exact version the bundle was built against. A system Node
# is the fallback, and only when it is new enough.
# ---------------------------------------------------------------------------
NODE_EXECUTABLE=""
BUNDLED_NODE="$APP_ROOT/runtime/node/bin/node"

if [ -x "$BUNDLED_NODE" ]; then
  NODE_EXECUTABLE="$BUNDLED_NODE"
  echo "Node (bundled)     : $NODE_EXECUTABLE"
elif command -v node >/dev/null 2>&1; then
  NODE_VERSION_TEXT="$(node --version 2>/dev/null || true)"
  NODE_MAJOR="$(printf '%s' "$NODE_VERSION_TEXT" | sed -nE 's/^v([0-9]+)\..*/\1/p')"
  if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt "$MINIMUM_NODE_MAJOR" ]; then
    echo "[Risen] Node.js $NODE_VERSION_TEXT is too old. Node $MINIMUM_NODE_MAJOR or newer is required." >&2
    echo "[Risen] Update Node.js from https://nodejs.org and run this launcher again." >&2
    exit 2
  fi
  NODE_EXECUTABLE="$(command -v node)"
  echo "Node (system)      : $NODE_EXECUTABLE ($NODE_VERSION_TEXT)"
else
  cat >&2 <<EOF
[Risen] Node.js was not found.

Install Node.js $MINIMUM_NODE_MAJOR or newer from https://nodejs.org and run this
launcher again, or ship a bundled runtime in:
  $BUNDLED_NODE
EOF
  exit 2
fi

# ---------------------------------------------------------------------------
# Start the server. PORT/HOSTNAME are the standalone server's own knobs;
# HOSTNAME is pinned to loopback so nothing is reachable from the network.
# Logs rotate beside the user data.
# ---------------------------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_LOG="$LOG_DIRECTORY/server-$STAMP.out.log"
ERR_LOG="$LOG_DIRECTORY/server-$STAMP.err.log"

# Keep the log folder from growing without bound (oldest removed first).
# On a first launch there are no logs yet, and an unmatched glob makes `ls` exit
# non-zero; under `set -o pipefail` that would abort the launcher before it ever
# started the server, so the listing is captured defensively.
STALE_LOGS="$(ls -1t "$LOG_DIRECTORY"/server-*.log 2>/dev/null | tail -n +$((LOG_FILES_TO_KEEP + 1)) || true)"
if [ -n "$STALE_LOGS" ]; then
  while IFS= read -r STALE_LOG; do
    if [ -n "$STALE_LOG" ]; then rm -f "$STALE_LOG"; fi
  done <<<"$STALE_LOGS"
fi

echo "Starting server on $BASE_URL ..."

PORT="$PORT" \
HOSTNAME="$BIND_ADDRESS" \
NODE_ENV=production \
RISEN_DB_PATH="$DATABASE_PATH" \
  nohup "$NODE_EXECUTABLE" "$SERVER_DIRECTORY/server.js" >"$OUT_LOG" 2>"$ERR_LOG" &

SERVER_PID=$!
echo "Server process PID : $SERVER_PID"

# ---------------------------------------------------------------------------
# Wait for a real health response before opening anything.
# ---------------------------------------------------------------------------
READY=0
DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi

  ATTEMPT="$(probe)"
  if [ "$ATTEMPT" != "000" ]; then
    ATTEMPT_IDENTITY="$(identity_from_body)"
    if [ "$ATTEMPT_IDENTITY" = "$APP_IDENTITY" ]; then
      if [ "$ATTEMPT" = "200" ]; then
        READY=1
        break
      fi
      echo "Health responded $ATTEMPT - waiting for the database to open ..."
    fi
  fi
  sleep 0.4
done

if [ "$READY" -ne 1 ]; then
  echo "[Risen] The server did not become healthy on $BASE_URL within $TIMEOUT_SECONDS seconds." >&2
  echo "[Risen] Nothing was opened in the browser. Recent output:" >&2
  echo "  $OUT_LOG" >&2
  echo "  $ERR_LOG" >&2
  if [ -s "$ERR_LOG" ]; then
    echo "--- last lines of server error log ---"
    tail -n 20 "$ERR_LOG"
  fi
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[Risen] The server process (PID $SERVER_PID) is still running; stop it before retrying."
  fi
  exit 5
fi

echo "Healthy. Risen Team Schedule Builder is running on $BASE_URL"

if [ "$OPEN_BROWSER" -eq 1 ]; then
  # Only now: the tab opens against an app that already confirmed it serves.
  open "$BASE_URL"
fi

exit 0
