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
- Database Sharding

資料庫

```
small_bank_meta
small_bank_s0
small_bank_s1
small_bank_s2
small_bank_s3
```

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

本專案測試包含三種架構：

1️⃣ 單資料庫架構（Single Database）  
2️⃣ 分片架構（Database Sharding - 2 Shards）  
3️⃣ 分片架構（Database Sharding - 4 Shards）

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

結論

```
單 DB 架構
穩定吞吐量 ≈ 6.4k transfers/sec
```

---

# Async Job Transfer Architecture

加入 **Async Job API + Redis Transfer Queue** 後：

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

Benchmark 流程

```
1. 發送 transfer request
2. 取得 jobId
3. 輪詢 /transfer-jobs/:jobId
4. 等待 job 完成
5. 統計成功與失敗
```

此 benchmark 測量的是：

```
完整 transfer lifecycle throughput
```

---

# Async Job Throughput

## Same-Shard Random Transfer

測試結果

```
Avg Success RPS ≈ 214
Success Rate = 100%
```

---

## Mixed Random Transfer

測試結果

```
Avg Success RPS ≈ 209
Success Rate = 100%
```

差異

```
≈ 2%
```

結論

```
cross-shard transaction 對吞吐影響很小
主要瓶頸在 async job pipeline
```

---

# Queue Batch Size Tuning

原始設定

```
batchSize = 20
```

調整為

```
batchSize = 10
```

效果

| Batch Size | Peak RPS |
|-------------|----------|
| 20 | ~507 |
| 10 | **~656** |

提升

```
≈ +29%
```

原因

```
降低單次 queue drain latency
提高 queue scheduling 粒度
```

---

# Concurrency Sweep（2 Shards）

| Concurrency | Success RPS | Success Rate |
|-------------|-------------|-------------|
| 700 | 606 | 100% |
| 750 | 632 | 100% |
| 800 | 653 | 100% |
| 850 | **656** | 93.76% |
| 900 | 596 | 68.69% |
| 950 | 568 | 60.65% |
| 1000 | 524 | 45.71% |

Stable Sweet Spot

```
CONCURRENCY ≈ 800
Avg Success RPS ≈ 653
Success Rate = 100%
```

Peak Throughput

```
≈ 656 transfers/sec
```

---

# Worker Scaling Benchmark

測試條件

```
CONCURRENCY = 800
batchSize = 10
poll interval = 100ms
```

測試結果

| Workers | Avg Success RPS | Success Rate |
|--------|-----------------|-------------|
| 6 | 603 | 95% |
| 8 | **653** | **100%** |
| 10 | 583 | 84% |
| 12 | 602 | 100% |

結論

```
最佳 worker 數量 ≈ CPU 平行度
本環境最佳值為 8 workers
```

---

# Sharding Benchmark（4 Shards）

資料庫

```
small_bank_s0
small_bank_s1
small_bank_s2
small_bank_s3
```

Routing

```
accountId % shardCount
```

帳戶分布

```
250 accounts per shard
```

---

# Same-Shard Concurrency Sweep（4 Shards）

| Concurrency | Total Requests | Success Requests | Failed Requests | Success Rate | Avg Total RPS | Avg Success RPS |
|-------------|----------------|------------------|----------------|--------------|---------------|-----------------|
| 300 | 9289 | 9289 | 0 | 100.00% | 300.63 | 300.63 |
| 400 | 11369 | 11369 | 0 | 100.00% | 361.69 | 361.69 |
| 500 | 13376 | 13376 | 0 | 100.00% | 430.57 | 430.57 |
| 600 | 15785 | 15785 | 0 | 100.00% | **510.28** | **510.28** |
| 700 | 20483 | 14249 | 6234 | 69.57% | 659.61 | 458.86 |
| 800 | 30716 | 13902 | 16814 | 45.26% | 993.08 | 449.47 |
| 900 | 36440 | 12117 | 24323 | 33.25% | 1165.04 | 387.40 |

Sweet Spot

```
CONCURRENCY ≈ 600
Avg Success RPS ≈ 510
Success Rate = 100%
```

---

# Throughput Curve

```
Concurrency ↑
↓
Throughput ↑
↓
Plateau
↓
Overload
↓
Throughput ↓
```

系統在

```
600 concurrency
```

達到最佳吞吐。

---

# 系統能力總結

目前架構

```
Node.js + Egg Cluster
8 workers
Redis transfer queue
PostgreSQL sharding
Async Job API
```

系統能力

```
Single DB throughput ≈ 6400 transfers/sec
Async Queue throughput ≈ 650 transfers/sec
4-shard throughput ≈ 510 transfers/sec
```

Async job pipeline 帶來更穩定的併發控制，但降低了單機吞吐。

---

# Benchmark 重要觀察

1️⃣ Async job pipeline 會降低單機吞吐

原因

```
enqueue
queue
worker
DB transaction
job polling
```

---

2️⃣ Sharding 主要降低 DB contention

但在 async pipeline 下：

```
queue system 成為主要瓶頸
```

---

3️⃣ 系統 overload threshold

```
Concurrency ≈ 700
```

超過後 queue backlog 開始增加。

---

# 目前主要瓶頸

```
Redis transfer queue
worker scheduling
job polling
async pipeline overhead
```

而非單純 DB throughput。

---

# 未來優化方向

可能的優化方向

```
API worker / queue worker 分離
Redis pipeline / Lua queue
減少 job polling
增加 shard 數量
多機部署
```

進一步提升吞吐能力。

---

# 未來 Benchmark 計畫

後續計畫測試：

```
API enqueue throughput benchmark
不同 shard 數 scaling
worker / queue worker 分離架構
multi-node deployment
```

以評估系統在更接近 production 的架構下的性能表現。