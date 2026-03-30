#!/bin/bash
# ========================================
# hotspot_transfer_single_db.sh
#
# Benchmark for single database hotspot transfer
#
# Scenario:
#   - fixed account pair transfer
#   - single PostgreSQL database
#   - extreme row lock contention
#
# Purpose:
#   - baseline hotspot throughput measurement
#
# ========================================

echo "========================================"
echo "Small Bank Hotspot Transfer Benchmark"
echo "========================================"
echo ""
echo "Test scenario:"
echo "single DB hotspot transfer"
echo "fromId = 6"
echo "toId = 7"
echo "amount = 1"
echo ""
echo "Endpoint:"
echo "POST http://127.0.0.1:7001/transfers"
echo ""

echo "----------------------------------------"
echo "Test 1: 100 connections / 5 seconds"
echo "----------------------------------------"
autocannon \
  -c 100 \
  -d 5 \
  -m POST \
  -H "Content-Type: application/json" \
  -b '{"fromId":6,"toId":7,"amount":1}' \
  http://127.0.0.1:7001/transfers

echo ""
echo "Waiting 2 seconds before next test..."
sleep 2

echo ""
echo "----------------------------------------"
echo "Test 2: 1000 connections / 10 seconds"
echo "----------------------------------------"
autocannon \
  -c 1000 \
  -d 10 \
  -m POST \
  -H "Content-Type: application/json" \
  -b '{"fromId":6,"toId":7,"amount":1}' \
  http://127.0.0.1:7001/transfers

echo ""
echo "Waiting 2 seconds before next test..."
sleep 2

echo ""
echo "----------------------------------------"
echo "Test 3: 2000 connections / 10 seconds"
echo "----------------------------------------"
autocannon \
  -c 2000 \
  -d 10 \
  -m POST \
  -H "Content-Type: application/json" \
  -b '{"fromId":6,"toId":7,"amount":1}' \
  http://127.0.0.1:7001/transfers

echo ""
echo "========================================"
echo "Hotspot benchmark finished"
echo "========================================"