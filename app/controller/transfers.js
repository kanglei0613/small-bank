'use strict';

const Controller = require('egg').Controller;

class TransferController extends Controller {
  async index() {
    const { ctx } = this;

    // 支援 JSON body
    const fromId = Number(ctx.request.body.fromId);
    const toId = Number(ctx.request.body.toId);
    const amount = Number(ctx.request.body.amount);

    try {
      const result = await ctx.service.transfers.transfer({ fromId, toId, amount });
      ctx.body = result;
    } catch (e) {
      ctx.status = e.status || 500;
      ctx.body = { ok: false, message: e.message };
    }
  }
}

module.exports = TransferController;
