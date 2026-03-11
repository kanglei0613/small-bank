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

      await Promise.all([
        this.ctx.service.accounts.invalidateAccountCache(fromId),
        this.ctx.service.accounts.invalidateAccountCache(toId),
      ]);

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
  // - 更新 job 狀態
  // - 執行真正的 transfer
  //
  async processTransferJob(job) {
    const { app, logger } = this.ctx;
    const { jobId, fromId, toId, amount } = job;

    try {

      await transferJobStore.markProcessing(app.redis, jobId);

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
