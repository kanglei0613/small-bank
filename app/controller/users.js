'use strict';

const Controller = require('egg').Controller;
const UsersService = require('../service/users');

class UsersController extends Controller {

  // POST /users 建立使用者
  async create() {
    const { ctx } = this;

    try {
      const service = new UsersService(ctx);

      const { name } = ctx.request.body || {};

      const user = await service.createUser({ name });

      ctx.status = 201;
      ctx.body = {
        ok: true,
        data: user,
      };

    } catch (err) {
      ctx.status = err.status || 500;
      ctx.body = {
        ok: false,
        message: err.message,
      };
    }
  }

  // GET /users/:id 查詢使用者 + 帳戶列表
  async show() {
    const { ctx } = this;

    try {
      const service = new UsersService(ctx);

      const user = await service.getUserById(ctx.params.id);

      ctx.status = 200;
      ctx.body = {
        ok: true,
        data: user,
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

module.exports = UsersController;
