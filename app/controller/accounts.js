'use strict';

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
