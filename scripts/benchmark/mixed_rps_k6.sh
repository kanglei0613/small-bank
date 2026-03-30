#!/usr/bin/env bash
# =============================================================================
# mixed_rps_bench.sh — 混合請求壓測啟動腳本
#
# 位置：scripts/benchmark/mixed_rps_bench.sh
#
# 用法：
#   bash scripts/benchmark/mixed_rps_bench.sh [選項]
#
# 範例（closed model）：
#   bash scripts/benchmark/mixed_rps_bench.sh --vus=50 --duration=30s
#   bash scripts/benchmark/mixed_rps_bench.sh --vus=100 --duration=60s
#
# 範例（open model）：
#   bash scripts/benchmark/mixed_rps_bench.sh --executor=open --rate=3000 --duration=30s
#   bash scripts/benchmark/mixed_rps_bench.sh --executor=open --rate=5000 --pre-vus=200 --max-vus=600
# =============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# =============================================================================
# 預設值
# =============================================================================

EXECUTOR="closed"
VUS=50
RATE=3000
DURATION="30s"
PRE_VUS=200
MAX_VUS=600

MIN_ID=33288
MAX_ID=136912
MIN_USER_ID=1
MAX_USER_ID=104042
AMOUNT=1
INIT_BAL=10000

GENERAL_URL="http://127.0.0.1:7001"
TRANSFER_URL="http://127.0.0.1:7010"

SCRIPT="$ROOT_DIR/scripts/benchmark/mixed_rps_bench.js"

# =============================================================================
# 解析參數
# =============================================================================

for arg in "$@"; do
  case $arg in
    --executor=*)     EXECUTOR="${arg#*=}"     ;;
    --vus=*)          VUS="${arg#*=}"          ;;
    --rate=*)         RATE="${arg#*=}"         ;;
    --duration=*)     DURATION="${arg#*=}"     ;;
    --pre-vus=*)      PRE_VUS="${arg#*=}"      ;;
    --max-vus=*)      MAX_VUS="${arg#*=}"      ;;
    --min-id=*)       MIN_ID="${arg#*=}"       ;;
    --max-id=*)       MAX_ID="${arg#*=}"       ;;
    --general-url=*)  GENERAL_URL="${arg#*=}"  ;;
    --transfer-url=*) TRANSFER_URL="${arg#*=}" ;;
    --help|-h)
      echo ""
      echo "用法: bash scripts/benchmark/mixed_rps_bench.sh [選項]"
      echo ""
      echo "選項："
      echo "  --executor=closed|open   執行模式 (預設: closed)"
      echo "  --vus=N                  VU 數，closed model 用 (預設: 50)"
      echo "  --rate=N                 目標 RPS，open model 用 (預設: 3000)"
      echo "  --duration=Ns            壓測時間 (預設: 30s)"
      echo "  --pre-vus=N              預先分配 VU 數，open model 用 (預設: 200)"
      echo "  --max-vus=N              最大 VU 數，open model 用 (預設: 600)"
      echo "  --min-id=N               帳號 ID 下限 (預設: 33288)"
      echo "  --max-id=N               帳號 ID 上限 (預設: 136912)"
      echo "  --general-url=URL        General API 位址 (預設: http://127.0.0.1:7001)"
      echo "  --transfer-url=URL       Transfer API 位址 (預設: http://127.0.0.1:7010)"
      echo ""
      exit 0
      ;;
    *)
      echo "未知參數: $arg (用 --help 查看說明)"
      exit 1
      ;;
  esac
done

# =============================================================================
# 印出設定
# =============================================================================

echo ""
echo "=========================================="
echo "  混合請求壓測"
echo "=========================================="
echo "  executor    : $EXECUTOR"
if [ "$EXECUTOR" = "open" ]; then
echo "  rate        : ${RATE} RPS"
echo "  pre-vus     : $PRE_VUS"
echo "  max-vus     : $MAX_VUS"
else
echo "  vus         : $VUS"
fi
echo "  duration    : $DURATION"
echo "  account IDs : $MIN_ID – $MAX_ID"
echo "  general url : $GENERAL_URL"
echo "  transfer url: $TRANSFER_URL"
echo "  script      : $SCRIPT"
echo "=========================================="
echo ""

# =============================================================================
# 執行 k6
# =============================================================================

k6 run \
  --env EXECUTOR="$EXECUTOR" \
  --env VUS="$VUS" \
  --env RATE="$RATE" \
  --env DURATION="$DURATION" \
  --env PRE_VUS="$PRE_VUS" \
  --env MAX_VUS="$MAX_VUS" \
  --env MIN_ID="$MIN_ID" \
  --env MAX_ID="$MAX_ID" \
  --env MIN_USER_ID="$MIN_USER_ID" \
  --env MAX_USER_ID="$MAX_USER_ID" \
  --env AMOUNT="$AMOUNT" \
  --env INIT_BAL="$INIT_BAL" \
  --env GENERAL_URL="$GENERAL_URL" \
  --env TRANSFER_URL="$TRANSFER_URL" \
  "$SCRIPT"
  