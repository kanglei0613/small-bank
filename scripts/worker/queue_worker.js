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
  host:                    process.env.PG_HOST     || '127.0.0.1',
  port:                    parseInt(process.env.PG_PORT || '5432'),
  user:                    process.env.PG_USER     || 'kanglei0613',
  password:                process.env.PG_PASSWORD || '',
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 5000,
  statement_timeout:       5000,
};

function createMetaPool() {
  return new Pool({ ...pgBase, database: process.env.PG_META_DB || 'small_bank_meta', max: PG_META_POOL_MAX });
}

function createShardPgMap() {
  const shardDbs = {
    0: process.env.PG_SHARD_0_DB || 'small_bank_s0',
    1: process.env.PG_SHARD_1_DB || 'small_bank_s1',
    2: process.env.PG_SHARD_2_DB || 'small_bank_s2',
    3: process.env.PG_SHARD_3_DB || 'small_bank_s3',
  };

  const map = {};
  for (const [id, database] of Object.entries(shardDbs)) {
    map[id] = new Pool({ ...pgBase, database, max: PG_SHARD_POOL_MAX });
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
// 注意：
//   只有 WORKER_INDEX=1 的 worker 執行掃描，避免多個 worker 同時重複推入。

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
