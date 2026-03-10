'use strict';

const Service = require('egg').Service;
const transferJobStore = require('../lib/transfer_job_store');

class TransferJobsService extends Service {

  // getJobById(jobId)
  //
  // 作用：
  // - 根據 jobId 從 Redis 讀取 transfer job 狀態
  // - 回傳 job 的完整資訊
  async getJobById(jobId) {
    const { app } = this.ctx;

    // 檢查 jobId
    if (!jobId || typeof jobId !== 'string') {
      const err = new Error('jobId is required');
      err.status = 400;
      throw err;
    }

    // 從 Redis job store 查詢 job
    const job = await transferJobStore.getJob(app.redis, jobId);

    // 找不到 job
    if (!job) {
      const err = new Error('transfer job not found');
      err.status = 404;
      throw err;
    }

    return job;
  }
}

module.exports = TransferJobsService;
