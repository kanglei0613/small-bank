#!/bin/bash
set -e
# ========================================
# random_request_benchmark.sh
#
# Mixed benchmark for all major services
#
# Includes:
# - POST /users
# - POST /accounts
# - GET /accounts/:id
# - POST /transfers
# - GET /transfer-jobs/:jobId
# - GET /transfers?accountId=...
# ========================================

echo "========================================"
echo "Small Bank Random Request Benchmark"
echo "========================================"
echo ""

API="${API:-http://127.0.0.1:7001}"

ACCOUNT_COUNT="${ACCOUNT_COUNT:-10000}"
INITIAL_BALANCE="${INITIAL_BALANCE:-100000}"

CONCURRENCY="${CONCURRENCY:-300}"
DURATION_SECONDS="${DURATION_SECONDS:-30}"
AMOUNT="${AMOUNT:-1}"
SHARD_COUNT="${SHARD_COUNT:-4}"

WEIGHT_GET_ACCOUNT="${WEIGHT_GET_ACCOUNT:-35}"
WEIGHT_POST_TRANSFER="${WEIGHT_POST_TRANSFER:-25}"
WEIGHT_GET_TRANSFER_JOB="${WEIGHT_GET_TRANSFER_JOB:-15}"
WEIGHT_GET_TRANSFER_HISTORY="${WEIGHT_GET_TRANSFER_HISTORY:-15}"
WEIGHT_POST_USER="${WEIGHT_POST_USER:-5}"
WEIGHT_POST_ACCOUNT="${WEIGHT_POST_ACCOUNT:-5}"

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
echo "Weights"
echo "----------------------------------------"
echo "GET_ACCOUNT=$WEIGHT_GET_ACCOUNT"
echo "POST_TRANSFER=$WEIGHT_POST_TRANSFER"
echo "GET_TRANSFER_JOB=$WEIGHT_GET_TRANSFER_JOB"
echo "GET_TRANSFER_HISTORY=$WEIGHT_GET_TRANSFER_HISTORY"
echo "POST_USER=$WEIGHT_POST_USER"
echo "POST_ACCOUNT=$WEIGHT_POST_ACCOUNT"
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

echo "Step 2: Create initial users + accounts"
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
echo "Step 4: Start random request benchmark"
echo "----------------------------------------"

API="$API" \
CONCURRENCY="$CONCURRENCY" \
DURATION_SECONDS="$DURATION_SECONDS" \
MAX_ACCOUNT_ID="$ACCOUNT_COUNT" \
INITIAL_USER_COUNT="$ACCOUNT_COUNT" \
AMOUNT="$AMOUNT" \
WEIGHT_GET_ACCOUNT="$WEIGHT_GET_ACCOUNT" \
WEIGHT_POST_TRANSFER="$WEIGHT_POST_TRANSFER" \
WEIGHT_GET_TRANSFER_JOB="$WEIGHT_GET_TRANSFER_JOB" \
WEIGHT_GET_TRANSFER_HISTORY="$WEIGHT_GET_TRANSFER_HISTORY" \
WEIGHT_POST_USER="$WEIGHT_POST_USER" \
WEIGHT_POST_ACCOUNT="$WEIGHT_POST_ACCOUNT" \
node scripts/benchmark/random_request_benchmark.js

echo ""
echo "========================================"
echo "Benchmark Finished"
echo "========================================"
