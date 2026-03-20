'use strict';

const { PassThrough } = require('stream');
const Service = require('egg').Service;
const transferJobStore = require('../lib/queue/transfer_job_store');
const { BadRequestError, NotFoundError } = require('../lib/errors');

class TransferJobsService extends Service {

  // getJobById(jobId)
  //
  // 作用：
  // - 根據 jobId 從 Redis 讀取 transfer job 狀態
  // - 回傳 job 的完整資訊
  async getJobById(jobId) {
    const { app } = this.ctx;

    if (!jobId || typeof jobId !== 'string') {
      throw new BadRequestError('jobId is required');
    }

    const redis = app.redisDb || app.redis;
    const job = await transferJobStore.getJob(redis, jobId);

    if (!job) {
      throw new NotFoundError('transfer job not found');
    }

    return job;
  }

  // streamJobById(jobId)
  //
  // 作用：
  // - 若 job 已完成，直接回傳 JSON，不建立 SSE 連線
  // - 若 job 尚未完成，建立 SSE 連線，透過 Redis Pub/Sub 等待完成通知
  // - 完成後立即推送給前端並關閉連線
  //
  // 注意：
  // - 訂閱後需再查一次 job 狀態，避免訂閱前 job 剛好完成導致漏掉通知
  // - 前端斷線時需清理 listener 和 subscription，避免 memory leak
  async streamJobById(jobId) {
    const { app, ctx } = this;

    if (!jobId || typeof jobId !== 'string') {
      throw new BadRequestError('jobId is required');
    }

    const redis = app.redisDb || app.redis;
    const job = await transferJobStore.getJob(redis, jobId);

    if (!job) {
      throw new NotFoundError('transfer job not found');
    }

    // job 已完成，直接回傳，不需要 SSE
    if (job.status === 'success' || job.status === 'failed') {
      ctx.body = { ok: true, data: job };
      return;
    }

    // 設定 SSE headers
    ctx.set('Content-Type', 'text/event-stream');
    ctx.set('Cache-Control', 'no-cache');
    ctx.set('Connection', 'keep-alive');
    ctx.set('X-Accel-Buffering', 'no');
    ctx.status = 200;

    const stream = new PassThrough();
    ctx.body = stream;

    const channel = `transfer:job:done:${jobId}`;
    let cleaned = false;
    let timer;
    let onMessage;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      app.redisSub.removeListener('message', onMessage);
      app.redisSub.unsubscribe(channel).catch(() => {});
    };

    onMessage = (ch, message) => {
      if (ch !== channel) return;
      stream.write(`data: ${message}\n\n`);
      stream.end();
      cleanup();
    };

    // 30 秒 timeout，避免連線永久佔用
    timer = setTimeout(() => {
      stream.write(`data: ${JSON.stringify({ status: 'timeout' })}\n\n`);
      stream.end();
      cleanup();
    }, 30000);

    app.redisSub.on('message', onMessage);
    await app.redisSub.subscribe(channel);

    // 訂閱後再查一次，避免訂閱期間 job 剛好完成導致漏掉通知
    const latestJob = await transferJobStore.getJob(redis, jobId);

    if (latestJob && (latestJob.status === 'success' || latestJob.status === 'failed')) {
      stream.write(`data: ${JSON.stringify(latestJob)}\n\n`);
      stream.end();
      cleanup();
      return;
    }

    // 前端斷線時清理資源
    ctx.req.on('close', cleanup);
  }
}

module.exports = TransferJobsService;
