#!/bin/bash
set -e

echo "========================================"
echo "Final API Intake / Enqueue Benchmark"
echo "========================================"

echo ""
echo "[1/2] Flush Redis..."
redis-cli FLUSHALL

echo ""
echo "[2/2] Run benchmark..."
node scripts/FinalBenchmark/final_api_intake_benchmark.js \
  --url=http://127.0.0.1:7001/bench/transfers-enqueue-no-log \
  --connections=100 \
  --duration=60 \
  --minAccountId=1 \
  --maxAccountId=1000 \
  --amount=1