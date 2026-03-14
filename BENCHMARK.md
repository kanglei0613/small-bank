# Small Bank 壓力測試 (Benchmark)

---

# 測試目的

本文件記錄 **Small Bank 系統在不同架構與測試情境下的壓力測試結果**，用於觀察：

- API 吞吐量
- 交易完成吞吐量 (completed transfer throughput)
- Sharding 架構下的交易分布
- Hotspot 保護機制
- Async Job + Queue Worker 架構的實際效果
- API intake throughput 與 completed throughput 的差異

測試分為八種類型：

1. Hotspot Transfer Test
2. Random Mixed Shard Transfer Test
3. Concurrency Sweep Test
4. Polling Interval Sweep Test
5. PostgreSQL Connection Pool Sweep
6. Queue Worker Scaling Test
7. Account Count Sweep
8. Enqueue-Only API Intake Test

---

# 測試環境

## 應用程式

| 項目 | 設定 |
|-----|-----|
| Runtime | Node.js |
| Framework | Egg.js |
| Process | Cluster Mode |
| Workers | 8 workers |

---

# 系統架構

目前系統架構包含：

- Async Job API
- Redis Transfer Queue
- Background Queue Worker
- PostgreSQL
- Row-level Locking
- Database Sharding (4 shards)

整體流程：

```text
Client
   │
   ▼
POST /transfers
   │
   │  (create transfer job)
   ▼
Redis Queue (per-fromId queue)
   │
   ▼
Queue Worker
   │
   │  DB transaction
   ▼
PostgreSQL Shards
```

Client 查詢結果：

```text
GET /transfer-jobs/:jobId
```

---

# Database Sharding

目前系統使用 **4 個資料庫 shard**

| Shard | Database |
|------|---------|
| shard 0 | small_bank_s0 |
| shard 1 | small_bank_s1 |
| shard 2 | small_bank_s2 |
| shard 3 | small_bank_s3 |

Meta Database：

| DB | 說明 |
|---|---|
| small_bank_meta | account_shards mapping |

Account Sharding Rule：

```text
shard_id = accountId % SHARD_COUNT
```

---

# Async Transfer Architecture

## Transfer API

```text
POST /transfers
```

流程：

1. API 驗證 request
2. 建立 transfer job
3. job 存入 Redis job store
4. job push 進 Redis queue
5. API 立即回傳 jobId

Response example：

```json
{
  "ok": true,
  "data": {
    "jobId": "1773502894541-ni3enz8i",
    "status": "queued"
  }
}
```

---

## Transfer Job Query

```text
GET /transfer-jobs/:jobId
```

Client 透過 polling 取得最終結果。

| Status | 說明 |
|------|------|
| queued | job 已進 queue |
| success | 轉帳成功 |
| failed | 轉帳失敗 |

註：後續優化後已移除 `processing` 中間狀態寫入，以減少 Redis write 成本。

---

# Benchmark Scenario 1
# Hotspot Transfer Test

## 測試目的

模擬 **單一帳戶高併發轉帳情境**

```text
fromId = 6
toId   = 7
```

---

## 測試結果

| Metric | Value |
|------|------|
| Total Requests | ~33k |
| 2xx Responses | 1760 |
| Non-2xx Responses | 31210 |
| Avg Req/Sec | ~3297 |
| Avg Latency | ~60 ms |

此測試顯示：

- 系統會對 **hot account** 啟動 admission control
- 避免 queue backlog 過大
- API intake 與實際可完成交易數量是不同維度

---

# Benchmark Scenario 2
# Random Mixed Shard Transfer Test

模擬真實交易情境：

- 隨機帳戶轉帳
- 混合 same-shard + cross-shard
- 完整 async workflow

## Initial Result

| Metric | Value |
|------|------|
| Avg Success RPS | ~307 |

---

## Optimized Result

在以下優化後重新測試：

- active queue set（不再 SCAN Redis keyspace）
- transfer hot path 不再查兩次 meta DB
- job store 移除 `processing` 狀態寫入
- cross-shard success path 簡化（`RESERVED -> COMPLETED`）
- benchmark client 啟用 HTTP keep-alive
- API / Queue worker 分離

| Metric | Value |
|------|------|
| Elapsed Seconds | 30.38 |
| Total Requests | 21183 |
| Success Requests | 21183 |
| Failed Requests | 0 |
| Success Rate | 100% |
| Avg Total RPS | 697.18 |
| Avg Success RPS | 697.18 |

### Shard Mix

| Metric | Value |
|------|------|
| Same-Shard Picked | 5212 (24.60%) |
| Cross-Shard Picked | 15971 (75.40%) |
| Same-Shard Success | 5212 |
| Cross-Shard Success | 15971 |

### Failure Breakdown

| Type | Count |
|-----|------|
| Insufficient Funds | 0 |
| Other Business Fail | 0 |
| Enqueue Failed | 0 |
| Request Errors | 0 |

---

# Benchmark Scenario 3
# Concurrency Sweep Test

## Mixed Random Concurrency Sweep

| Concurrency | Avg Success RPS |
|-------------|----------------|
| 100 | 315 |
| 200 | 316 |
| 300 | **321** |
| 400 | 319 |
| 500 | 315 |

### Sweet Spot

```text
Best Concurrency ≈ 300
```

---

## Same-Shard Concurrency Sweep

| Concurrency | Avg Success RPS |
|-------------|----------------|
| 100 | 387 |
| 200 | 381 |
| 300 | 388 |
| 400 | **391** |
| 500 | 390 |

### Sweet Spot

```text
Best Concurrency ≈ 400
```

---

# Benchmark Scenario 4
# Polling Interval Sweep

| Poll Interval | Avg Success RPS |
|---------------|----------------|
| 200 ms | 304 |
| 100 ms | **324** |
| 50 ms | 322 |

### Result

```text
Best Poll Interval ≈ 100 ms
```

---

# Benchmark Scenario 5
# PostgreSQL Connection Pool Sweep

| Pool Max | Avg Success RPS |
|---------|----------------|
| 10 | **324** |
| 20 | 319 |
| 30 | 295 |

### Result

```text
Best Pool Size ≈ 10
```

增加 connection pool 並未提升 throughput，  
反而因為 transaction contention 增加導致吞吐量下降。

---

# Benchmark Scenario 6
# Queue Worker Scaling Test

測試 **Queue Worker 數量對吞吐量的影響**

測試條件：

```text
Concurrency = 300
Poll Interval = 100 ms
Pool Max = 10
Mixed Random Traffic
```

---

## Queue Worker Scaling Result

| Queue Workers | Avg Success RPS |
|---------------|----------------|
| 2 | 403 |
| 4 | 539 |
| 6 | **580** |
| 8 | 541 |

### Result

```text
Best Queue Worker Count ≈ 6
Best Avg Success RPS ≈ 580
```

### Observations

- 2 → 4 workers：大幅提升
- 4 → 6 workers：仍有提升
- 6 → 8 workers：開始下降

代表 **6 workers 接近系統最佳 parallelism**。

---

# Benchmark Scenario 7
# Account Count Sweep

測試不同帳戶數量對系統吞吐量的影響。

測試條件：

```text
Concurrency = 300
Poll Interval = 100 ms
Pool Max = 10
Queue Workers = 6
Mixed Random Traffic
```

---

## Account Count Sweep Result

| Account Count | Avg Success RPS |
|---------------|----------------|
| 1000 | **519** |
| 5000 | 499 |
| 10000 | 475 |

### Result

```text
Best Account Count ≈ 1000
```

### Analysis

帳戶數量增加後 throughput 略微下降：

```text
519 → 475 (約 8%)
```

可能原因：

- PostgreSQL buffer cache locality 降低
- working set 增大
- index traversal 增加

但系統仍維持：

```text
>470 transfers/sec
```

表示系統在 dataset 擴大時仍能保持穩定吞吐量。

---

# Benchmark Scenario 8
# Enqueue-Only API Intake Test

此測試只衡量：

```text
POST /transfers
```

也就是：

- 建立 transfer job
- 寫入 Redis queue
- API 回傳 202

**不包含 polling，不等待 job 完成**

因此這個 benchmark 用來觀察：

- API intake throughput
- job enqueue 能力
- intake 與 completed throughput 的差異

---

## Enqueue-Only Result

測試條件：

```text
Concurrency = 300
Account Count = 1000
Duration = 30s
Keep-Alive = true
```

| Metric | Value |
|------|------|
| Elapsed Seconds | 30.04 |
| Total Requests | 114714 |
| Success Requests | 114714 |
| Failed Requests | 0 |
| Success Rate | 100% |
| Avg Total RPS | 3819.09 |
| Avg Success RPS | 3819.09 |

### Shard Mix

| Metric | Value |
|------|------|
| Same-Shard Picked | 28657 (24.98%) |
| Cross-Shard Picked | 86057 (75.02%) |

### Success Breakdown

| Type | Count |
|-----|------|
| Job Created | 114714 |
| Missing Job ID | 0 |

### Failure Breakdown

| Type | Count |
|-----|------|
| HTTP 429 | 0 |
| HTTP 4xx | 0 |
| HTTP 5xx | 0 |
| Other HTTP Status | 0 |
| Request Errors | 0 |

### Interpretation

Enqueue-only benchmark 顯示：

- API intake throughput 約可達 **3.8k req/sec**
- 成功率維持 **100%**
- 無 429 / 無 5xx / 無 request error

這表示目前系統瓶頸：

- **不在 API 收單能力**
- 而在後段 transfer processing workflow

也就是：

```text
API intake throughput  >>  completed transfer throughput
3819 RPS              >>  697 RPS
```

---

# Cross-Shard Overhead

| Scenario | Best RPS |
|--------|---------|
| Same-Shard | ~391 |
| Mixed Random (initial) | ~307 |
| Mixed Random (optimized, workflow) | **~697** |
| Enqueue-Only (API intake) | **~3819** |

---

# Optimization Summary

本輪新增與已完成的關鍵優化：

1. **Active Queue Set**
   - queue worker 不再透過 `SCAN transfer:queue:from:*` 尋找 active queue
   - 改為直接維護 active fromId set

2. **Shard Routing Fast Path**
   - transfer hot path 不再查 meta DB 取得 shard
   - 直接使用 `accountId % shardCount`

3. **Job Store Write Reduction**
   - 移除 `processing` 狀態
   - job lifecycle 簡化為 `queued -> success/failed`

4. **Cross-Shard Success Path Simplification**
   - 成功路徑由：
     ```text
     RESERVED -> CREDITED -> COMPLETED
     ```
     簡化為：
     ```text
     RESERVED -> COMPLETED
     ```

5. **Benchmark Client Keep-Alive**
   - benchmark client 使用 keep-alive agent
   - 減少大量 HTTP request 的 client-side overhead

---

# System Stability

所有 benchmark 結果顯示：

```text
Success Rate = 100%
Enqueue Failed = 0
Request Errors = 0
```

系統在目前測試條件下保持穩定。

---

# Current System Baseline

目前最佳 workflow 配置：

```text
Concurrency ≈ 300
Poll Interval ≈ 100 ms
Shard Pool Max ≈ 10
Queue Workers ≈ 6
```

---

## Baseline Throughput

| Scenario | Throughput |
|--------|-----------|
| Same-Shard Workflow | ~391 transfers/sec |
| Mixed Random Workflow (before latest simplification) | ~580 transfers/sec |
| Mixed Random Workflow (current) | **~697 transfers/sec** |
| Enqueue-Only API Intake | **~3819 req/sec** |

---

# Key Findings

## 1. API intake 並不是目前瓶頸

系統目前可以穩定達到：

```text
~3819 enqueue req/sec
```

但完整交易完成吞吐量約為：

```text
~697 completed transfers/sec
```

表示目前瓶頸主要在：

- queue draining
- Redis 協調
- cross-shard transaction path
- PostgreSQL transaction throughput

---

## 2. Cross-Shard Workflow 仍然是主成本來源

在 mixed-random 測試中：

```text
cross-shard ≈ 75%
same-shard  ≈ 25%
```

因此目前 workflow throughput 大多反映的是：

```text
cross-shard heavy workload
```

而不是純 same-shard 理想吞吐。

---

## 3. 簡化流程對 throughput 有實際幫助

Mixed Random Workflow 從最初：

```text
~307 RPS
```

提升到目前：

```text
~697 RPS
```

代表：

- queue architecture 優化有效
- hot path trimming 有效
- cross-shard success path 簡化有效

---

# Future Optimization Directions

### 1. Two-Machine Deployment Test

建議下一步測試：

- Machine 1：API server
- Machine 2：Queue workers

用於觀察 API 與 worker 分機後，completed throughput 是否進一步提升。

---

### 2. Redis Queue Parallelism

持續優化：

- queue draining
- owner scheduling
- worker coordination

---

### 3. PostgreSQL Transaction Throughput

進一步觀察：

- cross-shard contention
- transaction cost
- lock competition

---

### 4. Queue Admission Control Tuning

調整：

```text
queue length limit
reject threshold
```

平衡：

```text
throughput vs protection
```

---

# Summary

Small Bank 系統目前已完成：

- Async Job API
- Redis transfer queue
- Queue worker processing
- PostgreSQL sharding
- Cross-shard transaction support
- Active queue set optimization
- Transfer hot path routing optimization
- Job state write reduction
- Cross-shard success path simplification

目前 benchmark 結果：

| Scenario | Throughput |
|--------|-----------|
| Same-Shard Workflow | ~391 transfers/sec |
| Mixed Random Workflow | **~697 transfers/sec** |
| Enqueue-Only API Intake | **~3819 req/sec** |

系統保持：

- **100% success rate**
- **穩定吞吐**
- **無 queue rejection**
- **無 request error**

此結果可作為後續兩機實驗與更高吞吐優化的 **baseline benchmark**。
