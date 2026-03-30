#!/bin/bash
# ========================================
# random_transfer_single_DB.sh
#
# Benchmark for single database version
#
# Scenario:
#   - random account transfer
#   - single PostgreSQL database
#
# Purpose:
#   - baseline throughput measurement
#
# ========================================

echo "========================================"
echo "Small Bank Full Benchmark"
echo "========================================"
echo ""

API="http://127.0.0.1:7001"

ACCOUNT_COUNT=1000
INITIAL_BALANCE=100000

echo "Step 1: Reset database"
echo "----------------------------------------"

psql small_bank <<EOF
TRUNCATE TABLE transfers RESTART IDENTITY CASCADE;
TRUNCATE TABLE accounts RESTART IDENTITY CASCADE;
TRUNCATE TABLE users RESTART IDENTITY CASCADE;
EOF

echo "Database reset completed"
echo ""

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

if (( $i % 100 == 0 ))
then
echo "created $i accounts"
fi

done

echo ""
echo "Accounts created: $ACCOUNT_COUNT"
echo ""

echo "Step 3: Start random transfer benchmark"
echo "----------------------------------------"

node scripts/benchmark/random_transfer_single_db.js

echo ""
echo "========================================"
echo "Benchmark Finished"
echo "========================================"