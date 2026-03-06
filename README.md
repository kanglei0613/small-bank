# Small Bank (Node.js / Egg.js + PostgreSQL)

## 專案說明

本專案為一個簡化版銀行系統（Small Bank），使用 **Node.js + Egg.js + PostgreSQL** 實作，重點在：

- RESTful API 設計
- 高併發下資料一致性處理
- 帳戶餘額正確性保證
- 轉帳操作的併發安全控制
- PostgreSQL Transaction + Row-level Lock
- Lock Timeout Fail-Fast Strategy

---

## 系統架構

目前系統採用：

- **Egg.js Cluster**
- **PostgreSQL**

```text
            ┌────────────────────┐
            │     API Server     │
            │   Egg.js Cluster   │
            │   Multiple Workers │
            └─────────┬──────────┘
                      │
                      │
              ┌──────────────┐
              │  PostgreSQL  │
              │  small_bank  │
              │              │
              │  accounts    │
              │  transfers   │
              └──────────────┘
```

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

## 功能實作

### 1. 使用者（User)

```
POST /users
GET /users/:id
```

用途：

- 建立使用者
- 查詢使用者

---

### 2. 帳戶（Account）

```
POST /accounts
GET /accounts/:id
```

帳戶餘額不可直接修改，必須透過 **transfer** 改變。

---

### 3. 轉帳（Transfer）

```
POST /transfers
```

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

為避免高併發下 transaction 長時間等待 row lock，  
在 transfer transaction 中加入：

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

### 轉帳

```bash
curl -X POST http://127.0.0.1:7001/transfers \
  -H "Content-Type: application/json" \
  -d '{"fromId":1,"toId":2,"amount":30}'
```

---

## 執行方式

### 安裝套件

```bash
npm install
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
DB: PostgreSQL
Locking: row-level locking

Simulated hot account contention
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
Req/sec (avg) ≈ 1595
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

因此：

```text
PostgreSQL transaction 成為主要瓶頸
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
Redis queue
transfer queue
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