'use strict';

const Controller = require('egg').Controller;

class UsersController extends Controller {

  // POST /users
  async create() {
    const { ctx } = this;
    const { name } = ctx.request.body || {};

    const user = await ctx.service.users.createUser({ name });

    ctx.status = 201;
    ctx.body = { ok: true, data: user };
  }

  // GET /users/:id
  async show() {
    const { ctx } = this;

    const user = await ctx.service.users.getUserById(ctx.params.id);

    ctx.body = { ok: true, data: user };
  }
}

module.exports = UsersController;
