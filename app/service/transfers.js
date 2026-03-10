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
  // - 嘗試啟動 queue drain
  // - 立刻回傳 jobId
  //
  // 注意：
  // - 這裡不直接執行 DB transaction
  // - 真正的轉帳會在背景 drain / worker 流程中執行
  //
  async enqueueTransfer({ fromId, toId, amount }) {
    const { app, logger } = this.ctx;

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
    // 這裡先用時間戳 + 隨機字串組成簡單唯一值
    // 如果你之後想更正式，也可以改成 uuid
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // 建立 job payload
    const job = {
      jobId,
      fromId,
      toId,
      amount,
      createdAt: Date.now(),
    };

    // 先把 job metadata 寫進 job store
    // 初始狀態設為 queued
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

    // 用 fromId 產生 Redis queue key
    // 例如 fromId=6 -> transfer:queue:from:6
    const queueKey = redisTransferQueue.buildQueueKey(fromId);

    logger.info(
      '[TransferJob] enqueue: jobId=%s queueKey=%s fromId=%s toId=%s amount=%s',
      jobId,
      queueKey,
      fromId,
      toId,
      amount
    );

    // 將 job push 進 Redis queue
    await redisTransferQueue.pushJob(app.redis, fromId, job);

    // 嘗試啟動這個 fromId 的 drain 流程
    // 這裡不 await，避免 request 被 drain 卡住
    redisTransferQueue.tryStartDrain({
      ctx: this.ctx,
      fromId,
      handler: async jobItem => {
        return await this.processTransferJob(jobItem);
      },
    }).catch(err => {
      logger.error(
        '[TransferJob] tryStartDrain error: fromId=%s jobId=%s err=%s',
        fromId,
        jobId,
        err && err.message
      );
    });

    // Async Job API：立刻回 jobId
    return {
      jobId,
      status: 'queued',
    };
  }

  //
  // transfer({ fromId, toId, amount })
  //
  // 作用：
  // - 真正執行單筆轉帳邏輯
  // - 這裡不負責建立 job，也不負責排隊
  // - 它只專心做「真正的轉帳」
  //
  // 流程：
  // 1. 檢查 inflight protection
  // 2. 建立 accounts repository
  // 3. 呼叫 repository 執行 PostgreSQL transaction
  // 4. transaction 成功後，刪除轉出與轉入帳戶的 Redis cache
  // 5. request / worker 結束後，減少 inflight counter
  //
  async transfer({ fromId, toId, amount }) {
    const { app, logger } = this.ctx;

    // 產生 inflight counter 的 Redis key
    // 例如 fromId=6 -> inflight:transfer:from:6
    const inflightKey = inflight.transferFromKey(fromId);

    // 使用 Redis INCR 統計目前同時處理中的 transfer 數量
    const inflightCount = await app.redis.incr(inflightKey);

    // 如果超過 inflight 上限，直接拒絕
    if (inflightCount > inflight.transferMaxInflight()) {
      logger.warn(
        '[Inflight] transfer blocked: fromId=%s inflight=%s',
        fromId,
        inflightCount
      );

      // 因為這筆 request / job 沒有真的進 transaction，所以先減回去
      await app.redis.decr(inflightKey);

      const err = new Error('Too many concurrent transfers');
      err.status = 429;
      throw err;
    }

    // 建立 repository
    const repo = new AccountsRepo(this.ctx);

    try {
      // 執行真正的 PostgreSQL transaction
      const result = await repo.transfer(fromId, toId, amount);

      // transaction 成功後，刪除相關帳戶 cache
      // 避免後續查詢拿到舊資料
      await Promise.all([
        this.ctx.service.accounts.invalidateAccountCache(fromId),
        this.ctx.service.accounts.invalidateAccountCache(toId),
      ]);

      return result;
    } finally {
      // 不論成功或失敗，都要把 inflight counter 減回去
      await app.redis.decr(inflightKey);
    }
  }

  //
  // processTransferJob(job)
  //
  // 作用：
  // - 提供給 queue drain / worker 呼叫
  // - 負責更新 job 狀態
  // - 執行真正的 transfer()
  // - 將結果或錯誤回寫到 job store
  //
  async processTransferJob(job) {
    const { app, logger } = this.ctx;
    const { jobId, fromId, toId, amount } = job;

    try {
      // job 進入 processing 狀態
      await transferJobStore.markProcessing(app.redis, jobId);

      logger.info(
        '[TransferJob] processing: jobId=%s fromId=%s toId=%s amount=%s',
        jobId,
        fromId,
        toId,
        amount
      );

      // 執行真正轉帳
      const result = await this.transfer({ fromId, toId, amount });

      // 成功後更新 job 狀態
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
      // 失敗後更新 job 狀態
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
  // listTransfers({ accountId, limit })
  //
  // 作用：
  // - 查詢某個帳戶的交易紀錄
  //
  // 這個功能和 Async Job API queue 無關，維持原本邏輯即可
  //
  async listTransfers({ accountId, limit }) {
    const aid = Number(accountId);
    const lim = limit === undefined ? 50 : Number(limit);

    // 檢查 accountId
    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('accountId must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 檢查 limit
    if (!Number.isInteger(lim) || lim <= 0) {
      const err = new Error('limit must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 限制最大筆數，避免一次查太多
    if (lim > 200) {
      const err = new Error('limit must be <= 200');
      err.status = 400;
      throw err;
    }

    // 建立 repository
    const repo = new AccountsRepo(this.ctx);

    // 查詢交易紀錄
    const items = await repo.listTransfersByAccountId(aid, lim);

    return {
      items,
    };
  }
}

module.exports = TransferService;
