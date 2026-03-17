#!/bin/bash
set -e

echo "========================================"
echo "Final Random Request Benchmark"
echo "========================================"

echo ""
echo "[1/2] Flush Redis..."
redis-cli FLUSHALL

echo ""
echo "[2/2] Run benchmark..."
node scripts/FinalBenchmark/final_random_request_benchmark.js \
  --generalUrl=http://127.0.0.1:7001 \
  --transferUrl=http://127.0.0.1:7010 \
  --connections=100 \
  --duration=60 \
  --minAccountId=1 \
  --maxAccountId=1000 \
  --minUserId=1 \
  --maxUserId=1000 \
  --amount=1 \
  --initialBalance=1000 \
  --jobPoolLimit=5000