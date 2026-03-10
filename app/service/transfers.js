'use strict';

const Service = require('egg').Service;
const AccountsRepo = require('../repository/accountsRepo');
const inflight = require('../lib/inflight');
const transferQueueManager = require('../lib/transfer_queue_manager');

class TransferService extends Service {

  //
  // enqueueTransfer({ fromId, toId, amount })
  //
  // 作用：
  // - 作為 queue 的入口
  // - 根據 fromId 產生 queue key
  // - 同一個 fromId 的 transfer 會依序排隊
  // - 不同 fromId 的 transfer 可以並行
  //
  // 流程：
  // 1. 驗證基本輸入
  // 2. 依 fromId 產生 queue key
  // 3. 丟進 queue
  // 4. queue 內再真正執行 transfer()
  //
  async enqueueTransfer({ fromId, toId, amount }) {
    const { logger } = this.ctx;

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

    // 用 fromId 產生 queue key
    // 例如 fromId=6 -> transfer:from:6
    const queueKey = transferQueueManager.buildTransferFromKey(fromId);

    logger.info(
      '[Queue] enqueue transfer: key=%s fromId=%s toId=%s amount=%s currentQueueLen=%s',
      queueKey,
      fromId,
      toId,
      amount,
      transferQueueManager.getQueueLength(queueKey)
    );

    // 丟進 queue，等輪到這筆 job 時再執行真正 transfer
    return await transferQueueManager.enqueue(
      queueKey,
      async payload => {
        return await this.transfer(payload);
      },
      { fromId, toId, amount }
    );
  }

  //
  // transfer({ fromId, toId, amount })
  //
  // 作用：
  // - 真正執行單筆轉帳邏輯
  // - 這裡不負責排隊，排隊由 enqueueTransfer() 處理
  //
  // 流程：
  // 1. 檢查 inflight protection
  // 2. 建立 accounts repository
  // 3. 呼叫 repository 執行 PostgreSQL transaction
  // 4. transaction 成功後，刪除轉出與轉入帳戶的 Redis cache
  // 5. request 結束後，減少 inflight counter
  //
  async transfer({ fromId, toId, amount }) {
    const { app, logger } = this.ctx;

    //
    // 這裡保留 inflight protection
    //
    // 原因：
    // - queue 解的是「同一個 fromId 的排隊問題」
    // - inflight 解的是「正在處理中的數量上限」
    //
    // 在目前這版裡：
    // - 同一 fromId 基本上會被 queue 串行
    // - inflight 還是可當作保護機制保留
    //
    // 但因為已經有 queue，這層壓力通常會比之前小很多
    //

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

      // 因為這筆 request 沒有真的進 transaction，所以先減回去
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
  // listTransfers({ accountId, limit })
  //
  // 作用：
  // - 查詢某個帳戶的交易紀錄
  //
  // 這個功能和 queue 無關，維持原本邏輯即可
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
