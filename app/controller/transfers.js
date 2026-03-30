'use strict';

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
