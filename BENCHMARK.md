# BENCHMARK

small-bank 效能壓測記錄——測試環境、方法、各階段優化過程與決策說明。

---

## 目錄

- [測試環境](#測試環境)
- [壓測方法](#壓測方法)
- [壓測指令](#壓測指令)
- [優化過程](#優化過程)
- [最終成績](#最終成績)
- [優化決策說明](#優化決策說明)

---

## 測試環境

| 項目 | 規格 |
|------|------|
| 作業系統 | Windows 11 + WSL2（Ubuntu 24.04）|
| CPU | AMD / Intel（單機）|
| 記憶體 | 32 GB |
| Node.js | 18+ |
| PostgreSQL | 16（WSL 原生安裝）|
| Redis | 7+（WSL 原生安裝）|

> 所有 process（API server、queue worker、PostgreSQL、Redis、壓測腳本）皆在同一台機器上執行，屬於**單機壓測**環境。

---

## 壓測方法

### 工具

使用 [autocannon](https://github.com/mcollina/autocannon) 對 General API 和 Transfer API 同時施壓。

### 請求分布

**General API（75% 連線）**

| Endpoint | 比例 | 說明 |
|----------|------|------|
| `GET /accounts/:id` | 45% | 查詢餘額（有 Redis cache）|
| `GET /transfers?accountId=` | 20% | 查詢轉帳記錄 |
| `GET /accounts/:id`（getTransferJob）| 10% | 同上 |
| `POST /users` | 5% | 建立用戶 |
| `POST /accounts` | 5% | 開立帳號 |

**Transfer API（25% 連線）**

- 100%：`POST /transfers`，fromId 與 toId 皆從 `[min-id, max-id]` 隨機選取

### 一致性驗證

壓測結束後等待 queue 清空，再對所有 shard 執行全量餘額加總，與初始總額比對：

```
預期總額 = 實際帳號數 × 初始餘額
實際總額 = Σ shard_0 ~ shard_3 帳號餘額
diff     = 實際總額 - 預期總額
```

`diff = +0` 代表無資金憑空產生或消失。

---

## 壓測指令

```bash
# 啟動 stack（最佳參數）
bash scripts/run/wsl_stack.sh restart -g 3 -t 1 -qc 8 -pgMeta 25 -pgShard 10 -batchSize 20

# 建立測試資料
node scripts/benchmark/seed.js --concurrency=3

# 執行壓測
node scripts/benchmark/mixed_rps_autocannon.js \
  --connections=200 \
  --duration=30 \
  --min-id=1 \
  --max-id=50000 \
  --init-bal=1000000 \
  --queue-drain-timeout=120
```

---

## 優化過程

### 起點：基準成績

最初的參數設定下，總 RPS 約 **7,092**，餘額守恆。

```
總 RPS    : 7,092
General   : 3,707 RPS
Transfer  : 3,385 RPS
p99       : 219ms
失敗率    : 0%
```

---

### 優化一：修正 config typo（`configtransferQueue` → `config.transferQueue`）

**問題**

`config/config.default.js` 中有一個 typo：

```js
// ❌ 錯誤
configtransferQueue = { ... }

// ✅ 正確
config.transferQueue = { ... }
```

這導致 `getTransferQueueConfig(app)` 讀取 `app.config.transferQueue` 時拿到 `undefined`，fallback 到 hardcode 的預設值（`batchSize: 20`），env var 傳入的參數完全失效。

**效果**

確保 `batchSize`、`rejectThreshold` 等參數正確生效，是後續所有調參的前提。

---

### 優化二：調高 PostgreSQL `max_connections`

**問題**

PostgreSQL 預設 `max_connections = 500`。系統在高並發下連線數峰值達到 480，非常接近上限，導致偶發的「`remaining connection slots are reserved`」錯誤，Transfer API 出現 56 個失敗請求。

各元件的連線估算：

```
General API  : 3 workers × pool(10) × 4 shards = 120
Transfer API : 1 worker  × pool(10) × 4 shards =  40
Queue Worker : pool(10)  × 4 shards            =  40
pgMeta       : (3+1) workers × pool(25)        = 100
其他 overhead                                  ~180
合計                                           ~480
```

**修正**

```sql
ALTER SYSTEM SET max_connections = 1000;
-- 重啟 PostgreSQL 後生效
```

**效果**

解除連線瓶頸，RPS 從 7,092 大幅提升至 **9,023**（+27%）。

```
總 RPS    : 9,023  (+27%)
General   : 4,310 RPS
Transfer  : 4,712 RPS
p99       : 202ms
失敗率    : 0%
diff      : +0 ✅
```

---

### 優化三：同 shard 轉帳改用 CTE 合併查詢

**問題**

`transferSameShard` 原本需要 5 次 PostgreSQL round trip：

```
1. BEGIN
2. SET LOCAL lock_timeout
3. UPDATE accounts（debit）
4. UPDATE accounts（credit）
5. INSERT transfers
6. COMMIT
```

每次 round trip 都有網路來回延遲，在高並發下累積開銷顯著。

**修正**

將 debit、credit、INSERT 三個操作合併為一個 CTE，減少為 3 次 round trip：

```sql
-- round trip 2（原本 3 次 → 1 次）
WITH debit AS (
  UPDATE accounts SET ... WHERE id = $2 AND available_balance >= $1 RETURNING ...
),
credit AS (
  UPDATE accounts SET ... WHERE id = $3 RETURNING id
),
ins AS (
  INSERT INTO transfers ...
  SELECT ... WHERE EXISTS (SELECT 1 FROM debit) AND EXISTS (SELECT 1 FROM credit)
  RETURNING id
)
SELECT
  (SELECT COUNT(*) FROM debit)  AS debit_count,
  (SELECT COUNT(*) FROM credit) AS credit_count,
  (SELECT id FROM ins)          AS transfer_id,
  ...
```

CTE 在單一 transaction 內原子執行，`debit_count = 0` 表示餘額不足，`credit_count = 0` 表示目標帳號不存在，兩種錯誤都能正確識別。

**效果**

Transfer API RPS 從 3,385 提升至 **4,712**（+39%）。

---

### 優化四：Queue Worker drain 改用 `Promise.all` 並發

**問題**

Queue Worker 的 `drainQueue` 原本以 sequential for loop 處理同一個 fromId 的 job 批次：

```js
// 原本：一個跑完才跑下一個
for (const job of jobs) {
  await handler(job);
}
```

每個 job 約 10ms（PG round trip），一個 loop 每秒只能處理約 100 個 job，8 個 loop 合計約 800 job/秒。

**修正**

改為 `Promise.all` 並發執行同批次的所有 job：

```js
await Promise.all(jobs.map(async (job) => {
  if (ownerLost) return;
  try {
    await handler(job);
  } catch (err) {
    logger.error(...);
  }
}));
```

由於每個 job 操作的是不同帳號的 PG 資料，並發執行不會造成資料競爭。即使出現 lock 競爭，PG 的 `lock_timeout = 200ms` 保護也能確保不會無限等待。

**效果**

Transfer API 從 4,712 提升至 **5,079**（+8%），整體 RPS 達到 **9,377**（+4%）。

```
總 RPS    : 9,377  (+32% vs 起點)
General   : 4,298 RPS
Transfer  : 5,079 RPS
p99       : 181ms
失敗率    : 0%
diff      : +0 ✅
```

---

## 最終成績

### 各階段 RPS 對比

| 階段 | 優化項目 | 總 RPS | General | Transfer | p99 |
|------|---------|--------|---------|----------|-----|
| 起點 | — | 7,092 | 3,707 | 3,385 | 219ms |
| +1 | `max_connections` 1000 | 9,023 | 4,310 | 4,712 | 202ms |
| +2 | same-shard CTE | 9,023 | 4,310 | 4,712 | 202ms（含）|
| +3 | `Promise.all` drain | **9,377** | 4,298 | **5,079** | **181ms** |

> 優化一（config typo 修正）是優化二之後才發現的前置問題，修正後才讓後續調參真正生效。

### 最終壓測結果

```
總 RPS (avg)        : 9,377
加權平均 latency    : 28.53ms
p95 latency         : 158ms
p99 latency         : 181ms

General API
  RPS               : 4,298
  avg latency       : 34.91ms
  成功率            : 100%

Transfer API
  RPS               : 5,079
  avg latency       : 9.41ms
  成功率            : 100%

餘額守恆
  預期總額          : 50,000,000,000
  實際總餘額        : 50,000,000,000
  diff              : +0 ✅
```

---

## 優化決策說明

在優化過程中，有幾個方向被評估後選擇不實作，原因如下。

### ❌ 跨 Shard 轉帳也改用 CTE

實測後發現跨 shard CTE 版本（8,780 RPS）比原版（9,023 RPS）略低。

原因：跨 shard 轉帳走的是非同步 queue，Step 1 的 round trip 減少對 API 端幫助有限，但 CTE 的 query 更複雜，PG planning time 稍微增加，抵消了收益。因此維持原版。

### ❌ `GET /transfers` 加 Redis Cache

`GET /transfers` 每次都打 PG 是 General API 的成本之一。但壓測範圍有 50,000 個帳號，每個帳號被打到的頻率約每 67 秒一次，TTL 必須設到 60 秒以上才有明顯 cache hit rate。

然而 60 秒 TTL 在生產環境代表用戶可能看到過期的轉帳記錄，不符合銀行系統對**資料即時性**的要求，因此放棄。

### ❌ pgBouncer 連線池代理

pgBouncer 的 transaction mode 不支援 `SET LOCAL`，而系統中所有轉帳 transaction 都使用 `SET LOCAL lock_timeout = '200ms'` 防止 lock 等待過久。改用 session mode 效果又非常有限，整體複雜度提升但效益不確定，因此放棄。

### ❌ 調整壓測請求比例（降低寫入操作比例）

降低 `POST /users`、`POST /accounts` 的比例可以拉高 RPS 數字，但這屬於「投機取巧」——壓測的目的是模擬真實負載，人為調整比例只會讓數字好看但無法反映真實效能，因此維持原始比例。