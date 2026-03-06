'use strict';

const Service = require('egg').Service;
const AccountsRepo = require('../repository/accountsRepo');

class TransferService extends Service {

  // 執行轉帳
  async transfer({ fromId, toId, amount }) {
    // 建立 repository
    const repo = new AccountsRepo(this.ctx);

    // 呼叫 repository 執行轉帳 transaction
    const result = await repo.transfer(fromId, toId, amount);

    return result;
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
