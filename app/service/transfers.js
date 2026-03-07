'use strict';

const Service = require('egg').Service;
const AccountsRepo = require('../repository/accountsRepo');
const rateLimit = require('../lib/rateLimit');
const inflight = require('../lib/inflight');

class TransferService extends Service {

  // 執行轉帳
  // 流程：
  // 1. 檢查 transfer rate limit
  // 2. 檢查 transfer inflight protection
  // 3. 建立 accounts repository
  // 4. 呼叫 repository 執行 PostgreSQL transaction
  // 5. transaction 成功後，刪除轉出與轉入帳戶的 Redis cache
  // 6. request 結束後，減少 inflight counter
  async transfer({ fromId, toId, amount }) {

    const { app, logger } = this.ctx;

    // 產生 transfer rate limit 的 Redis key
    // 例如 fromId=6 -> ratelimit:transfer:from:6
    const rateKey = rateLimit.transferFromKey(fromId);

    // 使用 Redis INCR 來統計當前時間窗內的請求次數
    // 每次 transfer 請求都會讓這個 key 的數值 +1
    const count = await app.redis.incr(rateKey);

    // 如果這是第一次請求（count === 1）
    // 就設定 TTL，代表這個計數只會維持在指定時間窗內
    // 例如 window = 1 秒
    if (count === 1) {
      await app.redis.expire(rateKey, rateLimit.transferWindowSeconds());
    }

    // 檢查是否超過 rate limit 上限
    // 例如設定為每秒最多 20 次 transfer
    if (count > rateLimit.transferMaxRequests()) {
      logger.warn('[RateLimit] transfer blocked: fromId=%s count=%s', fromId, count);

      const err = new Error('Too many transfer requests');
      err.status = 429;
      throw err;
    }

    // 產生 transfer inflight counter 的 Redis key
    // 例如 fromId=6 -> inflight:transfer:from:6
    const inflightKey = inflight.transferFromKey(fromId);

    // 使用 Redis INCR 來統計目前同時處理中的 transfer 數量
    // 每個進來的 transfer request 都會先讓 inflight counter +1
    const inflightCount = await app.redis.incr(inflightKey);

    // 檢查是否超過 inflight 上限
    // 例如設定為同一個 fromId 最多只能有 10 個 transfer 同時處理中
    if (inflightCount > inflight.transferMaxInflight()) {
      logger.warn('[Inflight] transfer blocked: fromId=%s inflight=%s', fromId, inflightCount);

      // 因為這個 request 沒有真的進入 transaction
      // 所以要先把剛剛 +1 的 inflight counter 減回來
      await app.redis.decr(inflightKey);

      const err = new Error('Too many concurrent transfers');
      err.status = 429;
      throw err;
    }

    // 建立 repository
    const repo = new AccountsRepo(this.ctx);

    try {
      // 呼叫 repository 執行轉帳 transaction
      // 如果這一步失敗，會直接丟錯，不會往下刪 cache
      const result = await repo.transfer(fromId, toId, amount);

      // transaction 成功後，刪除相關 account cache
      // 這樣下次查詢帳戶時，才會重新從 DB 取得最新資料
      await Promise.all([
        this.ctx.service.accounts.invalidateAccountCache(fromId),
        this.ctx.service.accounts.invalidateAccountCache(toId),
      ]);

      return result;
    } finally {
      // 不管 transaction 成功或失敗
      // request 結束時都要把 inflight counter 減少
      // 避免 inflight 計數卡住
      await app.redis.decr(inflightKey);
    }
  }

  // 查詢交易紀錄
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

    // 呼叫 repository 查詢交易紀錄
    const items = await repo.listTransfersByAccountId(aid, lim);

    return {
      items,
    };
  }
}

module.exports = TransferService;
