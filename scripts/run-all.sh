#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# run-all.sh — 跑全量矩阵
#
# 用法:
#   ./run-all.sh [--dry-run]
#
# 环境变量:
#   CONCURRENCIES 并发梯度(默认 "10 100 500")
#   DURATION_SEC  每轮秒数(默认 30)
#   IMPLS         哪些实现(默认 "go node python")
#   SERVICE_HOST  在哪跑服务(local / xyz-mac / jd)
#   VERBOSE
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."

CONCURRENCIES="${CONCURRENCIES:-10 100 500}"
DURATION_SEC="${DURATION_SEC:-30}"
IMPLS="${IMPLS:-go node python}"
SERVICE_HOST="${SERVICE_HOST:-local}"
VERBOSE="${VERBOSE:-0}"
DRY_RUN=0
[[ "$*" == *--dry-run* ]] && DRY_RUN=1

echo "============================================="
echo "  gatebench-lab — Full Matrix Runner"
echo "  IMPLS:      $IMPLS"
echo "  SCENARIOS:  H1 H2 H3 H4 H5 H6 H7"
echo "  CONCURRENCIES: $CONCURRENCIES"
echo "  DURATION:   ${DURATION_SEC}s"
echo "  HOST:       ${SERVICE_HOST:-local}"
echo "  DRY_RUN:    $DRY_RUN"
echo "============================================="

# Pre-build: compile gateways & upstream
for impl in $IMPLS; do
  case "$impl" in
    go)   echo ">> Building go...";  cd "$PROJECT_DIR/apps/gateway-go" && go build -o gateway-go . && cd "$PROJECT_DIR" ;;
    node) echo ">> Installing node..."; cd "$PROJECT_DIR/apps/gateway-node" && npm install --silent && cd "$PROJECT_DIR" ;;
    python) echo ">> Python deps..."; pip install -q -r "$PROJECT_DIR/apps/gateway-python/requirements.txt" 2>/dev/null || true ;;
    rust) echo ">> Building rust (slow)..."; cd "$PROJECT_DIR/apps/gateway-rust" && cargo build --release -q && cd "$PROJECT_DIR" ;;
  esac
done
echo ">> Building upstream-echo..."
cd "$PROJECT_DIR/apps/upstream-echo" && go build -o upstream-echo . && cd "$PROJECT_DIR"

total=$(( $(echo "$IMPLS" | wc -w) * 7 * $(echo "$CONCURRENCIES" | wc -w) ))
echo ">> Total runs: $total"

run=0
for impl in $IMPLS; do
  for scenario in H1 H2 H3 H4 H5 H6 H7; do
    for concurrency in $CONCURRENCIES; do
      run=$((run + 1))
      echo "[$run/$total] $impl × $scenario × c$concurrency"
      [[ "$DRY_RUN" == "1" ]] && continue

      # Retry once on failure
      CONCURRENCY="$concurrency" DURATION_SEC="$DURATION_SEC" VERBOSE="$VERBOSE" SERVICE_HOST="$SERVICE_HOST" \
        bash "$SCRIPT_DIR/run-one.sh" "$impl" "$scenario" "$concurrency" "buffered" 1 2>&1 | tail -3 || {
        echo "  ⚠️  Retry..."
        pkill -f "upstream-echo" 2>/dev/null || true
        pkill -f "gateway-" 2>/dev/null || true
        sleep 2
        CONCURRENCY="$concurrency" DURATION_SEC="$DURATION_SEC" VERBOSE="$VERBOSE" SERVICE_HOST="$SERVICE_HOST" \
          bash "$SCRIPT_DIR/run-one.sh" "$impl" "$scenario" "$concurrency" "buffered" 2 2>&1 | tail -3 || {
          echo "  ❌ FAILED: $impl $scenario"
          continue
        }
      }
    done
  done
done

echo ""
echo "=== Full matrix done. Generating report... ==="
RESULTS_DIR=$(ls -d "$PROJECT_DIR/results/"* 2>/dev/null | sort -r | head -1)
if [[ -n "$RESULTS_DIR" && -d "$RESULTS_DIR/raw" ]]; then
  cd "$PROJECT_DIR/scripts"
  [[ -f node_modules/.package-lock.json ]] || npm install --silent
  npx ts-node normalize-results.ts "$RESULTS_DIR" 2>&1 | tail -5
  npx ts-node generate-report.ts "$RESULTS_DIR" 2>&1
  echo ""
  echo "✅ Report: $RESULTS_DIR/report.html"
else
  echo "No results found to generate report"
fi
