# Small Bank (Node.js / Egg.js + PostgreSQL + Redis)

## 專案說明

本專案實作一個簡化版銀行系統（Small Bank），使用：

- Node.js
- Egg.js
- PostgreSQL
- Redis

本專案的重點在於探索 **高併發轉帳系統的設計與優化**，包含：

- Transaction + Row-level Lock
- Redis queue-based transfer architecture
- Admission control（避免系統過載）
- Batch queue processing
- Queue metrics
- Benchmark-driven performance testing

系統主要功能：

- 建立使用者
- 建立帳戶
- 查詢帳戶餘額
- 轉帳
- 查詢轉帳紀錄
- 高併發壓力測試

---

# 系統架構

## High Level Architecture

```
Client
   │
   ▼
HTTP API (Egg.js)
   │
   │ enqueue transfer job
   ▼
Redis Transfer Queue
   │
   ▼
Queue Worker (Background)
   │
   ▼
PostgreSQL
(Transaction + Row-level Lock)
```

設計目標：

在高併發情境下減少 **資料庫 lock contention**，並提升系統吞吐量。

---

## Architecture Diagram

```
                +-------------+
                |   Client    |
                +-------------+
                       │
                       ▼
              +------------------+
              |   Egg.js API     |
              |   (Cluster x8)   |
              +------------------+
                       │
                       │ enqueue transfer job
                       ▼
               +----------------+
               | Redis Transfer |
               |     Queue      |
               +----------------+
                       │
                       ▼
               +----------------+
               | Queue Workers  |
               |  (Batch Drain) |
               +----------------+
                       │
                       ▼
               +----------------+
               |  PostgreSQL    |
               | Transactions + |
               | Row-level Lock |
               +----------------+
```

系統將流程拆成三個階段：

```
API 接收請求
        ↓
Redis Queue 緩衝請求
        ↓
Worker 執行轉帳
        ↓
PostgreSQL Transaction
```

這樣可以避免 API worker 在高併發時被資料庫 transaction block。

---

# 為什麼使用 Queue 架構

如果 API 直接執行轉帳：

```
API → PostgreSQL → Transaction
```

在高併發下可能出現：

- row-level lock 競爭
- API worker 被 transaction block
- throughput 不穩定
- latency 上升

因此改為：

```
API → Redis Queue → Worker → DB
```

角色分工如下：

| 元件 | 職責 |
|-----|-----|
| API Worker | 接收 request，建立 transfer job |
| Redis Queue | 暫存轉帳任務 |
| Queue Worker | 背景執行轉帳 |
| PostgreSQL | 保證資料一致性 |

優點：

- 減少 DB lock contention
- 平滑處理高併發流量
- 提升系統穩定度
- 提高 sustained throughput

---

# Concurrency Control Strategy

轉帳系統最大的挑戰是 **併發一致性（Concurrency + Consistency）**。

本系統採用三層策略：

---

## 1️⃣ PostgreSQL Transaction + Row-level Lock

每筆轉帳使用：

```
BEGIN
SELECT ... FOR UPDATE
UPDATE balance
INSERT transfer record
COMMIT
```

Row-level lock 確保：

- 同一帳戶餘額不會被同時修改
- 轉帳具有原子性
- 資料一致性

---

## 2️⃣ Redis Queue Serialization

Redis queue 將同一帳戶的轉帳 **序列化處理**。

例如：

```
transfer:queue:from:6
```

所有 `fromId = 6` 的轉帳會排入同一 queue：

```
transfer1
transfer2
transfer3
```

Worker 會依序處理。

好處：

- 避免 DB lock 競爭
- 減少 transaction 衝突
- 提升 throughput

---

## 3️⃣ Admission Control

為避免 queue 過長導致系統過載：

```
maxQueueLengthPerFromId
```

當 queue 超過 threshold：

```
API 會直接拒絕 request
```

好處：

- 保護資料庫
- 防止系統雪崩
- 維持穩定吞吐

---

# Transfer Flow

## Step 1：Client 發送轉帳

```
POST /transfers
```

範例：

```json
{
  "fromId": 6,
  "toId": 7,
  "amount": 1
}
```

---

## Step 2：API 建立 Transfer Job

API 不直接執行轉帳，而是將 job 放入 Redis queue：

```
transfer:queue:from:{fromId}
```

例如：

```
transfer:queue:from:6
```

---

## Step 3：Queue Worker 處理

Worker 會從 queue 取出 job，並執行：

```
PostgreSQL Transaction
+
Row-level Lock
```

確保：

- 轉帳原子性
- 餘額一致性
- 交易紀錄正確

---

# Redis Transfer Queue

每個帳戶有自己的 queue：

```
transfer:queue:from:{accountId}
```

例如：

```
transfer:queue:from:6
```

這樣可以避免：

- 多 request 競爭同一帳戶
- hot account lock contention

---

# Admission Control

為避免 queue 無限制成長：

```
maxQueueLengthPerFromId
```

當 queue 超過 threshold：

```
request 會被拒絕
```

這可以：

- 保護資料庫
- 防止系統過載
- 維持整體穩定

---

# Batch Queue Processing

Queue worker 會批次處理 queue：

```
batchSize = 20
```

優點：

- 減少 Redis round-trip
- 提升處理效率
- 提高吞吐量

---

# Queue Metrics

系統提供 Queue Metrics API。

---

## 查詢單一 Queue

```
GET /queue/stats?fromId=6
```

範例：

```json
{
  "ok": true,
  "data": {
    "fromId": 6,
    "queueLength": 2
  }
}
```

---

## 查詢整體 Queue 狀態

```
GET /queue/global-stats
```

範例：

```json
{
  "ok": true,
  "data": {
    "totalQueues": 3,
    "totalJobs": 8,
    "hotAccounts": [
      { "fromId": 6, "queueLength": 5 }
    ]
  }
}
```

可以觀察：

- queue 壓力
- hot accounts
- worker 活動

---

# API 使用方式

## Users

建立使用者

```
POST /users
```

查詢使用者

```
GET /users/:id
```

---

## Accounts

建立帳戶

```
POST /accounts
```

查詢帳戶

```
GET /accounts/:id
```

---

## Transfers

建立轉帳 job

```
POST /transfers
```

查詢轉帳紀錄

```
GET /transfers
```

---

## Transfer Job

查詢 job 狀態

```
GET /transfer-jobs/:jobId
```

---

# Benchmark

Benchmark scripts 位於：

```
scripts/
```

---

## Full Benchmark

執行完整測試：

```
./scripts/full_benchmark.sh
```

流程：

1. Reset database
2. 建立 1000 accounts
3. 執行 random transfer benchmark

---

## Random Transfer Benchmark

Script：

```
scripts/random_transfer_test.js
```

特性：

- 隨機 fromId
- 隨機 toId
- 分散 workload
- 模擬真實交易

設定範例：

```
MAX_ACCOUNT_ID = 1000
CONCURRENCY = 200
DURATION_SECONDS = 10
AMOUNT = 1
```

---

# Benchmark Results

## 測試環境

```
Egg.js cluster workers: 8
Redis transfer queue
PostgreSQL transactions
Batch size: 20
Accounts: 1000
```

---

# Burst Throughput（短時間吞吐）

測試：

```
CONCURRENCY = 200
DURATION = 10 seconds
```

結果：

```
Total Requests: 85600
Success Requests: 85600
Success Rate: 100%

Average Success RPS ≈ 8547
```

---

# Sustained Throughput（長時間穩定吞吐）

測試：

```
CONCURRENCY = 200
DURATION = 30 seconds
```

結果：

```
Total Requests: 193800
Success Requests: 193800
Success Rate: 100%

Average Success RPS ≈ 6459
```

系統可在 distributed workload 下 **穩定維持約 6k+ RPS**。

---

# 未來優化方向

## Database Sharding

目前所有帳戶仍在單一 PostgreSQL database。

未來可透過 **database sharding**：

```
accounts_0
accounts_1
accounts_2
```

透過 shard routing：

```
accountId % shardCount
```

優點：

- 分散 DB load
- 降低單一 database bottleneck
- 提升系統整體吞吐量

---

# 總結

本專案展示如何設計一個 **高併發轉帳系統**，包含：

- Redis queue-based architecture
- PostgreSQL transaction + row-level locking
- admission control
- batch queue processing
- queue metrics
- benchmark-driven optimization

目前系統可在 **distributed random workload** 下穩定達到：

```
~6k+ RPS sustained transfer throughput
```

並為未來 **database sharding 架構**打下基礎。