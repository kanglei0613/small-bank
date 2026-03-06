'use strict';

const Controller = require('egg').Controller;
const AccountsService = require('../service/accounts');

class AccountsController extends Controller {

  // POST /accounts 建立帳戶
  async create() {
    const { ctx } = this;

    try {
      // 建立service
      const service = new AccountsService(ctx);

      // 取得request body
      const { userId, initialBalance } = ctx.request.body || {};

      // 呼叫service建立帳戶
      const account = await service.openAccount({
        userId,
        initialBalance,
      });

      // 回傳成功結果
      ctx.status = 201;
      ctx.body = {
        ok: true,
        data: account,
      };

    } catch (err) {
      // 錯誤處理
      ctx.status = err.status || 500;
      ctx.body = {
        ok: false,
        message: err.message,
      };
    }
  }

  // GET /accounts/:id 查詢帳戶
  async show() {
    const { ctx } = this;

    try {
      // 建立service
      const service = new AccountsService(ctx);

      // 查詢帳戶
      const account = await service.getAccountById(ctx.params.id);

      // 回傳成功結果
      ctx.status = 200;
      ctx.body = {
        ok: true,
        data: account,
      };

    } catch (err) {
      // 錯誤處理
      ctx.status = err.status || 500;
      ctx.body = {
        ok: false,
        message: err.message,
      };
    }
  }
}

module.exports = AccountsController;
