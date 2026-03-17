'use strict';

const Controller = require('egg').Controller;

class TransferController extends Controller {

  // POST /transfers
  //
  // 作用：
  // - same-shard: 直接同步完成（fast path）
  // - cross-shard: 建立 transfer job，立刻回傳 jobId（slow path）
  async create() {
    const { ctx } = this;

    const body = ctx.request.body || {};

    const fromId = Number(body.fromId);
    const toId = Number(body.toId);
    const amount = Number(body.amount);

    try {
      const result = await ctx.service.transfers.submitTransfer({
        fromId,
        toId,
        amount,
      });

      // same-shard：同步完成
      if (result.mode === 'sync-same-shard') {
        ctx.status = 200;
        ctx.body = {
          ok: true,
          data: {
            mode: 'sync-same-shard',
            status: 'completed',
          },
        };
        return;
      }

      // cross-shard：排入 async queue
      ctx.status = 202;
      ctx.body = {
        ok: true,
        data: result,
      };
    } catch (e) {
      ctx.app.logger.error('transfers.create error:', e);

      // 503 Service Unavailable
      if (
        e.code === 'ECONNREFUSED' ||
        e.code === '57P01' || // admin_shutdown
        e.code === '53300' || // too_many_connections
        e.code === '08000' || // connection_exception
        e.code === '08003' || // connection_does_not_exist
        e.code === '08006' || // connection_failure
        e.code === '57P03' // cannot_connect_now
      ) {
        ctx.status = 503;
        ctx.body = {
          ok: false,
          message: 'service temporarily unavailable',
        };
        return;
      }

      // 已知業務錯誤
      if (e.status) {
        ctx.status = e.status;
        ctx.body = {
          ok: false,
          message: e.message,
        };
        return;
      }

      // 其他未預期錯誤
      ctx.status = 500;
      ctx.body = {
        ok: false,
        message: e.message,
        stack: e.stack,
      };
    }
  }

  // GET /transfers
  //
  // 作用：
  // - 查詢歷史交易紀錄
  // - 與 Async Job API 的 job 狀態查詢不同
  async list() {
    const { ctx } = this;

    try {
      const result = await ctx.service.transfers.listTransfers({
        accountId: ctx.query.accountId,
        limit: ctx.query.limit,
        before: ctx.query.before,
      });

      ctx.status = 200;
      ctx.body = {
        ok: true,
        data: result,
      };
    } catch (e) {
      ctx.app.logger.error('transfers.list error:', e);

      // 503 Service Unavailable
      if (
        e.code === 'ECONNREFUSED' ||
        e.code === '57P01' ||
        e.code === '53300' ||
        e.code === '08000' ||
        e.code === '08003' ||
        e.code === '08006' ||
        e.code === '57P03'
      ) {
        ctx.status = 503;
        ctx.body = {
          ok: false,
          message: 'service temporarily unavailable',
        };
        return;
      }

      // 已知業務錯誤
      if (e.status) {
        ctx.status = e.status;
        ctx.body = {
          ok: false,
          message: e.message,
        };
        return;
      }

      // 其他未預期錯誤
      ctx.status = 500;
      ctx.body = {
        ok: false,
        message: 'internal server error',
      };
    }
  }
}

module.exports = TransferController;
