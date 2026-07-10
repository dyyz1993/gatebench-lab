#!/usr/bin/env bash
set -uo pipefail

# ============================================================================
# run-ws-epyc.sh — WebSocket 基准测试
# 只跑支持 WS 的实现: node, python, upstream-direct
# ============================================================================

export PATH=$PATH:/usr/local/go/bin:/root/.cargo/bin
ulimit -n 65535

PROJECT_DIR="/root/gatebench-lab"
APP_DIR="$PROJECT_DIR/apps"
K6_BIN="/usr/local/bin/k6"
PYTHON_BIN="/etc/.hai/miniforge3/bin/python3"
WORKERS=8
DATE=$(date +%Y-%m-%d)
HOST_LABEL="tencent-epyc"
RESULT_DIR="$PROJECT_DIR/results/${DATE}-${HOST_LABEL}/raw"
PORT_UPSTREAM=9000
PORT_GATEWAY=8080
UPSTREAM_BASE="http://localhost:$PORT_UPSTREAM"
DURATION_SEC=30

mkdir -p "$RESULT_DIR"

kill_port() {
  local port="$1"
  for i in 1 2 3 4 5; do
    local pids=$(lsof -i :$port -t 2>/dev/null)
    if [ -n "$pids" ]; then
      echo "$pids" | xargs kill -9 2>/dev/null || true
      sleep 0.5
    fi
    if ! lsof -i :$port -t 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

run_ws() {
  local impl="$1" scenario="$2" concurrency="$3" msg_size="$4"
  
  local result_file=""
  if [ -z "$msg_size" ]; then
    result_file="$RESULT_DIR/${impl}-${scenario}-c${concurrency}-buffered-run1.json"
  else
    result_file="$RESULT_DIR/${impl}-${scenario}-c${concurrency}-msg${msg_size}-run1.json"
  fi

  # Skip if exists
  if [[ -f "$result_file" ]]; then
    local has_data=$(jq -r '.metrics.ws_sessions.rate // empty' "$result_file" 2>/dev/null)
    if [[ -n "$has_data" ]]; then
      echo "  SKIP (exists): $impl $scenario c=$concurrency (ws_sessions=$has_data)"
      return 0
    fi
  fi

  echo "  RUN: $impl $scenario c=$concurrency${msg_size:+ msg=$msg_size}"

  # Kill ports
  kill_port $PORT_GATEWAY
  kill_port $PORT_UPSTREAM
  
  # Start upstream
  PORT=$PORT_UPSTREAM "$APP_DIR/upstream-echo/upstream-echo" > /dev/null 2>&1 &
  local UP_PID=$!
  sleep 1
  curl -sf "http://localhost:$PORT_UPSTREAM/health" > /dev/null 2>&1 || { echo "    ❌ upstream failed"; return 1; }

  # Start gateway (only node/python/direct support WS)
  if [[ "$impl" == "upstream-direct" ]]; then
    PORT_GATEWAY=$PORT_UPSTREAM
  elif [[ "$impl" == "node" ]]; then
    cd "$APP_DIR/gateway-node"
    UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE=buffered PORT=$PORT_GATEWAY \
      NODE_ENV=production UV_THREADPOOL_SIZE=$WORKERS \
      node src/index.js > /dev/null 2>&1 &
    local GW_PID=$!
    cd "$PROJECT_DIR"
    sleep 2
    curl -sf "http://localhost:$PORT_GATEWAY/health" > /dev/null 2>&1 || { echo "    ❌ node health failed"; kill $UP_PID; return 1; }
  elif [[ "$impl" == "python" ]]; then
    cd "$APP_DIR/gateway-python"
    UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE=buffered \
      "$PYTHON_BIN" -m uvicorn src.main:app --port $PORT_GATEWAY \
      --workers $WORKERS --log-level error > /dev/null 2>&1 &
    local GW_PID=$!
    cd "$PROJECT_DIR"
    sleep 3
    curl -sf "http://localhost:$PORT_GATEWAY/health" > /dev/null 2>&1 || { echo "    ❌ python health failed"; kill $UP_PID; return 1; }
  else
    echo "    ❌ $impl doesn't support WS"
    kill $UP_PID 2>/dev/null
    return 1
  fi

  # Select k6 script
  local k6_file=""
  if [[ "$scenario" == "W1" ]]; then
    k6_file="ws-connect"
    MSG_SIZE="" 
  elif [[ "$scenario" == "W2" ]]; then
    k6_file="ws-echo"
    MSG_SIZE=""
  elif [[ "$scenario" == "W3" ]]; then
    k6_file="ws-echo-size"
    MSG_SIZE="${msg_size:-1024}"
  fi

  # Run k6
  CONCURRENCY="$concurrency" DURATION_SEC="$DURATION_SEC" \
    MSG_SIZE="${MSG_SIZE:-}" TARGET_URL="http://localhost:$PORT_GATEWAY" \
    "$K6_BIN" run "$PROJECT_DIR/bench/k6/${k6_file}.js" \
    --vus "$concurrency" \
    --duration "${DURATION_SEC}s" \
    --summary-export="$result_file" \
    --quiet > /dev/null 2>&1

  # Check result
  local sessions=$(jq -r '.metrics.ws_sessions.rate // (.metrics.http_reqs.rate // "0")' "$result_file" 2>/dev/null)
  local msgs=$(jq -r '.metrics.ws_messages_received.rate // (.metrics.http_req_duration.values.avg // "N/A")' "$result_file" 2>/dev/null)
  echo "    ✅ sessions/s=$sessions msgs/s=$msgs"

  # Cleanup
  [[ -n "${GW_PID:-}" ]] && kill $GW_PID 2>/dev/null
  kill $UP_PID 2>/dev/null
  kill_port $PORT_GATEWAY
  kill_port $PORT_UPSTREAM
  sleep 0.5

  return 0
}

echo "=============================================="
echo " WebSocket benchmarks: $HOST_LABEL"
echo "=============================================="

# W1: Connection hold (c=100 only — WS connections are heavy)
echo ""
echo "--- W1: WS connection hold (ws-connect) ---"
for impl in upstream-direct node python; do
  run_ws $impl W1 100 ""
done

# W2: Echo 64B
echo ""
echo "--- W2: Echo 64B (ws-echo) ---"
for impl in upstream-direct node python; do
  run_ws $impl W2 10 ""
done

# W3: Echo 1KB
echo ""
echo "--- W3: Echo 1KB (ws-echo-size) ---"
for impl in upstream-direct node python; do
  run_ws $impl W3 10 "1024"
done

# W3: Echo 64KB
echo ""
echo "--- W3: Echo 64KB (ws-echo-size) ---"
for impl in upstream-direct node python; do
  run_ws $impl W3 10 "65536"
done

echo ""
echo "=============================================="
echo " WS BENCHMARKS COMPLETE!"
echo "=============================================="
ls "$RESULT_DIR/" 2>/dev/null | grep -c "W[123]" || echo "0 WS result files"
ls "$RESULT_DIR/" 2>/dev/null | grep "W[123]" | head -20
