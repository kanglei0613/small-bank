# Small Bank

一個以 **Node.js + Egg.js + PostgreSQL + Redis + React** 實作的高併發銀行系統實驗專案。  
本專案的重點不只是 CRUD API，而是針對 **高併發轉帳、Sharding、Async Queue、Worker 分離、Benchmark 調校、前端操作體驗** 進行系統化設計與驗證。

目前系統已具備：

```text
- PostgreSQL Sharding（4 shards）
- Redis Transfer Queue
- Same-Shard Fast Path
- Cross-Shard Async Pipeline
- General API / Transfer API / Queue Worker 分離
- Account Redis Cache
- 使用者查詢回傳帳戶列表（user -> accounts）
- 前端網路銀行介面（React）
- 多組 Benchmark 與 Worker Scaling 實驗
```

---

# 專案目標

本專案的主要目標是驗證在單機環境下，如何透過：

```text
Sharding
Async Queue
Worker Role Separation
Same-Shard Fast Path
Cross-Shard Transaction Design
Frontend Integration
```

提升系統在高併發 transfer workload 下的吞吐量與穩定性。

重點不只是：

```text
能不能接住很多 request
```

而是：

```text
1. request intake throughput 能到多少
2. 真正 completed transfer throughput 能到多少
3. bottleneck 在哪一層
4. 什麼 worker 配比最合理
5. 系統在前端實際操作下是否合理
```

---

# 系統架構總覽

目前系統採用單機多角色分離架構：

```text
Client（React Frontend）
   │
   ├── General API (Port 7001)
   │      - Users API
   │      - Accounts API
   │      - Transfer History API
   │      - Transfer Job Query API
   │      - Queue Stats API
   │      - Benchmark APIs
   │
   └── Transfer API (Port 7010)
          - POST /transfers
                │
                ├── Same-Shard → Sync Fast Path
                └── Cross-Shard → Redis Queue
                                  │
                                  ▼
                           Queue Workers
                                  │
                                  ▼
                           PostgreSQL Shards
```

---

# 核心設計概念

本系統把 transfer request 分成兩條路：

## 1. Same-Shard Transfer

如果 `fromId` 與 `toId` 屬於同一個 shard：

```text
- 不進 Redis queue
- 不建立 async job
- API worker 直接同步執行 DB transaction
- 立即回傳 200
```

這是目前系統的 **fast path**。

---

## 2. Cross-Shard Transfer

如果 `fromId` 與 `toId` 屬於不同 shard：

```text
- 建立 transfer job
- 寫入 Redis job store
- push 進 Redis queue
- 由 queue worker 非同步處理
- API 立即回傳 202 + jobId
- client 可透過 polling 查詢結果
- 前端自動 polling，不顯示 jobId，只顯示最終結果
```

這是目前系統的 **slow path / async path**。

---

# Sharding 設計

## Shard Routing 規則

帳戶的 shard 由以下規則決定：

```text
shardId = accountId % shardCount
```

目前設定：

```text
shardCount = 4
```

也就是：

```text
accountId % 4
```

---

## 資料分布

### Meta DB

Meta DB 負責存放全域資訊：

```text
- users
- account_shards
- global_account_id_seq
```

其中：

```text
account_shards
```

用來記錄：

```text
account_id -> shard_id
```

---

### Shard DB

每個 shard DB 存放：

```text
- accounts
- transfers
```

目前配置為：

```text
small_bank_s0
small_bank_s1
small_bank_s2
small_bank_s3
```

---

## Account 建立流程

建立帳戶時：

```text
1. 先在 meta DB 取得 global account id
2. 依 accountId % shardCount 計算 shardId
3. 在 meta DB 寫入 account_shards
4. 在對應 shard DB 寫入 accounts
```

這樣可以確保：

```text
- account id 全域唯一
- shard routing 可預測
```

---

# Transfer 設計

## Same-Shard Transfer

same-shard transfer 採用同步 DB fast path：

```text
1. debit source account
2. credit destination account
3. COMMIT
```

特性：

```text
- 不走 Redis queue
- 不建立 transfer job
- 不寫 transfers log
- response body 較小
- latency 較低
```

回應：

```text
HTTP 200
{
  "ok": true,
  "data": {
    "mode": "sync-same-shard",
    "status": "completed"
  }
}
```

---

## Cross-Shard Transfer

cross-shard transfer 採用非同步 queue pipeline。

### API 階段

```text
1. 建立 jobId
2. 寫入 Redis job store（status = queued）
3. push 進 per-fromId queue
4. 若 queue 從空變成非空，補一筆 fromId 到 ready queue
5. API 回傳 202 + jobId
```

### Worker 階段

queue worker 會從 ready queue 阻塞式取出 fromId，然後 drain 該 fromId queue。

真正交易流程如下：

```text
Step 1: source shard reserve funds
Step 2: destination shard credit funds
Step 3: source shard finalize reserved funds
```

若中途失敗，會執行補償流程：

```text
release reserved funds
mark transfer failed
```

---

## Cross-Shard Transfer 狀態

目前 transfer log 主要狀態包含：

```text
RESERVED
COMPLETED
FAILED
```

---

# Redis Transfer Queue 設計

目前 queue 採用：

```text
per-fromId queue + ready queue + owner lock
```

---

## Per-fromId Queue

每個來源帳戶一條 queue：

```text
transfer:queue:from:{fromId}
```

目的：

```text
避免同一個 fromId 被多個 worker 同時併發處理
```

---

## Ready Queue

ready queue 只存：

```text
目前有工作可做的 fromId
```

key：

```text
transfer:queue:ready:fromIds
```

worker 不再掃 active set，而是直接：

```text
BRPOP ready queue
```

這樣可以減少：

```text
無效掃描
Redis round-trip
worker idle polling cost
```

---

## Owner Lock

每條 per-fromId queue 都有 owner lock：

```text
transfer:queue:owner:from:{fromId}
```

目的：

```text
確保同一時間只有一個 worker 可以 drain 某個 fromId queue
```

並搭配 heartbeat 定期刷新 TTL。

---

## Admission Control

enqueue 時會先檢查 queue 長度：

```text
rejectThresholdPerFromId = 320
maxQueueLengthPerFromId = 400
```

行為：

```text
- queue 長度 >= rejectThreshold → 429 queue admission rejected
- queue 長度 >= maxQueueLength → 429 queue full
```

這些 429 屬於 **系統保護機制**，用來避免 queue 與 DB 被打爆。

---

# Transfer Job Store 設計

job store 存在 Redis，key 格式為：

```text
transfer:job:{jobId}
```

TTL：

```text
24 hours
```

目前主要狀態：

```text
queued
success
failed
```

內容包含：

```text
jobId
fromId
toId
amount
createdAt
updatedAt
result
error
```

client 可透過：

```text
GET /transfer-jobs/:jobId
```

查詢 job 狀態。

---

# Account Redis Cache

帳戶查詢有做 Redis cache。

cache key：

```text
account:{id}
```

TTL：

```text
30 seconds
```

查詢流程：

```text
1. 先查 Redis
2. cache hit → 直接回傳
3. cache miss → 查 PostgreSQL
4. 寫回 Redis
```

當 transfer 成功後，可透過 invalidate 移除舊 cache，避免讀到 stale data。

---

# API 分工

## General API

General API 負責：

```text
- Users API
- Accounts API
- Transfer History API
- Transfer Job Query API
- Queue Stats API
- Benchmark APIs（非 /transfers）
```

---

## Transfer API

Transfer API 只負責：

```text
POST /transfers
```

這樣做的原因是：

```text
避免 transfer intake 與 read / CRUD API 互相競爭 worker 資源
```

---

## Queue Worker

Queue worker 不提供 HTTP API，專門做：

```text
- block pop ready queue
- drain per-fromId queue
- process cross-shard transfer jobs
- update transfer job store
```

---

# API 文件

## Health Check

### GET /health

用途：

```text
檢查系統是否正常運作
```

---

## Users API

### POST /users

建立使用者。

Request:

```json
{
  "name": "Alice"
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "id": 1,
    "name": "Alice",
    "created_at": "..."
  }
}
```

---

### GET /users/:id

查詢使用者。

Response:

```json
{
  "ok": true,
  "data": {
    "id": 1,
    "name": "Alice",
    "created_at": "...",
    "accounts": [1, 2]
  }
}
```

用途：

```text
- 查詢使用者基本資料
- 查詢該使用者底下所有帳戶 ID
```

---

## Accounts API

### POST /accounts

建立帳戶。

Request:

```json
{
  "userId": 1,
  "initialBalance": 1000
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "id": "1",
    "user_id": "1",
    "balance": "1000",
    "availableBalance": "1000",
    "reservedBalance": "0",
    "totalBalance": "1000",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

---

### GET /accounts/:id

查詢帳戶餘額。

---

## Transfers API

### POST /transfers

建立轉帳。

Request:

```json
{
  "fromId": 1,
  "toId": 5,
  "amount": 1
}
```

### Same-Shard Response

```json
{
  "ok": true,
  "data": {
    "mode": "sync-same-shard",
    "status": "completed"
  }
}
```

HTTP status:

```text
200
```

### Cross-Shard Response

```json
{
  "ok": true,
  "data": {
    "mode": "async-cross-shard",
    "jobId": "1700000000000-abcd1234",
    "status": "queued"
  }
}
```

HTTP status:

```text
202
```

---

### GET /transfers?accountId=...&limit=...

查詢指定帳戶的歷史交易紀錄。

Response:

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 123,
        "fromId": 1,
        "toId": 5,
        "amount": 1,
        "status": "COMPLETED",
        "createdAt": "...",
        "updatedAt": "..."
      }
    ]
  }
}
```

---

## Transfer Jobs API

### GET /transfer-jobs/:jobId

查詢 async transfer job 狀態。

可能狀態：

```text
queued
success
failed
```

---

## Queue API

### GET /queue/stats?fromId=6

查看某個 fromId queue 的狀態。

---

### GET /queue/global-stats

查看整體 queue 狀態。

---

## Bench API

目前專案內建多個 benchmark endpoints：

```text
GET  /bench/noop
POST /bench/redis-rpush
POST /bench/redis-set-rpush
POST /bench/redis-formal-push
POST /bench/redis-formal-push-with-job
POST /bench/transfers-enqueue-no-log
POST /bench/redis-pipeline-push
POST /bench/db-transfer
```

主要用途：

```text
- benchmark intake path
- benchmark Redis enqueue cost
- benchmark same-shard DB throughput
- isolate bottleneck
```

---

# 前端系統

本專案新增簡易網路銀行前端（React），用於驗證整體系統行為。

---

## 前端功能

```text
- 建立使用者（支援中文）
- 查詢使用者（顯示帳戶列表）
- 建立帳戶
- 查詢帳戶餘額
- 發送轉帳（自動處理 same-shard / cross-shard）
- 查詢轉帳歷史
- 顯示操作結果（modal）
```

---

## 前端互動設計

```text
- 使用者查詢會顯示 accounts 列表
- cross-shard 交易由前端自動 polling，隱藏 jobId
- 所有操作結果透過彈出式視窗顯示
- modal 支援上下捲動，避免訊息太長看不完
- modal 提供 OK 按鈕關閉
- 欄位名稱使用中文（使用者編號、帳戶編號、轉出帳戶、轉入帳戶、轉帳金額）
- 輸入欄位預設為空值，避免測試值干擾操作
```

---

## 前端執行方式

前端目錄：

```text
frontend
```

安裝：

```bash
cd frontend
npm install
```

啟動：

```bash
npm run dev
```

預設網址：

```text
http://localhost:5173
```

---

# 執行環境

## Node.js

```text
>= 18.0.0
```

---

## 主要依賴

```text
egg
egg-redis
egg-scripts
pg
axios
react
vite
```

---

# 安裝方式

```bash
npm install
```

---

# 啟動方式

## 開發模式

### General API

```bash
npm run dev:general-api
```

### Transfer API

```bash
npm run dev:transfer-api
```

### Queue Workers

```bash
npm run dev:queue-worker-1
npm run dev:queue-worker-2
npm run dev:queue-worker-3
npm run dev:queue-worker-4
npm run dev:queue-worker-5
npm run dev:queue-worker-6
```

---

## Benchmark / Daemon 模式

### 啟動 General API

```bash
npm run start:general-api
```

### 啟動 Transfer API

```bash
npm run start:transfer-api
```

### 啟動 Queue Workers

```bash
npm run start:queue-worker-1
npm run start:queue-worker-2
npm run start:queue-worker-3
npm run start:queue-worker-4
npm run start:queue-worker-5
npm run start:queue-worker-6
```

### 停止

```bash
npm run stop:general-api
npm run stop:transfer-api
npm run stop:queue-worker-1
npm run stop:queue-worker-2
npm run stop:queue-worker-3
npm run stop:queue-worker-4
npm run stop:queue-worker-5
npm run stop:queue-worker-6
```

---

## 一次啟動完整 benchmark stack

### Queue Workers = 2

```bash
npm run start:benchmark-stack-q2
```

### Queue Workers = 4

```bash
npm run start:benchmark-stack-q4
```

### Queue Workers = 6

```bash
npm run start:benchmark-stack-q6
```

---

# 測試資料建立

建立 100 個測試帳戶：

```bash
npm run create-test-accounts-100
```

建立 1000 個測試帳戶：

```bash
npm run create-test-accounts-1000
```

重置測試資料：

```bash
npm run reset-test-data
```

---

# Benchmark Scripts

目前 final benchmark scripts 包含：

```text
scripts/FinalBenchmark/final_api_intake_benchmark.sh
scripts/FinalBenchmark/final_random_request_benchmark.sh
scripts/FinalBenchmark/final_random_transfer_benchmark.sh
scripts/FinalBenchmark/final_same_shard_db_benchmark.sh
```

對應 npm scripts：

```bash
npm run final-api-intake-benchmark
npm run final-random-request-benchmark
npm run final-random-transfer-benchmark
npm run final-same-shard-db-benchmark
```

---

# Benchmark 重點結果摘要

詳細數據請參考：

```text
BENCHMARK.md
```

目前已確認的系統行為包括：

---

## API Intake Capacity

只做 enqueue、不做 transaction 時：

```text
API intake capacity ≈ 12.8k RPS
```

代表：

```text
API routing
request parsing
Redis enqueue
```

不是目前主 bottleneck。

---

## Same-Shard Pure DB Throughput

只做 same-shard DB transaction 時：

```text
~6.9k TPS
```

代表 PostgreSQL same-shard transaction 本身仍有更高 capacity。

---

## Full Transfer Pipeline

在 hybrid transfer 模式下：

```text
request throughput 可以到 8k ~ 10k+ RPS
completed transfer throughput 約落在 3k ~ 4k TPS
```

---

## Worker Scaling 結論

在 General API / Transfer API / Queue Worker 分離後，  
目前已驗證出兩種不同 operating mode：

### Completion Optimized

```text
6 / 2 / 4
```

代表：

```text
General API workers = 6
Transfer API workers = 2
Queue workers = 4
```

結果：

```text
Completed TPS ≈ 4021
```

這是目前 **最高 completed transfer throughput** 配置。

---

### Intake Optimized

```text
6 / 6 / 4
```

結果：

```text
Request RPS ≈ 8591
```

這是目前 **最高 request intake throughput** 配置。

但同時：

```text
429 / non2xx 也會明顯增加
```

---

## Queue Worker Sweet Spot

目前 benchmark 顯示：

```text
Queue workers ≈ 4
```

是比較合理的 sweet spot。

再往上增加到 6，throughput 並未持續提升，反而可能因為：

```text
PostgreSQL contention
Redis contention
context switching
connection pool pressure
```

導致退化。

---

# 目前系統 bottleneck

目前主要 bottleneck 已集中在：

```text
Cross-shard async transfer pipeline
```

具體包含：

```text
- Redis queue dispatch
- Queue worker scheduling
- Cross-shard transaction coordination
- Transfer state persistence
- finalize / compensation path
```

而不再是：

```text
API routing
Redis enqueue
same-shard DB transaction
```

---

# 專案目前的工程重點

這個專案的重點不是單純做出銀行 CRUD，而是驗證以下系統設計：

```text
1. API throughput 與 completed throughput 是不同層級的問題
2. same-shard 與 cross-shard 應該走不同 execution path
3. queue 設計與 worker 配比會直接影響實際 completed TPS
4. worker role separation 可以顯著改善資源競爭
5. single-machine tuning 也可以做出明顯的 throughput improvement
6. frontend integration 可以驗證系統在實際操作上的完整性
```

---

# 後續優化方向

根據目前 benchmark 結果，未來優化方向包括：

```text
1. 進一步瘦身 cross-shard transaction path
2. 降低 Redis queue / job status round-trip
3. 優化 queue worker scheduling
4. 重新設計 cross-shard execution model
5. 研究更進一步的 multi-machine distributed architecture
6. 持續優化前端操作體驗與系統展示能力
```

---

# 備註

本專案目前屬於：

```text
系統設計 / 效能驗證 / 架構演進型專案
```

README 主要說明目前架構與執行方式；  
若要查看完整 benchmark 過程、數據與分析，請搭配閱讀：

```text
BENCHMARK.md
```
