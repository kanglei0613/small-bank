# Small Bank 壓力測試 (Benchmark)

---

# 測試環境

應用程式

- Node.js
- Egg.js Framework
- Cluster Mode

Worker

- 8 Workers

系統架構

- Redis Transfer Queue
- PostgreSQL
- Row-level Locking
- Database Sharding (2 Shards)

資料庫

- small_bank_meta
- small_bank_s0
- small_bank_s1

帳戶設定

- 帳戶數量：1000
- 初始餘額：100000

轉帳設定

```
amount = 1
```

測試機器

```
MacBook Air (Development Machine)
```

---

# Benchmark 測試類型

本專案測試包含兩種架構：

1️⃣ 單資料庫架構（Single Database）  
2️⃣ 分片架構（Database Sharding）

工作負載（Workload）包含：

- Hotspot Transfer（熱點帳戶轉帳）
- Random Transfer（隨機帳戶轉帳）

---

# 單資料庫 Benchmark

## Hotspot Transfer（熱點轉帳）

測試情境

```
fromId = 6
toId   = 7
amount = 1
```

測試工具

```
autocannon
```

測試參數

```
connections = 50
duration = 10s
endpoint = POST /transfers
```

測試結果

```
Req/sec (avg) : ~1595
Total Requests: ~18000
```

延遲（Latency）

| 指標 | 數值 |
|------|------|
| Average | ~30 ms |
| p50 | ~22 ms |
| p99 | ~140 ms |

觀察

- Row-level locking 正常運作
- 轉帳資料保持一致性
- 系統在中等競爭下運行穩定

---

## Random Transfer（短時間吞吐）

測試參數

```
CONCURRENCY = 200
DURATION_SECONDS = 10
MAX_ACCOUNT_ID = 1000
AMOUNT = 1
```

測試結果

```
Avg Success RPS ≈ 8547
Success Rate = 100%
```

觀察

- 系統可以處理短時間 burst load
- 沒有 timeout 或錯誤
- Redis queue 與 worker 運作正常

---

## Random Transfer（長時間吞吐）

測試參數

```
CONCURRENCY = 200
DURATION_SECONDS = 30
MAX_ACCOUNT_ID = 1000
AMOUNT = 1
```

測試結果

```
Avg Success RPS ≈ 6459
Success Rate = 100%
```

觀察

- 長時間壓測下吞吐量略微下降
- Redis queue 仍維持穩定
- Worker 處理能力保持穩定

結論

```
單 DB 架構下
穩定吞吐量 ≈ 6.4k transfers/sec
```

---

# Sharding Benchmark

## 架構說明

本專案使用資料庫分片（Database Sharding）：

```
small_bank_meta
small_bank_s0
small_bank_s1
```

Routing 規則

```
accountId % shardCount
```

Meta Table

```
account_shards
```

用於記錄：

```
accountId → shardId
```

---

# Same-Shard Random Transfer

測試腳本

```
scripts/benchmark/random_transfer_same_shard.sh
```

測試情境

```
隨機帳戶轉帳
只允許 same-shard transfer
避免 cross-shard failure
```

測試目的

```
測量 sharding 架構在 same-shard 情況下的吞吐量
```

---

# Test 1

測試參數

```
CONCURRENCY = 200
DURATION_SECONDS = 30
MAX_ACCOUNT_ID = 1000
```

測試結果

```
Total Requests: 172400
Success Requests: 172400
Failed Requests: 0

Success Rate: 100%

Avg Total RPS: 5742
Avg Success RPS: 5742
Avg Fail RPS: 0
```

觀察

- 系統運行穩定
- 沒有 timeout
- same-shard routing 正常運作

---

# Test 2

測試參數

```
CONCURRENCY = 250
DURATION_SECONDS = 30
MAX_ACCOUNT_ID = 1000
```

測試結果

```
Total Requests: 185750
Success Requests: 185750
Failed Requests: 0

Success Rate: 100%

Avg Total RPS: 6190
Avg Success RPS: 6190
Avg Fail RPS: 0
```

觀察

- 系統仍保持完全穩定
- Worker 與 Redis queue 可以即時消化請求
- 吞吐量達到目前測試最高值

---

# Test 3

測試參數

```
CONCURRENCY = 300
DURATION_SECONDS = 30
MAX_ACCOUNT_ID = 1000
```

測試結果

```
Total Requests: 159900
Success Requests: 152518
Failed Requests: 7382

Success Rate: 95.38%

Avg Total RPS: 5327
Avg Success RPS: 5081
Avg Fail RPS: 245
```

錯誤統計

```
NETWORK_ERROR: 7382
```

觀察

- Client timeout 開始出現
- Redis queue backlog 增加
- Worker throughput 接近上限

---

# Test 4

測試參數

```
CONCURRENCY = 400
DURATION_SECONDS = 30
MAX_ACCOUNT_ID = 1000
```

測試結果

```
Avg Success RPS: 2848
Success Rate: 78%
```

觀察

- 系統明顯過載
- timeout 與 NETWORK_ERROR 大量增加
- 有效吞吐量明顯下降

---

# Sweet Spot 分析

Concurrency Sweep

| Concurrency | Success RPS | Success Rate |
|-------------|-------------|-------------|
| 200 | 5742 | 100% |
| 250 | **6190** | **100%** |
| 300 | 5081 | 95% |
| 400 | 2848 | 78% |

結論

```
系統最佳吞吐點 (Sweet Spot)

CONCURRENCY ≈ 250
```

此時系統可達到：

```
≈ 6200 transfers/sec
```

且保持：

```
100% success rate
```

---

# Async Job Transfer Benchmark

在加入 **Async Job API + Redis Transfer Queue** 後，  
系統的轉帳流程變為：

```
Client
↓
POST /transfers
↓
enqueue transfer job
↓
Redis Transfer Queue
↓
Queue Worker
↓
Execute DB transaction
↓
Update transfer job result
```

Benchmark 會：

```
1. 發送 transfer request
2. 取得 jobId
3. 輪詢 /transfer-jobs/:jobId
4. 等待 job 完成
5. 統計成功與失敗
```

因此此 benchmark 測量的是：

```
完整 transfer lifecycle throughput
```

而不是單純 API enqueue throughput。

---

# Same-Shard Random Transfer (Async Job)

測試腳本

```
scripts/benchmark/random_transfer_same_shard.sh
```

測試情境

```
隨機帳戶轉帳
只允許 same-shard transfer
```

目的

```
測量 async job 架構下
same-shard transaction throughput
```

---

# Test 1

測試參數

```
CONCURRENCY = 200
DURATION_SECONDS = 30
MAX_ACCOUNT_ID = 1000
AMOUNT = 1
```

測試結果

```
Total Requests: 6637
Success Requests: 6637
Failed Requests: 0

Success Rate: 100%

Avg Total RPS: 214.37
Avg Success RPS: 214.37
```

觀察

```
系統在 async job pipeline 下保持穩定
無 timeout 或 transaction error
same-shard transaction 正常運作
```

---

# Mixed Random Transfer (Same + Cross Shard)

測試腳本

```
scripts/benchmark/random_transfer_all_shards.sh
```

測試情境

```
完全隨機帳戶轉帳
包含 same-shard 與 cross-shard transaction
```

Shard 分布

```
Same-Shard ≈ 50%
Cross-Shard ≈ 50%
```

---

# Test 1

測試參數

```
CONCURRENCY = 200
DURATION_SECONDS = 30
MAX_ACCOUNT_ID = 1000
AMOUNT = 1
```

測試結果

```
Total Requests: 6463
Success Requests: 6463
Failed Requests: 0

Success Rate: 100%

Avg Total RPS: 209.95
Avg Success RPS: 209.95
```

Shard Mix

```
Same-Shard Picked   : 3251
Cross-Shard Picked  : 3212
```

觀察

```
cross-shard transaction 成功率 100%
compensation logic 正常運作
未出現 RESERVED transaction 卡住
```

---

# Same-Shard vs Mixed Throughput

| Workload | Success RPS |
|--------|--------|
| Same-Shard | **214.37** |
| Mixed Random | **209.95** |

差異

```
≈ 2%
```

觀察

```
cross-shard transaction 對整體吞吐影響很小
主要瓶頸更可能在 async job pipeline
而非 transaction 邏輯本身
```

---

# Concurrency Sweep Benchmark (Mixed Random)

為了更精確找出系統在 async job pipeline 下的吞吐極限，
進一步對 mixed workload 進行 concurrency sweep。

測試範圍：

```
CONCURRENCY = 300 ~ 1000
```

測試結果

| Concurrency | Total Requests | Success Requests | Failed Requests | Success Rate | Avg Total RPS | Avg Success RPS |
|-------------|----------------|------------------|----------------|--------------|---------------|-----------------|
| 300 | 9161 | 8936 | 225 | 97.54% | 292.82 | 285.63 |
| 400 | 11170 | 11170 | 0 | 100.00% | 361.36 | 361.36 |
| 500 | 13021 | 13021 | 0 | 100.00% | 421.79 | 421.79 |
| 550 | 13708 | 13708 | 0 | 100.00% | 442.44 | 442.44 |
| 600 | 15962 | 14175 | 1787 | 88.80% | 506.33 | 449.64 |
| 650 | 26863 | 11666 | 15197 | 43.43% | 865.15 | 375.72 |
| 700 | 34201 | 11085 | 23116 | 32.41% | 1097.42 | 355.69 |
| 750 | 38442 | 11156 | 27286 | 29.02% | 1227.36 | 356.18 |
| 800 | 40887 | 10240 | 30647 | 25.04% | 1286.32 | 322.15 |
| 850 | 43757 | 9574 | 34183 | 21.88% | 1401.88 | 306.73 |
| 900 | 44260 | 9400 | 34860 | 21.24% | 1423.15 | 302.25 |
| 950 | 41594 | 7354 | 34240 | 17.68% | 39.18 | 6.93 |
| 1000 | 20403 | 1843 | 18560 | 9.03% | 56.89 | 5.14 |

---

# Mixed Random Sweet Spot 分析

從 concurrency sweep 可以觀察到：

```
吞吐量在 concurrency 400 → 550 持續上升
```

在以下區間保持穩定：

```
CONCURRENCY ≈ 400 ~ 550
```

最佳穩定點為：

```
CONCURRENCY = 550
Avg Success RPS ≈ 442
Success Rate = 100%
```

---

# Peak Throughput

系統在以下條件達到目前觀測到的最高成功吞吐：

```
CONCURRENCY = 600
Avg Success RPS ≈ 449.64
Success Rate ≈ 88.8%
```

說明：

```
此點已接近系統處理極限
開始出現 transaction backlog 與 job timeout
```

因此不適合作為穩定運行配置。

---

# Overload 區間

當 concurrency ≥ 650 時：

```
failed requests 急劇增加
success rate 大幅下降
```

系統開始出現：

```
queue backlog
worker saturation
client timeout
```

成功吞吐反而下降。

---

# Benchmark 重要觀察

1️⃣ async job pipeline 顯著降低單機完成交易吞吐量

原因：

```
transfer lifecycle
= enqueue + queue + worker + DB transaction + job status update
```

而非單純 HTTP request throughput。

---

2️⃣ cross-shard transaction 對吞吐影響相對有限

mixed workload 與 same-shard workload 差異：

```
≈ 2%
```

說明目前瓶頸不在 transaction 邏輯。

---

3️⃣ 真正瓶頸更可能位於：

```
async job pipeline
queue processing
worker scheduling
job polling
```

---

# 系統能力總結

在目前架構下：

```
MacBook Air
8 workers
Redis transfer queue
PostgreSQL sharding (2 shards)
Async Job API
```

測得穩定吞吐量：

```
≈ 440 transfers/sec
```

(完整 transfer lifecycle throughput)

穩定 sweet spot：

```
CONCURRENCY ≈ 550
```

峰值吞吐：

```
≈ 450 transfers/sec
```

(但 success rate 下降)

---

# Poll Interval Sensitivity Benchmark

為了確認 **job polling interval** 對 async job benchmark 的影響，
進一步測試不同 polling interval 下的 concurrency sweep。

測試設定：

```
Poll Interval = 50ms / 100ms / 150ms
CONCURRENCY = 300 ~ 700
DURATION_SECONDS = 30
MAX_ACCOUNT_ID = 1000
AMOUNT = 1
```

Benchmark 流程：

```
1. Client 發送 POST /transfers
2. API enqueue transfer job
3. Client 取得 jobId
4. Client 輪詢 /transfer-jobs/:jobId
5. 等待 job 完成
6. 統計完成的 transfer 數量
```

此測試目的是：

```
觀察 polling frequency 對 benchmark throughput 的影響
```

---

# Poll Interval = 50 ms

| Concurrency | Success RPS | Success Rate |
|-------------|-------------|-------------|
| ~600 | ~449 | < 100% |

觀察：

```
poll interval 過短
client polling request 數量過多
Redis 與 API 需要處理額外查詢負載
```

結果：

```
benchmark throughput 被 polling noise 影響
success rate 開始下降
```

結論：

```
50ms polling 對系統造成額外負載
不適合作為 benchmark polling interval
```

---

# Poll Interval = 100 ms

| Concurrency | Success RPS | Success Rate |
|-------------|-------------|-------------|
| ~600 | ~507 | 100% |

觀察：

```
polling request 數量下降
job completion latency 仍然可接受
client 可以快速取得 job 完成狀態
```

結果：

```
benchmark throughput 提升
系統在 concurrency ≈ 600 時達到最高成功吞吐
```

結論：

```
100ms polling interval 為目前最佳設定
```

---

# Poll Interval = 150 ms

| Concurrency | Success RPS | Success Rate |
|-------------|-------------|-------------|
| ~600 | ~493 | 100% |

觀察：

```
polling interval 變慢
client 取得 job 完成結果的時間延後
```

結果：

```
job 已完成但 client 尚未 poll
benchmark latency 增加
throughput 略微下降
```

結論：

```
poll interval 過大會增加完成等待時間
導致 benchmark RPS 下降
```

---

# Poll Interval Comparison

| Poll Interval | Peak Success RPS | Success Rate | Observation |
|---------------|------------------|--------------|-------------|
| 50 ms | ~449 | <100% | polling request 過多 |
| 100 ms | **~507** | **100%** | throughput 最佳 |
| 150 ms | ~493 | 100% | polling latency 增加 |

---

# Benchmark 結論

Polling interval 會直接影響 benchmark 測得的 throughput。

原因：

```
benchmark RPS = 完成 job 的速度
```

而 polling interval 會影響：

```
client 偵測 job 完成的速度
```

因此：

```
poll interval 太小 → polling noise
poll interval 太大 → completion latency
```

最佳平衡點為：

```
Poll Interval ≈ 100 ms
```

---

# 更新後系統能力評估

在最佳 polling interval 設定下：

```
Poll Interval = 100ms
CONCURRENCY ≈ 600
```

系統可達到：

```
Peak Success RPS ≈ 500 transfers/sec
```

穩定區間：

```
CONCURRENCY ≈ 500 ~ 600
```

超過此區間後：

```
worker saturation
queue backlog
client timeout
```

會開始出現，成功吞吐量下降。

---

# 最終系統能力總結

目前架構：

```
MacBook Air
Node.js + Egg.js (Cluster)
8 workers
Redis transfer queue
PostgreSQL sharding (2 shards)
Async Job API
```

在 **完整 transfer lifecycle** 下：

```
穩定吞吐量 ≈ 450 transfers/sec
峰值吞吐量 ≈ 500 transfers/sec
```

最佳配置：

```
CONCURRENCY ≈ 600
POLL_INTERVAL ≈ 100ms
```

---

# Benchmark 重點觀察

1️⃣ async job pipeline 會降低完成交易吞吐量

原因：

```
transfer lifecycle
= enqueue + queue + worker + DB transaction + job status update
```

---

2️⃣ cross-shard transaction 對吞吐影響有限

mixed workload 與 same-shard workload 差異：

```
≈ 2%
```

顯示目前瓶頸不在 transaction 邏輯。

---

3️⃣ 主要瓶頸更可能位於：

```
async job pipeline
queue processing
worker scheduling
job polling
```

---

# 未來優化方向

可能的優化方向包括：

```
增加 worker 數量
調整 PostgreSQL connection pool
API worker 與 queue worker 分離
```

以進一步提升整體吞吐能力。
