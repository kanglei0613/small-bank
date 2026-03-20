'use strict';

const Controller = require('egg').Controller;

class BenchController extends Controller {

  async noop() {
    const { ctx } = this;
    ctx.body = { ok: true, data: { mode: 'noop', now: Date.now() } };
  }

  async redisRpush() {
    const { ctx } = this;
    const { fromId, toId, amount } = ctx.request.body || {};

    const result = await ctx.service.bench.redisRpush({
      fromId: Number(fromId),
      toId: Number(toId),
      amount: Number(amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async redisSetRpush() {
    const { ctx } = this;
    const { fromId, toId, amount } = ctx.request.body || {};

    const result = await ctx.service.bench.redisSetRpush({
      fromId: Number(fromId),
      toId: Number(toId),
      amount: Number(amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async redisFormalPush() {
    const { ctx } = this;
    const { fromId, toId, amount } = ctx.request.body || {};

    const result = await ctx.service.bench.redisFormalPush({
      fromId: Number(fromId),
      toId: Number(toId),
      amount: Number(amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async redisFormalPushWithJob() {
    const { ctx } = this;
    const { fromId, toId, amount } = ctx.request.body || {};

    const result = await ctx.service.bench.redisFormalPushWithJob({
      fromId: Number(fromId),
      toId: Number(toId),
      amount: Number(amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async transfersEnqueueNoLog() {
    const { ctx } = this;
    const { fromId, toId, amount } = ctx.request.body || {};

    const result = await ctx.service.bench.transfersEnqueueNoLog({
      fromId: Number(fromId),
      toId: Number(toId),
      amount: Number(amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async redisPipelinePush() {
    const { ctx } = this;
    const { fromId, toId, amount } = ctx.request.body || {};

    const result = await ctx.service.bench.redisPipelinePush({
      fromId: Number(fromId),
      toId: Number(toId),
      amount: Number(amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async dbTransfer() {
    const { ctx } = this;
    const { fromId, toId, amount } = ctx.request.body || {};

    const result = await ctx.service.bench.dbTransfer({
      fromId: Number(fromId),
      toId: Number(toId),
      amount: Number(amount),
    });

    ctx.body = { ok: true, data: result };
  }
}

module.exports = BenchController;
