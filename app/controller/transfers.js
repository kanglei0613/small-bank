'use strict';

/**
 * @file app/controller/transfers.js
 *
 * 轉帳 HTTP 控制層（TransferController）
 *
 * 路由對應：
 * - POST /transfers           → submit()  發起非同步轉帳，回傳 jobId（202 Accepted）
 * - GET  /transfers?accountId → list()    查詢帳號的轉帳紀錄
 *
 * 職責：解析 HTTP 請求參數，呼叫 service 層，回傳標準 JSON 格式（{ ok, data }）
 */

const Controller = require('egg').Controller;

class TransferController extends Controller {

  // POST /transfers
  async submit() {
    const { ctx } = this;
    const { fromId, toId, amount } = ctx.request.body || {};

    const result = await ctx.service.transfers.submitTransfer({
      fromId: Number(fromId),
      toId: Number(toId),
      amount: Number(amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  // GET /transfers
  async list() {
    const { ctx } = this;

    const result = await ctx.service.transfers.listTransfers({
      accountId: ctx.query.accountId,
      limit: ctx.query.limit,
    });

    ctx.body = { ok: true, data: result };
  }
}

module.exports = TransferController;
