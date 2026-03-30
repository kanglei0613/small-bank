#!/bin/bash
# ========================================
# random_transfer_all_shards.sh
#
# Benchmark for sharding random transfer
#
# Scenario:
#   - random account transfer
#   - include same-shard + cross-shard
#   - sharding version
#
# Purpose:
#   - measure full random transfer throughput
#   - include real mixed shard traffic
# ========================================

echo "========================================"
echo "Small Bank Full Random Benchmark"
echo "========================================"
echo ""

API="http://127.0.0.1:7001"

ACCOUNT_COUNT=1000
INITIAL_BALANCE=100000

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

echo "Sharding databases reset completed"
echo ""

sleep 1

echo "Step 2: Create users + accounts"
echo "----------------------------------------"

for ((i=1;i<=ACCOUNT_COUNT;i++))
do
  curl -s -X POST $API/users \
    -H "Content-Type: application/json" \
    -d "{
      \"name\":\"user_$i\"
    }" > /dev/null

  curl -s -X POST $API/accounts \
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

CONCURRENCY=200 \
DURATION_SECONDS=30 \
MAX_ACCOUNT_ID=1000 \
AMOUNT=1 \
SHARD_COUNT=4 \
node scripts/benchmark/random_transfer_all_shards.js

echo ""
echo "========================================"
echo "Benchmark Finished"
echo "========================================"
