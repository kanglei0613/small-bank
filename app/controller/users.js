'use strict';

const Controller = require('egg').Controller;
const UsersService = require('../service/users');

class UsersController extends Controller {
  async create() {
    const { ctx } = this;
    try {
      const service = new UsersService(ctx);
      const { name } = ctx.request.body || {};
      const user = await service.createUser({ name });

      ctx.status = 201;
      ctx.body = { ok: true, data: user };
    } catch (err) {
      ctx.status = err.status || 500;
      ctx.body = { ok: false, message: err.message };
    }
  }
  async show() {
    const { ctx } = this;
    try {
      const service = new UsersService(ctx);
      const user = await service.getUserById(ctx.params.id);
      ctx.body = { ok: true, data: user };
    } catch (err) {
      ctx.status = err.status || 500;
      ctx.body = { ok: false, message: err.message };
    }
  }
}

module.exports = UsersController;
