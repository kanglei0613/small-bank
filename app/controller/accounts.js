'use strict';

/**
 * @file app/controller/accounts.js
 *
 * 帳號 HTTP 控制層（AccountsController）
 *
 * 路由對應：
 * - POST /accounts            → create()   開戶
 * - POST /accounts/:id/deposit → deposit()  存款
 * - POST /accounts/:id/withdraw → withdraw() 提款
 * - GET  /accounts/:id        → show()     查詢帳號餘額
 *
 * 職責：解析 HTTP 請求參數，呼叫 service 層，回傳標準 JSON 格式（{ ok, data }）
 */

const Controller = require('egg').Controller;

class AccountsController extends Controller {

  // POST /accounts
  async create() {
    const { ctx } = this;
    const { userId, initialBalance } = ctx.request.body || {};

    const account = await ctx.service.accounts.openAccount({ userId, initialBalance });

    ctx.status = 201;
    ctx.body = { ok: true, data: account };
  }

  // POST /accounts/:id/deposit
  async deposit() {
    const { ctx } = this;
    const { amount } = ctx.request.body || {};

    const result = await ctx.service.accounts.deposit({
      accountId: ctx.params.id,
      amount,
    });

    ctx.body = { ok: true, data: result };
  }

  // POST /accounts/:id/withdraw
  async withdraw() {
    const { ctx } = this;
    const { amount } = ctx.request.body || {};

    const result = await ctx.service.accounts.withdraw({
      accountId: ctx.params.id,
      amount,
    });

    ctx.body = { ok: true, data: result };
  }

  // GET /accounts/:id
  async show() {
    const { ctx } = this;

    const account = await ctx.service.accounts.getAccountById(ctx.params.id);

    ctx.body = { ok: true, data: account };
  }
}

module.exports = AccountsController;
