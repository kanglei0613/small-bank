'use strict';

/**
 * @file app/controller/users.js
 *
 * 用戶 HTTP 控制層（UsersController）
 *
 * 路由對應：
 * - POST /users    → create()  新增用戶
 * - GET  /users/:id → show()   查詢用戶資料
 *
 * 職責：解析 HTTP 請求參數，呼叫 service 層，回傳標準 JSON 格式（{ ok, data }）
 */

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
