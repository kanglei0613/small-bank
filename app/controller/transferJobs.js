'use strict';

/**
 * @file app/controller/transferJobs.js
 *
 * 轉帳 Job 狀態 HTTP 控制層（TransferJobsController）
 *
 * 路由對應：
 * - GET /transfer-jobs/:jobId        → show()    輪詢查詢 job 狀態（JSON）
 * - GET /transfer-jobs/:jobId/stream → stream()  SSE 即時推送 job 完成通知
 *
 * 職責：解析 jobId，委派 service 層處理查詢或建立 SSE 連線
 */

const Controller = require('egg').Controller;

class TransferJobsController extends Controller {

  // GET /transfer-jobs/:jobId
  async show() {
    const { ctx } = this;

    const result = await ctx.service.transferJobs.getJobById(ctx.params.jobId);

    ctx.body = { ok: true, data: result };
  }

  // GET /transfer-jobs/:jobId/stream
  async stream() {
    const { ctx } = this;

    await ctx.service.transferJobs.streamJobById(ctx.params.jobId);
  }
}

module.exports = TransferJobsController;
