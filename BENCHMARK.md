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