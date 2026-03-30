#!/bin/bash
# ========================================
# run_account_count_matrix.sh
#
# Benchmark for sharding random transfer
# with variable account count
#
# Scenario:
#   - random account transfer
#   - include same-shard + cross-shard
#   - sharding version
#   - variable account count
#
# Purpose:
#   - measure throughput under different account counts
#   - observe whether larger dataset reduces contention
# ========================================

set -e

echo "========================================"
echo "Small Bank Full Random Benchmark"
echo "========================================"
echo ""

API="${API:-http://127.0.0.1:7001}"

ACCOUNT_COUNT="${ACCOUNT_COUNT:-1000}"
INITIAL_BALANCE="${INITIAL_BALANCE:-100000}"

CONCURRENCY="${CONCURRENCY:-300}"
DURATION_SECONDS="${DURATION_SECONDS:-30}"
AMOUNT="${AMOUNT:-1}"
SHARD_COUNT="${SHARD_COUNT:-4}"
JOB_POLL_INTERVAL_MS="${JOB_POLL_INTERVAL_MS:-100}"
JOB_POLL_TIMEOUT_MS="${JOB_POLL_TIMEOUT_MS:-10000}"

echo "Configuration"
echo "----------------------------------------"
echo "API=$API"
echo "ACCOUNT_COUNT=$ACCOUNT_COUNT"
echo "INITIAL_BALANCE=$INITIAL_BALANCE"
echo "CONCURRENCY=$CONCURRENCY"
echo "DURATION_SECONDS=$DURATION_SECONDS"
echo "AMOUNT=$AMOUNT"
echo "SHARD_COUNT=$SHARD_COUNT"
echo "JOB_POLL_INTERVAL_MS=$JOB_POLL_INTERVAL_MS"
echo "JOB_POLL_TIMEOUT_MS=$JOB_POLL_TIMEOUT_MS"
echo ""

echo "Step 1: Reset sharding databases"
echo "----------------------------------------"

psql small_bank_s0 <<EOF
TRUNCATE TABLE transfers RESTART IDENTITY CASCADE;
TRUNCATE TABLE accounts RESTART IDENTITY CASCADE;
EOF

psql small_bank_s1 <<EOF
TRUNCATE TABLE transfers RESTART IDENTITY CASCADE;
TRUNCATE TABLE accounts RESTART IDENTITY CASCADE;
EOF

psql small_bank_s2 <<EOF
TRUNCATE TABLE transfers RESTART IDENTITY CASCADE;
TRUNCATE TABLE accounts RESTART IDENTITY CASCADE;
EOF

psql small_bank_s3 <<EOF
TRUNCATE TABLE transfers RESTART IDENTITY CASCADE;
TRUNCATE TABLE accounts RESTART IDENTITY CASCADE;
EOF

psql small_bank_meta <<EOF
TRUNCATE TABLE account_shards CASCADE;
TRUNCATE TABLE users RESTART IDENTITY CASCADE;
ALTER SEQUENCE global_account_id_seq RESTART WITH 1;
EOF

# 清空 Redis
redis-cli FLUSHDB

echo "Sharding databases reset completed"
echo ""

sleep 1

echo "Step 2: Create users + accounts"
echo "----------------------------------------"

for ((i=1;i<=ACCOUNT_COUNT;i++))
do
  curl -s -X POST "$API/users" \
    -H "Content-Type: application/json" \
    -d "{
      \"name\":\"user_$i\"
    }" > /dev/null

  curl -s -X POST "$API/accounts" \
    -H "Content-Type: application/json" \
    -d "{
      \"userId\":$i,
      \"initialBalance\":$INITIAL_BALANCE
    }" > /dev/null

  if (( i % 100 == 0 ))
  then
    echo "created $i accounts"
  fi
done

echo ""
echo "Accounts created: $ACCOUNT_COUNT"
echo ""

echo "Step 3: Show shard distribution"
echo "----------------------------------------"

psql small_bank_meta -c "
SELECT shard_id, COUNT(*) AS account_count
FROM account_shards
GROUP BY shard_id
ORDER BY shard_id;
"

echo ""
echo "Step 4: Start full random transfer benchmark"
echo "----------------------------------------"

API="$API" \
CONCURRENCY="$CONCURRENCY" \
DURATION_SECONDS="$DURATION_SECONDS" \
MAX_ACCOUNT_ID="$ACCOUNT_COUNT" \
AMOUNT="$AMOUNT" \
SHARD_COUNT="$SHARD_COUNT" \
JOB_POLL_INTERVAL_MS="$JOB_POLL_INTERVAL_MS" \
JOB_POLL_TIMEOUT_MS="$JOB_POLL_TIMEOUT_MS" \
node scripts/benchmark/random_transfer_all_shards.js

echo ""
echo "========================================"
echo "Benchmark Finished"
echo "========================================"