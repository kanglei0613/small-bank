#!/bin/bash

echo "========================================"
echo "Small Bank Hotspot Transfer Light Test"
echo "========================================"
echo ""
echo "Scenario:"
echo "fromId = 6"
echo "toId = 7"
echo "amount = 1"
echo ""

echo "Running light benchmark..."
echo ""

autocannon \
  -c 100 \
  -d 5 \
  -m POST \
  -H "Content-Type: application/json" \
  -b '{"fromId":6,"toId":7,"amount":1}' \
  http://127.0.0.1:7001/transfers

echo ""
echo "========================================"
echo "Hotspot light test finished"
echo "========================================"