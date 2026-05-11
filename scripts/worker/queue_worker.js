'use strict';

/**
 * scripts/worker/queue_worker.js
 *
 * 獨立 Node.js process，不受 egg 管控。
 * 使用 BRPOP block-timeout=0，消除 1 秒空窗期。
 *
 * 啟動方式（由 stack_control.sh 呼叫）：
 *   node scripts/worker/queue_worker.js
 *
 * 環境變數（與 egg worker 相同）：
 *   QUEUE_CONCURRENCY
 *   PG_META_POOL_MAX
 *   PG_SHARD_POOL_MAX
 *   TRANSFER_QUEUE_OWNER_TTL_MS
 *   TRANSFER_QUEUE_OWNER_REFRESH_MS
 *   TRANSFER_QUEUE_BATCH_SIZE
 *   WORKER_INDEX  (由 stack_control.sh 注入，用於 log 識別)
 *
 * 連線設計：
 *   - 每個 concurrency loop 有自己專屬的 brpopRedis 連線
 *     → brpop 是阻塞命令，同一條連線同時只能跑一個，多個 loop 共用會互相排隊
 *   - drain（執行 job）共用一個 drainRedis 連線
 *     → drain 是在 brpop 返回後才執行，不會有衝突
 *
 * ════════════════════════════════════════════════════════════════
 * ⚠️  架構審查標注（Architecture Review Annotations）2026-05
 * ════════════════════════════════════════════════════════════════
 *
 * [NOT PRODUCTION-READY] 以下已知問題需在 production 部署前修補：
 *
 * 1. drainQueue 使用 Promise.all 批次並行（Batch parallelism breaks per-fromId ordering）
 *    - redis_transfer_queue.drainQueue 對每批 batchSize 個 job 用 Promise.all 並行執行，
 *      破壞 per-fromId 序列化保證。
 *    - 影響：同一 fromId 的多筆跨 shard 轉帳在同一批次中並行執行 RESERVE，
 *      競爭同一個 row lock，200ms lock_timeout 下大量 lock timeout 503。
 *    - 修法：在 redis_transfer_queue.drainQueue 中改為 `for...await` 依序執行，
 *      或在 batchSize 中只取 1（犧牲吞吐量換正確性）。
 *    - Risk level: CRITICAL — 序列化保證完全失效。
 *
 * 2. Owner heartbeat 第一次 tick 延遲過久（First heartbeat too late）
 *    - startOwnerHeartbeat 的第一次 tick 在 ownerTtlMs（預設 10s）後才執行，
 *      而非 ownerRefreshIntervalMs（預設 3s）後。
 *    - 如果一批 job 的 drain 時間 >= ownerTtlMs，lock 會在第一次 heartbeat 前過期。
 *    - 修法：將 `setTimeout(initTimer, ownerTtlMs)` 改為 `setTimeout(initTimer, ownerRefreshIntervalMs)`。
 *    - Risk level: CRITICAL — drain 超過 10s 時 owner lock 失效，兩個 worker 同時 drain 同一 fromId。
 *
 * 3. recoverStaleQueues 依賴 WORKER_INDEX=1（Single-worker recovery assumption）
 *    - 若 WORKER_INDEX 環境變數未設為 '1'，重啟後殘留 queue 不會被恢復。
 *    - stack_control.sh 應確保至少一個 worker 以 WORKER_INDEX=1 啟動。
 *    - 修法：改用分散式 lock（Redis SET NX）決定哪個 worker 執行 recovery，
 *      而非依賴靜態環境變數。
 *    - Risk level: MEDIUM — 重啟後殘留 jobs 永久卡住，直到手動干預。
 *
 * 4. 無 graceful shutdown（No SIGTERM handler）
 *    - Worker 被 SIGTERM 終止時，可能正在執行 Saga Step 2 或 Step 3。
 *    - 雖然 recovery_worker 會處理未完成的 saga，但有 STALE_THRESHOLD 延遲。
 *    - 修法：監聽 SIGTERM，設定 isShuttingDown flag，等待 in-flight jobs 完成後退出。
 *    - Risk level: MEDIUM — graceful shutdown 缺失，降低 recovery 效率。
 *
 * 5. 硬碼預設使用者名稱（Hardcoded default PG username）
 *    - pgBase.user 預設為 'kanglei0613'（開發者本機帳號）。
 *    - Production 必須透過 PG_USER 環境變數覆蓋，否則連線失敗。
 *    - Risk level: LOW — 設定問題，無安全漏洞（PG_USER 需在部署時設定）。
 */

const { Pool } = require('pg');
const Redis = require('ioredis');

// ─── lib（路徑相對 project root）────────────────────────────────────────────
const redisTransferQueue = require('../../app/lib/queue/redis_transfer_queue');
const transferJobStore   = require('../../app/lib/queue/transfer_job_store');
const TransfersRepo      = require('../../app/repository/transfersRepo');

// ─── Config ─────────────────────────────────────────────────────────────────

const CONCURRENCY       = parseInt(process.env.QUEUE_CONCURRENCY || '8');
const PG_META_POOL_MAX  = parseInt(process.env.PG_META_POOL_MAX  || '2');
const PG_SHARD_POOL_MAX = parseInt(process.env.PG_SHARD_POOL_MAX || '5');
const WORKER_INDEX      = process.env.WORKER_INDEX || '?';

const SHARD_COUNT = 4;

const OWNER_TTL_MS      = parseInt(process.env.TRANSFER_QUEUE_OWNER_TTL_MS      || '10000');
const OWNER_REFRESH_MS  = parseInt(process.env.TRANSFER_QUEUE_OWNER_REFRESH_MS  || '3000');
const BATCH_SIZE        = parseInt(process.env.TRANSFER_QUEUE_BATCH_SIZE        || '50');
const ERROR_SLEEP_MS    = 1000;

// ─── Logger ──────────────────────────────────────────────────────────────────

const logger = {
  info:  (...a) => console.log ('[QueueWorker]', `[w${WORKER_INDEX}]`, ...a),
  error: (...a) => console.error('[QueueWorker]', `[w${WORKER_INDEX}]`, ...a),
  warn:  (...a) => console.warn ('[QueueWorker]', `[w${WORKER_INDEX}]`, ...a),
};

// ─── Redis ───────────────────────────────────────────────────────────────────

function createRedis(label) {
  const r = new Redis({
    host:     process.env.REDIS_HOST || '127.0.0.1',
    port:     parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    db:       parseInt(process.env.REDIS_DB || '0'),
  });
  r.on('error', err => logger.error(`redis[${label}] error:`, err && err.message));
  return r;
}

// ─── PostgreSQL pools ────────────────────────────────────────────────────────

const pgBase = {
  // PG_HOST is used for single-host setups (e.g. local dev where all shards
  // are on the same PostgreSQL instance). In Docker / multi-host setups,
  // PG_SHARD_N_HOST overrides this per shard.
  host:                    process.env.PG_HOST     || '127.0.0.1',
  port:                    parseInt(process.env.PG_PORT || '5432'),
  user:                    process.env.PG_USER     || 'kanglei0613',
  password:                process.env.PG_PASSWORD || '',
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 5000,
  statement_timeout:       5000,
};

function createMetaPool() {
  const metaHost = process.env.PG_META_HOST || pgBase.host;
  return new Pool({ ...pgBase, host: metaHost, database: process.env.PG_META_DB || 'small_bank_meta', max: PG_META_POOL_MAX });
}

function createShardPgMap() {
  const shardDbs = {
    0: process.env.PG_SHARD_0_DB || 'small_bank_s0',
    1: process.env.PG_SHARD_1_DB || 'small_bank_s1',
    2: process.env.PG_SHARD_2_DB || 'small_bank_s2',
    3: process.env.PG_SHARD_3_DB || 'small_bank_s3',
  };
  const shardHosts = {
    0: process.env.PG_SHARD_0_HOST || pgBase.host,
    1: process.env.PG_SHARD_1_HOST || pgBase.host,
    2: process.env.PG_SHARD_2_HOST || pgBase.host,
    3: process.env.PG_SHARD_3_HOST || pgBase.host,
  };

  const map = {};
  for (const [id, database] of Object.entries(shardDbs)) {
    map[id] = new Pool({ ...pgBase, host: shardHosts[id], database, max: PG_SHARD_POOL_MAX });
  }
  return map;
}

// ─── 假的 ctx ────────────────────────────────────────────────────────────────

function buildFakeCtx({ metaPg, shardPgMap, redis }) {
  const app = {
    metaPg,
    shardPgMap,
    redis,
    config: {
      sharding: { shardCount: SHARD_COUNT },
      transferQueue: {
        ownerTtlMs:             OWNER_TTL_MS,
        ownerRefreshIntervalMs: OWNER_REFRESH_MS,
        batchSize:              BATCH_SIZE,
      },
    },
  };

  return { app, logger };
}

// ─── processJob ──────────────────────────────────────────────────────────────

// ⚠️ [NOT PRODUCTION-READY] 無分類重試（No categorized error retry）
// 所有錯誤（包含 DB 暫時斷線、55P03 lock timeout）都呼叫 markFailed，job 永久消失。
// Production 應區分：
//   ConflictError / NotFoundError → permanent fail (user error)
//   PG error code 55P03 / connection error → transient, retry up to 3 times with jitter
//   After N retries → push to DLQ (e.g., transfer:dlq Redis list)
async function processJob(job, repo, redis) {
  const { jobId, fromId, toId, amount } = job;
  const start = Date.now();
  const queueWaitMs = start - (job.createdAt || start);

  logger.info('queue wait: jobId=%s fromId=%s queueWaitMs=%dms', jobId, fromId, queueWaitMs);

  try {
    const result = await repo.transfer(fromId, toId, amount);
    const duration = Date.now() - start;

    logger.info('success: jobId=%s fromId=%s toId=%s duration=%dms', jobId, fromId, toId, duration);

    await transferJobStore.markSuccess(redis, job, result);
    await redis.incr('bench:transfer:success');

    return result;
  } catch (err) {
    const duration = Date.now() - start;

    logger.error('failed: jobId=%s fromId=%s toId=%s duration=%dms err=%s',
      jobId, fromId, toId, duration, err && err.message);

    await transferJobStore.markFailed(redis, job, err);
    await redis.incr('bench:transfer:failed');

    throw err;
  }
}

// ─── drain ───────────────────────────────────────────────────────────────────

async function tryDrainOneFromIdQueue(fromId, repo, drainRedis, ctx) {
  return await redisTransferQueue.tryStartDrain({
    ctx,
    fromId,
    redis: drainRedis,
    handler: async job => {
      await processJob(job, repo, drainRedis);
    },
  });
}

// ─── 單一 BRPOP loop ──────────────────────────────────────────────────────────
//
// 每個 loop 有自己專屬的 brpopRedis：
//   brpop 是阻塞命令，佔住整條連線直到有資料。
//   多個 loop 共用同一條連線時，只有第一個 brpop 能真正阻塞，
//   其他的全部排隊等待，等同於只有 1 個 loop 在工作。
//   所以每個 loop 必須有自己的連線。
//
// drainRedis 共用是安全的：
//   drain 是在 brpop 返回後才執行，不會有連線衝突。

async function runLoop(loopIndex, repo, drainRedis, brpopRedis, ctx) {
  logger.info('loop %d started (block-timeout=0)', loopIndex);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fromId = await redisTransferQueue.blockPopReadyFromId(brpopRedis, 0);

      if (!fromId) continue;

      // 不 await，讓 loop 立刻取下一個 fromId
      tryDrainOneFromIdQueue(fromId, repo, drainRedis, ctx).catch(err => {
        logger.error('drain error: fromId=%s err=%s', fromId, err && (err.stack || err.message));
      });
    } catch (err) {
      logger.error('loop %d error: %s', loopIndex, err && (err.stack || err.message));
      await new Promise(r => setTimeout(r, ERROR_SLEEP_MS));
    }
  }
}

// ─── 啟動時掃描殘留 job ───────────────────────────────────────────────────────
//
// 問題背景：
//   pushJob 的 Lua script 只在「queue 從空變非空（newLength == 1）」時
//   才把 fromId push 進 ready queue。
//   如果 worker 重啟前 queue 裡已有積壓 job，重啟後 ready queue 是空的，
//   worker 永遠不會取到這些殘留 job。
//
// 解法：
//   worker 啟動時掃描所有 transfer:queue:from:* 的 key，
//   對每個有 job 的 fromId，把它推進 ready queue，讓 worker loop 可以處理。
//
// ⚠️ [NOT PRODUCTION-READY] WORKER_INDEX=1 是靜態假設（Static single-worker assumption）
//   只有 WORKER_INDEX='1' 的 worker 執行掃描，避免多個 worker 同時重複推入。
//   問題：若 WORKER_INDEX 未設定（預設 '?'），此函數永遠 skip，重啟後積壓 job 永久卡住。
//   改進方向：以 Redis SET NX 搶分散式 lock，第一個搶到的 worker 執行掃描，
//   與 WORKER_INDEX 無關，適合多機水平擴展場景。

async function recoverStaleQueues(redis) {
  if (String(WORKER_INDEX) !== '1') {
    logger.info('recoverStaleQueues: skip (not worker 1)');
    return;
  }

  logger.info('recoverStaleQueues: scanning for stale fromId queues...');

  const readyQueueKey = redisTransferQueue.buildReadyQueueKey();
  let cursor = '0';
  let recovered = 0;

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'transfer:queue:from:*', 'COUNT', 100);
    cursor = nextCursor;

    for (const key of keys) {
      const len = await redis.llen(key);
      if (len > 0) {
        const fromId = key.replace('transfer:queue:from:', '');
        await redis.lpush(readyQueueKey, fromId);
        logger.info('recoverStaleQueues: re-enqueued fromId=%s (queueLen=%d)', fromId, len);
        recovered++;
      }
    }
  } while (cursor !== '0');

  logger.info('recoverStaleQueues: done, recovered=%d fromIds', recovered);
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  logger.info('starting: concurrency=%d', CONCURRENCY);

  const metaPg     = createMetaPool();
  const shardPgMap = createShardPgMap();

  // drainRedis：執行 job、markSuccess/markFailed、owner lock，所有 loop 共用
  const drainRedis = createRedis('drain');

  const ctx  = buildFakeCtx({ metaPg, shardPgMap, redis: drainRedis });
  const repo = new TransfersRepo(ctx);

  // 啟動時掃描殘留 job，避免重啟後積壓 job 永遠卡住
  await recoverStaleQueues(drainRedis);

  const loops = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    // 每個 loop 專屬的 brpop 連線，避免阻塞命令互相排隊
    const brpopRedis = createRedis(`brpop-${i}`);
    loops.push(runLoop(i, repo, drainRedis, brpopRedis, ctx));
  }

  await Promise.all(loops);
}

main().catch(err => {
  console.error('[QueueWorker] fatal:', err);
  process.exit(1);
});
