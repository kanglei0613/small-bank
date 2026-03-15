---

# Benchmark Scenario 9
# Two-Machine Deployment Test

此測試驗證 **API 與 Queue Worker 分機部署**的實際效果。

測試拓樸：

```text
Machine 1 (MacBook)
  - API Server
  - Redis
  - PostgreSQL

Machine 2 (Desktop)
  - Queue Worker
```

系統 workflow：

```text
Client
   │
   ▼
API (Machine 1)
   │
   ▼
Redis Queue (Machine 1)
   │
   ▼
Queue Worker (Machine 2)
   │
   ▼
PostgreSQL Shards (Machine 1)
```

---

## Test Conditions

```text
Concurrency = 300
Duration = 30s
Account Count = 1000
Shard Count = 4
Polling Interval = 100ms
Queue Workers = 4 (Machine 2)
```

---

## Benchmark Result

| Metric | Value |
|------|------|
| Elapsed Seconds | 30.95 |
| Total Requests | 6512 |
| Success Requests | 6512 |
| Failed Requests | 0 |
| Success Rate | 100% |
| Avg Total RPS | 210.38 |
| Avg Success RPS | 210.38 |

---

### Shard Mix

| Metric | Value |
|------|------|
| Same-Shard Picked | 1613 (24.77%) |
| Cross-Shard Picked | 4899 (75.23%) |
| Same-Shard Success | 1613 |
| Cross-Shard Success | 4899 |

---

### Failure Breakdown

| Type | Count |
|-----|------|
| Insufficient Funds | 0 |
| Other Business Fail | 0 |
| Enqueue Failed | 0 |
| Request Errors | 0 |

---

# Comparison With Single-Machine Baseline

| Architecture | Avg Success RPS |
|--------------|----------------|
| Single Machine (optimized) | **~697** |
| Two-Machine (worker separated) | **~210** |

---

# Observations

Two-machine deployment successfully validated functional correctness:

- API successfully enqueues jobs
- Desktop worker successfully processes jobs
- Cross-shard transactions complete correctly
- System maintains **100% success rate**

However, throughput dropped significantly.

---

# Root Cause Analysis

Current two-machine topology:

```text
Machine 1
  API + Redis + PostgreSQL

Machine 2
  Queue Worker
```

Every job processed by the worker requires multiple **cross-machine network round-trips**:

```text
Worker -> Redis (queue pop)
Worker -> Redis (job store update)
Worker -> PostgreSQL (transaction)
Worker -> Redis (final job result)
```

These remote operations introduce additional latency compared with the single-machine architecture.

---

# Key Finding

Separating **only the queue worker process** from the API host **does not improve throughput** when:

```text
Redis + PostgreSQL remain on the API machine
```

In this configuration, network latency outweighs the benefits of CPU parallelism.

---

# Architectural Implication

For multi-machine scaling to be effective, the heavy data path should be colocated with workers.

A more scalable architecture would be:

```text
Machine 1
  API

Machine 2
  Redis
  PostgreSQL
  Queue Workers
```

This would eliminate cross-machine data path latency for most operations.

---

# Conclusion

Two-machine deployment validation results:

| Metric | Result |
|------|------|
| Functional correctness | Verified |
| System stability | 100% success rate |
| Throughput improvement | Not observed |
| Primary limitation | Cross-machine data path latency |

This experiment demonstrates that **worker-only separation is not an effective scaling strategy** for the current architecture.

The single-machine optimized configuration therefore remains the **current performance baseline**.

---

# Benchmark Scenario 10
# Async Job Pipeline Bottleneck Investigation

此測試的目的是 **定位系統吞吐量 (throughput) 的主要瓶頸**。

先前的單機測試顯示：

| Architecture | Avg Success RPS |
|--------------|----------------|
| Single Machine (optimized) | ~696 |

為了更精確定位 bottleneck，本次測試將系統拆成三個不同階段：

1. **Enqueue-only benchmark**
2. **Fake transfer benchmark（移除 DB transaction）**
3. **Full transfer benchmark（完整交易流程）**

透過逐步移除系統成本，觀察 throughput 的變化。

---

# Test Environment

```text
Machine
  MacBook (Single Machine)

System Components
  API Server
  Redis
  PostgreSQL
  Queue Workers

Queue Workers = 4
Shard Count = 4
Account Count = 10000
Concurrency = 300
Duration = 30 seconds
Polling Interval = 200 ms
```

---

# Benchmark Scenario 10A
# Enqueue-Only Benchmark

此測試只測量 API 接收請求並建立 job 的能力：

```text
Client
  ↓
API
  ↓
Create Job
  ↓
Push Job → Redis Queue
```

Queue Worker 不參與 job 執行。

---

## Benchmark Result

| Metric | Value |
|------|------|
| Elapsed Seconds | 30.39 |
| Total Requests | 136088 |
| Success Requests | 136088 |
| Failed Requests | 0 |
| Success Rate | 100% |
| Avg Total RPS | 4477.90 |
| Avg Success RPS | 4477.90 |

---

## Shard Mix

| Metric | Value |
|------|------|
| Same-Shard Picked | 34010 (24.99%) |
| Cross-Shard Picked | 102078 (75.01%) |

---

# Observation

API enqueue throughput 可達 **~4478 RPS**。

這代表以下元件 **並不是主要瓶頸**：

```text
API server
Job creation
Redis enqueue
```

系統能夠在短時間內接受數千筆 transfer request。

---

# Benchmark Scenario 10B
# Fake Transfer Benchmark

為了排除 PostgreSQL transaction 的影響，本測試將：

```text
AccountsRepo.transfer()
```

暫時替換為 **fake implementation**：

```text
不執行任何資料庫 transaction
直接回傳成功結果
```

系統仍保留以下流程：

```text
API
Redis queue
Queue worker
Job store
Polling
```

---

## Benchmark Result

| Metric | Value |
|------|------|
| Elapsed Seconds | 30.43 |
| Total Requests | 24921 |
| Success Requests | 24921 |
| Failed Requests | 0 |
| Success Rate | 100% |
| Avg Total RPS | 818.96 |
| Avg Success RPS | 818.96 |

---

## Shard Mix

| Metric | Value |
|------|------|
| Same-Shard Picked | 6330 (25.40%) |
| Cross-Shard Picked | 18591 (74.60%) |
| Same-Shard Success | 6330 |
| Cross-Shard Success | 18591 |

---

# Benchmark Scenario 10C
# Full Transfer Benchmark (Real DB Transaction)

完整交易流程 benchmark：

| Metric | Value |
|------|------|
| Avg Success RPS | ~696 |

---

# Throughput Comparison

| Scenario | Avg Success RPS |
|------|------|
| Enqueue-only | **4478** |
| Fake transfer (no DB) | **819** |
| Full transfer (real DB) | **696** |

---

# Key Findings

測試結果顯示系統吞吐量可以分為三個層級：

```text
API intake capacity        ≈ 4478 RPS
Async job pipeline         ≈ 819 RPS
Full transaction pipeline  ≈ 696 RPS
```

代表大部分 throughput 限制 **並不是來自 API intake 或資料庫 transaction**。

---

# Bottleneck Analysis

目前系統主要成本來自 **Async Job Pipeline**：

```text
Queue dispatch
Queue worker scheduling
Redis job store 更新
Job result polling
```

每一筆 transfer 需要多次 Redis 操作：

```text
createJob
queue push
queue pop
markSuccess
client polling job status
```

即使完全移除資料庫 transaction，  
系統吞吐量仍被限制在約 **800 completed transfers/sec**。

---

# PostgreSQL Impact

PostgreSQL transaction 仍然帶來額外成本：

```text
Fake transfer → ~819 RPS
Real transfer → ~696 RPS
```

代表資料庫 transaction **確實有成本，但並不是目前最大的 bottleneck**。

---

# Current Architecture

```text
Client
  ↓
API
  ↓
Redis Queue
  ↓
Queue Worker
  ↓
PostgreSQL
  ↓
Job Store Update
  ↓
Client Polling
```

整個 async pipeline 包含多次 network / storage round-trip。

即使移除資料庫 transaction，這些流程仍然限制系統 throughput。

---

# Future Optimization Directions

根據本次 bottleneck investigation，未來優化方向包括：

---

## 1. 降低 Async Pipeline 成本

可能的優化方向：

```text
減少 Redis job store round-trip
優化 queue dispatch
減少不必要的 Redis 操作
```

---

## 2. Hybrid Transfer Execution Model

目前系統 **所有 transfer 都走 async job pipeline**。

未來可能採用：

```text
Same-shard transfer → 同步執行
Cross-shard transfer → Async job pipeline
```

優點：

```text
減少 async pipeline overhead
保留 cross-shard transaction 的安全性
```

由於目前測試中：

```text
Same-shard ≈ 25%
Cross-shard ≈ 75%
```

此架構可能顯著提高 completed throughput。

---

## 3. Async Pipeline Optimization

未來可能研究：

```text
Batch queue draining
減少 polling overhead
優化 job status storage
```

---

# Conclusion

本次測試顯示系統 throughput 主要受到 **Async Job Pipeline** 限制，而非 API intake 或 PostgreSQL transaction。

| Layer | Throughput |
|------|------|
| API Intake | ~4478 RPS |
| Async Job Pipeline | ~819 RPS |
| Full Transaction | ~696 RPS |

這提供了清楚的系統優化方向。

未來優化將優先集中於：

```text
降低 async pipeline 成本
探索 hybrid transfer execution model
```

---