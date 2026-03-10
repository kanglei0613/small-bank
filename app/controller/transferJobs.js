'use strict';

const Controller = require('egg').Controller;

class TransferJobsController extends Controller {

  // GET /transfer-jobs/:jobId
  //
  // 作用：
  // - 查詢指定 transfer job 的狀態
  // - 提供 client 輪詢使用
  //
  // 可能狀態：
  // - queued
  // - processing
  // - success
  // - failed
  async show() {
    const { ctx } = this;

    try {
      const jobId = ctx.params.jobId;

      const result = await ctx.service.transferJobs.getJobById(jobId);

      ctx.status = 200;
      ctx.body = {
        ok: true,
        data: result,
      };
    } catch (err) {
      ctx.app.logger.error('transferJobs.show error:', err);

      if (err.status) {
        ctx.status = err.status;
        ctx.body = {
          ok: false,
          message: err.message,
        };
        return;
      }

      ctx.status = 500;
      ctx.body = {
        ok: false,
        message: 'internal server error',
      };
    }
  }
}

module.exports = TransferJobsController;
