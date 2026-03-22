'use strict';

const Redis = require('ioredis');
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
  // - 每個請求建立獨立的 ioredis subscriber 連線，避免共享 app.redisSub
  //   造成 unsubscribe 互相干擾的競態問題
  // - 訂閱後需再查一次 job 狀態，避免訂閱前 job 剛好完成導致漏掉通知
  // - 前端斷線或完成時 quit() 獨立連線，不影響其他請求
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

    // 建立獨立的 ioredis subscriber 連線，繞過共享 app.redisSub 的競態問題
    // 連線設定沿用 app.redis.client，確保連到同一台 Redis
    const redisConfig = app.config.redis && app.config.redis.client
      ? app.config.redis.client
      : { host: '127.0.0.1', port: 6379, db: 0 };

    const sub = new Redis({
      host: redisConfig.host || '127.0.0.1',
      port: redisConfig.port || 6379,
      password: redisConfig.password || undefined,
      db: redisConfig.db || 0,
    });

    const channel = `transfer:job:done:${jobId}`;
    let cleaned = false;
    let timer;

    const send = data => {
      if (!stream.writableEnded) {
        stream.write(`data: ${JSON.stringify(data)}\n\n`);
        stream.end();
      }
    };

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      ctx.logger.info('[TransferJobsService] cleanup called: jobId=%s stack=%s', jobId, new Error().stack.split('\n')[2].trim());
      clearTimeout(timer);
      sub.quit().catch(() => {});
    };

    sub.on('message', (ch, message) => {
      if (ch !== channel) return;
      try {
        send(JSON.parse(message));
      } catch (err) {
        this.ctx.logger.error('[TransferJobsService] message parse error: jobId=%s err=%s', jobId, err && err.message);
        send({ status: 'failed', error: { message: 'parse error' } });
      }
      cleanup();
    });

    // sub 連線異常時推送 timeout，讓前端 fallback 輪詢
    sub.on('error', err => {
      process.stderr.write('[sub error] jobId=' + jobId + ' err=' + (err && err.message) + '\n');
      send({ status: 'timeout' });
      cleanup();
    });

    await sub.subscribe(channel);

    // 訂閱後再查一次，避免訂閱期間 job 剛好完成導致漏掉通知
    const latestJob = await transferJobStore.getJob(redis, jobId);

    if (latestJob && (latestJob.status === 'success' || latestJob.status === 'failed')) {
      send(latestJob);
      cleanup();
      return;
    }

    // 30 秒 timeout，避免連線永久佔用
    timer = setTimeout(() => {
      send({ status: 'timeout' });
      cleanup();
    }, 30000);

    // 前端斷線時清理資源
    ctx.req.on('close', cleanup);
  }
}

module.exports = TransferJobsService;
