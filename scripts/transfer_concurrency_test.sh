#!/bin/bash

URL="http://127.0.0.1:7001/transfers"

echo "Running 200 concurrent transfers..."

for i in {1..200}; do
  curl -s -X POST $URL \
  -H "Content-Type: application/json" \
  -d '{"fromId":4,"toId":5,"amount":1}' &
done

wait

echo "Test finished"
