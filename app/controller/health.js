'use strict';

/**
 * @file app/controller/health.js
 *
 * 健康檢查 HTTP 控制層（HealthController）
 *
 * 路由對應：
 * - GET /health → index()  回傳 { ok: true, ts } 供 load balancer / Docker healthcheck 使用
 */

const Controller = require('egg').Controller;

class HealthController extends Controller {
  async index() {
    this.ctx.body = { ok: true, ts: Date.now() };
  }
}

module.exports = HealthController;
