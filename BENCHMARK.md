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

# Benchmark Scenario 11
# Mixed Workload Random Request Benchmark

此測試的目的是模擬 **更接近實際系統流量的混合 API workload**。

先前的 benchmark 主要集中於：

```text
POST /transfers
```

但在真實系統中，API 流量通常包含：

```text
Account 查詢
Transfer 建立
Transfer job polling
Transaction history 查詢
User / Account 建立
```

因此本測試設計 **Mixed Workload Random Benchmark**  
隨機對多個 API endpoint 發送請求。

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
```

---

# Workload Distribution

本測試使用隨機請求分布：

| Endpoint | Weight |
|------|------|
| GET /accounts/:id | 35% |
| POST /transfers | 25% |
| GET /transfer-jobs/:jobId | 15% |
| GET /transfers (history) | 15% |
| POST /users | 5% |
| POST /accounts | 5% |

這樣的 workload 模擬：

```text
高比例 read requests
適度 transfer write traffic
部分 job polling
少量資料建立
```

更接近實際 production API usage pattern。

---

# Benchmark Result

| Metric | Value |
|------|------|
| Elapsed Seconds | 30.18 |
| Total Requests | 128578 |
| Success Requests | 128523 |
| Failed Requests | 0 |
| Success Rate | 99.96% |
| Avg Total RPS | 4259.81 |
| Avg Success RPS | 4257.98 |

---

# Endpoint Breakdown

| Endpoint | Total | Success | Failed |
|------|------|------|------|
| GET /accounts/:id | 45230 | 45230 | 0 |
| GET /transfer-jobs/:jobId | 19114 | 19114 | 0 |
| GET /transfers (history) | 19477 | 19477 | 0 |
| POST /accounts | 6367 | 6367 | 0 |
| POST /transfers | 32008 | 32008 | 0 |
| POST /users | 6327 | 6327 | 0 |

---

# Transfer Job Statistics

| Metric | Value |
|------|------|
| Transfer Jobs Created | 32008 |
| Job Poll Success | 16037 |
| Job Poll Failed | 0 |
| Job Poll Queued | 3077 |

---

# Additional Statistics

| Metric | Value |
|------|------|
| Created Users | 6327 |
| Created Accounts | 6367 |
| Request Errors | 0 |

---

# Observations

在混合 workload 情況下，系統仍然維持：

```text
~4250 RPS API throughput
```

且幾乎沒有 request failure。

這顯示系統具備：

```text
穩定的 API routing
可靠的 Redis queue
穩定的 PostgreSQL sharding transaction
```

同時支援：

```text
read-heavy workload
transfer write workload
async job polling
data creation
```

---

# Transfer Throughput Estimation

從 benchmark 統計可觀察：

```text
POST /transfers ≈ 32008 requests / 30s
```

平均：

```text
≈ 1066 transfer jobs / second
```

這個數字基本上代表 **transfer pipeline 的實際處理能力**。

---

# Throughput Comparison

| Scenario | Avg Success RPS |
|------|------|
| Enqueue-only benchmark | ~4478 |
| Mixed workload benchmark | ~4258 |
| Fake transfer (no DB) | ~819 |
| Full transfer (real DB) | ~696 |

---

# System Throughput Layers

目前系統吞吐量可以分為三個層級：

```text
API intake capacity        ≈ 4478 RPS
Mixed workload API system  ≈ 4258 RPS
Async transfer pipeline    ≈ 819 transfers/sec
Full DB transaction        ≈ 696 transfers/sec
```

代表：

```text
API layer capacity 已經非常高
Async pipeline 是主要 throughput 限制
```

---

# Current System Architecture

```text
Client
  ↓
API Server
  ↓
Redis Queue
  ↓
Queue Workers
  ↓
PostgreSQL Shards
  ↓
Job Store Update
  ↓
Client Polling
```

每一筆 transfer transaction 包含：

```text
enqueue job
queue dispatch
queue drain
DB transaction
job store update
client polling
```

這些 round-trip 共同構成 async pipeline 成本。

---

# Key Findings

Mixed workload benchmark 顯示：

```text
系統整體 API throughput ≈ 4200+ RPS
transfer pipeline throughput ≈ 1000 transfers/sec
```

系統在混合 API 流量下仍然保持：

```text
高成功率
穩定 latency
無明顯 request error
```

---

# Future Optimization Directions

未來可能的優化方向包括：

---

## 1. Hybrid Transfer Execution

目前所有 transfer 都透過 async pipeline。

未來可以考慮：

```text
Same-shard transfer → synchronous execution
Cross-shard transfer → async pipeline
```

優點：

```text
減少 async overhead
提高 completed throughput
```

---

## 2. Async Pipeline Optimization

可能研究方向：

```text
減少 Redis round-trip
優化 queue drain scheduling
降低 polling overhead
```

---

## 3. Transfer Worker Scaling

提高 transfer throughput 的方法包括：

```text
增加 queue workers
優化 DB transaction latency
減少 worker idle time
```

---

# Conclusion

Mixed workload benchmark 證明系統具備穩定的 API throughput 與 async transaction pipeline。

| Layer | Throughput |
|------|------|
| API Intake | ~4478 RPS |
| Mixed Workload | ~4258 RPS |
| Async Pipeline | ~819 transfers/sec |
| Full Transaction | ~696 transfers/sec |

系統目前的主要 bottleneck 位於：

```text
Async Job Pipeline
```

未來優化將集中於：

```text
Hybrid transfer execution
Async pipeline optimization
Worker throughput improvement
```

---

# Benchmark Scenario 12
# Same-Shard Fast Path + Shard / Worker / Concurrency Tuning

本階段測試的目的，是驗證以下優化與參數調整對系統 throughput 的影響：

1. Same-shard transfer 改為 synchronous fast path  
2. Same-shard transaction 進一步輕量化  
3. 比較 Shard Count = 4 與 8  
4. 比較 Queue Worker = 2 與 4  
5. 掃描 benchmark concurrency（connections）

本階段核心架構調整：

- Same-shard transfer → API worker 直接同步執行  
- Cross-shard transfer → 維持 async Redis queue + queue worker

系統 workflow：

Client  
↓  
API Server  

- Same-Shard → 直接 DB transaction  
- Cross-Shard → Redis Queue  

↓  

Queue Worker  

↓  

PostgreSQL Shards

---

# Optimization Changes

本階段完成的主要優化如下：

## 1. Same-Shard Fast Path

先前架構：

POST /transfers  
↓  
Create Job  
↓  
Redis Queue  
↓  
Queue Worker  
↓  
DB Transaction  

優化後：

Same-shard transfer  
↓  
API worker 直接執行 DB transaction  

而：

Cross-shard transfer  
↓  
仍維持 async queue pipeline

---

## 2. Same-Shard Path Lightweight Optimization

same-shard transaction 做了以下輕量化：

- 不再寫入 transfers log  
- 不走 inflight Redis counter  
- 移除不必要 logging  
- 回傳更小的 response body  
- transaction 改為更直接的 debit / credit update  

目標是讓 same-shard transaction 成為：

最短 DB path

---

# Benchmark Scenario 12A
# 4-Shard Mixed Transfer Benchmark (Optimized Baseline)

此測試用來確認在最佳化後，4 shard 是否仍為目前最佳配置。

## Test Environment

Machine  
MacBook (Single Machine)

System Components  

API Server  
Redis  
PostgreSQL  
Queue Workers  

API Cluster Workers = 8  
Queue Workers = 2  
Shard Count = 4  
Account Count = 1000  

Connections = 100  
Duration = 30s  
Endpoint = /transfers  

---

## Benchmark Result

| Metric | Value |
|------|------|
| Avg Request RPS | ~10598 |
| Avg Latency | ~8.9 ms |
| 2xx Responses | 317919 |
| Non-2xx | 4 |

---

## Transfer Counters

| Metric | Value |
|------|------|
| Same-Shard Routed | 79193 |
| Cross-Shard Routed | 238830 |
| Success | 99005 |
| Failed | 238 |

---

## Derived Throughput

| Metric | Value |
|------|------|
| Completed TPS | ~3300 transfers/sec |
| Same-Shard Ratio | ~25% |
| Cross-Shard Ratio | ~75% |

---

# Observation

4 shard 下：

Same-shard ≈ 25%  
Cross-shard ≈ 75%

這與理論值一致，代表 shard routing 正常。

此配置下系統可達：

Request throughput ≈ 10.6k RPS  
Completed transfer throughput ≈ 3.3k TPS

這是目前整體 mixed transfer workload 的最佳實測配置。

---

# Benchmark Scenario 12B
# 8-Shard Same-Shard Pure DB Benchmark

此測試用來觀察 shard 數量增加後，same-shard pure DB throughput 是否提升。

## Test Environment

API Cluster Workers = 8  
Queue Workers = 2  
Shard Count = 8  
Account Count = 1000  

Connections = 10  
Duration = 30s  

Endpoint = /bench/db-transfer  
Workload = Same-shard only  

---

## Benchmark Result

| Metric | Value |
|------|------|
| Avg Request RPS | ~6953 |
| Avg Latency | ~1.01 ms |
| Non-2xx | 3 |

---

# Observation

與先前 4 shard same-shard pure DB 相比：

| Configuration | Same-Shard Pure DB TPS |
|------|------|
| 4 shards | ~5568 |
| 8 shards | ~6953 |

代表：

增加 shard 數確實能降低 same-shard contention。

---

# Benchmark Scenario 12C
# 8-Shard Mixed Transfer Benchmark

雖然 8 shard 提升了 same-shard pure DB throughput，但 mixed transfer workload 是否也會改善，需要實際驗證。

## Test Environment

API Cluster Workers = 8  
Queue Workers = 2  
Shard Count = 8  
Account Count = 1000  

Connections = 100  
Duration = 30s  

Endpoint = /transfers  

---

## Benchmark Result

| Metric | Value |
|------|------|
| Avg Request RPS | ~12892 |
| Avg Latency | ~7.22 ms |
| 2xx Responses | 367533 |
| Non-2xx | 19244 |

---

## Transfer Counters

| Metric | Value |
|------|------|
| Same-Shard Routed | 47717 |
| Cross-Shard Routed | 339160 |
| Success | 65918 |
| Failed | 31 |

---

## Derived Throughput

| Metric | Value |
|------|------|
| Completed TPS | ~2197 transfers/sec |
| Same-Shard Ratio | ~12.5% |
| Cross-Shard Ratio | ~87.5% |

---

# Observation

8 shard 下：

Same-shard ≈ 12.5%  
Cross-shard ≈ 87.5%

由於目前架構：

Same-shard = synchronous fast path  
Cross-shard = async pipeline  

增加 shard 數雖然提升了 same-shard pure DB throughput，但 mixed workload 中 cross-shard 比例大幅提高。

因此：

8 shard mixed workload throughput  
反而低於  
4 shard mixed workload throughput。

---

# Benchmark Scenario 12D
# Queue Worker Scaling Test

此測試用來驗證：增加 queue worker 數量，是否能改善 mixed workload throughput。

## Test Environment

API Cluster Workers = 8  
Shard Count = 4  
Connections = 100  
Duration = 30s  

---

## Queue Workers = 2

| Metric | Value |
|------|------|
| Avg Request RPS | ~10598 |
| Completed TPS | ~3300 |

---

## Queue Workers = 4

| Metric | Value |
|------|------|
| Avg Request RPS | ~9012 |
| Completed TPS | ~3115 |

---

# Observation

增加 queue worker 並未提升 throughput。

原因是：

- Redis queue dispatch 成為 bottleneck  
- Worker CPU utilization 並未飽和  
- 多 worker 反而增加 Redis contention

因此在此硬體環境下：

最佳配置仍為：

Queue Workers = 2

---

# Benchmark Scenario 12E
# Benchmark Concurrency Tuning

測試不同 benchmark connections 對 throughput 的影響。

## Connections = 50

| Metric | Value |
|------|------|
| Request RPS | ~8281 |
| Completed TPS | ~3240 |
| Avg Latency | ~5.49 ms |

---

## Connections = 100

| Metric | Value |
|------|------|
| Request RPS | ~10598 |
| Completed TPS | ~3300 |
| Avg Latency | ~8.9 ms |

---

## Connections = 150

| Metric | Value |
|------|------|
| Request RPS | ~9236 |
| Completed TPS | ~3188 |
| Avg Latency | ~15.65 ms |

---

# Concurrency Observation

結果顯示：

connections = 100 為最佳 benchmark concurrency。

原因：

connections = 50 → 壓力不足  
connections = 100 → throughput 最大  
connections = 150 → latency 上升且 throughput 下降  

---

# Final Optimized Configuration

目前單機最佳配置：

API Cluster Workers = 8  
Queue Workers = 2  
Shard Count = 4  
Benchmark Connections = 100  

---

# Final Performance Summary

| Metric | Value |
|------|------|
| API Request Throughput | ~10.6k RPS |
| Completed Transfer Throughput | ~3.3k TPS |
| Avg Latency | ~8.9 ms |
| Same-Shard Ratio | ~25% |
| Cross-Shard Ratio | ~75% |

---

# Key Findings

本階段優化帶來的主要成果：

1. Same-shard fast path 顯著降低 transfer latency  
2. 系統 completed throughput 提升至 ~3.3k TPS  
3. 4 shard 在 mixed workload 下優於 8 shard  
4. 增加 queue worker 並未提升 throughput  
5. Benchmark sweet spot 為 connections = 100  

---

# Conclusion

透過 Same-Shard Fast Path 與 transaction path 輕量化，系統在單機環境下達到：

API throughput ≈ 10k RPS  
Completed transfer throughput ≈ 3.3k TPS  

目前系統主要限制仍來自：

Async cross-shard transfer pipeline

未來優化方向可能包括：

- Cross-shard transaction pipeline optimization  
- Redis queue round-trip reduction  
- Worker dispatch scheduling improvement  
- Multi-machine distributed architecture

---

# Benchmark Scenario 13
# Single-Machine Final Optimization Snapshot

本階段整理 **今天這一輪單機優化後** 的最新結果。  
測試環境全程為：

```text
Single Machine
- API Server
- Redis
- PostgreSQL
- Queue Workers
```

本輪重點優化包括：

```text
1. Same-shard transfer 改為 synchronous fast path
2. Same-shard transaction path 輕量化
3. Redis transfer queue 改為 ready queue 模式
4. 移除 active set 掃描
5. Cross-shard transaction path 瘦身
```

---

## Test Environment

```text
Machine
  MacBook (Single Machine)

System Components
  API Server
  Redis
  PostgreSQL
  Queue Workers

API Cluster Workers = 8
Queue Workers = 2
Shard Count = 4
Account Count = 1000
Benchmark Connections = 100
```

---

# Benchmark Scenario 13A
# API Intake / Enqueue Capacity Benchmark

此測試用來測量 API 在 **只執行 enqueue，不執行實際 transaction** 時的 intake 能力。

Endpoint:

```text
/bench/transfers-enqueue-no-log
```

Workflow:

```text
Client
 ↓
API
 ↓
Create Job
 ↓
Redis Queue Push
```

Queue worker 不參與 transaction。

---

## Benchmark Result

| Metric | Value |
|------|------|
| Duration | 60s |
| Total Requests | ~769k |
| Avg Request RPS | **~12813.9 RPS** |
| Successful Enqueue (202) | 365478 |
| Rejected (429) | 403260 |

---

## Latency

| Metric | Value |
|------|------|
| Avg Latency | ~7.3 ms |
| p50 | ~6 ms |
| p97.5 | ~17 ms |
| p99 | ~45 ms |
| Max | ~209 ms |

---

## Observation

API intake layer 可以承受：

```text
~12.8k requests/sec
```

代表：

```text
API routing
request parsing
Redis enqueue
```

都不是目前的主要瓶頸。

---

# Benchmark Scenario 13B
# Same-Shard Pure DB Benchmark

此測試測量 **只執行 same-shard DB transaction** 時的純資料庫 throughput。

Endpoint:

```text
/bench/db-transfer
```

Workload:

```text
Same-shard transfer only
No queue
No async pipeline
```

---

## Benchmark Result

| Metric | Value |
|------|------|
| Connections | 10 |
| Duration | 60s |
| Avg Request RPS | **~6937.14 TPS** |
| Avg Latency | ~0.81 ms |
| Non-2xx | 87 |

---

## Observation

Same-shard 純 DB transaction throughput 約為：

```text
~6.9k transfers/sec
```

這代表 PostgreSQL transaction layer 本身仍高於目前整體 completed throughput。

---

# Benchmark Scenario 13C
# Random Transfer Request Benchmark (Current Best Single-Machine Result)

此測試模擬隨機 transfer request workload。  
測試同時包含：

```text
same-shard transfer
cross-shard transfer
```

Endpoint:

```text
POST /transfers
```

---

## Benchmark Result

| Metric | Value |
|------|------|
| Duration | 60s |
| Total Requests | ~616k |
| 2xx Responses | 493323 |
| Non-2xx | 122398 |
| Avg Request RPS | **~10262.57 RPS** |
| Avg Latency | **~9.2 ms** |

---

## Percentile Latency

| Metric | Value |
|------|------|
| p50 | 1 ms |
| p90 | 22 ms |
| p97.5 | 88 ms |
| p99 | 137 ms |
| p99.9 | 345 ms |

---

## Transfer Counters

| Metric | Value |
|------|------|
| Same-Shard Routed | 153287 |
| Cross-Shard Routed | 462534 |
| Success | 183427 |
| Failed | 1549 |

---

## Derived Throughput

```text
Completed transfer throughput
= 183427 / 60
≈ 3057 TPS
```

---

## Observation

目前單機最佳結果顯示：

```text
Transfer request throughput ≈ 10.26k RPS
Completed transfer throughput ≈ 3.06k TPS
Avg latency ≈ 9.2 ms
```

---

# Optimization Summary

本輪單機優化後，系統 throughput 結構如下：

| Layer | Throughput |
|------|------|
| API Intake Capacity | **~12.8k RPS** |
| Transfer Request Throughput | **~10.26k RPS** |
| Same-Shard Pure DB Throughput | **~6.94k TPS** |
| Full Transfer Pipeline Throughput | **~3.06k TPS** |

---

# Key Findings

目前單機架構已經達成：

```text
API transfer request throughput > 10k RPS
```

但 **completed transfer throughput** 仍然顯著低於 request throughput：

```text
~3.06k TPS
```

這表示目前主要瓶頸已不在：

```text
API layer
Redis enqueue
same-shard DB transaction
```

而是在：

```text
Cross-shard async transfer pipeline
```

---

# Bottleneck Location

目前主要成本仍集中在：

```text
Redis queue dispatch
Queue worker scheduling
Cross-shard transaction coordination
Transfer state persistence
Cross-shard finalize / compensation path
```

---

# Final Single-Machine Performance Summary

| Metric | Value |
|------|------|
| API Intake Capacity | **~12.8k RPS** |
| Transfer Request Throughput | **~10.26k RPS** |
| Completed Transfer Throughput | **~3.06k TPS** |
| Same-Shard Pure DB Throughput | **~6.94k TPS** |
| Avg Transfer Request Latency | **~9.2 ms** |

---

# Final Conclusion

在本輪 **單機優化版本** 中，系統已經可以穩定承受：

```text
~10k+ transfer requests/sec
```

目前最佳實測 completed throughput 為：

```text
~3.06k completed transfers/sec
```

這代表：

```text
10k request RPS 目標已達成
但 10k completed TPS 尚未達成
```

目前最主要限制仍為：

```text
Cross-shard async transfer pipeline
```

---

# Next Optimization Directions

接下來若要繼續提升 completed TPS，優先方向包括：

```text
1. 進一步瘦身 cross-shard transaction path
2. 降低 Redis queue / job status round-trip
3. 做 transfer path 與其他 API 的資源隔離
4. 重新設計 cross-shard execution model
```

------

# Benchmark Scenario 14
# API / Transfer Worker Separation Benchmark

本階段測試的目的，是驗證將 **General API 與 Transfer API 分離**，並為兩者配置不同 worker 數量後，是否能提升：

```text
Mixed workload throughput
Transfer-only throughput
Completed transfer throughput
```

先前的單機最佳化版本雖然已達到：

```text
Transfer request throughput ≈ 10k RPS
Completed transfer throughput ≈ 3.06k TPS
```

但當 General API 與 Transfer API 共用同一組 API cluster workers 時，  
不同類型的 request 仍會互相競爭 CPU / event loop / DB / Redis 資源。

因此本階段進一步採用：

```text
General API cluster
Transfer API cluster
Queue worker cluster
```

的分離架構。

---

# Architecture Change

本階段新的單機部署方式如下：

```text
Port 7001
  - General API
  - 6 workers

Port 7010
  - Transfer API
  - 2 workers

Port 7002
  - Queue Worker 1
  - 1 worker

Port 7003
  - Queue Worker 2
  - 1 worker
```

系統 workflow：

```text
Client
   │
   ├── General API (7001, 6 workers)
   │      - GET /accounts/:id
   │      - GET /transfers
   │      - GET /transfer-jobs/:jobId
   │      - POST /users
   │      - POST /accounts
   │
   └── Transfer API (7010, 2 workers)
          - POST /transfers
                │
                ├── Same-Shard → sync fast path
                └── Cross-Shard → Redis Queue
                                  │
                                  ▼
                          Queue Workers (7002 / 7003)
                                  │
                                  ▼
                           PostgreSQL Shards
```

---

# Test Environment

```text
Machine
  MacBook (Single Machine)

System Components
  General API
  Transfer API
  Redis
  PostgreSQL
  Queue Workers

General API Workers = 6
Transfer API Workers = 2
Queue Workers = 2
Shard Count = 4
Account Count = 1000
Benchmark Connections = 100
Duration = 60 seconds
```

---

# Benchmark Scenario 14A
# Mixed Workload Benchmark (Separated API Roles)

此測試模擬更接近實際系統流量的混合 API workload，  
但與先前不同的是：

```text
General API 與 Transfer API 已經分離
```

其中：

```text
General API → 7001
Transfer API → 7010
```

---

## Workload Distribution

本測試使用隨機請求分布：

| Endpoint | Weight |
|------|------|
| GET /accounts/:id | 35% |
| POST /transfers | 25% |
| GET /transfer-jobs/:jobId | 15% |
| GET /transfers (history) | 15% |
| POST /users | 5% |
| POST /accounts | 5% |

---

## Benchmark Result

| Metric | Value |
|------|------|
| Elapsed Seconds | 60.08 |
| Total Requests | 214458 |
| Success Requests | 214371 |
| Failed Requests | 87 |
| Success Rate | 99.96% |
| Avg Total RPS | 3569.53 |
| Avg Success RPS | 3568.08 |

---

## Status Codes

| Code | Count |
|------|------|
| 200 | 153016 |
| 201 | 21581 |
| 202 | 39774 |
| 500 | 87 |

---

## Endpoint Breakdown

| Endpoint | Total | Success | Failed |
|------|------:|------:|------:|
| GET /accounts/:id | 75218 | 75218 | 0 |
| POST /transfers | 53218 | 53218 | 0 |
| GET /transfer-jobs/:jobId | 32130 | 32130 | 0 |
| GET /transfers?accountId=... | 32310 | 32224 | 86 |
| POST /users | 10771 | 10771 | 0 |
| POST /accounts | 10811 | 10810 | 1 |

---

## Transfer Job Statistics

| Metric | Value |
|------|------|
| Transfer Jobs Created | 39774 |
| Job Poll Hits | 32130 |
| Job Pool Size | 5000 |

---

# Observation

在 **General API / Transfer API worker 分離** 之後，  
mixed workload throughput 可達：

```text
~3569 RPS
```

相較於先前未正確做 worker 配額分離的版本：

```text
~1335 RPS
```

有明顯提升。

這表示：

```text
General API 與 Transfer API 分離後，
不同類型 request 之間的資源競爭顯著下降。
```

---

# Benchmark Scenario 14B
# Transfer-Only Benchmark (Separated Transfer API Cluster)

此測試專門測量：

```text
Transfer API cluster（7010）
```

在獨立 worker 配額下的 throughput。

測試同時包含：

```text
same-shard transfer
cross-shard transfer
```

---

## Benchmark Result

| Metric | Value |
|------|------|
| Duration | 60s |
| Total Requests | ~335k |
| 2xx Responses | 334755 |
| Non-2xx | 454 |
| Avg Request RPS | **~5587.24 RPS** |
| Avg Latency | **~16.84 ms** |

---

## Percentile Latency

| Metric | Value |
|------|------|
| p50 | 4 ms |
| p90 | 42 ms |
| p97.5 | 107 ms |
| p99 | 159 ms |
| p99.9 | 2000 ms |

---

## Transfer Counters

| Metric | Value |
|------|------|
| Same-Shard Routed | 83981 |
| Cross-Shard Routed | 251328 |
| Success | 220393 |
| Failed | 2066 |

---

## Derived Throughput

```text
Completed transfer throughput
= 220393 / 60
≈ 3673 TPS
```

---

## Queue Backlog

| Metric | Value |
|------|------|
| Ready Queue Length | 9000 |

---

# Observation

在 Transfer API 從 General API 中分離後，  
transfer request throughput 可達：

```text
~5587 RPS
```

而 completed transfer throughput 可達：

```text
~3673 TPS
```

相較於先前單機最佳版本：

```text
Completed transfer throughput ≈ 3057 TPS
```

進一步提升。

---

# Throughput Comparison

| Scenario | Throughput |
|------|------|
| Scenario 13 Mixed Workload | ~1335 RPS |
| Scenario 14 Mixed Workload | **~3569 RPS** |
| Scenario 13 Transfer Request | ~10263 RPS |
| Scenario 14 Transfer Request | **~5587 RPS** |
| Scenario 13 Completed Transfer | ~3057 TPS |
| Scenario 14 Completed Transfer | **~3673 TPS** |

---

# Result Interpretation

本階段結果需要分成兩個層面解讀：

---

## 1. Mixed Workload Throughput 明顯提升

General API 與 Transfer API 分離後：

```text
Mixed workload: ~1335 RPS → ~3569 RPS
```

代表：

```text
read / CRUD API 不再被 transfer request 明顯拖慢
```

因此 worker role separation 對整體 API system throughput 是有效的。

---

## 2. Transfer Request RPS 下降，但 Completed TPS 上升

相較於先前：

```text
Transfer request throughput: ~10.26k RPS
```

本階段 transfer-only benchmark 變成：

```text
~5.59k RPS
```

原因不是系統變差，而是：

```text
Transfer API 現在只分配 2 個 workers
不再共享先前 8 個 API workers 的 intake 能力
```

因此 request RPS 下降是符合預期的。

但更重要的是：

```text
Completed transfer throughput: ~3057 TPS → ~3673 TPS
```

這代表：

```text
worker separation 有助於提升真正完成的 transfer throughput
```

---

# Shard Mix Validation

本次 transfer benchmark 中：

| Metric | Value |
|------|------|
| Same-Shard Ratio | ~25% |
| Cross-Shard Ratio | ~75% |

這與 4-shard 隨機理論值一致，代表：

```text
Shard routing 正常
same-shard / cross-shard 分流正常
```

---

# Current Bottleneck

雖然 completed TPS 已提升至：

```text
~3673 TPS
```

但測試結束後：

```text
Ready Queue Length ≈ 9000
```

代表：

```text
Transfer intake 仍高於 queue worker drain speed
```

這表示目前 bottleneck 已更明確集中於：

```text
Queue worker throughput
Cross-shard async processing
Cross-shard finalize / completion path
```

而不再是：

```text
General API routing
Transfer API intake routing
```

---

# Key Findings

本階段的主要發現如下：

1. **General API / Transfer API worker 分離有效**
2. Mixed workload throughput 從 **~1335 RPS 提升到 ~3569 RPS**
3. Completed transfer throughput 從 **~3057 TPS 提升到 ~3673 TPS**
4. Transfer request RPS 雖然下降，但屬於預期現象
5. 目前 bottleneck 已更集中在 **queue worker drain speed 與 cross-shard async processing**

---

# Architectural Implication

這代表系統進一步演化成：

```text
General API cluster
Transfer API cluster
Queue worker cluster
```

是有實際效益的。

與先前單一 API cluster 相比，  
此設計可以更有效避免：

```text
read requests
transfer intake
cross-shard queue processing
```

彼此互相爭奪相同 worker 資源。

---

# Final Performance Summary (Scenario 14)

| Metric | Value |
|------|------|
| Mixed Workload Throughput | **~3569 RPS** |
| Transfer Request Throughput | **~5587 RPS** |
| Completed Transfer Throughput | **~3673 TPS** |
| Avg Transfer Request Latency | **~16.84 ms** |
| Ready Queue Length | **~9000** |

---

# Conclusion

本階段證明：

```text
API / Transfer worker separation
```

對目前單機架構具有明顯正面效果。

具體成果包括：

```text
Mixed workload throughput 顯著提升
Completed transfer throughput 進一步提升
```

這表示：

```text
General API 與 Transfer API 分離
是目前單機優化路線中有效的一步
```

但同時也顯示：

```text
下一階段瓶頸已更集中於 queue worker 與 cross-shard async pipeline
```

---

# Next Optimization Directions

根據本階段結果，下一步優化方向包括：

```text
1. 增加 queue workers，驗證 drain speed 是否為主要瓶頸
2. 進一步瘦身 cross-shard finalize / completion path
3. 減少 Redis queue 與 job status round-trip
4. 研究 transfer API workers 與 queue workers 的最佳配比
```

---

# Benchmark Scenario 15
# API / Transfer Worker Separation + Worker Scaling Benchmark

本階段測試的目的，是驗證將 **General API 與 Transfer API 分離** 後，  
再進一步調整：

```text
Transfer API workers
Queue workers
```

是否能提升以下兩種不同指標：

```text
1. request intake throughput
2. completed transfer throughput
```

先前的單機最佳化版本雖然已達到：

```text
Transfer request throughput ≈ 10.26k RPS
Completed transfer throughput ≈ 3.06k TPS
```

但當 General API 與 Transfer API 共用同一組 API cluster workers 時，  
不同類型 request 仍會互相競爭：

```text
CPU
event loop
Redis
PostgreSQL
```

因此本階段進一步採用：

```text
General API cluster
Transfer API cluster
Queue worker cluster
```

的分離架構，並對 worker 配比進行系統化 benchmark。

---

# Architecture Change

本階段新的單機部署方式如下：

```text
Port 7001
  - General API
  - 6 workers

Port 7010
  - Transfer API
  - N workers (variable)

Port 7002~7007
  - Queue Workers
```

系統 workflow：

```text
Client
   │
   ├── General API (7001, 6 workers)
   │      - GET /accounts/:id
   │      - GET /transfers
   │      - GET /transfer-jobs/:jobId
   │      - POST /users
   │      - POST /accounts
   │
   └── Transfer API (7010)
          - POST /transfers
                │
                ├── Same-Shard → sync fast path
                └── Cross-Shard → Redis Queue
                                  │
                                  ▼
                          Queue Workers
                                  │
                                  ▼
                           PostgreSQL Shards
```

---

# Test Environment

```text
Machine
  MacBook (Single Machine)

System Components
  General API
  Transfer API
  Redis
  PostgreSQL
  Queue Workers

General API Workers = 6
Shard Count = 4
Account Count = 1000
Benchmark Connections = 100
Duration = 60 seconds
```

---

# Worker Scaling Test Matrix

本階段測試以下 worker 配置：

| General | Transfer | Queue |
|--------|--------|------|
| 6 | 2 | 2 |
| 6 | 2 | 4 |
| 6 | 3 | 4 |
| 6 | 4 | 4 |
| 6 | 4 | 6 |
| 6 | 6 | 4 |
| 6 | 6 | 6 |

---

# Benchmark Result

| General | Transfer | Queue | Req/sec | Completed TPS | Fail (non2xx) | Ready Queue |
|-------|-------|-------|-------|-------|-------|-------|
| 6 | 2 | 2 | ~5587 | ~3673 | 2900 | 0 |
| 6 | 2 | 4 | ~5807 | **~4021** | 518 | 10565 |
| 6 | 3 | 4 | ~7826 | ~3885 | 14245 | 5408 |
| 6 | 4 | 4 | ~8209 | ~3607 | 25705 | 4903 |
| 6 | 4 | 6 | ~7853 | ~3488 | 15379 | 4976 |
| 6 | 6 | 4 | **~8591** | ~3298 | 41880 | 2839 |
| 6 | 6 | 6 | ~7942 | ~3034 | 18578 | 2867 |

---

# Metric Definitions

```text
Req/sec
  HTTP request throughput measured by autocannon.

Completed TPS
  Successfully completed transfer transactions per second.

Fail (non2xx)
  Requests rejected or failed (429 / 500).

Ready Queue
  Remaining ready jobs in Redis queue after benchmark.
```

---

# Observations

## 1. Increasing Transfer API workers increases request intake

Example:

```text
6 / 2 / 4 → 5807 RPS
6 / 4 / 4 → 8209 RPS
6 / 6 / 4 → 8591 RPS
```

更多 Transfer API workers 可以讓系統接受更多 transfer request。

但同時：

```text
queue backlog
failure rate
```

也會增加。

---

## 2. Queue Worker Scaling Shows Diminishing Returns

Queue workers 對 completed throughput 有幫助，但只有在某個範圍內。

Example:

```text
Queue workers = 2 → ~3673 TPS
Queue workers = 4 → ~4021 TPS
Queue workers = 6 → ~3488 TPS
```

當 queue workers 超過 4 之後，throughput 不再提升，甚至下降。

可能原因包括：

```text
PostgreSQL contention
Redis contention
connection pool pressure
context switching overhead
```

因此：

```text
Queue worker sweet spot ≈ 4
```

---

## 3. Two Distinct Operating Modes

Worker scaling 顯示系統存在兩種不同運作模式。

### Completion Optimized Mode

Configuration:

```text
6 / 2 / 4
```

Result:

```text
Completed TPS ≈ 4021
Failure rate minimal
```

此配置最大化 **實際完成 transfer throughput**。

---

### Intake Optimized Mode

Configuration:

```text
6 / 6 / 4
```

Result:

```text
Request RPS ≈ 8591
Higher rejection rate
```

此配置最大化 **API request intake capacity**。

---

# Failure Analysis

Non-2xx responses 主要來自：

```text
429 Too Many Requests
500 Internal Server Error
```

其中大多數為：

```text
queue admission rejection
queue full protection
```

這些錯誤屬於 **系統保護機制**，避免 Redis queue 與 database 過載。

---

# Key Findings

本階段 worker scaling benchmark 的主要發現如下：

```text
1. General API / Transfer API worker separation 是有效的架構優化
2. Transfer API worker 數量直接影響 request intake throughput
3. Queue worker scaling 存在明顯 sweet spot
4. Queue workers ≈ 4 為目前最佳配置
5. 系統存在 intake optimized 與 completion optimized 兩種 operating mode
```

---

# Current System Throughput Structure

```text
API intake capacity
        │
        ▼
Transfer request throughput (~8k RPS)
        │
        ▼
Async transfer pipeline
        │
        ▼
Completed transfer throughput (~3k–4k TPS)
```

---

# Final Conclusion

Worker role separation + worker scaling 實驗顯示：

```text
General API / Transfer API separation
```

能有效避免：

```text
read requests
transfer intake
async queue processing
```

彼此爭奪 worker 資源。

目前最佳 worker 配置取決於系統目標：

### Completion Optimized

```text
6 / 2 / 4
```

最大 completed throughput：

```text
≈ 4021 transfers/sec
```

### Intake Optimized

```text
6 / 6 / 4
```

最大 request throughput：

```text
≈ 8591 requests/sec
```

---

# Next Optimization Directions

根據本階段 benchmark，未來優化方向包括：

```text
1. Cross-shard async pipeline optimization
2. Redis queue round-trip reduction
3. Queue worker scheduling improvement
4. Transfer API / queue worker resource isolation
```

目前主要 bottleneck 已集中於：

```text
Cross-shard async transfer execution pipeline
```

而不再是：

```text
API routing
Redis enqueue
same-shard DB transaction
```