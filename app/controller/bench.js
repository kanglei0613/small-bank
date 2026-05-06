'use strict';

/**
 * @file app/controller/bench.js
 *
 * 壓測用 HTTP 控制層（BenchController）
 *
 * 職責：提供各種壓測端點，用於隔離測試不同層的性能（Redis、DB、Queue）
 *
 * 路由對應（均為 POST /bench/...）：
 * - noop              → 空操作，測量純框架 overhead
 * - redis-rpush       → 直接 RPUSH，測量最原始 Redis 寫入速度
 * - redis-set-rpush   → SET + RPUSH，測量帶狀態寫入的 Redis 速度
 * - redis-formal-push → 完整 Lua 腳本 push，含流控邏輯
 * - redis-formal-push-with-job → 完整 push + job 建立
 * - transfers-enqueue-no-log  → 正式轉帳 enqueue，無額外 log
 * - redis-pipeline-push       → Pipeline 批次寫入壓測
 * - db-transfer               → 直接走 DB 轉帳（繞過 queue）
 *
 * 注意：這些端點僅供開發 / 壓測使用，正式環境應關閉或加上 IP 白名單
 */

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
