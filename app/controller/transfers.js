'use strict';

const Controller = require('egg').Controller;

class TransferController extends Controller {

  // POST /transfers
  async create() {
    const { ctx } = this;

    const fromId = Number(ctx.request.body.fromId);
    const toId = Number(ctx.request.body.toId);
    const amount = Number(ctx.request.body.amount);

    try {
      const result = await ctx.service.transfers.transfer({
        fromId,
        toId,
        amount,
      });

      ctx.status = 200;
      ctx.body = {
        ok: true,
        data: result,
      };
    } catch (e) {
      ctx.status = e.status || 500;
      ctx.body = {
        ok: false,
        message: e.message,
      };
    }
  }

  // GET /transfers
  async list() {
    const { ctx } = this;

    try {
      const result = await ctx.service.transfers.listTransfers({
        accountId: ctx.query.accountId,
        limit: ctx.query.limit,
      });

      ctx.status = 200;
      ctx.body = {
        ok: true,
        data: result,
      };
    } catch (e) {
      ctx.status = e.status || 500;
      ctx.body = {
        ok: false,
        message: e.message,
      };
    }
  }
}

module.exports = TransferController;
