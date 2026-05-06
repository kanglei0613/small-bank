'use strict';

/**
 * @file app/controller/home.js
 *
 * 首頁 / Redis 連線測試控制層（HomeController）
 *
 * 路由對應：
 * - GET / → index()  寫入並讀取 Redis test key，驗證 Redis 連線是否正常
 *
 * 注意：此端點僅供開發期間快速驗證 Redis 連線狀態使用
 */

const Controller = require('egg').Controller;

class HomeController extends Controller {
  async index() {
    const { app, ctx } = this;

    await app.redis.set('test:redis', 'ok', 'EX', 60);
    const value = await app.redis.get('test:redis');

    ctx.body = {
      message: 'redis test success',
      value,
    };
  }
}

module.exports = HomeController;
