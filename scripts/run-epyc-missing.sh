#!/usr/bin/env bash
set -uo pipefail

# ============================================================================
# run-epyc-missing.sh — 补跑剩余场景
# 用最可靠的方式：每次一个新 SSH session 启动关闭
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

run_one() {
  local impl="$1" scenario="$2" concurrency="$3" mode="$4"
  local k6_file=""
  local result_file="$RESULT_DIR/${impl}-${scenario}-c${concurrency}-${mode}-run1.json"

  # Already exists? Check if it looks complete (has metrics)
  if [[ -f "$result_file" ]]; then
    local has_data=$(jq -r '.metrics.http_reqs.rate // empty' "$result_file" 2>/dev/null)
    if [[ -n "$has_data" ]]; then
      echo "  SKIP (exists): $impl $scenario c=$concurrency $mode (rps=$has_data)"
      return 0
    fi
  fi

  echo "  RUN: $impl $scenario c=$concurrency $mode"

  # Kill ports
  kill_port $PORT_GATEWAY
  kill_port $PORT_UPSTREAM
  
  # Start upstream
  PORT=$PORT_UPSTREAM "$APP_DIR/upstream-echo/upstream-echo" > /dev/null 2>&1 &
  local UP_PID=$!
  sleep 1
  curl -sf "http://localhost:$PORT_UPSTREAM/health" > /dev/null 2>&1 || { echo "    ❌ upstream failed"; return 1; }

  # Start gateway
  case "$impl" in
    go)
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE="$mode" PORT=$PORT_GATEWAY \
        "$APP_DIR/gateway-go/gateway-go" > /dev/null 2>&1 &
      local GW_PID=$!
      ;;
    rust)
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE="$mode" PORT=$PORT_GATEWAY \
        "$APP_DIR/gateway-rust/target/release/gateway-rust" > /dev/null 2>&1 &
      local GW_PID=$!
      ;;
    rust-hyper)
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" PORT=$PORT_GATEWAY \
        "$APP_DIR/gateway-rust-hyper/target/release/gateway-rust-hyper" > /dev/null 2>&1 &
      local GW_PID=$!
      ;;
    node)
      cd "$APP_DIR/gateway-node"
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE="$mode" PORT=$PORT_GATEWAY \
        NODE_ENV=production UV_THREADPOOL_SIZE=$WORKERS \
        node src/index.js > /dev/null 2>&1 &
      local GW_PID=$!
      cd "$PROJECT_DIR"
      ;;
    python)
      cd "$APP_DIR/gateway-python"
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE="$mode" \
        "$PYTHON_BIN" -m uvicorn src.main:app --port $PORT_GATEWAY \
        --workers $WORKERS --log-level error > /dev/null 2>&1 &
      local GW_PID=$!
      cd "$PROJECT_DIR"
      ;;
    upstream-direct)
      # No gateway
      local GW_PID=""
      PORT_GATEWAY=$PORT_UPSTREAM
      ;;
    *) echo "    ❌ unknown impl"; return 1 ;;
  esac

  sleep 2
  local health_ok=false
  if [[ "$impl" == "upstream-direct" ]]; then
    health_ok=true
  else
    for i in 1 2 3; do
      if curl -sf "http://localhost:$PORT_GATEWAY/health" > /dev/null 2>&1; then
        health_ok=true
        break
      fi
      sleep 1
    done
  fi

  if ! $health_ok; then
    echo "    ❌ health check FAILED"
    kill $GW_PID $UP_PID 2>/dev/null
    return 1
  fi

  # Map scenario
  case "$scenario" in
    H1) k6_file="http-get" ;;
    H2) k6_file="http-proxy-small" ;;
    H3) k6_file="http-json-large" ;;
    H4) k6_file="http-upload" ;;
    H5) k6_file="http-upload-instant" ;;
    H6) k6_file="http-large-response" ;;
    H7) k6_file="http-binary-response" ;;
    W1) k6_file="ws-connect" ;;
    W2) k6_file="ws-echo" ;;
    W3) k6_file="ws-echo-size" ;;
    *) echo "    ❌ unknown scenario"; kill $GW_PID $UP_PID 2>/dev/null; return 1 ;;
  esac

  # Run k6
  CONCURRENCY="$concurrency" DURATION_SEC="$DURATION_SEC" \
    HASH_HIT_RATE=50 TARGET_URL="http://localhost:$PORT_GATEWAY" \
    "$K6_BIN" run "$PROJECT_DIR/bench/k6/${k6_file}.js" \
    --vus "$concurrency" \
    --duration "${DURATION_SEC}s" \
    --summary-export="$result_file" \
    --quiet > /dev/null 2>&1

  # Check result
  local rps=$(jq -r '.metrics.http_reqs.rate // "0"' "$result_file" 2>/dev/null)
  local err=$(jq -r '.metrics.http_req_failed.rate // "0"' "$result_file" 2>/dev/null)
  echo "    ✅ rps=$rps err=$err"

  # Cleanup
  kill $GW_PID 2>/dev/null
  kill_port $PORT_GATEWAY
  kill $UP_PID 2>/dev/null
  kill_port $PORT_UPSTREAM
  sleep 0.5

  return 0
}

echo "=============================================="
echo " Missing benchmarks for $HOST_LABEL"
echo "=============================================="

# === Node missing runs ===
echo ""
echo "--- Node (missing: H4 c100 streaming, H5, H6 c100, H7 c100) ---"
for conc in 10 100; do
  for mode in buffered; do
    run_one node H5 $conc $mode
  done
done

for conc in 100; do
  for mode in buffered streaming; do
    run_one node H4 $conc $mode
    run_one node H6 $conc $mode
    run_one node H7 $conc $mode
  done
done

# === Python (needs everything from scratch) ===
echo ""
echo "--- Python (full run) ---"
for conc in 10 100; do
  for scenario in H1 H2 H3 H5; do
    run_one python $scenario $conc buffered
  done
  for scenario in H4 H6 H7; do
    run_one python $scenario $conc buffered
    run_one python $scenario $conc streaming
  done
done

# === upstream-direct (full run) ===
echo ""
echo "--- upstream-direct (full run) ---"
for conc in 10 100; do
  for scenario in H1 H2 H3 H5; do
    run_one upstream-direct $scenario $conc buffered
  done
  for scenario in H4 H6 H7; do
    run_one upstream-direct $scenario $conc buffered
    run_one upstream-direct $scenario $conc streaming
  done
done

echo ""
echo "=============================================="
echo " ALL MISSING RUNS COMPLETE!"
echo "=============================================="
ls "$RESULT_DIR/" 2>/dev/null | wc -l
echo "files total"
ls "$RESULT_DIR/" 2>/dev/null | sed 's/-H[0-9].*//' | sort | uniq -c | sort -rn
