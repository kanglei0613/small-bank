'use strict';

/**
 * @file app/service/transfers.js
 *
 * 轉帳業務邏輯層（TransferService）
 *
 * ════════════════════════════════════════════════════════════════
 * 職責與路由決策
 * ════════════════════════════════════════════════════════════════
 *
 * 主要方法：
 *   submitTransfer          — 驗證輸入，路由到同步 CTE 或非同步 queue
 *   _enqueueTransfer        — 建立 jobId，寫入 Redis job store，push 進 per-fromId queue
 *   processJob              — 執行單筆 transfer job，更新 Redis 狀態並 publish SSE 通知
 *   tryDrainOneFromIdQueue  — 嘗試取得 owner lock 並 drain 一個 fromId 的 queue
 *   startQueueWorker        — 啟動無限 BRPOP 迴圈，持續消費 ready queue（Egg scheduler 用）
 *
 * 路由決策（Routing Decision）：
 *   fromId % shardCount === toId % shardCount
 *     → 同 shard：直接呼叫 repo.transferSameShard()，單一 CTE 同步完成，回傳 COMPLETED
 *   否則
 *     → 跨 shard：呼叫 _enqueueTransfer()，寫入 Redis queue，回傳 jobId + status=queued
 *        由 queue worker 非同步以 Saga 模式執行（RESERVE → CREDIT → FINALIZE）
 *
 * 前端模式判斷（Client-side mode detection）：
 *   API response 包含 mode: 'sync' | 'async' 欄位，前端可依此決定是否輪詢。
 *   ⚠️ 前端不應自行以 fromId%4===toId%4 判斷 mode（leaky abstraction），
 *      應以 API response 的 mode 欄位為準。
 *
 * ════════════════════════════════════════════════════════════════
 * ⚠️  架構審查標注（Architecture Review Annotations）2026-05
 * ════════════════════════════════════════════════════════════════
 *
 * [NOT PRODUCTION-READY] 以下已知問題需在 production 部署前修補：
 *
 * 1. processJob 無分類重試（No categorized retry — Risk: HIGH）
 *    - 所有錯誤（包含 DB 暫時斷線、lock timeout）都呼叫 markFailed，job 永久消失。
 *    - 問題：PG error 55P03（lock_not_available）是暫時性錯誤，不應永久失敗。
 *    - 修法：依錯誤類型分類：
 *        ConflictError / NotFoundError → permanent fail（業務邏輯錯誤，markFailed 正確）
 *        PG 55P03 / connection timeout  → transient，retry with exponential backoff（max 3 次）
 *        超過 N 次 retry 後             → 推入 DLQ（Dead Letter Queue）供人工審查
 *
 * 2. startQueueWorker 共用單一 Redis 連線（Connection sharing — Risk: MEDIUM）
 *    - 此方法建立一個 `redis` 連線，同時用於：
 *        (a) blockPopReadyFromId：BRPOP 阻塞命令，佔住連線直到有資料
 *        (b) tryDrainOneFromIdQueue：drain 期間的 popJobs / markSuccess / owner lock 操作
 *    - BRPOP await 返回後，drain 以 fire-and-forget 啟動，loop 立刻執行下一次 BRPOP。
 *      此時 drain 的非同步操作仍在 in-flight，兩者共享同一條 Redis 連線，
 *      ioredis 將指令串行排隊（pipelining），使 BRPOP 等待前面所有 drain 指令完成。
 *    - 正確做法（參考 scripts/worker/queue_worker.js）：
 *        每個 BRPOP loop 使用獨立的 brpopRedis 連線；
 *        所有 drain 操作共用一個 drainRedis 連線；
 *        啟動 CONCURRENCY 個獨立 loop，每個 loop 一條 brpopRedis 連線。
 *
 * 3. _enqueueTransfer 無 idempotency key（No idempotency support — Risk: HIGH）
 *    - 每次呼叫都產生新的 jobId（timestamp + random），客戶端網路重試建立重複 job → 重複扣款。
 *    - 修法：接受 X-Idempotency-Key header，以 (userId + idempotencyKey) 在 Redis 查重，
 *      相同 key 直接回傳原有 jobId 而非建立新 job。
 *
 * 4. Routing logic duplication（submitTransfer 與 repo.transfer() 都計算 shard — Risk: LOW）
 *    - submitTransfer 計算 fromShardId/toShardId 決定 sync/async；
 *      repo.transfer() 內部也重複計算相同 shardId。
 *    - 若 shardCount 或路由邏輯改變，需同步修改兩處。
 *    - 修法：將 shard 路由邏輯集中在 ShardRouter utility class，兩處共用。
 *
 * 5. startQueueWorker fire-and-forget drain（Observability gap — Risk: LOW）
 *    - drain 以 fire-and-forget 啟動（.catch() 只 log error），
 *      drain 的執行時間、成功/失敗率無法被上層監控。
 *    - 修法：emit metrics（Prometheus counter/histogram）供 SRE 監控 drain 效能。
 */

const Redis = require('ioredis');
const Service = require('egg').Service;
const TransfersRepo = require('../repository/transfersRepo');
const redisTransferQueue = require('../lib/queue/redis_transfer_queue');
const transferJobStore = require('../lib/queue/transfer_job_store');
const { BadRequestError } = require('../lib/errors');
const { logger } = require('../lib/logger');

/**
 * 產生唯一的 jobId：timestamp + 隨機字串，保證在同一毫秒內不重複
 * @returns {string}
 */
function buildJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 驗證轉帳輸入參數，不合法時拋出 BadRequestError
 * @param {{ fromId: number, toId: number, amount: number }} params
 */
function validateTransferInput({ fromId, toId, amount }) {
  if (!Number.isInteger(fromId) || fromId <= 0) {
    throw new BadRequestError('fromId must be a positive integer');
  }
  if (!Number.isInteger(toId) || toId <= 0) {
    throw new BadRequestError('toId must be a positive integer');
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new BadRequestError('amount must be a positive integer');
  }
  if (fromId === toId) {
    throw new BadRequestError('fromId and toId cannot be the same');
  }
}

class TransferService extends Service {

  constructor(ctx) {
    super(ctx);
    this.repo = new TransfersRepo(ctx);
  }

  // Decide between synchronous same-shard transfer and async cross-shard queue.
  async submitTransfer({ fromId, toId, amount }) {
    validateTransferInput({ fromId, toId, amount });

    const { app } = this.ctx;
    const requestId = this.ctx.requestId;
    const shardCount = Number(app.config.sharding.shardCount);
    const fromShardId = fromId % shardCount;
    const toShardId = toId % shardCount;
    const mode = fromShardId === toShardId ? 'sync' : 'async';

    const start = Date.now();

    try {
      if (fromShardId === toShardId) {
        const result = await this.repo.transferSameShard({
          fromAccountId: fromId,
          toAccountId: toId,
          transferAmount: amount,
          shardId: fromShardId,
        });
        return { mode: 'sync', ...result };
      }

      const queued = await this._enqueueTransfer({ fromId, toId, amount });
      return { mode: 'async', ...queued };
    } catch (err) {
      const duration = Date.now() - start;
      logger.error('[submitTransfer] error', {
        requestId,
        fromId,
        toId,
        amount,
        mode,
        fromShardId,
        toShardId,
        durationMs: duration,
        errCode: err.status || err.code,
        errMessage: err.message,
        stack: err.stack,
      });
      throw err;
    }
  }

  // Enqueue a cross-shard transfer job and return the jobId immediately.
  async _enqueueTransfer({ fromId, toId, amount }) {
    const { app } = this.ctx;
    const queueConfig = app.config.transferQueue || {
      rejectThresholdPerFromId: 240,
      maxQueueLengthPerFromId: 300,
    };

    const jobId = buildJobId();
    const now = Date.now();

    await transferJobStore.createJob(app.redis, {
      jobId,
      fromId,
      toId,
      amount,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    await redisTransferQueue.pushJob(
      app.redis,
      fromId,
      { jobId, fromId, toId, amount, createdAt: now },
      {
        rejectThresholdPerFromId: queueConfig.rejectThresholdPerFromId,
        maxQueueLengthPerFromId: queueConfig.maxQueueLengthPerFromId,
      }
    );

    return { jobId, status: 'queued' };
  }

  // ⚠️ [NOT PRODUCTION-READY] processJob 無分類重試（No categorized retry）
  // 所有錯誤一律 markFailed，包含暫時性錯誤（lock timeout, network blip）。
  // Production 應區分：
  //   ConflictError / NotFoundError → permanent fail, mark failed immediately
  //   PG 55P03 (lock_not_available) / connection timeout → transient, retry with backoff (max 3 attempts)
  //   After N retries → move to DLQ (dead letter queue) for manual review
  async processJob(job, redis) {
    const { logger } = this.ctx;
    const { jobId, fromId, toId, amount } = job;
    const start = Date.now();
    const queueWaitMs = start - (job.createdAt || start);

    logger.info('[TransferJob] queue wait: jobId=%s fromId=%s queueWaitMs=%d', jobId, fromId, queueWaitMs);

    try {
      const result = await this.repo.transfer(fromId, toId, amount);
      const duration = Date.now() - start;

      logger.info('[TransferJob] success: jobId=%s fromId=%s toId=%s duration=%dms', jobId, fromId, toId, duration);

      await transferJobStore.markSuccess(redis, job, result);
      await redis.incr('bench:transfer:success');

      return result;
    } catch (err) {
      const duration = Date.now() - start;

      logger.error('[TransferJob] failed: jobId=%s fromId=%s toId=%s duration=%dms err=%s', jobId, fromId, toId, duration, err && err.message);

      await transferJobStore.markFailed(redis, job, err);
      await redis.incr('bench:transfer:failed');

      throw err;
    }
  }

  async tryDrainOneFromIdQueue(fromId, redis) {
    return await redisTransferQueue.tryStartDrain({
      ctx: this.ctx,
      fromId,
      redis,
      handler: async job => {
        await this.processJob(job, redis);
      },
    });
  }

  // ⚠️ [NOT PRODUCTION-READY] startQueueWorker 使用單一 Redis 連線（Single connection shared by BRPOP + drain）
  //
  // 問題描述：
  //   此方法建立一個 `redis` 連線，同時用於：
  //   1. `blockPopReadyFromId`：BRPOP 阻塞命令，佔住連線直到有資料
  //   2. `tryDrainOneFromIdQueue`：drain 時的 popJobs / markSuccess / owner lock 操作
  //
  //   BRPOP 是 await 的（阻塞直到返回），返回後才 fire-and-forget drain。
  //   但 loop 立刻執行下一次 BRPOP，此時 drain 的非同步操作可能仍在 in-flight 中，
  //   兩者共享同一條 Redis 連線，指令會被 ioredis 串行排隊（pipelining），
  //   使得 BRPOP 等待前面所有 drain 指令完成。
  //
  // 影響：單一 Redis 連線成為 throughput bottleneck，並行 drain 能力受限。
  //
  // 正確做法（參考 scripts/worker/queue_worker.js）：
  //   每個 BRPOP loop 使用獨立的 brpopRedis 連線；
  //   所有 drain 操作共用一個 drainRedis 連線；
  //   啟動 CONCURRENCY 個獨立 loop（每個 loop 一條 brpopRedis 連線）。
  async startQueueWorker() {
    const { app, logger } = this.ctx;
    const workerConfig = app.config.transferQueue || {};
    const blockTimeoutSec = workerConfig.readyQueueBlockTimeoutSec ?? 1;
    const errorSleepMs = Number(workerConfig.workerErrorSleepMs || 1000);

    const redisConfig = app.config.redis && app.config.redis.client
      ? app.config.redis.client
      : { host: '127.0.0.1', port: 6379, db: 0 };

    const redis = new Redis({
      host: redisConfig.host || '127.0.0.1',
      port: redisConfig.port || 6379,
      password: redisConfig.password || undefined,
      db: redisConfig.db || 0,
    });

    redis.on('error', err => {
      logger.error('[QueueWorker] redis error: %s', err && err.message);
    });

    logger.info('[QueueWorker] direct redis connected');

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const fromId = await redisTransferQueue.blockPopReadyFromId(redis, blockTimeoutSec);
        if (!fromId) continue;

        // Fire-and-forget: let the loop immediately pick up the next fromId
        // ⚠️ drain 和下一次 BRPOP 共用同一條 redis 連線，見上方說明
        this.tryDrainOneFromIdQueue(fromId, redis).catch(err => {
          logger.error('[QueueWorker] drain error: fromId=%s err=%s', fromId, err && (err.stack || err.message));
        });
      } catch (err) {
        logger.error('[QueueWorker] loop error: %s', err && (err.stack || err.message));
        await new Promise(resolve => setTimeout(resolve, errorSleepMs));
      }
    }
  }

  async listTransfers({ accountId, limit }) {
    const aid = Number(accountId);
    const lim = limit === undefined ? 50 : Number(limit);

    if (!Number.isInteger(aid) || aid <= 0) {
      throw new BadRequestError('accountId must be a positive integer');
    }
    if (!Number.isInteger(lim) || lim <= 0) {
      throw new BadRequestError('limit must be a positive integer');
    }
    if (lim > 200) {
      throw new BadRequestError('limit must be <= 200');
    }

    const items = await this.repo.listByAccountId(aid, lim);
    return { items };
  }
}

module.exports = TransferService;
