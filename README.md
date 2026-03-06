# Small Bank (Node.js / Egg.js + PostgreSQL)

## 專案說明

本專案為一個簡化版銀行系統（Small Bank），使用 **Node.js + Egg.js + PostgreSQL** 實作，重點在：

- RESTful API 設計
- 高併發下資料一致性處理
- 帳戶餘額正確性保證
- 轉帳操作的併發安全控制
- PostgreSQL Transaction + Row-level Lock
- Database Sharding（水平擴展）

---

## 系統架構

目前系統採用：

- **Egg.js Cluster**
- **PostgreSQL Sharding**

```text
                ┌────────────────────┐
                │     API Server     │
                │   Egg.js Cluster   │
                │    Multiple Workers│
                └─────────┬──────────┘
                          │
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
   ┌──────────────┐                   ┌──────────────┐
   │ small_bank_s0 │                   │ small_bank_s1 │
   │  shard DB     │                   │  shard DB     │
   │ accounts      │                   │ accounts      │
   │ transfers     │                   │ transfers     │
   └──────────────┘                   └──────────────┘
                │
                │
        ┌──────────────┐
        │ small_bank_meta │
        │ routing table   │
        │ account_shards  │
        └──────────────┘
```

---

## Database Sharding 設計

系統使用 **三個 PostgreSQL Database**

### small_bank_meta

儲存帳戶與 shard 的 routing 資訊。

Table：

```text
account_shards
```

|欄位|型別|
|---|---|
|account_id|BIGINT|
|shard_id|INT|
|created_at|TIMESTAMP|

用途：

```text
account_id -> shard_id
```

---

### small_bank_s0

Shard Database 0

包含：

```text
accounts
transfers
```

---

### small_bank_s1

Shard Database 1

Schema 與 `small_bank_s0` 相同。

---

## Sharding Strategy

目前使用 **Modulo-based Sharding**

```text
shard_id = account_id % shard_count
```

Example（2 shards）：

```text
account_id 1 -> shard 1
account_id 2 -> shard 0
account_id 3 -> shard 1
account_id 4 -> shard 0
```

---

## Sharding 實作進度

目前系統已完成基本 **Database Sharding routing**。

Database 架構：

```text
small_bank_meta   (routing table)
small_bank_s0     (shard)
small_bank_s1     (shard)
```

routing table：

```text
account_shards
```

Example：

```text
account_id | shard_id
1          | 1
```

代表：

```text
account 1 存在於 small_bank_s1
```

建立帳戶流程：

```text
create user
      ↓
create account
      ↓
計算 shard_id
      ↓
寫入 shard database
      ↓
更新 routing table
```

目前已成功驗證：

- account routing
- shard 寫入
- routing table 建立

Example：

```bash
psql -d small_bank_meta -c "SELECT * FROM account_shards;"
```

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

建立帳戶流程：

1. 建立 account_id
2. 計算 shard_id
3. 寫入 shard database
4. 更新 routing table

---

### 3. 轉帳（Transfer）

```
POST /transfers
```

---

### 轉帳特性

- 檢查餘額是否足夠
- 使用 PostgreSQL Transaction
- 使用 `SELECT ... FOR UPDATE` 進行 row-level locking
- 固定順序上鎖避免 deadlock
- 同時寫入 `transfers` 交易紀錄表

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

## 高併發設計說明

### Transaction + Row-Level Lock

每筆轉帳流程：

1. 開啟 database transaction
2. 依 accountId 排序後加鎖
3. 使用 `SELECT ... FOR UPDATE` 鎖定帳戶
4. 檢查餘額
5. 更新餘額
6. 寫入 transfers 紀錄
7. Commit

---

## 為何需要固定順序上鎖？

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

透過排序：

```text
先鎖較小 id
再鎖較大 id
```

可避免交叉等待。

---

## 設計說明

### 為何不能直接修改餘額？

銀行系統中餘額不應直接透過 `UPDATE` 操作改變，而應透過交易（transaction）改變。

優點：

- 保證交易可追溯性
- 避免資料被任意覆寫
- 確保帳務一致性
- 保證 ACID 特性

---

## 壓測結果（Benchmark）

本專案使用 **autocannon** 進行壓力測試。

測試環境：

- MacBook Air (Apple Silicon)
- Node.js v20
- PostgreSQL 16

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

- 此 API 不存取資料庫
- 可視為 Node.js + Egg.js 的純應用層吞吐能力
- 證明系統瓶頸不在 Web Server

---

## 熱點帳戶轉帳（高鎖競爭）

測試情境：

所有請求集中於兩個帳戶互轉

```text
1 -> 2
2 -> 1
```

測試結果：

```text
≈ 1.4k RPS
平均延遲 ≈ 55ms
```

說明：

- row-level lock 競爭嚴重
- transaction 必須序列化
- PostgreSQL 成為瓶頸

---

## 多帳戶隨機轉帳

測試情境：

多帳戶隨機轉帳，分散 lock contention。

測試結果：

```text
≈ 5k RPS
平均延遲 ≈ 38ms
0 error
```

說明：

- 鎖競爭降低
- throughput 顯著提升

---

## 效能觀察

實驗結果顯示：

```text
Node.js / Egg.js 應用層 ≈ 40k RPS
PostgreSQL transaction 成為主要瓶頸
單 DB transfer throughput ≈ 5k RPS
```

透過 Sharding 可以提升整體吞吐量。

---

## 未來優化方向

可能優化方向：

- 增加 shard 數量
- PostgreSQL tuning
- connection pool tuning
- WAL tuning
- transfer table partition
- async transfer pipeline

目標：

```text
10k RPS transfer workload
```

---

## Concurrency Test

### Single Worker
- 20 concurrent transfers: passed
- 50 concurrent transfers: passed

### 8 Workers Cluster
- 50 concurrent transfers: passed

Result:
- balance consistency preserved
- transfer records fully written
- no lost update
- no overdraft

Author: **kanglei0613**