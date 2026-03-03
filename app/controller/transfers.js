'use strict';

const Controller = require('egg').Controller;
const TransfersService = require('../service/transfers');

class TransfersController extends Controller {
  async create() {
    const { ctx } = this;
    try {
      const service = new TransfersService(ctx);
      const { fromAccountId, toAccountId, amount } = ctx.request.body || {};
      const result = await service.transfer({ fromAccountId, toAccountId, amount });
      ctx.status = 201;
      ctx.body = { ok: true, data: result };
    } catch (err) {
      ctx.status = err.status || 500;
      ctx.body = { ok: false, message: err.message };
    }
  }
}

module.exports = TransfersController;
