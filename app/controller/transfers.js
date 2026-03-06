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
      ctx.app.logger.error('transfers.create error:', e);

      // 504 Gateway Timeout
      if (
        e.message &&
        (
          e.message.includes('lock timeout') ||
          e.message.includes('statement timeout') ||
          e.message.includes('canceling statement due to lock timeout') ||
          e.message.includes('canceling statement due to statement timeout')
        )
      ) {
        ctx.status = 504;
        ctx.body = {
          ok: false,
          message: 'request timeout',
        };
        return;
      }

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

      // 400 / 404 / 409 等已定義錯誤
      if (e.status) {
        ctx.status = e.status;
        ctx.body = {
          ok: false,
          message: e.message,
        };
        return;
      }

      // 500 Internal Server Error
      ctx.status = 500;
      ctx.body = {
        ok: false,
        message: 'internal server error',
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
        before: ctx.query.before,
      });

      ctx.status = 200;
      ctx.body = {
        ok: true,
        data: result,
      };
    } catch (e) {
      ctx.app.logger.error('transfers.list error:', e);

      // 504 Gateway Timeout
      if (
        e.message &&
        (
          e.message.includes('lock timeout') ||
          e.message.includes('statement timeout') ||
          e.message.includes('canceling statement due to lock timeout') ||
          e.message.includes('canceling statement due to statement timeout')
        )
      ) {
        ctx.status = 504;
        ctx.body = {
          ok: false,
          message: 'request timeout',
        };
        return;
      }

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

      // 400 / 404 / 409 等已定義錯誤
      if (e.status) {
        ctx.status = e.status;
        ctx.body = {
          ok: false,
          message: e.message,
        };
        return;
      }

      // 500 Internal Server Error
      ctx.status = 500;
      ctx.body = {
        ok: false,
        message: 'internal server error',
      };
    }
  }
}

module.exports = TransferController;
