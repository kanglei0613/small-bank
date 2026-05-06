'use strict';

/**
 * @file app/controller/queue.js
 *
 * Queue 狀態查詢 HTTP 控制層（QueueController）
 *
 * 路由對應：
 * - GET /queue/stats?fromId=<id>  → stats()       查詢單一 fromId 的 queue 長度、owner lock 狀態
 * - GET /queue/global-stats       → globalStats()  掃描所有 per-fromId queue，回傳整體排隊量與 hot accounts
 *
 * 職責：解析請求參數，委派 QueueService，回傳 JSON 格式統計資料
 */

const Controller = require('egg').Controller;

class QueueController extends Controller {

  // GET /queue/stats?fromId=6
  async stats() {
    const { ctx } = this;
    const fromId = Number(ctx.query.fromId);

    if (!Number.isInteger(fromId) || fromId <= 0) {
      ctx.throw(400, 'fromId must be positive integer');
    }

    const data = await ctx.service.queue.getQueueStats(fromId);

    ctx.body = { ok: true, data };
  }

  // GET /queue/global-stats
  async globalStats() {
    const { ctx } = this;

    const data = await ctx.service.queue.getGlobalStats();

    ctx.body = { ok: true, data };
  }
}

module.exports = QueueController;
