'use strict';

const Controller = require('egg').Controller;
const UsersService = require('../service/users');

// UsersController 負責處理與使用者相關的 HTTP 請求
class UsersController extends Controller {
  // POST /users
  async create() {
    const { ctx } = this;
    try {
      // 建立service
      const service = new UsersService(ctx);
      // 從request body取得name參數
      const { name } = ctx.request.body || {};
      // 呼叫service的createUser方法建立使用者
      const user = await service.createUser({ name });

      // 回傳成功結果
      ctx.status = 201;
      ctx.body = { ok: true, data: user };
    } catch (err) {
      // 發生錯誤時, 回傳錯誤訊息
      ctx.status = err.status || 500;
      ctx.body = { ok: false, message: err.message };
    }
  }

  // GET /users/:id
  async show() {
    const { ctx } = this;
    try {
      const service = ctx.service.users;
      const user = await service.getUserById(ctx.params.id);

      ctx.status = 200;
      ctx.body = { ok: true, data: user };
    } catch (err) {
      ctx.status = err.status || 500;
      ctx.body = { ok: false, message: err.message };
    }
  }
}

// 匯出UsersController給路由使用
module.exports = UsersController;
