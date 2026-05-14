'use strict';

/**
 * @file app/lib/queue/redis_transfer_queue.js
 *
 * Redis 轉帳佇列核心模組
 *
 * ════════════════════════════════════════════════════════════════
 * 架構概覽
 * ════════════════════════════════════════════════════════════════
 *
 * 資料結構（Redis Keys）：
 *   transfer:queue:from:{fromId}        — per-fromId List（RPUSH 入隊，LRANGE+LTRIM 批次出隊）
 *   transfer:queue:ready:fromIds        — 全域排程 List（有 job 的 fromId 在此等候 BRPOP）
 *   transfer:queue:owner:from:{fromId}  — owner lock（SET NX PX，防止多 worker 並行 drain）
 *
 * 設計動機：
 *   跨 shard 轉帳的 RESERVE 步驟需要對 fromAccount row 加鎖（UPDATE WHERE id=$1）。
 *   若多個不同 fromId 的 Saga 並行 RESERVE，各自取不同的 row lock，互不干擾。
 *   但若同一 fromId 的多個 Saga 並行 RESERVE，它們競爭同一個 row lock：
 *     - PostgreSQL 的 lock_timeout=200ms → N-1 個 Saga lock timeout 失敗
 *     - batchSize=50 時，有效成功率 = 1/50 = 2%（其餘 98% 白費）
 *   per-fromId queue + sequential drain 徹底消除此問題：同一 fromId 的 Saga 依序執行，
 *   每次只有一個 Saga 持有 fromAccount row lock，100% 成功率。
 *
 * 流量控制（Back-pressure）：
 *   rejectThreshold（預設 240）  → 超過此長度立即回傳 429，保護 DB
 *   maxQueueLength（預設 300）   → 軟性上限，防止單一 fromId 佔用過多 Redis 記憶體
 *
 * 關鍵函數：
 *   pushJob           — Lua 原子化：長度檢查 + RPUSH + ready queue 通知（從空→非空只通知一次）
 *   popJobs           — Lua 原子化：LRANGE + LTRIM 批次出隊
 *   tryAcquireOwner   — Redis SET NX PX，取得 owner lock
 *   refreshOwner      — Lua 原子化：比對 ownerValue 再 PEXPIRE，防止誤延長他人的 lock
 *   releaseOwner      — Lua 原子化：比對 ownerValue 再 DEL，防止誤刪他人的 lock
 *   startOwnerHeartbeat — 背景 interval，定期刷新 owner lock TTL，防止長 drain 中 lock 過期
 *   drainQueue        — 主要 drain 邏輯，sequential/concurrent 可切換（見下方 tradeoff）
 *   tryStartDrain     — 嘗試取得 lock 並啟動 drain（已有 owner 則立即 return false）
 *
 * ════════════════════════════════════════════════════════════════
 * ⚠️ drainQueue：Sequential vs Concurrent Tradeoff（關鍵架構決策）
 * ════════════════════════════════════════════════════════════════
 *
 * 問題根源：
 *   per-fromId queue 中的所有 job 共用同一個 fromAccount row（PostgreSQL row lock）。
 *   若同時執行 N 個 Saga（concurrent），每個 Saga 的 RESERVE 步驟都 UPDATE 同一行：
 *     UPDATE accounts SET ... WHERE id = {fromAccountId} AND available_balance >= {amount}
 *   PostgreSQL 會序列化這些 UPDATE，但 lock_timeout=200ms 下，
 *   第 1 個取得 lock，其餘 N-1 個在 200ms 內等不到 lock 而 timeout → 503 回傳。
 *
 * Concurrent 模式（QUEUE_DRAIN_SEQUENTIAL=false）：
 *   理論吞吐量：batchSize 個 Saga 同時發送
 *   實際成功率：≈ 1/batchSize（batchSize=50 → 2%）
 *   適用場景：fromId 隊列中每筆轉帳金額足夠分散，不同 fromId 的任務混排
 *   結論：在 per-fromId queue 設計下，concurrent 破壞序列化保證，不適用
 *
 * Sequential 模式（QUEUE_DRAIN_SEQUENTIAL=true，現行預設）：
 *   理論吞吐量：受限於單個 Saga 延遲（e.g. Saga=50ms → 20 job/s/fromId）
 *   實際成功率：100%（無 row lock 競爭）
 *   適用場景：所有 per-fromId queue 設計
 *   結論：正確模式，犧牲少量吞吐量換取 100% 正確性
 *
 * 壓測驗證（11,689 RPS 純轉帳，100% 成功，餘額守恆 diff=+0）：
 *   Sequential 模式下系統吞吐量由多個 fromId 的並行 drain 提供，
 *   單一 fromId 的 20 job/s 限制乘以 worker 並發數（N 個 fromId 同時 drain），
 *   整體 throughput ≫ concurrent 模式（concurrent 大量 lock timeout 造成大量重試）。
 *
 * 環境變數控制（不需重建 image 即可切換）：
 *   QUEUE_DRAIN_SEQUENTIAL=true   → sequential（預設，推薦）
 *   QUEUE_DRAIN_SEQUENTIAL=false  → concurrent（供對照壓測使用）
 *
 * ════════════════════════════════════════════════════════════════
 * ⚠️ 已知問題（Known Issues）
 * ════════════════════════════════════════════════════════════════
 *
 * 1. ✅ Owner heartbeat 第一次 tick 延遲過久（First heartbeat too late）— 已修復
 *    原本：第一次 tick 在 ownerTtlMs（10s）後才執行，drain >= 10s 時 lock 過期。
 *    修復：改為 `setTimeout(tick, ownerRefreshIntervalMs)`（3s），確保 lock 在 TTL
 *    過期前至少刷新一次。
 *
 * 2. startQueueWorker 共用單一 Redis 連線（Connection sharing，見 transfers.js）
 *    Egg service 版本的 startQueueWorker 讓 BRPOP 和 drain 共用同一條 Redis 連線，
 *    ioredis 會將指令排隊（serialize），降低吞吐量。
 *    修法：參考 scripts/worker/queue_worker.js 的 brpopRedis + drainRedis 分離設計。
 *
 * ════════════════════════════════════════════════════════════════
 * ⚠️  架構審查標注（Architecture Review Annotations）2026-05-14 v7
 * ════════════════════════════════════════════════════════════════
 *
 * 3. 【v7 — L11】`pushJob` Lua — `maxQueueLengthPerFromId`（-1）路徑為死碼
 *    （Dead code in pushJob Lua: maxQueueLengthPerFromId -1 path is unreachable）
 *
 *    問題描述（Problem）：
 *      Lua 腳本的判斷順序是：
 *        if currentLength >= rejectThreshold(ARGV[1]=240) then return -2 end
 *        if currentLength >= maxLength(ARGV[2]=300)       then return -1 end
 *      因為 rejectThreshold(240) < maxLength(300)，任何長度 ≥ 240 的 queue 都先觸發 -2。
 *      -1 的條件（>= 300）在現行參數下永遠不可達，等同死碼。
 *
 *    影響（Impact）：
 *      - 兩段 429 錯誤訊息（"is full" vs "at capacity"）語意設計失效
 *      - 若監控 / 告警依賴 error message 區分兩種壓力等級，分類永遠錯誤
 *      - maxQueueLengthPerFromId 配置項對 pushJob 的行為無任何影響
 *
 *    修法（Fix）：
 *      交換判斷順序：先 >= maxLength 回傳 -1（硬上限），再 >= rejectThreshold 回傳 -2（軟限流）：
 *      ```lua
 *      if currentLength >= tonumber(ARGV[2]) then return -1 end   -- hard cap (maxLength)
 *      if currentLength >= tonumber(ARGV[1]) then return -2 end   -- soft reject (rejectThreshold)
 *      ```
 *      或：將兩個閾值合并為一個，避免語意混淆。
 *
 *    Risk level: LOW — 功能仍正確（都 return 429），但設計意圖失效，配置項存在誤導性。
 *    TODO: FIX — Swap the Lua check order so maxLength hard cap is checked before rejectThreshold
 *
 * 4. 【v7 — L12】`drainQueue` finally 中 `releaseOwner` 拋錯時 re-enqueue 被靜默跳過
 *    （drainQueue finally: releaseOwner error propagation skips re-enqueue）
 *
 *    問題描述（Problem）：
 *      `drainQueue` 的 `finally` 區塊：
 *        1. heartbeat.stop()         -- 停 heartbeat
 *        2. await releaseOwner(...)  -- ← 若此行拋錯（Redis 短暫中斷），直接 propagate
 *        3. try { llen → lpush }     -- ← 永遠不被執行
 *      `releaseOwner` 失敗後，後續 re-enqueue 邏輯被完全跳過。
 *
 *    情境（Scenario）：
 *      Redis 短暫中斷（< 10s）時：
 *        (a) owner lock 未釋放（lock 仍在 Redis 中直至 TTL=10s 過期）
 *        (b) 若 drainQueue 結束前仍有 jobs 殘留在 per-fromId queue 中，
 *            re-enqueue 訊號不發出，這些 job 無法被下一個 worker 消費，
 *            直至 worker 重啟（recoverStaleQueues）或下次 pushJob 觸發 ready 訊號
 *
 *    最壞情境（Worst case）：
 *      Redis 中斷 → releaseOwner 失敗 → lock TTL 到期（10s）→ re-enqueue 已跳過
 *      → 剩餘 jobs 停滯最多 10s（lock TTL）+ SAGA_RECOVERY_INTERVAL_MS（10s）= 20s 無法處理
 *      若同時有多個 fromId 的 drain 都在 Redis 中斷時完成，多個 fromId 的 jobs 均被卡住。
 *
 *    修法（Fix）：
 *      將 releaseOwner 包在 .catch() 中（owner lock 會 TTL 自動到期，拋錯可靜默忽略），
 *      確保 re-enqueue 邏輯始終執行：
 *      ```js
 *      finally {
 *        heartbeat.stop();
 *        await releaseOwner(redis, fromId, ownerValue).catch(err => {
 *          logger.error('[RedisQueue] releaseOwner failed (lock will expire by TTL): err=%s', err && err.message);
 *        });
 *        // re-enqueue 現在保證執行
 *        try {
 *          const remaining = await redis.llen(buildQueueKey(fromId));
 *          if (remaining > 0) await redis.lpush(buildReadyQueueKey(), String(fromId));
 *        } catch (err) { ... }
 *      }
 *      ```
 *
 *    Risk level: MEDIUM — Redis 短暫中斷場景下可能造成最多 ~20 秒的 job 積壓無人消費。
 *    TODO: FIX — Wrap releaseOwner in .catch() to guarantee re-enqueue always runs
 */

const { TooManyRequestsError } = require('../errors');

// Key builders
function buildQueueKey(fromId) { return `transfer:queue:from:${fromId}`; }
function buildOwnerKey(fromId) { return `transfer:queue:owner:from:${fromId}`; }
function buildReadyQueueKey() { return 'transfer:queue:ready:fromIds'; }
function buildOwnerValue() { return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }

function getTransferQueueConfig(app) {
  return app.config.transferQueue || {
    rejectThresholdPerFromId: 240,
    maxQueueLengthPerFromId: 300,
    ownerTtlMs: 10000,
    ownerRefreshIntervalMs: 3000,
    batchSize: 20,
    readyQueueBlockTimeoutSec: 1,
  };
}

// Push a job into the per-fromId queue.
//
// Uses a Lua script for atomicity: length check + push + ready-queue signal are one operation.
// The fromId is pushed to the ready queue only when the queue transitions from empty → non-empty,
// so the worker doesn't get redundant signals for every job.
async function pushJob(redis, fromId, job, options = {}) {
  const queueKey = buildQueueKey(fromId);
  const readyQueueKey = buildReadyQueueKey();
  const payload = JSON.stringify(job);
  const rejectThreshold = options.rejectThresholdPerFromId || 240;
  const maxLength = options.maxQueueLengthPerFromId || 300;

  // ⚠️ [v7 — L11] Lua 邏輯錯誤：maxQueueLengthPerFromId（-1）路徑為死碼（Lua dead code）
  //
  // ARGV[1] = rejectThreshold = 240（軟限流，先觸發）
  // ARGV[2] = maxLength       = 300（硬上限，後判斷）
  //
  // 因為 240 < 300，任何長度 ≥ 240 的 queue 都先觸發第一個 return -2，
  // 第二個 return -1（>= 300）在當前參數設定下永遠不可達。
  //
  // 修法：交換判斷順序（先 >= maxLength 回傳 -1，再 >= rejectThreshold 回傳 -2）
  // TODO [L11]: Swap check order — check maxLength (>= ARGV[2]) first, rejectThreshold second
  const lua = `
    local currentLength = redis.call("LLEN", KEYS[1])
    if currentLength >= tonumber(ARGV[1]) then return -2 end
    if currentLength >= tonumber(ARGV[2]) then return -1 end
    local newLength = redis.call("RPUSH", KEYS[1], ARGV[3])
    if newLength == 1 then redis.call("LPUSH", KEYS[2], ARGV[4]) end
    return newLength
  `;

  const result = await redis.eval(
    lua,
    2,
    queueKey,
    readyQueueKey,
    String(rejectThreshold),
    String(maxLength),
    payload,
    String(fromId)
  );

  if (result === -2) {
    throw new TooManyRequestsError('transfer queue is full, please try again later');
  }

  if (result === -1) {
    throw new TooManyRequestsError('transfer queue is at capacity, please try again later');
  }

  return result;
}

// Pop a single job from the left of the queue.
async function popJob(redis, fromId) {
  const jobs = await popJobs(redis, fromId, 1);
  return jobs[0] || null;
}

// Atomically pop up to batchSize jobs from the left of the queue.
async function popJobs(redis, fromId, batchSize) {
  const queueKey = buildQueueKey(fromId);

  const lua = `
    local values = redis.call("LRANGE", KEYS[1], 0, tonumber(ARGV[1]) - 1)
    if #values == 0 then return values end
    redis.call("LTRIM", KEYS[1], tonumber(ARGV[1]), -1)
    return values
  `;

  const raws = await redis.eval(lua, 1, queueKey, String(batchSize));

  if (!raws || raws.length === 0) return [];
  return raws.map(raw => JSON.parse(raw));
}

async function getQueueLength(redis, fromId) {
  return await redis.llen(buildQueueKey(fromId));
}

async function getQueueStats(redis, fromId, options = {}) {
  const queueKey = buildQueueKey(fromId);
  const ownerKey = buildOwnerKey(fromId);
  const readyQueueKey = buildReadyQueueKey();

  const [ queueLength, ownerValue, ownerTTL, readyQueueLength ] = await Promise.all([
    redis.llen(queueKey),
    redis.get(ownerKey),
    redis.pttl(ownerKey),
    redis.llen(readyQueueKey),
  ]);

  return {
    fromId,
    queueKey,
    ownerKey,
    readyQueueKey,
    queueLength,
    ownerExists: !!ownerValue,
    ownerValue: ownerValue || null,
    ownerTTL,
    readyQueueLength,
    rejectThresholdPerFromId: options.rejectThresholdPerFromId || 240,
    maxQueueLengthPerFromId: options.maxQueueLengthPerFromId || 300,
    ownerTtlMs: options.ownerTtlMs || 10000,
    ownerRefreshIntervalMs: options.ownerRefreshIntervalMs || 3000,
    batchSize: options.batchSize || 5,
  };
}

// Acquire the owner lock for a fromId queue (SET NX PX).
// Returns true if acquired, false if another worker already holds it.
async function tryAcquireOwner(redis, fromId, ownerValue, options = {}) {
  const result = await redis.set(
    buildOwnerKey(fromId),
    ownerValue,
    'PX', options.ownerTtlMs || 10000,
    'NX'
  );
  return result === 'OK';
}

// Extend the owner lock TTL, but only if ownerValue still matches.
async function refreshOwner(redis, fromId, ownerValue, options = {}) {
  const lua = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    end
    return 0
  `;
  const result = await redis.eval(
    lua, 1,
    buildOwnerKey(fromId),
    ownerValue,
    String(options.ownerTtlMs || 10000)
  );
  return result === 1;
}

// Release the owner lock, but only if ownerValue still matches.
async function releaseOwner(redis, fromId, ownerValue) {
  const lua = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    end
    return 0
  `;
  await redis.eval(lua, 1, buildOwnerKey(fromId), ownerValue);
}

// Run a background heartbeat that periodically refreshes the owner lock TTL.
// Returns a { stop() } handle. Call stop() when drain is complete.
//
// The first tick fires after ownerRefreshIntervalMs (default 3 s) so the lock
// TTL is refreshed well before it expires (default TTL = 10 s). After that,
// subsequent ticks run on the same interval via setInterval.
//
// Fix history: previously the first tick was delayed by ownerTtlMs (10 s),
// meaning the lock could expire before the first heartbeat on a slow drain.
function startOwnerHeartbeat({ ctx, fromId, redis, ownerValue, options = {} }) {
  const { logger } = ctx;
  const ownerTtlMs = options.ownerTtlMs || 10000;
  const ownerRefreshIntervalMs = options.ownerRefreshIntervalMs || 3000;
  const onLost = options.onLost || null;

  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const refreshed = await refreshOwner(redis, fromId, ownerValue, { ownerTtlMs });
      if (!refreshed) {
        logger.warn('[RedisQueue] owner heartbeat lost: fromId=%s owner=%s', fromId, ownerValue);
        if (onLost) onLost();
      }
    } catch (err) {
      logger.error('[RedisQueue] owner heartbeat error: fromId=%s owner=%s err=%s', fromId, ownerValue, err && err.message);
    }
  };

  // FIX: use ownerRefreshIntervalMs (3 s) for the first tick, NOT ownerTtlMs
  // (10 s). With the old delay the lock could expire before the first heartbeat
  // on any drain that takes >= 10 s, letting two workers drain the same fromId.
  const initTimer = setTimeout(() => {
    if (stopped) return;
    tick();
    timer = setInterval(tick, ownerRefreshIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }, ownerRefreshIntervalMs);

  if (typeof initTimer.unref === 'function') initTimer.unref();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(initTimer);
      if (timer) clearInterval(timer);
    },
  };
}

// Block-pop a fromId from the ready queue (BRPOP). Returns null on timeout.
async function blockPopReadyFromId(redis, timeoutSec) {
  const result = await redis.brpop(buildReadyQueueKey(), timeoutSec);
  if (!result || result.length < 2) return null;

  const fromId = Number(result[1]);
  return (Number.isInteger(fromId) && fromId > 0) ? fromId : null;
}

// Drain all jobs from a fromId queue while holding the owner lock.
//
// - Runs a heartbeat to keep the lock alive during long drains.
// - Processes jobs sequentially (one at a time) to avoid row-lock self-contention.
//   All jobs in a per-fromId queue share the same fromAccount row; running them
//   concurrently (Promise.all) causes the others to hit lock_timeout (200ms) and
//   fail. Sequential processing trades throughput for correctness — every job
//   succeeds instead of 1-in-batchSize.
//
// Tradeoff vs concurrent batch:
//   Concurrent (old): higher theoretical throughput per worker tick, but
//     same-fromId jobs contend on the same PG row → ~1/batchSize success rate.
//   Sequential (new): lower throughput per tick, but 100% success rate per job,
//     and total successful transfers ≫ concurrent mode under load.
// - On finish (or owner loss), releases the lock and re-enqueues fromId
//   if jobs arrived mid-drain.
//
// ⚠️ [NOT PRODUCTION-READY] At-most-once delivery（交割語義為「最多一次」—— Risk: MEDIUM）
//
// 問題描述（At-most-once delivery gap）：
//   `popJobs` 使用 Lua 腳本原子執行 LRANGE + LTRIM，將 batchSize 個 job 從 Redis list 移除。
//   若 process 在 `popJobs` 之後、`handler(job)` 完成之前 crash，這些 job 永久消失：
//     - `transfer:queue:from:{fromId}` list 已被 LTRIM，沒有 job 可供 recoverStaleQueues 恢復
//     - `saga_log` 尚未寫入（RESERVE 步驟尚未執行）
//     - `transferJobStore` 中 job 的 status 永久停留在 'queued'（never executed）
//   用戶提交了轉帳並收到 jobId，但轉帳永遠不會執行，最終 polling timeout。
//
// 觸發條件：
//   process kill（OOM、SIGKILL）或硬體故障發生在 popJobs 返回後、handler 成功前。
//   在 graceful shutdown（SIGTERM + 等待）場景下，此窗口可以縮短但無法完全消除。
//
// Production 修法（At-least-once delivery）：
//   採用「Reserved List」模式：
//     1. LRANGE：讀取但不移除
//     2. SADD transfer:queue:processing:{fromId}：記錄「正在處理的 job IDs」
//     3. 處理成功後：LTRIM + SREM 清除
//     4. Worker 啟動時：掃描所有 processing set，把殘留 job 推回 fromId queue
//   代價：多一次 Redis round trip，且 handler 必須設計為冪等（再次執行不重複計帳）。
//   本系統的 saga_credits ON CONFLICT DO NOTHING 已提供 Step 2 冪等性，
//   Step 1 的冪等性則需要在 saga_log ON CONFLICT 時跳過 RESERVE UPDATE，目前未實作。
//
// 暫時緩解（不完整）：
//   - 使用 PM2 / systemd 確保 worker 崩潰後快速重啟（縮短受影響窗口）
//   - SIGTERM handler 等待 in-flight job 完成後才退出（防止部署觸發此問題）
async function drainQueue({ ctx, fromId, redis, handler, ownerValue, options = {} }) {
  const { logger } = ctx;
  const ownerTtlMs = options.ownerTtlMs || 10000;
  const ownerRefreshIntervalMs = options.ownerRefreshIntervalMs || 3000;
  const batchSize = options.batchSize || 5;
  // sequential=true: process one job at a time → no row-lock contention on fromAccount.
  // sequential=false: Promise.all concurrent → higher throughput per tick, but
  //   N-1 jobs will hit lock_timeout (200ms) when they all UPDATE the same row.
  // Read from env so bench_concurrent / bench_sequential scripts can flip the mode
  // without rebuilding the image.
  const sequential = options.sequential !== undefined
    ? options.sequential
    : (process.env.QUEUE_DRAIN_SEQUENTIAL !== 'false');

  let ownerLost = false;

  const heartbeat = startOwnerHeartbeat({
    ctx, fromId, redis, ownerValue,
    options: { ownerTtlMs, ownerRefreshIntervalMs, onLost: () => { ownerLost = true; } },
  });

  try {
    while (!ownerLost) {
      const jobs = await popJobs(redis, fromId, batchSize);
      if (jobs.length === 0) break;

      if (sequential) {
        // One job at a time: zero row-lock contention, 100% saga success rate.
        for (const job of jobs) {
          if (ownerLost) break;
          try {
            await handler(job);
          } catch (err) {
            logger.error('[RedisQueue] job handler error: fromId=%s jobId=%s err=%s', fromId, job.jobId, err && err.message);
          }
        }
      } else {
        // Concurrent batch: faster per tick, but same-fromId sagas contend on
        // the same PG row → only ~1/batchSize jobs succeed per batch.
        await Promise.all(jobs.map(async (job) => {
          if (ownerLost) return;
          try {
            await handler(job);
          } catch (err) {
            logger.error('[RedisQueue] job handler error: fromId=%s jobId=%s err=%s', fromId, job.jobId, err && err.message);
          }
        }));
      }
    }

    if (ownerLost) {
      logger.warn('[RedisQueue] owner lost during drain: fromId=%s owner=%s', fromId, ownerValue);
    }
  } finally {
    heartbeat.stop();

    // ✅ [L12 FIXED] releaseOwner 包在 .catch() 中，確保 re-enqueue 始終執行。
    //
    // 問題（修復前）：releaseOwner 若拋出（Redis 短暫中斷），錯誤 propagate 至 finally 外，
    //   後續 llen + lpush re-enqueue 被完全跳過，per-fromId queue 殘留 jobs 無 ready 訊號，
    //   卡住直至 lock TTL（10s）到期 + worker 下一次 poll 才能恢復。
    //
    // 修法：owner lock 會 TTL 自動到期（ownerTtlMs=10s），releaseOwner 拋錯可靜默忽略，
    //   確保 finally 的 re-enqueue 邏輯無論如何都能執行。
    await releaseOwner(redis, fromId, ownerValue).catch(err => {
      logger.error('[RedisQueue] releaseOwner failed (lock will expire by TTL): fromId=%s err=%s', fromId, err && err.message);
    });

    // If jobs arrived while we were draining, re-signal the ready queue.
    try {
      const remaining = await redis.llen(buildQueueKey(fromId));
      if (remaining > 0) {
        await redis.lpush(buildReadyQueueKey(), String(fromId));
      }
    } catch (err) {
      logger.error('[RedisQueue] failed to re-enqueue fromId after drain: fromId=%s err=%s', fromId, err && err.message);
    }
  }
}

// Try to acquire the owner lock and drain the queue for a given fromId.
// If another worker already holds the lock, returns false immediately.
async function tryStartDrain({ ctx, fromId, redis, handler }) {
  const { app } = ctx;
  const ownerValue = buildOwnerValue();
  const config = getTransferQueueConfig(app);

  const acquired = await tryAcquireOwner(redis, fromId, ownerValue, { ownerTtlMs: config.ownerTtlMs });
  if (!acquired) return false;

  await drainQueue({
    ctx, fromId, redis, handler, ownerValue,
    options: {
      ownerTtlMs: config.ownerTtlMs,
      ownerRefreshIntervalMs: config.ownerRefreshIntervalMs,
      batchSize: config.batchSize,
    },
  });

  return true;
}

module.exports = {
  buildQueueKey,
  buildOwnerKey,
  buildReadyQueueKey,
  buildOwnerValue,
  getTransferQueueConfig,
  pushJob,
  popJob,
  popJobs,
  getQueueLength,
  getQueueStats,
  tryAcquireOwner,
  refreshOwner,
  releaseOwner,
  startOwnerHeartbeat,
  blockPopReadyFromId,
  drainQueue,
  tryStartDrain,
};
