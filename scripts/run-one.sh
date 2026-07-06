#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# run-one.sh — 跑单个压测场景
#
# 用法:
#   ./run-one.sh <impl> <scenario> [concurrency] [mode] [run_id]
#
# 参数:
#   impl       rust | go | node | python | upstream-direct | nginx
#   scenario   H1 | H2 | H3 | H4 | H5 | H6 | H7
#   concurrency  并发数(默认 10)
#   mode       buffered | streaming(默认 buffered,仅 H4/H6/H7 生效)
#   run_id     第几轮标记(默认 1)
#
# 环境变量:
#   K6_BIN     k6 可执行文件路径(默认 ~/bin/k6)
#   SERVICE_HOST  在哪台机器启动服务(xyz-mac / jd / local,默认 local)
#   VERBOSE    1=打印详细日志
#
# 输出:
#   results/<YYYY-MM-DD>-<host>/raw/<impl>-<scenario>-c<concurrency>-<mode>-run<run_id>.json
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

# 参数
IMPL="${1:?"Usage: $0 <impl> <scenario> [concurrency] [mode] [run_id]"}"
SCENARIO="${2:?"Usage: $0 <impl> <scenario> [concurrency] [mode] [run_id]"}"
CONCURRENCY="${3:-10}"
MODE="${4:-buffered}"
RUN_ID="${5:-1}"

K6_BIN="${K6_BIN:-$HOME/bin/k6}"
SERVICE_HOST="${SERVICE_HOST:-local}"
VERBOSE="${VERBOSE:-0}"

APP_DIR="$PROJECT_DIR/apps"
UPSTREAM_DIR="$APP_DIR/upstream-echo"
GATEWAY_DIR="$APP_DIR/gateway-$IMPL"
K6_SCRIPT="$PROJECT_DIR/bench/k6/http-${SCENARIO}.js"

DATE=$(date +%Y-%m-%d)
MACHINE_LABEL="${SERVICE_HOST}"
[[ "$SERVICE_HOST" == "local" ]] && MACHINE_LABEL="$(hostname | cut -d. -f1)"
RESULT_DIR="$PROJECT_DIR/results/${DATE}-${MACHINE_LABEL}/raw"
PID_DIR="/tmp/gatebench-pids"

PORT_UPSTREAM=9000
PORT_GATEWAY=8080
UPSTREAM_BASE="http://localhost:$PORT_UPSTREAM"

# --- helpers ---
log() { if [[ "$VERBOSE" == "1" ]]; then echo "[$(date +%H:%M:%S)] $*"; fi; }
die() { echo "ERROR: $*" >&2; exit 1; }
cleanup() {
  log "Cleaning up..."
  [[ -f "$PID_DIR/upstream.pid" ]] && kill "$(cat "$PID_DIR/upstream.pid")" 2>/dev/null && rm -f "$PID_DIR/upstream.pid"
  [[ -f "$PID_DIR/gateway.pid" ]] && kill "$(cat "$PID_DIR/gateway.pid")" 2>/dev/null && rm -f "$PID_DIR/gateway.pid"
}
trap cleanup EXIT

mkdir -p "$RESULT_DIR" "$PID_DIR"

# --- validate ---
[[ -f "$K6_BIN" ]] || die "k6 not found at $K6_BIN (install or set K6_BIN)"
[[ "$SCENARIO" =~ ^H[1-7]$ ]] || die "Unknown scenario: $SCENARIO (use H1-H7)"
case "$IMPL" in
  rust|go|node|python|upstream-direct|nginx) ;;
  *) die "Unknown impl: $IMPL" ;;
esac

echo "==============================================="
echo "  Run:    $IMPL × $SCENARIO"
echo "  Concurrency: $CONCURRENCY"
echo "  Mode:   $MODE"
echo "  Host:   $MACHINE_LABEL"
echo "  Result: $RESULT_DIR"
echo "==============================================="

# --- 1. Start upstream-echo ---
log "Starting upstream-echo (port $PORT_UPSTREAM)..."
UPSTREAM_BIN="$UPSTREAM_DIR/upstream-echo"
if [[ ! -x "$UPSTREAM_BIN" ]]; then
  cd "$UPSTREAM_DIR" && go build -o "$(basename "$UPSTREAM_BIN")" . && cd "$PROJECT_DIR"
fi
PORT=$PORT_UPSTREAM "$UPSTREAM_BIN" &
echo $! > "$PID_DIR/upstream.pid"
sleep 1
# quick health check
curl -sf "http://localhost:$PORT_UPSTREAM/health" >/dev/null 2>&1 || die "upstream-echo failed to start"

# --- 2. Start gateway ---
if [[ "$IMPL" == "upstream-direct" ]]; then
  log "Using upstream-direct (no gateway, directly proxied)"
  GATEWAY_BIN="$UPSTREAM_BIN"
  PORT_GATEWAY=$PORT_UPSTREAM
elif [[ "$IMPL" == "nginx" ]]; then
  log "Using nginx gateway"
  # assumes nginx is already configured and running
  PORT_GATEWAY=8080
else
  log "Starting gateway-$IMPL (port $PORT_GATEWAY)..."
  case "$IMPL" in
    go)
      GATEWAY_BIN="$GATEWAY_DIR/gateway-$IMPL"
      if [[ ! -x "$GATEWAY_BIN" ]]; then
        cd "$GATEWAY_DIR" && go build -o "$(basename "$GATEWAY_BIN")" . && cd "$PROJECT_DIR"
      fi
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE="$MODE" "$GATEWAY_BIN" &
      echo $! > "$PID_DIR/gateway.pid"
      ;;
    rust)
      cd "$GATEWAY_DIR" && cargo build --release -q 2>&1 && cd "$PROJECT_DIR"
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE="$MODE" "$GATEWAY_DIR/target/release/gateway-rust" &
      echo $! > "$PID_DIR/gateway.pid"
      ;;
    node)
      cd "$GATEWAY_DIR" && npm start > /dev/null 2>&1 &
      echo $! > "$PID_DIR/gateway.pid"
      cd "$PROJECT_DIR"
      sleep 2
      ;;
    python)
      cd "$GATEWAY_DIR"
      pip install -q -r requirements.txt 2>/dev/null || true
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE="$MODE" uvicorn src.main:app --port $PORT_GATEWAY --workers 1 &
      echo $! > "$PID_DIR/gateway.pid"
      cd "$PROJECT_DIR"
      sleep 2
      ;;
  esac
  sleep 2
  curl -sf "http://localhost:$PORT_GATEWAY/health" >/dev/null 2>&1 || die "gateway-$IMPL health check failed"
fi

# --- 3. Run k6 ---
RESULT_FILE="$RESULT_DIR/${IMPL}-${SCENARIO}-c${CONCURRENCY}-${MODE}-run${RUN_ID}.json"
log "Running k6 (-> $RESULT_FILE)..."

TARGET_URL="http://localhost:$PORT_GATEWAY"

# Map scenario ID to k6 script filename
case "$SCENARIO" in
  H1) K6_FILE="http-get" ;;
  H2) K6_FILE="http-proxy-small" ;;
  H3) K6_FILE="http-json-large" ;;
  H4) K6_FILE="http-upload" ;;
  H5) K6_FILE="http-upload-instant" ;;
  H6) K6_FILE="http-large-response" ;;
  H7) K6_FILE="http-binary-response" ;;
  *) die "Unknown scenario: $SCENARIO" ;;
esac
K6_SCRIPT_FILE="$PROJECT_DIR/bench/k6/${K6_FILE}.js"
[[ -f "$K6_SCRIPT_FILE" ]] || die "k6 script not found: $K6_SCRIPT_FILE"
[[ -f "$K6_SCRIPT_FILE" ]] || die "k6 script not found: $K6_SCRIPT_FILE"

cd "$PROJECT_DIR"
TARGET_URL="$TARGET_URL" CONCURRENCY="$CONCURRENCY" DURATION_SEC="${DURATION_SEC:-60}" \
  HASH_HIT_RATE="${HASH_HIT_RATE:-50}" \
  "$K6_BIN" run "$K6_SCRIPT_FILE" \
    --vus "$CONCURRENCY" \
    --duration "${DURATION_SEC:-60}s" \
    --summary-export="$RESULT_FILE" \
    --quiet \
    2>&1 | tail -3

echo "Done: $RESULT_FILE"
