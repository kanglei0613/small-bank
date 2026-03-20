'use strict';

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
