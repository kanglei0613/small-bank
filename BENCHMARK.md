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

# 系統能力總結

在目前架構下：

```
8 workers
Redis transfer queue
PostgreSQL sharding (2 shards)
Async Job API
```

測得吞吐量：

```
≈ 210 transfers/sec
```

此數值代表：

```
完整 transfer lifecycle throughput
```

而非單純 API request throughput。

---