#!/bin/bash

echo "========================================"
echo "Small Bank Full Benchmark Runner"
echo "========================================"
echo ""

echo "Run same-shard matrix"
echo "----------------------------------------"
TARGET=same-shard node scripts/benchmark/run_concurrency_matrix.js

echo ""
echo "Run mixed random matrix"
echo "----------------------------------------"
TARGET=all-shards node scripts/benchmark/run_concurrency_matrix.js

echo ""
echo "Run enqueue-only matrix"
echo "----------------------------------------"
TARGET=enqueue-only node scripts/benchmark/run_concurrency_matrix.js

echo ""
echo "========================================"
echo "All Benchmarks Finished"
echo "========================================"
