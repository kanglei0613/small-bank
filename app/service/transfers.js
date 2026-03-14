'use strict';

const Service = require('egg').Service;
const AccountsRepo = require('../repository/accountsRepo');
const inflight = require('../lib/inflight');
const redisTransferQueue = require('../lib/redis_transfer_queue');
const transferJobStore = require('../lib/transfer_job_store');

class TransferService extends Service {

  //
  // enqueueTransfer({ fromId, toId, amount })
  //
  // 作用：
  // - Async Job API 的入口
  // - 驗證輸入
  // - 建立 transfer job
  // - 寫入 job store
  // - 丟進 Redis per-fromId queue
  // - 立刻回傳 jobId
  //
  // 注意：
  // - 這裡不直接執行 DB transaction
  // - 真正的轉帳會由背景 queue worker 負責 drain
  //
  async enqueueTransfer({ fromId, toId, amount }) {
    const { app, logger } = this.ctx;

    // 讀取 transfer queue config
    const transferQueueConfig = app.config.transferQueue || {
      rejectThresholdPerFromId: 240,
      maxQueueLengthPerFromId: 300,
    };

    // 基本檢查：fromId 必須是正整數
    if (!Number.isInteger(fromId) || fromId <= 0) {
      const err = new Error('fromId must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 基本檢查：toId 必須是正整數
    if (!Number.isInteger(toId) || toId <= 0) {
      const err = new Error('toId must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 基本檢查：amount 必須是正整數
    if (!Number.isInteger(amount) || amount <= 0) {
      const err = new Error('amount must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 基本檢查：不可自己轉給自己
    if (fromId === toId) {
      const err = new Error('fromId and toId cannot be the same');
      err.status = 400;
      throw err;
    }

    // 建立 jobId
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // 建立 job payload
    const job = {
      jobId,
      fromId,
      toId,
      amount,
      createdAt: Date.now(),
    };

    // 寫入 job store
    await transferJobStore.createJob(app.redis, {
      jobId,
      fromId,
      toId,
      amount,
      status: 'queued',
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      result: null,
      error: null,
    });

    // queue key
    const queueKey = redisTransferQueue.buildQueueKey(fromId);

    logger.info(
      '[TransferJob] enqueue: jobId=%s queueKey=%s fromId=%s toId=%s amount=%s',
      jobId,
      queueKey,
      fromId,
      toId,
      amount
    );

    // push job 進 Redis queue（含 admission control）
    await redisTransferQueue.pushJob(app.redis, fromId, job, {
      rejectThresholdPerFromId: transferQueueConfig.rejectThresholdPerFromId,
      maxQueueLengthPerFromId: transferQueueConfig.maxQueueLengthPerFromId,
    });

    // Async Job API 回傳
    return {
      jobId,
      status: 'queued',
    };
  }

  //
  // transfer({ fromId, toId, amount })
  //
  // 真正執行 DB transaction
  //
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
      const result = await repo.transfer(fromId, toId, amount);

      // 轉帳成功後刪除 account cache
      // cache 清理失敗不能影響已經成功的 DB transaction
      const cacheResults = await Promise.allSettled([
        this.ctx.service.accounts.invalidateAccountCache(fromId),
        this.ctx.service.accounts.invalidateAccountCache(toId),
      ]);

      for (const item of cacheResults) {
        if (item.status === 'rejected') {
          logger.error('[Redis] invalidate account cache error: %s', item.reason && item.reason.message);
        }
      }

      return result;
    } finally {
      await app.redis.decr(inflightKey);
    }
  }

  //
  // processTransferJob
  //
  // 作用：
  // - Queue worker 呼叫
  // - 執行真正的 transfer
  // - 更新 job 狀態
  //
  async processTransferJob(job) {
    const { app, logger } = this.ctx;
    const { jobId, fromId, toId, amount } = job;

    try {
      logger.info(
        '[TransferJob] processing: jobId=%s fromId=%s toId=%s amount=%s',
        jobId,
        fromId,
        toId,
        amount
      );

      const result = await this.transfer({ fromId, toId, amount });

      await transferJobStore.markSuccess(app.redis, jobId, result);

      logger.info(
        '[TransferJob] success: jobId=%s fromId=%s toId=%s amount=%s',
        jobId,
        fromId,
        toId,
        amount
      );

      return result;

    } catch (err) {

      await transferJobStore.markFailed(app.redis, jobId, err);

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

  //
  // sleep(ms)
  //
  // Queue worker 背景 loop 的簡單等待工具
  //
  async sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  //
  // listActiveFromIds()
  //
  // 作用：
  // - 從 Redis active queue set 讀出目前待處理的 fromId
  // - 不再掃描整個 Redis keyspace
  //
  async listActiveFromIds() {
    const { app } = this.ctx;

    return await redisTransferQueue.getActiveFromIds(app.redis);
  }

  //
  // tryDrainOneFromIdQueue(fromId)
  //
  // 作用：
  // - 嘗試取得該 fromId queue 的 owner lock
  // - 若成功，開始 drain queue
  // - 若失敗，表示已有其他 worker 正在處理
  //
  async tryDrainOneFromIdQueue(fromId) {
    const { logger } = this.ctx;

    const drained = await redisTransferQueue.tryStartDrain({
      ctx: this.ctx,
      fromId,
      handler: async job => {
        await this.processTransferJob(job);
      },
    });

    if (drained) {
      logger.info(
        '[QueueWorker] drain finished: fromId=%s',
        fromId
      );
    }

    return drained;
  }

  //
  // startQueueWorker()
  //
  // 作用：
  // - queue role 啟動後進入背景 loop
  // - 持續讀取 active queue set
  // - 對每個 fromId 嘗試取得 owner 並 drain
  //
  // 注意：
  // - 同一個 fromId 只會有一個 owner
  // - 多個 queue worker process 可以同時存在
  // - owner lock 會保證同一條 queue 不會被多個 process 同時 drain
  //
  async startQueueWorker() {
    const { app, logger } = this.ctx;

    const workerConfig = app.config.transferQueue || {};
    const idleSleepMs = Number(workerConfig.workerIdleSleepMs || 200);
    const errorSleepMs = Number(workerConfig.workerErrorSleepMs || 1000);

    logger.info(
      '[QueueWorker] started: pid=%s idleSleepMs=%s errorSleepMs=%s',
      process.pid,
      idleSleepMs,
      errorSleepMs
    );

    // 背景 loop
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const fromIds = await this.listActiveFromIds();

        if (fromIds.length === 0) {
          await this.sleep(idleSleepMs);
          continue;
        }

        logger.info(
          '[QueueWorker] active queues found: count=%s fromIds=%j',
          fromIds.length,
          fromIds
        );

        for (const fromId of fromIds) {
          try {
            await this.tryDrainOneFromIdQueue(fromId);
          } catch (err) {
            logger.error(
              '[QueueWorker] drain error: fromId=%s err=%s',
              fromId,
              err && (err.stack || err.message)
            );
          }
        }

        // 避免空轉過快
        await this.sleep(idleSleepMs);

      } catch (err) {
        logger.error(
          '[QueueWorker] loop error: %s',
          err && (err.stack || err.message)
        );

        await this.sleep(errorSleepMs);
      }
    }
  }

  //
  // listTransfers
  //
  // 查詢某個帳戶的交易紀錄
  //
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
