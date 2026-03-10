# Small Bank (Node.js / Egg.js + PostgreSQL + Redis)

## 專案說明

本專案為一個簡化版銀行系統（Small Bank），使用 **Node.js + Egg.js + PostgreSQL + Redis** 實作，重點在：

- RESTful API 設計
- 高併發下資料一致性處理
- 帳戶餘額正確性保證
- 轉帳操作的併發安全控制
- PostgreSQL Transaction + Row-level Lock
- Lock Timeout Fail-Fast Strategy
- Async Job API
- Redis Transfer Queue
- Cluster-safe Queue Processing

---

## 系統架構

目前系統採用：

- **Egg.js Cluster**
- **Redis Queue**
- **PostgreSQL**

```text
                 ┌────────────────────────┐
                 │       API Server       │
                 │     Egg.js Cluster     │
                 │     Multiple Workers   │
                 └───────────┬────────────┘
                             │
                             │
                    ┌────────▼────────┐
                    │   Redis Queue   │
                    │ transfer:queue  │
                    │  per-fromId     │
                    └────────┬────────┘
                             │
                             │
                      ┌──────▼──────┐
                      │ PostgreSQL  │
                      │ small_bank  │
                      │             │
                      │ accounts    │
                      │ transfers   │
                      └─────────────┘
```

---

## Transfer Processing Flow

轉帳 API 採用 **Async Job API**。

Client 呼叫：

```text
POST /transfers
```

Server 不直接執行 transaction，而是：

```text
建立 transfer job
↓
寫入 Redis Job Store
↓
推入 Redis Queue
↓
worker drain queue
↓
執行 PostgreSQL transaction
↓
更新 job status
```

Client 會先收到：

```json
{
  "jobId": "...",
  "status": "queued"
}
```

之後透過：

```text
GET /transfer-jobs/:jobId
```

查詢最終結果。

---

## System Invariants

銀行系統必須滿足以下不變條件：

```text
1. Balance cannot be negative
2. Total balance invariant preserved
3. Every successful transfer must create a transfer record
```

說明：

```text
balance >= 0
Σ(balance before) = Σ(balance after)
successful transfer → transfer record
```

---

## Database Schema

系統包含兩個核心資料表。

### accounts

|欄位|型別|
|---|---|
|id|BIGINT|
|user_id|BIGINT|
|balance|BIGINT|
|created_at|TIMESTAMP|
|updated_at|TIMESTAMP|

---

### transfers

|欄位|型別|
|---|---|
|id|BIGINT|
|from_account_id|BIGINT|
|to_account_id|BIGINT|
|amount|BIGINT|
|created_at|TIMESTAMP|

---

## Redis Transfer Queue

為了解決 **Hot Account Contention** 問題，系統使用：

```text
per-fromId queue
```

Redis key：

```text
transfer:queue:from:{fromId}
```

例如：

```text
transfer:queue:from:6
```

設計效果：

```text
同一 fromId transfer 會被序列化
不同 fromId transfer 可以並行
```

避免：

```text
多筆 transfer 同時修改同一帳戶
```

---

## Cluster-safe Queue Processing

系統支援 **Egg.js Cluster / multi-worker**。

為避免多 worker 同時處理同一 queue，使用：

```text
Redis Owner Lock
```

Owner key：

```text
transfer:queue:owner:from:{fromId}
```

流程：

```text
worker 嘗試 SET NX owner lock

成功 → drain queue
失敗 → queue 已由其他 worker 處理
```

Owner lock TTL：

```text
10 seconds
```

worker 在 drain 過程中會持續 refresh lock。

---

## Transaction 設計

每筆轉帳流程：

```text
BEGIN
↓
鎖定帳戶 row
SELECT ... FOR UPDATE
↓
檢查餘額
↓
扣款
↓
加款
↓
寫入 transfer record
↓
COMMIT
```

---

## Deadlock Prevention

若兩筆轉帳同時執行：

```text
A：1 -> 2
B：2 -> 1
```

若未排序，可能發生：

```text
A 鎖 1 等 2
B 鎖 2 等 1
```

造成 **deadlock**。

解決方式：

```text
先鎖較小 id
再鎖較大 id
```

避免交叉等待。

---

## Lock Timeout Strategy

為避免高併發下 transaction 長時間等待 row lock：

```sql
SET LOCAL lock_timeout = '200ms'
```

設計理念：

```text
Fail Fast instead of Wait Forever
```

效果：

```text
lock wait timeout → transaction cancel
API 回傳 504 Gateway Timeout
connection pool 不被占滿
```

API Response：

```json
{
  "ok": false,
  "message": "request timeout"
}
```

---

## API 使用範例

### 建立使用者

```bash
curl -X POST http://127.0.0.1:7001/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice"}'
```

---

### 建立帳戶

```bash
curl -X POST http://127.0.0.1:7001/accounts \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"initialBalance":100}'
```

---

### 建立轉帳

```bash
curl -X POST http://127.0.0.1:7001/transfers \
  -H "Content-Type: application/json" \
  -d '{"fromId":1,"toId":2,"amount":30}'
```

---

### 查詢 Job

```bash
curl http://127.0.0.1:7001/transfer-jobs/{jobId}
```

---

## 執行方式

### 安裝套件

```bash
npm install
```

---

### 啟動 Redis

```bash
brew services start redis
```

---

### 啟動 PostgreSQL（macOS）

```bash
brew services start postgresql@16
```

---

### 啟動開發模式

```bash
npm run dev
```

預設執行於：

```text
http://127.0.0.1:7001
```

---

## 壓測結果（Benchmark）

本專案使用 **autocannon** 進行壓力測試。

測試環境：

```text
MacBook Air (Apple Silicon)
Node.js v20
PostgreSQL 16
Redis
Egg.js cluster: 8 workers
```

---

## Health API（不經資料庫）

測試指令：

```bash
autocannon -c 200 -d 15 http://127.0.0.1:7001/health
```

測試結果：

```text
≈ 39k - 46k RPS
平均延遲 ≈ 6-8ms
```

說明：

```text
此 API 不存取資料庫
代表 Node.js + Egg.js 應用層的最大吞吐能力
```

---

## Hot Account Contention Test

### Test Setup

```text
8 workers cluster
Redis Queue
PostgreSQL transaction
row-level locking

fromId = 6
toId = 7
amount = 1
```

---

### Load Test

```text
Tool: autocannon

connections = 50
duration = 10 seconds
endpoint = POST /transfers
```

---

### Initial Data

```text
Account 6 balance = 100000
Account 7 balance = 0
```

---

### Performance Result

```text
Req/sec (avg) ≈ 1600
Total requests ≈ 18000
```

Latency

| Metric | Value |
|------|------|
| Average | ~30 ms |
| p50 | ~22 ms |
| p99 | ~140 ms |
| Max | ~287 ms |

---

### Transfer Result

```text
Successful transfers = 17595

Final account 6 balance = 82405
Final account 7 balance = 17595
```

驗證：

```text
Total balance invariant preserved
```

---

## Observation

在熱點帳戶競爭情境下：

```text
多個 transaction 競爭相同 account row
```

造成：

```text
transaction queue
row-level lock contention
```

透過 Redis queue：

```text
transfer 被序列化
避免 row lock storm
```

目前系統主要瓶頸：

```text
PostgreSQL transaction throughput
```

---

## Future Improvements

可能優化方向：

### Redis

```text
account balance read cache
hot account protection
rate limit
減少 PostgreSQL 壓力
```

---

### System Protection

```text
request rate limiting
backpressure
connection pool protection
```

---

### Architecture Improvement

```text
database sharding
分散資料量
分散寫入壓力
提升吞吐量
```

或

```text
Redis transfer queue
job retry
dead letter queue
```

---

## Target

```text
10k RPS transfer workload
```

---

## Concurrency Test

### Single Worker

```text
20 concurrent transfers: passed
50 concurrent transfers: passed
```

### 8 Workers Cluster

```text
50 concurrent transfers: passed
```

Result

```text
balance consistency preserved
transfer records fully written
no lost update
no overdraft
```

---

Author: **kanglei0613**