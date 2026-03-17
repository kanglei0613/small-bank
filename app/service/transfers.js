'use strict';

const Service = require('egg').Service;
const AccountsRepo = require('../repository/accountsRepo');
const inflight = require('../lib/inflight');
const redisTransferQueue = require('../lib/redis_transfer_queue');
const transferJobStore = require('../lib/transfer_job_store');

// 驗證 transfer 輸入
//
// 這裡只做最基本的參數檢查：
// - fromId / toId 必須是正整數
// - amount 必須是正整數
// - 不可自己轉給自己
function validateTransferInput({ fromId, toId, amount }) {
  if (!Number.isInteger(fromId) || fromId <= 0) {
    const err = new Error('fromId must be a positive integer');
    err.status = 400;
    throw err;
  }

  if (!Number.isInteger(toId) || toId <= 0) {
    const err = new Error('toId must be a positive integer');
    err.status = 400;
    throw err;
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    const err = new Error('amount must be a positive integer');
    err.status = 400;
    throw err;
  }

  if (fromId === toId) {
    const err = new Error('fromId and toId cannot be the same');
    err.status = 400;
    throw err;
  }
}

class TransferService extends Service {
  // submitTransfer
  //
  // 入口邏輯：
  // - same-shard：直接同步執行，不進 queue
  // - cross-shard：建立 async job，丟進 Redis queue
  async submitTransfer({ fromId, toId, amount }) {
    const { app } = this.ctx;

    validateTransferInput({ fromId, toId, amount });

    const repo = new AccountsRepo(this.ctx);
    const shardCount = Number(app.config.sharding.shardCount);
    const fromShardId = fromId % shardCount;
    const toShardId = toId % shardCount;

    // same-shard：走同步 fast path
    if (fromShardId === toShardId) {
      try {
        await app.redis.incr('bench:transfer:sameShard');

        const result = await repo.transferSameShard({
          fromAccountId: fromId,
          toAccountId: toId,
          transferAmount: amount,
          shardId: fromShardId,
        });

        await app.redis.incr('bench:transfer:success');

        return {
          mode: 'sync-same-shard',
          status: 'completed',
          result,
        };
      } catch (err) {
        await app.redis.incr('bench:transfer:failed');
        throw err;
      }
    }

    // cross-shard：維持 async queue
    await app.redis.incr('bench:transfer:crossShard');

    const queued = await this.enqueueTransfer({ fromId, toId, amount });

    return {
      mode: 'async-cross-shard',
      ...queued,
    };
  }

  // enqueueTransfer
  //
  // 作用：
  // - 建立 transfer job
  // - 寫入 job store
  // - push 進 Redis per-fromId queue
  //
  // 注意：
  // - 這裡不執行 DB transaction
  // - 真正交易由 queue worker 處理
  async enqueueTransfer({ fromId, toId, amount }) {
    const { app } = this.ctx;

    validateTransferInput({ fromId, toId, amount });

    const transferQueueConfig = app.config.transferQueue || {
      rejectThresholdPerFromId: 240,
      maxQueueLengthPerFromId: 300,
    };

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const job = {
      jobId,
      fromId,
      toId,
      amount,
      createdAt: Date.now(),
    };

    await transferJobStore.createJob(app.redis, {
      jobId,
      fromId,
      toId,
      amount,
      status: 'queued',
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
    });

    await redisTransferQueue.pushJob(app.redis, fromId, job, {
      rejectThresholdPerFromId: transferQueueConfig.rejectThresholdPerFromId,
      maxQueueLengthPerFromId: transferQueueConfig.maxQueueLengthPerFromId,
    });

    return {
      jobId,
      status: 'queued',
    };
  }

  // transfer
  //
  // 真正執行 DB transaction 的入口
  //
  // 這裡目前是給 queue worker 處理 cross-shard job 使用，
  // 因此保留 inflight 保護，避免同一 fromId 同時被過多 transfer 併發打爆
  async transfer({ fromId, toId, amount }) {
    const { app, logger } = this.ctx;

    const inflightKey = inflight.transferFromKey(fromId);
    const inflightCount = await app.redis.incr(inflightKey);

    if (inflightCount > inflight.transferMaxInflight()) {
      logger.warn(
        '[Inflight] transfer blocked: fromId=%s inflight=%s',
        fromId,
        inflightCount
      );

      await app.redis.decr(inflightKey);

      const err = new Error('Too many concurrent transfers');
      err.status = 429;
      throw err;
    }

    const repo = new AccountsRepo(this.ctx);

    try {
      return await repo.transfer(fromId, toId, amount);
    } finally {
      await app.redis.decr(inflightKey);
    }
  }

  // processTransferJob
  //
  // 作用：
  // - queue worker 拿到 job 後呼叫
  // - 執行真正 transfer
  // - 更新 job store success / failed
  async processTransferJob(job) {
    const { app, logger } = this.ctx;
    const { jobId, fromId, toId, amount } = job;

    try {
      const result = await this.transfer({ fromId, toId, amount });

      await transferJobStore.markSuccess(app.redis, job, result);
      await app.redis.incr('bench:transfer:success');

      return result;
    } catch (err) {
      await transferJobStore.markFailed(app.redis, job, err);
      await app.redis.incr('bench:transfer:failed');

      logger.error(
        '[TransferJob] failed: jobId=%s fromId=%s toId=%s amount=%s err=%s',
        jobId,
        fromId,
        toId,
        amount,
        err && err.message
      );

      throw err;
    }
  }

  // sleep
  //
  // worker loop 發生 error 時的退避等待
  async sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  // tryDrainOneFromIdQueue
  //
  // 作用：
  // - 嘗試取得該 fromId queue 的 owner lock
  // - 如果成功，drain 該 queue
  // - 如果失敗，表示別的 worker 已在處理
  async tryDrainOneFromIdQueue(fromId) {
    return await redisTransferQueue.tryStartDrain({
      ctx: this.ctx,
      fromId,
      handler: async job => {
        await this.processTransferJob(job);
      },
    });
  }

  // startQueueWorker
  //
  // 新版 worker 模式：
  // - 不再掃 active set
  // - 直接阻塞等待 ready queue
  // - 拿到 fromId 後，嘗試 drain 該 queue
  async startQueueWorker() {
    const { app, logger } = this.ctx;

    const workerConfig = app.config.transferQueue || {};
    const blockTimeoutSec = Number(workerConfig.readyQueueBlockTimeoutSec || 1);
    const errorSleepMs = Number(workerConfig.workerErrorSleepMs || 1000);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const fromId = await redisTransferQueue.blockPopReadyFromId(
          app.redis,
          blockTimeoutSec
        );

        if (!fromId) {
          continue;
        }

        try {
          await this.tryDrainOneFromIdQueue(fromId);
        } catch (err) {
          logger.error(
            '[QueueWorker] drain error: fromId=%s err=%s',
            fromId,
            err && (err.stack || err.message)
          );
        }
      } catch (err) {
        logger.error(
          '[QueueWorker] loop error: %s',
          err && (err.stack || err.message)
        );

        await this.sleep(errorSleepMs);
      }
    }
  }

  // listTransfers
  //
  // 查詢帳戶歷史交易紀錄
  async listTransfers({ accountId, limit }) {
    const aid = Number(accountId);
    const lim = limit === undefined ? 50 : Number(limit);

    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('accountId must be a positive integer');
      err.status = 400;
      throw err;
    }

    if (!Number.isInteger(lim) || lim <= 0) {
      const err = new Error('limit must be a positive integer');
      err.status = 400;
      throw err;
    }

    if (lim > 200) {
      const err = new Error('limit must be <= 200');
      err.status = 400;
      throw err;
    }

    const repo = new AccountsRepo(this.ctx);
    const items = await repo.listTransfersByAccountId(aid, lim);

    return {
      items,
    };
  }
}

module.exports = TransferService;
