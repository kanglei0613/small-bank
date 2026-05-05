# Interview Script — small-bank Backend

---

## 1-minute Pitch（約 1 分鐘口頭說明）

### 中文版（約 230 字）

這個專案是一個高並發的銀行轉帳系統，核心挑戰是在高 RPS 下保證資金不會憑空產生或消失。

架構上，我把資料分散到四個 PostgreSQL shard，routing 規則是 `accountId % 4`，不需要額外的路由表查詢，O(1) 就能決定要去哪個 shard。API 層分成兩個 port：port 7001 處理帳號查詢，port 7010 專門吃 POST /transfers，這樣可以獨立調整兩邊的 worker 數量。

轉帳有兩條路徑。同 shard 的情況，我用一個 CTE 把 debit、credit、insert transfer record 合在同一個 round trip 完成，整個操作是原子的，不可能有中間狀態。跨 shard 的情況，直接 ACID transaction 不夠用，所以我用 Saga pattern：先在 fromShard 凍結 `reserved_balance`，再去 toShard 入帳，最後回來銷帳。每個步驟的補償邏輯都有冪等保護，用 `saga_credits` 和 `saga_compensations` 表的 unique index 防止重複執行。

並發控制上，每個 account 的跨 shard 轉帳會進入一個 per-fromId Redis queue，確保同一個帳號的轉帳不會同時競爭 DB row lock。row-level lock 加了 200ms timeout，避免慢鎖把整個 worker pool 拖死。

最後壓測結果是 9,377 RPS、失敗率 0%、全量餘額守恆 diff = +0。

---

### English Version（~230 words）

This project is a high-concurrency banking transfer system. The core challenge is guaranteeing balance conservation — no money created or destroyed — under high RPS.

The data layer shards across four PostgreSQL instances. Routing is deterministic: `shardId = accountId % 4`, computed inline with no routing table lookup. The API tier runs on two ports: port 7001 for accounts and queries, port 7010 exclusively for `POST /transfers`, so each tier can be scaled independently.

Transfers follow two paths. For same-shard transfers, I merge the debit, credit, and transfer-record insert into a single CTE, completing the entire operation in one round trip. The CTE's conditional INSERT — `WHERE EXISTS (debit) AND EXISTS (credit)` — means no partial state can commit. For cross-shard transfers, I implement a three-step Saga: first freeze `available_balance` into `reserved_balance` on the source shard, then credit the destination shard, then finalize by draining `reserved_balance` on the source. Compensation is idempotent — `saga_credits` and `saga_compensations` tables use unique indexes on `transfer_id` to prevent double-apply on retry.

For concurrency control, all outbound transfers per `fromId` are serialized through a per-fromId Redis queue, eliminating row-lock races between concurrent transfers from the same account. Every transaction sets `lock_timeout = 200ms` to fail fast under contention rather than pile up blocked connections.

Benchmark result: **9,377 RPS, 0% failure rate, balance conservation diff = +0**.

---

## 可能的追問問題 + 建議回答

---

### Q1：為什麼不用 2PC（Two-Phase Commit）處理跨 shard 轉帳？

**建議回答：**

2PC 需要一個 coordinator 在 prepare 階段鎖住所有參與者，等待 all-or-nothing 決議。在跨網路、跨 DB 的場景裡，coordinator 本身就是 single point of failure — 如果 coordinator 在 prepare 和 commit 之間崩潰，所有參與者的 lock 會一直持有到 coordinator 恢復，這對高並發系統是致命的。

Saga 的設計是把跨 shard 操作拆成多個獨立的 local transaction，每一步成功後立刻 commit，不持有跨服務的 lock。失敗時執行補償，而不是 rollback。這樣的代價是最終一致性而非強一致性，但我用 `saga_log` 記錄每個步驟的狀態，recovery worker 可以在 crash 後自動補完未完成的轉帳，達到 eventual consistency。

---

### Q2：per-fromId queue 如何防止 race condition？

**建議回答：**

每個 `fromId` 對應一個獨立的 Redis list（`transfer:queue:{fromId}`）。queue worker 在 drain 某個 fromId 的 queue 時，會先用 Redis SETNX 取得一個 owner lock（`transfer:owner:{fromId}`），確保同一時間只有一個 worker 在處理同一個 fromId 的轉帳。

這樣即使有多個 worker process，同一個帳號的轉帳永遠是序列執行的，不會兩個 worker 同時對同一個 fromAccount 做 `UPDATE accounts SET available_balance = available_balance - $1`，消除了 race condition 的根本原因。

---

### Q3：`balance = available_balance + reserved_balance` 這個 CHECK constraint 的作用是什麼？有沒有可能繞過它？

**建議回答：**

這個 constraint 是 DB-level 的最後防線。Application code 理論上應該維持這個不變量，但如果有 bug（例如只更新了 `available_balance` 卻沒更新 `balance`），PostgreSQL 會在 COMMIT 時直接拒絕這筆 transaction，資料不會寫入，而不是悄悄讓不一致的狀態進 DB。

這個設計把資料正確性從「application 的自律」提升到「DB 的強制保證」。在金融系統裡，這一層保護是必要的，因為一旦餘額錯了，很難 detect，更難修復。

繞過的方式理論上是用有 SUPERUSER 權限的 session 執行 `ALTER TABLE DISABLE TRIGGER ALL` 或關掉 constraint，但這在正常 application 的 DB user 應該沒有這個 permission。

---

### Q4：如果 Step 2（credit toAccount）成功但 Step 3（finalize fromAccount）失敗，怎麼辦？

**建議回答：**

這是最複雜的 failure case。此時 toAccount 已入帳，但 fromAccount 的 `reserved_balance` 還沒被銷帳，所以帳號的 `balance` 還沒被真正扣掉。

我的處理是把 `transfers.status` 設成 `PENDING_FINALIZE`，`saga_log.step` 維持 `CREDITED` 不動。Recovery worker 每隔 10 秒掃描 `saga_log` 找 `step = 'CREDITED'` 的 row，重新執行 Step 3。Step 3 只做 `UPDATE accounts SET reserved_balance = reserved_balance - $1, balance = balance - $1 WHERE reserved_balance >= $1`，這個操作是冪等的——如果 reserved_balance 已經被扣了（例如第一次其實成功了但 response 沒回來），`WHERE reserved_balance >= $1` 的 guard 會讓重試安全失敗。

所以最終結果是 toAccount 的錢到了，fromAccount 的 `balance` 也被正確扣掉，系統達到 eventual consistency。

---

### Q5：9,377 RPS 的瓶頸在哪裡？怎麼繼續優化？

**建議回答：**

目前的主要瓶頸有幾個：

**DB connection pool**：每個 shard pool max 設 10，壓測時 pool 幾乎滿載。可以透過增加 shard 數或用 PgBouncer 做 connection pooling 來緩解。

**同 shard CTE 的 lock contention**：當多個請求同時對同一個 `fromId` 做同 shard 轉帳，row lock 競爭會導致 `lock_timeout = 200ms` 的錯誤增加。解法是把同 shard 的熱帳號也走 Redis queue 序列化，而不是直接並發打 DB。

**Node.js 單執行緒**：Transfer API 只開 1 個 worker，主要是為了讓 queue worker 取得更多 CPU。如果增加 Transfer API worker 數，throughput 可以進一步提升，但要注意 queue worker 的 concurrency 也要相應調整。

**跨 shard 3 round trip → 可優化**：目前 Step 1、Step 2、Step 3 各自是獨立的 BEGIN/COMMIT，可以考慮把 Step 1 和 Step 3 的 saga_log update pipeline 掉，減少 RTT。
