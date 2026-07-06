#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

IMPLS=(rust go node python upstream-direct nginx)
SCENARIOS=(H1 H2 H3 H4 H5 H6 H7)
CONCURRENCIES=(10 50 100 200)

for impl in "${IMPLS[@]}"; do
  for scenario in "${SCENARIOS[@]}"; do
    for concurrency in "${CONCURRENCIES[@]}"; do
      # TODO: run-one.sh "$impl" "$scenario" "$concurrency"
      echo "Scheduled: $impl $scenario $concurrency"
    done
  done
done

echo "All scenarios completed."
