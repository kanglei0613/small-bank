#!/bin/bash
# ========================================
# hotspot_same_shard_c100.sh
#
# Benchmark for same-shard hotspot transfer
# ========================================

API="http://127.0.0.1:7001/transfers"

FROM_ID=3
TO_ID=5
AMOUNT=1
CONNECTIONS=100
DURATION=10

echo "========================================"
echo "Small Bank Same-Shard Hotspot Benchmark"
echo "========================================"
echo ""
echo "Test scenario:"
echo "same-shard hotspot transfer"
echo "fromId = $FROM_ID"
echo "toId = $TO_ID"
echo "amount = $AMOUNT"
echo "connections = $CONNECTIONS"
echo "duration = $DURATION seconds"
echo ""
echo "Endpoint:"
echo "POST $API"
echo ""

autocannon \
  -c $CONNECTIONS \
  -d $DURATION \
  -m POST \
  -H "Content-Type: application/json" \
  -b "{\"fromId\":$FROM_ID,\"toId\":$TO_ID,\"amount\":$AMOUNT}" \
  $API

echo ""
echo "========================================"
echo "Benchmark finished"
echo "========================================"
