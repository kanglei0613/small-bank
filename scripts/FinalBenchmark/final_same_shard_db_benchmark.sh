#!/bin/bash
set -e

echo "========================================"
echo "Final Same-Shard Pure DB Benchmark"
echo "========================================"

node scripts/FinalBenchmark/final_same_shard_db_benchmark.js \
  --url=http://127.0.0.1:7001/bench/db-transfer \
  --connections=10 \
  --duration=60 \
  --minAccountId=1 \
  --maxAccountId=1000 \
  --amount=1 \
  --shardCount=4
  