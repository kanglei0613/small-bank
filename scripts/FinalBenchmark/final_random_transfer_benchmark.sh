#!/bin/bash
set -e

# ========================================
# Final Random Transfer Benchmark
# ========================================
#
# 此 benchmark 用於測試隨機轉帳請求的 throughput。
#
# 測試流程：
# 1. 清空 Redis（避免 queue / counter 殘留）
# 2. 使用 autocannon 發送隨機 transfer request
#
# 注意：
# transfer API 已經分離到 port 7010
#

echo "========================================"
echo "Final Random Transfer Benchmark"
echo "========================================"

echo ""
echo "[1/2] Flush Redis..."
redis-cli FLUSHALL

echo ""
echo "[2/2] Run benchmark..."

node scripts/FinalBenchmark/final_random_transfer_benchmark.js \
  --url=http://127.0.0.1:7010/transfers \
  --connections=100 \
  --duration=60 \
  --minAccountId=1 \
  --maxAccountId=1000 \
  --amount=1