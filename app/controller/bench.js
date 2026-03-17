'use strict';

const Controller = require('egg').Controller;

class BenchController extends Controller {
  async noop() {
    const { ctx } = this;
    ctx.status = 200;
    ctx.body = {
      ok: true,
      data: {
        mode: 'noop',
        now: Date.now(),
      },
    };
  }

  async redisRpush() {
    const { ctx } = this;
    const body = ctx.request.body || {};
    const result = await ctx.service.bench.redisRpush({
      fromId: Number(body.fromId),
      toId: Number(body.toId),
      amount: Number(body.amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async redisSetRpush() {
    const { ctx } = this;
    const body = ctx.request.body || {};
    const result = await ctx.service.bench.redisSetRpush({
      fromId: Number(body.fromId),
      toId: Number(body.toId),
      amount: Number(body.amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async redisFormalPush() {
    const { ctx } = this;
    const body = ctx.request.body || {};
    const result = await ctx.service.bench.redisFormalPush({
      fromId: Number(body.fromId),
      toId: Number(body.toId),
      amount: Number(body.amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async redisFormalPushWithJob() {
    const { ctx } = this;
    const body = ctx.request.body || {};
    const result = await ctx.service.bench.redisFormalPushWithJob({
      fromId: Number(body.fromId),
      toId: Number(body.toId),
      amount: Number(body.amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async transfersEnqueueNoLog() {
    const { ctx } = this;
    const body = ctx.request.body || {};
    const result = await ctx.service.bench.transfersEnqueueNoLog({
      fromId: Number(body.fromId),
      toId: Number(body.toId),
      amount: Number(body.amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async redisPipelinePush() {
    const { ctx } = this;
    const body = ctx.request.body || {};
    const result = await ctx.service.bench.redisPipelinePush({
      fromId: Number(body.fromId),
      toId: Number(body.toId),
      amount: Number(body.amount),
    });

    ctx.status = 202;
    ctx.body = { ok: true, data: result };
  }

  async dbTransfer() {
    const { ctx } = this;
    const body = ctx.request.body || {};

    try {
      const result = await ctx.service.bench.dbTransfer({
        fromId: Number(body.fromId),
        toId: Number(body.toId),
        amount: Number(body.amount),
      });

      ctx.status = 200;
      ctx.body = { ok: true, data: result };
    } catch (err) {
      if (err.status) {
        ctx.status = err.status;
        ctx.body = {
          ok: false,
          message: err.message,
        };
        return;
      }

      ctx.status = 500;
      ctx.body = {
        ok: false,
        message: 'internal server error',
      };
    }
  }
}

module.exports = BenchController;
