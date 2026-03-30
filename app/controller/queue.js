'use strict';

const Controller = require('egg').Controller;

class QueueController extends Controller {

  // GET /queue/stats?fromId=6
  async stats() {
    const { ctx } = this;
    const fromId = Number(ctx.query.fromId);

    if (!Number.isInteger(fromId) || fromId <= 0) {
      ctx.throw(400, 'fromId must be positive integer');
    }

    const data = await ctx.service.queue.getQueueStats(fromId);

    ctx.body = { ok: true, data };
  }

  // GET /queue/global-stats
  async globalStats() {
    const { ctx } = this;

    const data = await ctx.service.queue.getGlobalStats();

    ctx.body = { ok: true, data };
  }
}

module.exports = QueueController;
