#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---------------------------------------------------------------------------
# Configuration (override via env vars)
# ---------------------------------------------------------------------------
TIDB_ZERO_API="${TIDB_ZERO_API:-https://zero.tidbapi.com/v1alpha1/instances}"
DB_NAME="${MNEMO_DB_NAME:-test}"
SERVER_PORT="${MNEMO_IT_PORT:-18081}"

# ---------------------------------------------------------------------------
# Cleanup on exit
# ---------------------------------------------------------------------------
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    echo "--- Stopping mnemo-server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Provision TiDB Zero cluster
# ---------------------------------------------------------------------------
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required but not installed."; exit 1; }

echo "--- Provisioning TiDB Zero cluster"
ZERO_RESP=$(curl -sf --retry 3 -X POST "$TIDB_ZERO_API" \
  -H "Content-Type: application/json" \
  -d '{"tag":"mnemo-it"}')

DB_HOST=$(echo "$ZERO_RESP" | jq -r '.instance.connection.host')
DB_PORT=$(echo "$ZERO_RESP" | jq -r '.instance.connection.port')
DB_USER=$(echo "$ZERO_RESP" | jq -r '.instance.connection.username')
DB_PASS=$(echo "$ZERO_RESP" | jq -r '.instance.connection.password')
CLUSTER_ID=$(echo "$ZERO_RESP" | jq -r '.instance.id')
CLAIM_URL=$(echo "$ZERO_RESP" | jq -r '.instance.claimInfo.claimUrl')

if [[ -z "$DB_HOST" || "$DB_HOST" == "null" ]]; then
  echo "ERROR: Failed to parse TiDB Zero response:"
  echo "$ZERO_RESP" | jq . 2>/dev/null || echo "$ZERO_RESP"
  exit 1
fi

echo "    Cluster ID: $CLUSTER_ID"
echo "    Host:       $DB_HOST:$DB_PORT"
echo "    Claim URL:  $CLAIM_URL"

DSN="${DB_USER}:${DB_PASS}@tcp(${DB_HOST}:${DB_PORT})/${DB_NAME}?parseTime=true&tls=true"

# Wait for TiDB Zero cluster to accept connections
echo "    Waiting for TiDB at ${DB_HOST}:${DB_PORT}..."
for i in $(seq 1 60); do
  if MYSQL_PWD="$DB_PASS" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
       --ssl-mode=REQUIRED -e "SELECT 1" >/dev/null 2>&1; then
    echo "    TiDB ready."
    break
  fi
  sleep 2
done

if ! MYSQL_PWD="$DB_PASS" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
     --ssl-mode=REQUIRED -e "SELECT 1" >/dev/null 2>&1; then
  echo "ERROR: TiDB Zero cluster failed to become ready within 120s."
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Apply schema
# ---------------------------------------------------------------------------
echo "--- Applying schema to ${DB_HOST}:${DB_PORT}/${DB_NAME}"
MYSQL_PWD="$DB_PASS" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -D "$DB_NAME" \
  --ssl-mode=REQUIRED < "$ROOT/server/schema.sql"
echo "    Schema applied."

# ---------------------------------------------------------------------------
# 2. Build & start server
# ---------------------------------------------------------------------------
echo "--- Building mnemo-server"
cd "$ROOT/server"
go build -o "$ROOT/server/mnemo-server" ./cmd/mnemo-server

echo "--- Starting mnemo-server on port $SERVER_PORT"
MNEMO_DSN="$DSN" MNEMO_PORT="$SERVER_PORT" "$ROOT/server/mnemo-server" \
  > /tmp/mnemo-it-server.log 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${SERVER_PORT}/healthz" >/dev/null 2>&1; then
    echo "    Server ready (pid $SERVER_PID)."
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: Server exited unexpectedly. Logs:"
    cat /tmp/mnemo-it-server.log
    exit 1
  fi
  sleep 0.5
done

if ! curl -sf "http://localhost:${SERVER_PORT}/healthz" >/dev/null 2>&1; then
  echo "ERROR: Server failed to start within 15s. Logs:"
  cat /tmp/mnemo-it-server.log
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Install integration test deps (if needed)
# ---------------------------------------------------------------------------
cd "$ROOT/integration-tests"
if [[ ! -d node_modules ]]; then
  echo "--- Installing integration test dependencies"
  npm install --silent
fi

# ---------------------------------------------------------------------------
# 4. Run all integration tests
# ---------------------------------------------------------------------------
echo "--- Running integration tests"
MNEMO_IT_API_URL="http://localhost:${SERVER_PORT}" npm test
