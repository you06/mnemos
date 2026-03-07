#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---------------------------------------------------------------------------
# Configuration (override via env vars)
# ---------------------------------------------------------------------------
TIDB_VERSION="${TIDB_VERSION:-v8.5.5}"
DB_HOST="${MNEMO_DB_HOST:-127.0.0.1}"
DB_PORT="${MNEMO_DB_PORT:-4000}"
DB_USER="${MNEMO_DB_USER:-root}"
DB_PASS="${MNEMO_DB_PASS:-}"
DB_NAME="${MNEMO_DB_NAME:-test}"
SERVER_PORT="${MNEMO_BENCH_PORT:-18081}"

DSN="${DB_USER}${DB_PASS:+:${DB_PASS}}@tcp(${DB_HOST}:${DB_PORT})/${DB_NAME}?parseTime=true"

# ---------------------------------------------------------------------------
# Cleanup on exit
# ---------------------------------------------------------------------------
SERVER_PID=""
TIUP_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    echo "--- Stopping mnemo-server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$TIUP_PID" ]]; then
    echo "--- Stopping tiup playground (pid $TIUP_PID)"
    kill "$TIUP_PID" 2>/dev/null || true
    wait "$TIUP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Start TiDB via tiup playground
# ---------------------------------------------------------------------------
echo "--- Starting tiup playground ${TIDB_VERSION}"
tiup playground "$TIDB_VERSION" --without-monitor --tiflash=0 \
  --host "$DB_HOST" --db.port "$DB_PORT" \
  > /tmp/mnemo-bench-tiup.log 2>&1 &
TIUP_PID=$!

# Wait for TiDB to accept connections
echo "    Waiting for TiDB at ${DB_HOST}:${DB_PORT}..."
for i in $(seq 1 60); do
  if MYSQL_PWD="$DB_PASS" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
       -e "SELECT 1" >/dev/null 2>&1; then
    echo "    TiDB ready."
    break
  fi
  if ! kill -0 "$TIUP_PID" 2>/dev/null; then
    echo "ERROR: tiup playground exited unexpectedly. Logs:"
    tail -50 /tmp/mnemo-bench-tiup.log
    exit 1
  fi
  sleep 1
done

if ! MYSQL_PWD="$DB_PASS" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
     -e "SELECT 1" >/dev/null 2>&1; then
  echo "ERROR: TiDB failed to start within 60s. Logs:"
  tail -50 /tmp/mnemo-bench-tiup.log
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Apply schema
# ---------------------------------------------------------------------------
echo "--- Applying schema to ${DB_HOST}:${DB_PORT}/${DB_NAME}"
# TiDB doesn't support DEFAULT on JSON columns — strip it before applying.
sed "s/JSON\s\+NOT NULL DEFAULT\s\+('{}'/JSON/g" "$ROOT/server/schema.sql" \
  | MYSQL_PWD="$DB_PASS" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -D "$DB_NAME"
echo "    Schema applied."

# ---------------------------------------------------------------------------
# 2. Build & start server
# ---------------------------------------------------------------------------
echo "--- Building mnemo-server"
cd "$ROOT/server"
go build -o "$ROOT/server/mnemo-server" ./cmd/mnemo-server

echo "--- Starting mnemo-server on port $SERVER_PORT"
MNEMO_DSN="$DSN" MNEMO_PORT="$SERVER_PORT" "$ROOT/server/mnemo-server" \
  > /tmp/mnemo-bench-server.log 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${SERVER_PORT}/healthz" >/dev/null 2>&1; then
    echo "    Server ready (pid $SERVER_PID)."
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: Server exited unexpectedly. Logs:"
    cat /tmp/mnemo-bench-server.log
    exit 1
  fi
  sleep 0.5
done

if ! curl -sf "http://localhost:${SERVER_PORT}/healthz" >/dev/null 2>&1; then
  echo "ERROR: Server failed to start within 15s. Logs:"
  cat /tmp/mnemo-bench-server.log
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Install benchmark deps (if needed)
# ---------------------------------------------------------------------------
cd "$ROOT/benchmarks"
if [[ ! -d node_modules ]]; then
  echo "--- Installing benchmark dependencies"
  npm install --silent
fi

# ---------------------------------------------------------------------------
# 4. Run all benchmark tests
# ---------------------------------------------------------------------------
echo "--- Running benchmarks"
MNEMO_BENCH_API_URL="http://localhost:${SERVER_PORT}" npm test
