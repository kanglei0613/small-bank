'use strict';

const Controller = require('egg').Controller;
const AccountsService = require('../service/accounts');

class AccountsController extends Controller {

  // POST /accounts
  async create() {
    const { ctx } = this;

    try {
      const service = new AccountsService(ctx);

      const { userId, initialBalance } = ctx.request.body || {};

      const account = await service.openAccount({
        userId,
        initialBalance,
      });

      ctx.status = 201;
      ctx.body = {
        ok: true,
        data: account,
      };

    } catch (err) {
      ctx.status = err.status || 500;
      ctx.body = {
        ok: false,
        message: err.message,
      };
    }
  }

  // GET /accounts/:id
  async show() {
    const { ctx } = this;

    try {
      const service = new AccountsService(ctx);

      const account = await service.getAccountById(ctx.params.id);

      ctx.body = {
        ok: true,
        data: account,
      };

    } catch (err) {
      ctx.status = err.status || 500;
      ctx.body = {
        ok: false,
        message: err.message,
      };
    }
  }
}

module.exports = AccountsController;
