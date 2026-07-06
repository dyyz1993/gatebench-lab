#!/usr/bin/env bash
set -euo pipefail

IMPL=$1
SCENARIO=$2
CONCURRENCY=${3:-10}
MODE=${4:-buffered}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
DATE=$(date +%Y-%m-%d)
HOSTNAME=$(hostname)
RESULT_DIR="$PROJECT_DIR/results/$DATE-$HOSTNAME/raw"
mkdir -p "$RESULT_DIR"

echo "=== Running $SCENARIO on $IMPL (concurrency=$CONCURRENCY, mode=$MODE) ==="

# TODO: start upstream-echo if not running
# TODO: start gateway if not upstream-direct/nginx
# TODO: run k6
# TODO: collect results

echo "Done."
