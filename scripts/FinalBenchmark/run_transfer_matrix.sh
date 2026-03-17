#!/bin/bash
set -e

# ========================================
# Transfer API / Queue Worker Matrix Runner
# ========================================
#
# 用途：
# - 依序執行 final_random_transfer_benchmark
# - 將每次結果附加到 matrix report 檔案
#
# 使用方式：
#
# 1. 先手動啟動你要測的 server 組合
#    例如：
#    - general api
#    - transfer api
#    - queue workers
#
# 2. 執行：
#    bash scripts/FinalBenchmark/run_transfer_matrix.sh
#
# 3. 結果會寫到：
#    scripts/FinalBenchmark/transfer_matrix_report.txt
#
# 注意：
# - 這支不會自動幫你切 worker 數量
# - 你每次要先手動調整好環境，再按 Enter 繼續
#

REPORT_FILE="scripts/FinalBenchmark/transfer_matrix_report.txt"
BENCH_SCRIPT="scripts/FinalBenchmark/final_random_transfer_benchmark.sh"

mkdir -p scripts/FinalBenchmark

echo "========================================" | tee "$REPORT_FILE"
echo "Transfer API / Queue Worker Matrix Report" | tee -a "$REPORT_FILE"
echo "Generated at: $(date)" | tee -a "$REPORT_FILE"
echo "========================================" | tee -a "$REPORT_FILE"
echo "" | tee -a "$REPORT_FILE"

run_case() {
  local case_name="$1"
  local transfer_api_workers="$2"
  local queue_workers="$3"

  echo "========================================"
  echo "Case: $case_name"
  echo "Transfer API Workers: $transfer_api_workers"
  echo "Queue Workers       : $queue_workers"
  echo "========================================"
  echo ""

  echo "請先確認你已經手動啟動以下配置："
  echo "- Transfer API Workers = $transfer_api_workers"
  echo "- Queue Workers        = $queue_workers"
  echo ""
  read -p "確認後按 Enter 開始測試..."

  echo "" | tee -a "$REPORT_FILE"
  echo "========================================" | tee -a "$REPORT_FILE"
  echo "Case: $case_name" | tee -a "$REPORT_FILE"
  echo "Transfer API Workers: $transfer_api_workers" | tee -a "$REPORT_FILE"
  echo "Queue Workers       : $queue_workers" | tee -a "$REPORT_FILE"
  echo "Started at          : $(date)" | tee -a "$REPORT_FILE"
  echo "========================================" | tee -a "$REPORT_FILE"

  bash "$BENCH_SCRIPT" | tee -a "$REPORT_FILE"

  echo "Finished at: $(date)" | tee -a "$REPORT_FILE"
  echo "" | tee -a "$REPORT_FILE"
}

# =========================
# Minimal matrix
# =========================
#
# 先跑三組最有價值的：
# 1. baseline
# 2. 加 transfer API workers
# 3. 加 queue workers
#

run_case "baseline" "2" "2"
run_case "more-transfer-api-workers" "4" "2"
run_case "more-queue-workers" "2" "4"

echo "========================================"
echo "All cases completed."
echo "Report saved to: $REPORT_FILE"
echo "========================================"
