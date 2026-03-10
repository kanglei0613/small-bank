'use strict';

const Controller = require('egg').Controller;

class TransferController extends Controller {

  //
  // POST /transfers
  //
  // 作用：
  // - 接收前端送來的轉帳請求
  // - 解析 fromId / toId / amount
  // - 呼叫 service 層處理
  //
  // 這裡不直接處理 queue 細節，
  // 只把 request 轉交給 service。
  //
  async create() {
    const { ctx } = this;

    // 避免 request body 不存在時直接報錯
    const body = ctx.request.body || {};

    // 從 request body 取出欄位，並轉成 Number
    const fromId = Number(body.fromId);
    const toId = Number(body.toId);
    const amount = Number(body.amount);

    try {
      //
      // 這裡改成呼叫 enqueueTransfer()
      //
      // 原本是直接 transfer()：
      //   ctx.service.transfers.transfer(...)
      //
      // 現在改成：
      //   ctx.service.transfers.enqueueTransfer(...)
      //
      // 差別是：
      // - transfer()：直接執行 DB transaction
      // - enqueueTransfer()：先依 fromId 進 queue，再執行 transfer
      //
      const result = await ctx.service.transfers.enqueueTransfer({
        fromId,
        toId,
        amount,
      });

      // 成功回傳
      ctx.status = 200;
      ctx.body = {
        ok: true,
        data: result,
      };
    } catch (e) {
      // 記錄錯誤 log，方便 debug
      ctx.app.logger.error('transfers.create error:', e);

      //
      // 504 Gateway Timeout
      //
      // 適用情況：
      // - DB lock timeout
      // - statement timeout
      //
      // 這類通常代表：
      // - transaction 等太久
      // - SQL 執行太久
      //
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

      //
      // 503 Service Unavailable
      //
      // 適用情況：
      // - DB 連不上
      // - DB 正在關閉
      // - 連線數已滿
      //
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

      //
      // 已知的業務錯誤
      //
      // 例如：
      // - 400 bad request
      // - 404 account not found
      // - 409 conflict
      // - 429 queue overflow
      //
      // 只要 service / queue 層有設定 e.status，
      // controller 就照著回傳。
      //
      if (e.status) {
        ctx.status = e.status;
        ctx.body = {
          ok: false,
          message: e.message,
        };
        return;
      }

      // 其他未預期錯誤，一律回 500
      ctx.status = 500;
      ctx.body = {
        ok: false,
        message: 'internal server error',
      };
    }
  }

  //
  // GET /transfers
  //
  // 作用：
  // - 查詢交易紀錄列表
  //
  // 這個 API 跟 queue 沒有直接關係，
  // 所以目前先維持原本寫法即可。
  //
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
