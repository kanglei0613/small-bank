#!/bin/bash

echo "========================================"
echo "Small Bank Concurrency Matrix Runner"
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
echo "========================================"
echo "Matrix Finished"
echo "========================================"
