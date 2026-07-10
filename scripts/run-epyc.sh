#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# run-epyc.sh — tencent-epyc 8 核基准机自动化运行脚本
#
# 适配：
#   - k6 路径 /usr/local/bin/k6
#   - Python 路径 /etc/.hai/miniforge3/bin/python3 (3.10)
#   - worker=8（Python uvicorn --workers 8, Node UV_THREADPOOL_SIZE=8）
#   - 支持 6 个实现: go / rust / rust-hyper / node / python / upstream-direct
#   - H4/H6/H7 分 buffered + streaming
#
# 用法:
#   ./run-epyc.sh http          # 跑全部 HTTP 场景
#   ./run-epyc.sh ws            # 跑全部 WS 场景
#   ./run-epyc.sh smoke         # 快速验证（每场景 5s，c=10）
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
PID_DIR="/tmp/gatebench-pids"

PORT_UPSTREAM=9000
PORT_GATEWAY=8080
UPSTREAM_BASE="http://localhost:$PORT_UPSTREAM"

MODE="${1:-http}"
DURATION_SEC="${DURATION_SEC:-30}"

mkdir -p "$RESULT_DIR" "$PID_DIR"

# 实现列表
if [[ "$MODE" == "smoke" ]]; then
  IMPLS="go rust rust-hyper node python upstream-direct"
  CONCURRENCIES="10"
  DURATION_SEC=5
  SCENARIOS="H1 H2 H3 H6 H7"
elif [[ "$MODE" == "http" ]]; then
  IMPLS="${IMPLS:-go rust rust-hyper node python upstream-direct}"
  CONCURRENCIES="${CONCURRENCIES:-10 100}"
  SCENARIOS="${SCENARIOS:-H1 H2 H3 H4 H5 H6 H7}"
elif [[ "$MODE" == "ws" ]]; then
  IMPLS="${IMPLS:-go rust rust-hyper node python}"
  SCENARIOS="W1 W2 W3"
  CONCURRENCIES="${CONCURRENCIES:-10 100}"
fi

# --- helpers ---
log()  { echo "[$(date +%H:%M:%S)] $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

cleanup_procs() {
  [[ -f "$PID_DIR/gateway.pid" ]] && kill "$(cat "$PID_DIR/gateway.pid")" 2>/dev/null || true
  [[ -f "$PID_DIR/upstream.pid" ]] && kill "$(cat "$PID_DIR/upstream.pid")" 2>/dev/null || true
  pkill -f "gateway-rust" 2>/dev/null || true
  pkill -f "gateway-go" 2>/dev/null || true
  pkill -f "upstream-echo" 2>/dev/null || true
  pkill -f "uvicorn" 2>/dev/null || true
  pkill -f "src/index.js" 2>/dev/null || true
  sleep 1
}
trap cleanup_procs EXIT

start_upstream() {
  cleanup_procs
  log "Starting upstream-echo (port $PORT_UPSTREAM)..."
  PORT=$PORT_UPSTREAM "$APP_DIR/upstream-echo/upstream-echo" > /tmp/upstream.log 2>&1 &
  echo $! > "$PID_DIR/upstream.pid"
  sleep 1
  curl -sf "http://localhost:$PORT_UPSTREAM/health" >/dev/null 2>&1 || die "upstream-echo failed to start"
  log "  ✅ upstream healthy"
}

start_gateway() {
  local impl="$1"
  local gw_mode="${2:-buffered}"

  log "Starting gateway-$impl (port $PORT_GATEWAY, mode=$gw_mode)..."

  case "$impl" in
    go)
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE="$gw_mode" PORT=$PORT_GATEWAY \
        "$APP_DIR/gateway-go/gateway-go" > /tmp/gateway.log 2>&1 &
      echo $! > "$PID_DIR/gateway.pid"
      ;;
    rust)
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE="$gw_mode" PORT=$PORT_GATEWAY \
        "$APP_DIR/gateway-rust/target/release/gateway-rust" > /tmp/gateway.log 2>&1 &
      echo $! > "$PID_DIR/gateway.pid"
      ;;
    rust-hyper)
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" PORT=$PORT_GATEWAY \
        "$APP_DIR/gateway-rust-hyper/target/release/gateway-rust-hyper" > /tmp/gateway.log 2>&1 &
      echo $! > "$PID_DIR/gateway.pid"
      ;;
    node)
      cd "$APP_DIR/gateway-node"
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE="$gw_mode" PORT=$PORT_GATEWAY \
        NODE_ENV=production UV_THREADPOOL_SIZE=$WORKERS \
        node src/index.js > /tmp/gateway.log 2>&1 &
      echo $! > "$PID_DIR/gateway.pid"
      cd "$PROJECT_DIR"
      ;;
    python)
      cd "$APP_DIR/gateway-python"
      UPSTREAM_BASE_URL="$UPSTREAM_BASE" GATEWAY_MODE="$gw_mode" \
        "$PYTHON_BIN" -m uvicorn src.main:app --port $PORT_GATEWAY \
        --workers $WORKERS --log-level error > /tmp/gateway.log 2>&1 &
      echo $! > "$PID_DIR/gateway.pid"
      cd "$PROJECT_DIR"
      ;;
    upstream-direct)
      # 不启动额外网关，直接打 upstream
      PORT_GATEWAY=$PORT_UPSTREAM
      log "  (upstream-direct: no gateway, hitting port $PORT_GATEWAY)"
      return 0
      ;;
    *) die "Unknown impl: $impl" ;;
  esac

  sleep 2
  # 重试健康检查（Python/Rust 可能需要更久）
  for i in 1 2 3; do
    if curl -sf "http://localhost:$PORT_GATEWAY/health" >/dev/null 2>&1; then
      log "  ✅ gateway-$impl healthy"
      return 0
    fi
    sleep 1
  done
  log "  ❌ gateway-$impl health check failed! Last 10 lines of log:"
  tail -10 /tmp/gateway.log >&2 || true
  return 1
}

# 场景到 k6 脚本的映射
scenario_to_k6() {
  case "$1" in
    H1) echo "http-get" ;;
    H2) echo "http-proxy-small" ;;
    H3) echo "http-json-large" ;;
    H4) echo "http-upload" ;;
    H5) echo "http-upload-instant" ;;
    H6) echo "http-large-response" ;;
    H7) echo "http-binary-response" ;;
    W1) echo "ws-connect" ;;
    W2) echo "ws-echo" ;;
    W3) echo "ws-echo-size" ;;
    *) die "Unknown scenario: $1" ;;
  esac
}

# 哪些场景需要 streaming 变体
needs_streaming() {
  [[ "$1" == "H4" || "$1" == "H6" || "$1" == "H7" ]]
}

run_k6() {
  local impl="$1"
  local scenario="$2"
  local concurrency="$3"
  local gw_mode="$4"
  local k6_name="$5"

  local result_file="$RESULT_DIR/${impl}-${scenario}-c${concurrency}-${gw_mode}-run1.json"
  local k6_script="$PROJECT_DIR/bench/k6/${k6_name}.js"

  [[ -f "$k6_script" ]] || die "k6 script not found: $k6_script"

  log "  k6: $scenario × c=$concurrency × $gw_mode → $(basename $result_file)"

  CONCURRENCY="$concurrency" DURATION_SEC="$DURATION_SEC" \
    HASH_HIT_RATE="${HASH_HIT_RATE:-50}" TARGET_URL="http://localhost:$PORT_GATEWAY" \
    "$K6_BIN" run "$k6_script" \
    --vus "$concurrency" \
    --duration "${DURATION_SEC}s" \
    --summary-export="$result_file" \
    --quiet 2>&1 | tail -3

  if [[ -f "$result_file" ]]; then
    local rps=$(jq -r '.metrics.http_reqs.rate // .metrics.ws_sessions.rate // "N/A"' "$result_file" 2>/dev/null)
    log "    → rps≈$rps"
  fi
}

# ============================================================================
# 主逻辑
# ============================================================================

total_impls=$(echo "$IMPLS" | wc -w)
total_scenarios=$(echo "$SCENARIOS" | wc -w)
total_concs=$(echo "$CONCURRENCIES" | wc -w)
log "============================================="
log "  gatebench-lab — EPYC Benchmark Runner"
log "  Mode:    $MODE"
log "  Impls:   $IMPLS ($total_impls)"
log "  Scenarios: $SCENARIOS ($total_scenarios)"
log "  Concurrency: $CONCURRENCIES"
log "  Duration: ${DURATION_SEC}s/run"
log "  Workers: $WORKERS"
log "  Results: $RESULT_DIR"
log "============================================="

start_upstream

for impl in $IMPLS; do
  log ""
  log "======== Implementation: $impl ========"

  for scenario in $SCENARIOS; do
    k6_name=$(scenario_to_k6 "$scenario")

    for concurrency in $CONCURRENCIES; do
      if needs_streaming "$scenario"; then
        # buffered + streaming 两轮
        for gw_mode in buffered streaming; do
          start_gateway "$impl" "$gw_mode" || { log "SKIP: $impl health check failed"; continue; }
          run_k6 "$impl" "$scenario" "$concurrency" "$gw_mode" "$k6_name"
        done
      else
        start_gateway "$impl" "buffered" || { log "SKIP: $impl health check failed"; continue; }
        run_k6 "$impl" "$scenario" "$concurrency" "buffered" "$k6_name"
      fi
    done
  done
done

cleanup_procs

log ""
log "============================================="
log "  ✅ All runs complete!"
log "  Results: $RESULT_DIR"
log "============================================="
log ""
ls -la "$RESULT_DIR/" | head -40
