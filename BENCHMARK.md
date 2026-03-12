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

結論

```
same-shard 穩定吞吐量 ≈ 5.7k RPS
```

---

# Test 2

測試參數

```
CONCURRENCY = 400
DURATION_SECONDS = 30
MAX_ACCOUNT_ID = 1000
```

測試結果

```
Total Requests: 109200
Success Requests: 85805
Failed Requests: 23395

Success Rate: 78.58%

Avg Total RPS: 3625
Avg Success RPS: 2848
Avg Fail RPS: 776
```

錯誤統計

```
NETWORK_ERROR: 23395
```

觀察

- Client timeout 開始出現
- Redis queue backlog 增加
- Worker 處理能力達到瓶頸

結論

```
系統飽和點約在

CONCURRENCY ≈ 200
```

當 concurrency 超過系統飽和點時：

```
吞吐量下降
timeout 增加
NETWORK_ERROR 上升
```

---

# 性能總覽

| 架構 | Workload | Concurrency | RPS | 成功率 |
|----|----|----|----|----|
| Single DB | Hotspot | 50 | ~1595 | 100% |
| Single DB | Random (10s) | 200 | ~8547 | 100% |
| Single DB | Random (30s) | 200 | ~6459 | 100% |
| Sharding | Same-Shard Random | 200 | ~5742 | 100% |
| Sharding | Same-Shard Random | 400 | ~2848 | 78% |

---

# 重要觀察

1️⃣ 系統在以下情況達到飽和：

```
CONCURRENCY ≈ 200
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

## 1 Worker tuning

可能測試

```
workers = 12
workers = 16
```

---

## 2 PostgreSQL connection pool tuning

```
增加 pool size
提高並行處理能力
```

---

## 3 API worker 與 queue worker 分離

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

## 4 進一步壓測

建議測試

```
CONCURRENCY = 250
CONCURRENCY = 300
```

目的

```
找到系統的 saturation curve
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
≈ 5.7k transfers/sec
```

在 same-shard random workload 情境下。

---
