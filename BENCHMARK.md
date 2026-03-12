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

# 重要觀察

1️⃣ 系統在以下情況達到飽和：

```
CONCURRENCY ≈ 250
```

2️⃣ 當 concurrency 超過系統能力時：

```
Redis queue backlog
Client timeout
NETWORK_ERROR
```

3️⃣ same-shard transaction 仍然會產生：

```
row-level lock contention
```

4️⃣ Sharding 的優勢主要在：

```
降低不同帳戶之間的 DB contention
```

而不是解決同 shard 的鎖競爭。

---

# 未來優化方向

## 1 PostgreSQL connection pool tuning

```
增加 pool size
提高並行處理能力
```

---

## 2 API worker 與 queue worker 分離

目標架構

```
API Workers
↓
enqueue transfer job

Queue Workers
↓
process transfer
```

---

## 3 進一步壓測

建議測試

```
CONCURRENCY = 280
CONCURRENCY = 320
```

目的

```
更精確找出系統 saturation curve
```

---

# 系統能力總結

在目前架構下：

```
8 workers
Redis transfer queue
PostgreSQL sharding (2 shards)
1000 accounts
```

系統可穩定支撐約：

```
≈ 6200 transfers/sec
```

在 same-shard random workload 情境下。

---