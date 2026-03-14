#!/bin/bash
# ========================================
# random_transfer_enqueue_only.sh
#
# Benchmark for API intake throughput
#
# Scenario:
#   - random account transfer
#   - enqueue only
#   - no job polling
#
# Purpose:
#   - measure POST /transfers intake RPS
# ========================================

set -e

echo "========================================"
echo "Small Bank Enqueue Only Benchmark"
echo "========================================"
echo ""

API="${API:-http://127.0.0.1:7001}"

ACCOUNT_COUNT="${ACCOUNT_COUNT:-1000}"
INITIAL_BALANCE="${INITIAL_BALANCE:-100000}"

CONCURRENCY="${CONCURRENCY:-300}"
DURATION_SECONDS="${DURATION_SECONDS:-30}"
AMOUNT="${AMOUNT:-1}"

SHARD_COUNT="${SHARD_COUNT:-4}"

echo "Configuration"
echo "----------------------------------------"
echo "API=$API"
echo "ACCOUNT_COUNT=$ACCOUNT_COUNT"
echo "INITIAL_BALANCE=$INITIAL_BALANCE"
echo "CONCURRENCY=$CONCURRENCY"
echo "DURATION_SECONDS=$DURATION_SECONDS"
echo "AMOUNT=$AMOUNT"
echo "SHARD_COUNT=$SHARD_COUNT"
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

redis-cli FLUSHDB

echo "Database reset completed"
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
echo "Step 4: Start enqueue-only benchmark"
echo "----------------------------------------"

API="$API" \
CONCURRENCY="$CONCURRENCY" \
DURATION_SECONDS="$DURATION_SECONDS" \
MAX_ACCOUNT_ID="$ACCOUNT_COUNT" \
AMOUNT="$AMOUNT" \
SHARD_COUNT="$SHARD_COUNT" \
node scripts/benchmark/random_transfer_enqueue_only.js

echo ""
echo "========================================"
echo "Benchmark Finished"
echo "========================================"