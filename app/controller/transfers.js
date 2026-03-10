'use strict';

const Controller = require('egg').Controller;

class TransferController extends Controller {

  // POST /transfers
  //
  // 作用：
  // - 接收轉帳請求
  // - 建立 transfer job
  // - 立刻回傳 jobId
  //
  // 注意：
  // - 這裡不會直接回傳最終 transfer 結果
  // - client 需要再呼叫 GET /transfer-jobs/:jobId 查詢狀態
  async create() {
    const { ctx } = this;

    // 避免 request body 不存在時直接報錯
    const body = ctx.request.body || {};

    // 從 request body 取出欄位，並轉成 Number
    const fromId = Number(body.fromId);
    const toId = Number(body.toId);
    const amount = Number(body.amount);

    try {
      // 建立 transfer job
      const result = await ctx.service.transfers.enqueueTransfer({
        fromId,
        toId,
        amount,
      });

      // Async Job API：建立成功後回傳 jobId
      ctx.status = 202;
      ctx.body = {
        ok: true,
        data: result,
      };
    } catch (e) {
      // 記錄錯誤 log，方便 debug
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
        message: 'internal server error',
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
